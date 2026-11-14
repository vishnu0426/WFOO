"""The engine's resource manager: what a solve may use, and what is held back for everything else.

Three problems this exists to solve:

1. **Two solves must not both be told "there is room" for the same memory.** Reading the free memory is a snapshot; two solves that read it a moment apart each see all of it.
   So a solve RESERVES what it expects to need before it starts, and the manager admits the next one against what is reserved, not only against what the system reports.
   A reservation counts against the solvers' budget for as long as the solve runs; and, because a freshly started process has not yet taken the memory it reserved, for its first
   RAMP_SEC seconds it is also subtracted from what the system reports free.
2. **A big solve must not starve the small calls.** Staffing, intraday, simulation and forecasting need a little memory and a thread at any moment. A fraction of the machine
   (`light_reserve_mb`) is never offered to solves, so those calls always have room, however many large solves are queued.
3. **Cancelled or hopeless work must not hold a place.** Waiting for room can be cancelled (it returns within a quarter of a second), and a solve that cannot be admitted in time is
   refused with a clear, retryable reason (MemoryPressure, "ENGINE_BUSY"), never launched into memory that is known to be short.

The manager knows nothing about solvers or gRPC: it is given functions that read memory and CPU, so it is tested with a controlled clock and controlled memory.
"""
import contextlib
import os
import sys
import threading
import time

RAMP_SEC = float(os.environ.get("ENGINE_RESERVATION_RAMP_SEC", "20"))
POLL_SEC = 0.25


class MemoryPressure(RuntimeError):
    """There is not enough memory to start this work safely. The caller can retry."""


class RequestTooLarge(MemoryPressure):
    """The work needs more memory than solves may ever hold at once. Waiting will not help and neither will retrying: the request has to be made smaller (fewer people or days)."""


class Cancelled(Exception):
    """The caller gave up while waiting for room."""


def effective_cpus(cgroup_root="/sys/fs/cgroup"):
    """The cores this engine may really use: the CPU quota of its container when there is one, else the cores it is allowed to run on, else the machine's."""
    n = os.cpu_count() or 1
    try:
        n = min(n, len(os.sched_getaffinity(0)))
    except (AttributeError, OSError):
        pass
    try:                                                                                # the files exist only under a Linux container; anywhere else the open fails and is ignored
        with open(os.path.join(cgroup_root, "cpu.max")) as f:                          # cgroup v2: "quota period" or "max period"
            quota, period = f.read().split()[:2]
        if quota != "max":
            n = min(n, max(1, int(round(int(quota) / int(period)))))
    except (OSError, ValueError):
        try:
            with open(os.path.join(cgroup_root, "cpu/cpu.cfs_quota_us")) as f:         # cgroup v1
                quota = int(f.read())
            with open(os.path.join(cgroup_root, "cpu/cpu.cfs_period_us")) as f:
                period = int(f.read())
            if quota > 0:
                n = min(n, max(1, int(round(quota / period))))
        except (OSError, ValueError):
            pass
    return max(1, n)


class ResourceManager:
    def __init__(self, free_mb, total_mb, budget_pct=85.0, light_reserve_mb=None, ramp_sec=RAMP_SEC, clock=time.monotonic, cpus=effective_cpus):
        self._free, self._total, self._clock, self._cpus = free_mb, total_mb, clock, cpus
        self.budget_pct, self.ramp_sec = budget_pct, ramp_sec
        self._light = light_reserve_mb
        self._cv = threading.Condition()
        self._held = {}                      # id -> (kind, mb, admitted at)
        self._next = 0
        self.stats = {"admitted": 0, "waited": 0, "refused": 0, "cancelled": 0, "wait_sec": 0.0, "max_wait_sec": 0.0, "too_large": 0}

    # ---- what there is
    def total_mb(self):
        t = self._total()
        return None if t is None else float(t)

    def light_reserve_mb(self):
        if self._light is not None:
            return float(self._light)
        t = self.total_mb()
        return 512.0 if t is None else max(512.0, 0.08 * t)

    def budget_mb(self):
        """What solves may hold between them. None when the system does not say how much memory there is (then only the live reading limits them)."""
        t = self.total_mb()
        return None if t is None else max(1.0, t * self.budget_pct / 100.0 - self.light_reserve_mb())

    def reserved_mb(self):
        with self._cv:
            return sum(mb for _, mb, _ in self._held.values())

    def _unramped_mb(self, now):
        return sum(mb for _, mb, t in self._held.values() if now - t < self.ramp_sec)

    def snapshot(self):
        with self._cv:
            return {"reserved_mb": sum(mb for _, mb, _ in self._held.values()), "holders": len(self._held), "budget_mb": self.budget_mb(), "light_reserve_mb": self.light_reserve_mb(),
                    "free_mb": self._free(), "total_mb": self.total_mb(), "cpus": self._cpus(), **self.stats}

    # ---- admission
    def _room(self, mb, now):
        """None when `mb` fits now, else the reason it does not."""
        budget = self.budget_mb()
        held = sum(h[1] for h in self._held.values())
        if budget is not None and held + mb > budget + 1e-9:
            return f"{int(held)} MB is already reserved by running solves and this one needs {int(mb)} MB of the {int(budget)} MB they may share"
        free = self._free()
        if free is not None:
            usable = free - self._unramped_mb(now)
            if usable < mb:
                return f"only {int(max(usable, 0))} MB of memory is free (after what solves that have just started will take) and this solve needs about {int(mb)} MB"
        return None

    @contextlib.contextmanager
    def reserve(self, kind, mb, cancel=None, wait_sec=300.0):
        """Hold `mb` megabytes for the duration of the block, waiting up to `wait_sec` for room. Raises Cancelled if `cancel` is set while waiting and MemoryPressure if the room does not
        come. A request for more than solves may ever hold is REFUSED at once (RequestTooLarge): it would run into memory that is not there. Callers that can do the work with less
        (fewer search threads) ask for the smaller amount instead of this one."""
        mb = float(max(mb, 0.0))
        budget = self.budget_mb()
        if budget is not None and mb > budget:
            self.stats["too_large"] += 1
            raise RequestTooLarge(f"REQUEST_TOO_LARGE: this work needs about {int(mb)} MB and solves may hold at most {int(budget)} MB on this machine. Ask for fewer people or days, or give the engine more memory.")
        t0 = time.monotonic()                # waiting is real time; the injected clock only dates reservations (for the ramp)
        waited = False
        with self._cv:
            while True:
                if cancel is not None and cancel.is_set():
                    self.stats["cancelled"] += 1
                    raise Cancelled()
                now = self._clock()
                why = self._room(mb, now)
                if why is None:
                    break
                waited = True
                if time.monotonic() - t0 >= wait_sec:
                    self.stats["refused"] += 1
                    raise MemoryPressure(f"ENGINE_BUSY: {why}. Try again in a moment, or ask for fewer people or days.")
                self._cv.wait(min(POLL_SEC, max(0.01, wait_sec / 10)))
            self._next += 1
            hid = self._next
            self._held[hid] = (kind, mb, self._clock())
            self.stats["admitted"] += 1
            if waited:
                took = time.monotonic() - t0
                self.stats["waited"] += 1
                self.stats["wait_sec"] += took
                self.stats["max_wait_sec"] = max(self.stats["max_wait_sec"], took)
        try:
            yield mb
        finally:
            with self._cv:
                self._held.pop(hid, None)
                self._cv.notify_all()
