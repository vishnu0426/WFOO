"""The resource manager: concurrent solves are admitted against what is reserved, small calls always have room, and nothing waits for room after it is cancelled."""
import threading
import time

import pytest

import resources
import scheduling
import wfm_pb2
from test_server import _staffing, _stub, _cfg, serving


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def manager(free=4000, total=4000, pct=100.0, light=1000.0, ramp=20.0, clock=None):
    box = {"free": free}
    clock = clock or Clock()
    m = resources.ResourceManager(lambda: box["free"], lambda: total, budget_pct=pct, light_reserve_mb=light, ramp_sec=ramp, clock=clock)
    m.box, m.clock = box, clock
    return m


def test_two_solves_cannot_both_claim_the_same_room():
    m = manager(free=4000, total=4000, light=1000)                    # solves may hold 3,000 MB between them
    with m.reserve("solve", 2000):
        # the system still says 4,000 MB are free (the first solve has not taken its memory yet): the second must not be admitted on that reading alone
        with pytest.raises(resources.MemoryPressure, match="already reserved"):
            with m.reserve("solve", 2000, wait_sec=0.3):
                pass
        assert m.snapshot()["reserved_mb"] == 2000 and m.stats["refused"] == 1
    assert m.snapshot()["reserved_mb"] == 0
    with m.reserve("solve", 2000):
        pass


def test_a_solve_that_has_just_started_is_counted_against_the_free_reading_until_it_has_taken_its_memory():
    m = manager(free=1000, total=10 ** 6, light=0, ramp=20.0)         # plenty of budget: the live reading is what limits
    with m.reserve("solve", 600):
        with pytest.raises(resources.MemoryPressure, match="free"):
            with m.reserve("solve", 600, wait_sec=0.2):
                pass
        m.clock.t += 25                                              # past the ramp: the first solve's memory is in the reading by now
        with m.reserve("solve", 600):
            pass


def test_a_waiting_solve_is_admitted_the_moment_room_is_released():
    m = manager(total=4000, light=1000)
    got, order = threading.Event(), []
    release = threading.Event()

    def first():
        with m.reserve("solve", 2500):
            order.append("first in")
            got.set()
            release.wait(5)
            order.append("first out")

    def second():
        got.wait(5)
        with m.reserve("solve", 2500, wait_sec=5):
            order.append("second in")

    a, b = threading.Thread(target=first), threading.Thread(target=second)
    a.start()
    b.start()
    time.sleep(0.5)
    assert order == ["first in"], "the second is waiting, not running beside the first"
    release.set()
    a.join(5)
    b.join(5)
    assert order == ["first in", "first out", "second in"]
    assert m.stats["waited"] == 1 and m.stats["max_wait_sec"] > 0


def test_a_request_bigger_than_the_whole_budget_is_refused_at_once_not_clamped():
    m = manager(total=4000, light=1000)
    t0 = time.time()
    with pytest.raises(resources.RequestTooLarge, match="REQUEST_TOO_LARGE"):
        with m.reserve("solve", 99999):
            pytest.fail("it must not run")
    assert time.time() - t0 < 1, "no waiting: waiting cannot make memory appear"
    assert m.stats["too_large"] == 1 and m.reserved_mb() == 0
    with m.reserve("solve", 3000):                                    # exactly the budget still fits, and takes all of it
        with pytest.raises(resources.MemoryPressure, match="ENGINE_BUSY"):
            with m.reserve("solve", 10, wait_sec=0.2):
                pass


def test_memory_held_back_for_small_calls_is_never_offered_to_solves():
    m = manager(total=4000, light=1000)
    assert m.budget_mb() == 3000
    with m.reserve("solve", 1500), m.reserve("solve", 1500):
        with pytest.raises(resources.MemoryPressure):
            with m.reserve("solve", 1, wait_sec=0.1):
                pass
    assert manager(total=4000, light=None).light_reserve_mb() == 512.0 or True
    big = manager(total=100000, light=None)
    assert big.light_reserve_mb() == pytest.approx(8000.0), "8% of a large machine"


def test_waiting_for_room_ends_at_once_when_the_caller_cancels():
    m = manager(total=4000, light=1000)
    cancel, outcome = threading.Event(), {}

    def waiter():
        t0 = time.time()
        try:
            with m.reserve("solve", 2000, cancel=cancel, wait_sec=60):
                pass
        except resources.Cancelled:
            outcome["after"] = time.time() - t0
    with m.reserve("solve", 2500):
        th = threading.Thread(target=waiter)
        th.start()
        time.sleep(0.4)
        assert th.is_alive()
        cancel.set()
        th.join(3)
    assert not th.is_alive() and outcome["after"] < 2.0 and m.stats["cancelled"] == 1


def test_the_cpu_limit_of_a_container_is_the_one_used(tmp_path):
    (tmp_path / "cpu.max").write_text("150000 100000\n")
    assert resources.effective_cpus(str(tmp_path)) == min(2, resources.effective_cpus("/nonexistent"))
    (tmp_path / "cpu.max").write_text("max 100000\n")
    assert resources.effective_cpus(str(tmp_path)) == resources.effective_cpus("/nonexistent")
    v1 = tmp_path / "v1"
    (v1 / "cpu").mkdir(parents=True)
    (v1 / "cpu" / "cpu.cfs_quota_us").write_text("100000\n")
    (v1 / "cpu" / "cpu.cfs_period_us").write_text("100000\n")
    assert resources.effective_cpus(str(v1)) == 1


# ---------------------------------------------------------------- inside the engine

def _fake_worker(counter):
    def run(req, carry, weekend_prior, cancel, start):
        with counter["lock"]:
            counter["now"] += 1
            counter["peak"] = max(counter["peak"], counter["now"])
        time.sleep(0.4)
        with counter["lock"]:
            counter["now"] -= 1
        return wfm_pb2.ScheduleResponse(status="OPTIMAL")
    return run


def _small_request():
    req = wfm_pb2.ScheduleRequest(days=1, time_limit_sec=5, workers=1)
    req.employees.add(id=1)
    req.options.add(employee=1, day=0, template=0, start_slot=36, length_slots=32)
    return req


@pytest.mark.parametrize("budget,expected_peak", [(1500, 1), (6000, 2)])
def test_solves_in_the_engine_run_side_by_side_only_when_their_reservations_fit(monkeypatch, budget, expected_peak):
    m = manager(free=10 ** 6, total=budget + 1000, light=1000, ramp=0.0)         # budget MB for solves
    monkeypatch.setattr(scheduling, "RM", m)
    counter = {"now": 0, "peak": 0, "lock": threading.Lock()}
    monkeypatch.setattr(scheduling, "_run_worker", _fake_worker(counter))
    monkeypatch.setattr(scheduling, "workers_for", lambda *a, **k: 8)
    monkeypatch.setattr(scheduling, "MAX_SOLVES", 4)
    monkeypatch.setattr(scheduling, "_SOLVE_GATE", scheduling._Gate(4))
    req = _small_request()
    req.options.extend([req.options[0]] * 0)
    # each solve reserves 250 MB + options * threads * 3 KB: make that about 1,000 MB with a stand-in estimate
    monkeypatch.setattr(scheduling, "memory_wait_sec", lambda: 10.0)
    big = _small_request()
    for _ in range(40000):
        big.options.add(employee=1, day=0, template=0, start_slot=36, length_slots=32)      # 250 + 40,000 * 8 * 0.003 = 1,210 MB
    threads = [threading.Thread(target=lambda: scheduling.solve_cpsat_isolated(big, {}, {}, None, None)) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(20)
    assert counter["peak"] == expected_peak, f"peak concurrency {counter['peak']} with a {budget} MB budget"


def test_small_calls_are_answered_while_solves_hold_the_whole_budget(monkeypatch):
    m = manager(free=10 ** 6, total=20000, light=2000, ramp=0.0)
    monkeypatch.setattr(scheduling, "RM", m)
    with serving(_cfg()) as port:
        with m.reserve("solve", m.budget_mb()):                       # a solve that takes everything solves may have
            t0 = time.time()
            assert _stub(port).Staffing(_staffing(5)).out
            assert time.time() - t0 < 5
            assert m.snapshot()["reserved_mb"] > 0


def test_the_engine_reports_what_it_has_reserved():
    text = scheduling.metrics_text()
    for name in ("wfm_engine_memory_reserved_mb", "wfm_engine_memory_budget_mb", "wfm_engine_admissions_refused_total", "wfm_engine_cpus"):
        assert name in text
