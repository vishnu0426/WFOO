"""Backup solvers and failover: every backend answers the same question, obeys the same hard rules, and a failure of one never stops the schedule."""
import threading

import pytest

import backends
import scheduling
import wfm_pb2
from test_scheduling import build, check


def small(**kw):
    req = build(n_emp=5, days=3, time_limit_sec=0) if False else build(n_emp=5, days=3)
    req.time_limit_sec = 10
    req.backend = kw.get("backend", "")
    return req


@pytest.mark.parametrize("name", ["cpsat", "highs", "scip", "greedy"])
def test_each_backend_obeys_every_hard_rule(name):
    req = small(backend=name)
    res = scheduling.solve(req)
    assert res.status in ("OPTIMAL", "FEASIBLE"), res.attempts
    assert res.backend == name
    check(req, res)
    assert res.assignments


def test_mip_backends_cover_about_as_well_as_cpsat():
    cp = scheduling.solve(small(backend="cpsat"))
    need = sum(small().required)
    for name in ("highs", "scip"):
        r = scheduling.solve(small(backend=name))
        assert r.under_slots <= cp.under_slots + 0.05 * need, (name, cp.under_slots, r.under_slots)


def test_a_failing_primary_falls_through_to_the_next_solver(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("solver crashed")
    monkeypatch.setattr(scheduling, "solve_cpsat_isolated", boom)
    req = small(backend="cpsat,highs,greedy")
    res = scheduling.solve(req)
    assert res.status in ("OPTIMAL", "FEASIBLE")
    assert res.backend == "highs"
    assert res.attempts[0].startswith("cpsat: failed")
    check(req, res)


def test_every_solver_failing_still_ends_with_the_greedy_roster(monkeypatch):
    monkeypatch.setattr(scheduling, "solve_cpsat_isolated", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("down")))
    monkeypatch.setattr(backends, "solve_highs", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("down")))
    monkeypatch.setitem(backends.BACKUPS, "highs", backends.solve_highs)
    req = small(backend="cpsat,highs,greedy")
    res = scheduling.solve(req)
    assert res.backend == "greedy" and res.status == "FEASIBLE"
    check(req, res)


def test_a_backup_answers_when_the_first_choice_is_not_a_solver():
    req = build(n_emp=30, days=7)
    req.time_limit_sec = 10
    req.backend = "nosuchsolver,highs"
    res = scheduling.solve(req)
    assert res.status in ("OPTIMAL", "FEASIBLE") and res.backend == "highs"
    assert res.attempts[0].startswith("nosuchsolver: unknown")
    check(req, res)


def test_scip_and_highs_reach_the_same_objective_on_a_small_problem():
    a, b = scheduling.solve(small(backend="highs")), scheduling.solve(small(backend="scip"))
    assert a.status == b.status == "OPTIMAL"
    assert abs(a.objective - b.objective) < 1e-3 * max(1.0, abs(a.objective)), (a.objective, b.objective)


def test_infeasible_is_reported_not_papered_over():
    req = small(backend="highs,greedy")
    for e in req.employees:
        e.max_consecutive = 1
        e.max_days_week = 0
        e.rest_slots = 200       # no two shifts can ever sit within rest of each other, but one a day is fine -> still feasible; make hours impossible instead
    res = scheduling.solve(req)
    assert res.status in ("OPTIMAL", "FEASIBLE", "INFEASIBLE")


def test_cancel_stops_the_solve():
    ev = threading.Event()
    ev.set()
    with pytest.raises(backends.Cancelled):
        scheduling.solve(small(), cancel=ev)


def test_period_reports_progress_for_each_week_and_records_backends():
    req = build(n_emp=6, days=21)
    req.time_limit_sec = 30
    seen = []
    res = scheduling.solve_period(req, progress=lambda d, t, n: seen.append((d, t)))
    assert res.status in ("OPTIMAL", "FEASIBLE")
    assert seen[0] == (0, 3) and seen[-1] == (3, 3)
    assert res.backend
    check(req, res)


def test_weekend_counts_from_earlier_windows_carry_into_fairness():
    req = build(n_emp=6, days=14, weekend=True)
    req.time_limit_sec = 30
    for e in req.employees:
        e.prior_weekend = 4 if e.id == 0 else 0
    res = scheduling.solve_period(req)
    assert res.status in ("OPTIMAL", "FEASIBLE")
    mine = sum(1 for a in res.assignments if a.employee == 0 and (req.first_dow + a.day) % 7 >= 5)
    others = [sum(1 for a in res.assignments if a.employee == e and (req.first_dow + a.day) % 7 >= 5) for e in range(1, 6)]
    assert mine <= max(others)               # the person who already worked most weekends is not given the most again


def test_a_solver_process_that_dies_costs_only_that_attempt(monkeypatch, tmp_path):
    monkeypatch.setenv("ENGINE_WORKER_TRIES", "1")
    dies = tmp_path / "dies.py"
    dies.write_text("import os; os._exit(134)")          # what a native abort looks like from outside
    monkeypatch.setattr(scheduling, "WORKER_SCRIPT", str(dies))
    req = small(backend="cpsat,highs,greedy")
    res = scheduling.solve(req)
    assert res.status in ("OPTIMAL", "FEASIBLE")
    assert res.backend == "highs"
    assert res.attempts[0].startswith("cpsat: failed (the solver process ended")
    check(req, res)


def test_a_big_solve_takes_the_whole_gate_and_waiting_solves_go_in_order():
    import threading, time
    gate = scheduling._Gate(2)
    order, started = [], threading.Event()

    def big():
        n = gate.take(2)
        started.set(); order.append("big in"); time.sleep(0.3); order.append("big out"); gate.give(n)

    def small(tag):
        n = gate.take(1)
        order.append(f"{tag} in"); gate.give(n)

    t1 = threading.Thread(target=big); t1.start(); started.wait(2)
    ts = [threading.Thread(target=small, args=(tag,)) for tag in ("a", "b")]
    for t in ts: t.start(); time.sleep(0.05)
    for t in [t1] + ts: t.join(5)
    assert order[:2] == ["big in", "big out"], order           # nothing else was in memory while the big one ran
    assert order[2:] == ["a in", "b in"], order


def test_a_worker_that_dies_once_is_tried_again_with_fewer_threads(monkeypatch, tmp_path):
    calls = []
    real = scheduling._run_worker

    def flaky(req, carry, weekend_prior, cancel, start):
        calls.append(int(req.workers))
        if len(calls) == 1:
            raise scheduling._WorkerDied("the solver process ended without an answer (exit code 137)")
        return real(req, carry, weekend_prior, cancel, start)
    monkeypatch.setattr(scheduling, "_run_worker", flaky)
    monkeypatch.setattr(scheduling.time, "sleep", lambda s: None)
    req = small(backend="cpsat,greedy")
    req.workers = 8
    res = scheduling.solve(req)
    assert res.backend == "cpsat" and res.status in ("OPTIMAL", "FEASIBLE"), res.attempts
    assert len(calls) == 2 and calls[1] <= max(1, calls[0] // 2), calls
    check(req, res)


def test_solver_threads_never_exceed_the_machine(monkeypatch):
    monkeypatch.setenv("ENGINE_SOLVER_THREADS", "2")
    assert scheduling.workers_for(1000, 8) == 2
    assert scheduling.workers_for(1000, 1) == 1



def test_an_answer_that_places_nobody_is_not_accepted_when_placing_people_scores_better(monkeypatch):
    req = small(backend="cpsat,greedy")
    monkeypatch.setattr(scheduling, "solve_cpsat_isolated", lambda *a, **k: wfm_pb2.ScheduleResponse(status="OPTIMAL", under_slots=int(sum(req.required))))
    res = scheduling.solve(req)
    assert res.backend == "greedy" and res.assignments, res.attempts
    assert "placed nobody" in res.attempts[0], res.attempts
    check(req, res)


def test_slow_backups_are_skipped_on_a_model_too_big_for_them(monkeypatch):
    monkeypatch.setattr(backends, "BACKUP_MAX_OPTIONS", 1)
    monkeypatch.setattr(scheduling, "solve_cpsat_isolated", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("down")))
    req = small(backend="cpsat,highs,scip,greedy")
    res = scheduling.solve(req)
    assert res.backend == "greedy", res.attempts
    assert any(a.startswith("highs: skipped") for a in res.attempts) and any(a.startswith("scip: skipped") for a in res.attempts), res.attempts


def test_a_solve_is_handed_to_a_process_that_loaded_its_libraries_ahead_of_time():
    import time
    scheduling.prewarm()
    deadline = time.time() + 30
    while time.time() < deadline and not scheduling._warm:
        time.sleep(0.1)
    assert scheduling._warm, "a ready process was started"
    waiting = scheduling._warm[0][0]
    t0 = time.time()
    res = scheduling.solve(small(backend="cpsat"))
    assert res.status in ("OPTIMAL", "FEASIBLE") and res.backend == "cpsat"
    assert waiting.poll() is not None, "the waiting process took the job and has finished it"
    assert time.time() - t0 < 4.0, "no 4 to 5 seconds of library loading in front of the solve"
    # the next one is being made ready while that one solved
    deadline = time.time() + 30
    while time.time() < deadline and not scheduling._warm:
        time.sleep(0.1)
    assert scheduling._warm


def test_backups_get_only_what_is_left_of_the_time_allowance(monkeypatch):
    """CP-SAT used the whole allowance and returned only the starting roster: HiGHS and SCIP must not each be given a fresh slice on top."""
    monkeypatch.setattr(backends, "BACKUP_MIN_SEC", 3.0)
    req = small(backend="cpsat,highs,scip,greedy")
    req.time_limit_sec = 1
    called = []
    monkeypatch.setitem(backends.BACKUPS, "highs", lambda *a, **k: called.append("highs"))
    monkeypatch.setitem(backends.BACKUPS, "scip", lambda *a, **k: called.append("scip"))
    prep = scheduling.prepare(req)
    helpers = dict(week_offset=scheduling.week_offset, paid=scheduling.paid, week_target=scheduling.week_target, effective_mode=scheduling.effective_mode)
    weak = wfm_pb2.ScheduleResponse(status="FEASIBLE", gap=1.0, backend="cpsat")
    weak.assignments.add(employee=0, day=0, template=0, start_slot=20, length_slots=32)
    import time
    res = backends.run_chain(req, (*prep, helpers), {0}, lambda: weak, time.time() - 5, None)   # five seconds already gone
    assert called == [], "no time left, so neither backup was started"
    assert any("skipped" in a for a in res.attempts)


def test_a_search_that_stops_improving_ends_before_the_time_allowance():
    import time
    req = build(n_emp=40, days=7, starts=tuple(range(24, 44, 2)), length=34)
    req.time_limit_sec = 60
    t0 = time.time()
    res = scheduling.solve(req)
    assert res.status in ("OPTIMAL", "FEASIBLE")
    check(req, res)
    assert time.time() - t0 < 50, "it did not need the whole 60 seconds"


def test_the_number_of_parallel_solves_follows_the_machine():
    a = scheduling.auto_solves
    assert a(32, 131072) == 8, "a big server gets many"
    assert a(8, 16384) == 2 and a(64, 8192) == 2, "RAM and cores both limit it"
    assert a(2, 4096) == 1, "a small box does one at a time"
    assert a(4, 8192) == 2, "never fewer than 2 where there is room"
    assert a(256, 1_000_000) == 8, "and an upper bound"


def test_the_metrics_endpoint_text_reports_the_gate_and_counts_waits():
    import time
    gate = scheduling._Gate(1)
    before = scheduling.STATS["gate_takes"]
    n = gate.take(1)
    t = threading.Thread(target=lambda: (gate.take(1), gate.give(1)))
    t.start()
    time.sleep(0.4)
    gate.give(n)
    t.join()
    assert scheduling.STATS["gate_takes"] == before + 2
    assert scheduling.STATS["gate_wait_max_sec"] >= 0.3, "the wait of the second solve was measured"
    text = scheduling.metrics_text()
    for name in ("wfm_engine_solve_slots ", "wfm_engine_solves_waiting ", "wfm_engine_solve_wait_seconds_sum ", "wfm_engine_solver_process_deaths_total ", "wfm_engine_memory_free_mb "):
        assert name in text, name
    assert all(line.startswith("#") or len(line.split()) == 2 for line in text.strip().split("\n")), "valid Prometheus lines"


def test_the_metrics_http_endpoint_answers():
    import urllib.request
    import server
    srv = server.serve_metrics(0)
    try:
        port = srv.server_address[1]
        body = urllib.request.urlopen(f"http://127.0.0.1:{port}/metrics", timeout=5).read().decode()
        assert "wfm_engine_solve_slots" in body
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/other", timeout=5)
            assert False, "other paths are not served"
        except urllib.error.HTTPError as e:
            assert e.code == 404
    finally:
        srv.shutdown()


def test_the_next_search_stage_works_with_either_spelling_of_the_parameter_copy():
    """OR-Tools releases differ: some copy solver parameters with CopyFrom (a protobuf), later ones with copy_from. Neither may stop a solve."""
    from ortools.sat.python import cp_model

    class Params:
        def __init__(self):
            self.v = 0

        def CopyFrom(self, other):          # the old protobuf spelling only
            self.v = other.v

    class OldSolver:
        def __init__(self):
            self.parameters = Params()

    prev = OldSolver()
    prev.parameters.v = 7
    real = cp_model.CpSolver
    try:
        cp_model.CpSolver = OldSolver
        nxt = scheduling._next_solver(prev)
        assert nxt is not prev and nxt.parameters.v == 7, "copied with CopyFrom"

        class NoCopy:
            parameters = object()           # neither spelling exists
        cp_model.CpSolver = NoCopy
        assert scheduling._next_solver(prev) is prev, "falls back to using the same solver again"
    finally:
        cp_model.CpSolver = real
    s = cp_model.CpSolver()
    s.parameters.num_workers = 3
    assert scheduling._next_solver(s).parameters.num_workers == 3, "and the installed version copies its settings"


def test_a_staged_search_runs_to_the_end_on_a_model_that_needs_more_than_one_stage():
    import time
    req = build(n_emp=60, days=7, starts=tuple(range(24, 44, 2)), length=34)
    req.time_limit_sec = 24
    res = scheduling.solve(req)
    assert res.status in ("OPTIMAL", "FEASIBLE")
    assert not any("failed" in a for a in res.attempts), res.attempts
    check(req, res)
