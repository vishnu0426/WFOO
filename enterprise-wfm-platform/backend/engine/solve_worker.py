"""One CP-SAT solve in its own process (started by scheduling.solve_cpsat_isolated).

The solver library can abort the whole process on a native failure (running out of memory, an internal check). Run inside the engine, that took every
forecast and schedule request down with it. Run here, it ends this process only and the engine carries on with the next solver in the chain.

    python solve_worker.py <input.pkl> <output.pkl> <cancel-flag-path>
    python solve_worker.py --warm        (imports first, then waits for one line on stdin: a JSON list of the three paths)
The input holds (request bytes, carry, weekend_prior, start). The output holds ("ok", response bytes) | ("cancelled", None) | ("error", text).
Cancelling is a file appearing at the flag path.
"""
import os
import pickle
import sys

import backends
import scheduling
import wfm_pb2


def _parent_alive(ppid):
    """Whether the engine that started this process is still there."""
    if sys.platform == "win32":
        import ctypes
        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, ppid)          # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        code = ctypes.c_ulong()
        ok = ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
        ctypes.windll.kernel32.CloseHandle(handle)
        return bool(ok) and code.value == 259                                      # STILL_ACTIVE
    return os.getppid() == ppid


def guard_parent():
    """End this process if the engine that started it goes away: a solve nobody is waiting for would otherwise keep its memory and cores until its own time limit."""
    import threading
    import time
    ppid = os.getppid()

    def watch():
        while True:
            time.sleep(2)
            if not _parent_alive(ppid):
                os._exit(3)
    threading.Thread(target=watch, daemon=True).start()


class FileFlag:
    """Quacks like threading.Event for the solver's cancel check."""
    def __init__(self, path):
        self.path = path

    def is_set(self):
        return os.path.exists(self.path)


def main(inp, outp, flag):
    guard_parent()
    with open(inp, "rb") as f:
        req_bytes, carry, weekend_prior, start = pickle.load(f)
    req = wfm_pb2.ScheduleRequest()
    req.ParseFromString(req_bytes)
    try:
        res = scheduling.solve_cpsat(req, carry, weekend_prior, FileFlag(flag), start)
        out = ("ok", res.SerializeToString())
    except backends.Cancelled:
        out = ("cancelled", None)
    except Exception as e:  # noqa: BLE001
        out = ("error", f"{type(e).__name__}: {e}"[:400])
    with open(outp + ".tmp", "wb") as f:
        pickle.dump(out, f)
    os.replace(outp + ".tmp", outp)   # the parent only ever sees a finished file


def warm():
    """Loading the solver libraries takes 4 to 5 seconds, which used to be paid by every solve (a 13-week plan is 13 of them). The engine starts one of these ahead of time
    (the imports above are the work), hands it a job when one arrives, and starts the next while this one solves. It gives up if nothing arrives, or the engine goes away."""
    import json
    import threading
    idle = threading.Timer(float(os.environ.get("ENGINE_WARM_IDLE_SEC", "900")), lambda: os._exit(0))
    idle.daemon = True
    idle.start()
    line = sys.stdin.readline()            # '' when the engine closed the pipe or exited
    idle.cancel()
    if not line.strip():
        return
    inp, outp, flag = json.loads(line)
    main(inp, outp, flag)


if __name__ == "__main__":
    if sys.argv[1] == "--warm":
        warm()
    else:
        main(sys.argv[1], sys.argv[2], sys.argv[3])
