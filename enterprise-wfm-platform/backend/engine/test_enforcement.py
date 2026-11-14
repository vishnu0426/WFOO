"""The rules the engine enforces itself, rather than trusting its callers: every roster it returns is validated, required consistency holds across a whole plan, memory it does not have is
never promised, one definition of demand is used everywhere, and a solver that does not implement a rule is not used."""
import grpc
import pytest

import backends
import capabilities
import coverage
import resources
import scheduling
import validator
import verdict
import wfm_pb2
import test_scheduling as ts
from test_resources import manager
from test_server import _cfg, _stub, serving

SPD = 96


# ---------------------------------------------------------------- the Schedule call carries its own verdict

def test_the_schedule_call_returns_the_validators_verdict_with_the_roster():
    req = ts.build(n_emp=8, days=7)
    req.time_limit_sec = 8
    res = scheduling.solve_period(req)
    assert res.verdict.checked and res.verdict.valid and res.verdict.status in ("VALIDATED", "VALIDATED_WITH_WARNINGS")
    assert res.verdict.hard_violations == 0


def test_over_grpc_a_caller_never_receives_a_roster_without_a_verdict():
    req = ts.build(n_emp=6, days=7)
    req.time_limit_sec = 6
    for e in req.employees:                                                           # the engine refuses an employee numbered 0
        e.id += 1
    for x in req.options:
        x.employee += 1
    with serving(_cfg()) as port:
        res = _stub(port).Schedule(req)
    assert res.verdict.checked and res.verdict.valid and len(res.assignments) > 0


def _break_a_rule(req, extra_day=0):
    """A roster in which the first person works two shifts on one day."""
    res = wfm_pb2.ScheduleResponse(status="OPTIMAL", backend="liar")
    o = req.options[0]
    res.assignments.add(employee=o.employee, day=o.day, template=o.template, start_slot=o.start_slot, length_slots=o.length_slots)
    res.assignments.add(employee=o.employee, day=o.day, template=o.template + 1, start_slot=o.start_slot + 4, length_slots=o.length_slots)
    return res


def test_a_backend_whose_roster_breaks_a_rule_is_rejected_and_the_next_one_answers(monkeypatch):
    req = ts.build(n_emp=6, days=7)
    req.time_limit_sec = 6
    req.backend = "highs,greedy"
    monkeypatch.setitem(backends.BACKUPS, "highs", lambda r, prep, pick, t0, limit, cancel: _break_a_rule(r))
    res = scheduling.solve(req)
    assert res.backend == "greedy" and res.verdict.checked and res.verdict.valid
    assert any(a.startswith("highs: rejected") and "rule" in a for a in res.attempts), res.attempts


def test_if_no_backend_can_make_a_valid_roster_the_answer_says_so(monkeypatch):
    req = ts.build(n_emp=6, days=7)
    req.time_limit_sec = 6
    req.backend = "highs,greedy"
    monkeypatch.setitem(backends.BACKUPS, "highs", lambda r, prep, pick, t0, limit, cancel: _break_a_rule(r))
    monkeypatch.setitem(backends.BACKUPS, "greedy", lambda r, prep, pick, t0, limit, cancel: _break_a_rule(r))
    res = scheduling.solve(req)
    assert res.verdict.checked and not res.verdict.valid and res.verdict.status == "INVALID" and res.verdict.hard_violations >= 1
    assert len(res.verdict.findings) >= 1


def test_a_check_that_cannot_run_is_not_a_pass(monkeypatch):
    req = ts.build(n_emp=4, days=7)
    res = wfm_pb2.ScheduleResponse(status="OPTIMAL")
    monkeypatch.setattr(verdict, "VERIFY", False)
    assert not verdict.check(req, res).checked
    monkeypatch.setattr(verdict, "VERIFY", True)
    monkeypatch.setattr(validator, "validate", lambda r: (_ for _ in ()).throw(RuntimeError("boom")))
    v = verdict.check(req, res)
    assert not v.checked and "boom" in v.note


# ---------------------------------------------------------------- required consistency, in the validator and across a long plan

def _validation(tol=2, anchor=None, mode=3, starts=(36, 36), ends=None):
    v = wfm_pb2.ValidateRequest(days=7, first_dow=0, week_start=0, start_tol_slots=tol, end_tol_slots=tol)
    e = v.employees.add(name="Asha")
    e.limits.id, e.limits.consist_mode = 1, mode
    if anchor:
        e.limits.has_anchor, e.limits.anchor_start, e.limits.anchor_end = True, anchor[0], anchor[1]
    for d, st in enumerate(starts):
        v.shifts.add(employee=1, day=d, start_slot=st, length_slots=32, ref=f"s{d}")
    return v


def test_the_validator_enforces_one_usual_start_and_end_for_a_person_who_must_have_them():
    ok = validator.validate(_validation(starts=(36, 38, 34)))                         # within two slots of a middle time
    assert ok.valid, [f.message for f in ok.findings]
    bad = validator.validate(_validation(starts=(20, 60)))
    assert not bad.valid and any(f.code == "CONSISTENCY" for f in bad.findings)
    assert "usual start" in next(f.message for f in bad.findings if f.code == "CONSISTENCY")
    relaxed = validator.validate(_validation(starts=(20, 60), mode=2))                # prefer: a cost, not a rule
    assert relaxed.valid
    anchored = validator.validate(_validation(starts=(41,), anchor=(36, 68)))        # the usual times were set by the weeks before
    assert any(f.code == "CONSISTENCY" for f in anchored.findings)
    assert validator.validate(_validation(starts=(37,), anchor=(36, 68))).valid


@pytest.mark.parametrize("backend", ["cpsat", "highs", "scip", "greedy"])
def test_every_solver_keeps_a_required_usual_start_and_end(backend):
    req = ts.build(n_emp=8, days=7, starts=(20, 28, 36, 44, 52, 60))
    req.time_limit_sec, req.backend = 12, backend
    req.consistency_mode, req.start_tol_slots, req.end_tol_slots = 2, 2, 2
    res = scheduling.solve(req)
    assert res.verdict.checked and res.verdict.valid, [f.message for f in res.verdict.findings]
    starts = {}
    for a in res.assignments:
        starts.setdefault(a.employee, set()).add(a.start_slot)
    assert starts and all(max(v) - min(v) <= 4 for v in starts.values()), starts


def _three_weeks(people=6):
    req = ts.build(n_emp=people, days=21, starts=(20, 28, 36, 44, 52, 60))
    req.time_limit_sec = 40
    req.consistency_mode, req.start_tol_slots, req.end_tol_slots, req.w_consist = 2, 2, 2, 200
    return req


def test_required_consistency_holds_across_every_week_of_a_long_plan():
    req = _three_weeks()
    res = scheduling.solve_period(req)
    assert res.status in ("OPTIMAL", "FEASIBLE") and res.windowed
    assert res.verdict.checked and res.verdict.valid, [f.message for f in res.verdict.findings]
    starts = {}
    for a in res.assignments:
        starts.setdefault(a.employee, set()).add(a.start_slot)
    assert starts and all(max(s) - min(s) <= 4 for s in starts.values()), starts


def test_a_person_with_no_shift_near_their_usual_times_in_a_week_is_not_scheduled_that_week_instead_of_being_given_new_ones():
    req = _three_weeks(5)
    keep = [o for o in req.options if o.employee != 0]
    del req.options[:]
    req.options.extend(keep)
    for d in range(21):                                                              # person 0: only the early start in week 1, only the late start after it
        req.options.add(employee=0, day=d, template=0 if d < 7 else 5, start_slot=20 if d < 7 else 60, length_slots=32)
    res = scheduling.solve_period(req)
    assert res.verdict.checked and res.verdict.valid, [f.message for f in res.verdict.findings]
    mine = [a for a in res.assignments if a.employee == 0]
    assert mine and all(a.day < 7 for a in mine) and all(a.start_slot == 20 for a in mine), "the rule is kept: nothing later, because nothing later is near the usual times"
    assert any("not scheduled this week" in a for a in res.attempts), res.attempts


# ---------------------------------------------------------------- one definition of demand

def test_demand_semantics_in_one_place():
    assert coverage.generic_need(10, {1: 6}) == 4          # the total is 10, 6 of them serve skill 1: 4 more are needed from anybody
    assert coverage.generic_need(4, {1: 6}) == 0           # the skills ask for more than the total: they decide
    assert coverage.generic_need(0, {}) == 0
    skilled = {frozenset({1}): 2}
    assert coverage.unmet({1: 2}, skilled) == 0
    assert coverage.unmet({1: 2}, skilled, extra=3, unskilled=1) == 2                 # 2 serve the skill, 1 unskilled person fills one of the 3 others: 2 short
    assert coverage.unmet({1: 2}, skilled, extra=3, unskilled=3) == 0
    assert coverage.unmet({}, {frozenset({1}): 2}, extra=3, unskilled=0) == 1         # skilled people can fill the generic part too
    assert coverage.unmet({1: 3}, skilled) == 1


def _aggregate_over_skill():
    """Three people are needed on the phones from slot 36 to 67, one of whom must hold the skill. Of four people, only A holds it."""
    r = wfm_pb2.ScheduleRequest(days=1, first_dow=0, time_limit_sec=8, w_under=100, w_over=10, w_hours=0, w_pref=0, w_fair=0, workers=2)
    r.required.extend([3 if 36 <= s < 68 else 0 for s in range(SPD)])
    r.skill_requirements.add(id=1, required=[1 if 36 <= s < 68 else 0 for s in range(SPD)])
    for e in range(4):
        emp = r.employees.add(id=e, max_week_slots=160, min_week_slots=0, max_consecutive=5, rest_slots=44, max_days_week=5)
        if e == 0:
            emp.skill_ids.append(1)
        r.options.add(employee=e, day=0, template=0, start_slot=36, length_slots=32)
    return r


@pytest.mark.parametrize("backend", ["cpsat", "highs", "scip", "greedy"])
def test_every_solver_meets_the_total_not_only_the_skill_part_of_it(backend):
    r = _aggregate_over_skill()
    r.backend = backend
    res = scheduling.solve(r)
    who = sorted(a.employee for a in res.assignments)
    assert res.under_slots == 0 and len(who) == 3 and 0 in who, f"{backend}: {who}, short {res.under_slots}"
    assert res.verdict.checked and res.verdict.valid and res.verdict.coverage_status == "ADEQUATE"


def test_with_too_few_people_the_shortfall_counts_the_whole_total_in_the_solver_the_evaluator_and_the_validator():
    r = _aggregate_over_skill()
    del r.options[:]
    for e in range(2):                                                                # only two people can work: the total of 3 cannot be met
        r.options.add(employee=e, day=0, template=0, start_slot=36, length_slots=32)
    res = scheduling.solve(r)
    assert res.under_slots == 32 and res.score_terms and any(t.name == "under" and t.value == 100 * 32 for t in res.score_terms)
    assert res.verdict.coverage_status == "UNDERSTAFFED"
    v = validator.validate(verdict.to_validate_request(r, res))
    assert v.under_slots == 32 and v.coverage_status == "UNDERSTAFFED"


# ---------------------------------------------------------------- memory: what cannot fit is refused, however the solve would run

def _wide(n):
    req = wfm_pb2.ScheduleRequest(days=1, time_limit_sec=5, workers=4)
    req.employees.add(id=1)
    for _ in range(n):
        req.options.add(employee=1, day=0, template=0, start_slot=36, length_slots=32)
    return req


def test_a_solve_that_cannot_fit_even_with_one_thread_is_refused_before_anything_starts(monkeypatch):
    m = manager(free=10 ** 6, total=1300, light=1000, ramp=0.0)                      # solves may hold 300 MB
    monkeypatch.setattr(scheduling, "RM", m)
    with pytest.raises(resources.RequestTooLarge, match="REQUEST_TOO_LARGE"):
        scheduling.admit_threads(30000, 8)                                            # 250 + 30,000 * 0.003 = 340 MB with a single thread
    assert scheduling.admit_threads(5000, 8) == 3                                     # 250 + 15 MB a thread: three fit in 300 MB, eight would not: fewer threads, not a failure


def test_the_in_process_path_is_refused_and_reserved_like_a_worker_process(monkeypatch):
    m = manager(free=10 ** 6, total=1300, light=1000, ramp=0.0)
    monkeypatch.setattr(scheduling, "RM", m)
    monkeypatch.setenv("ENGINE_ISOLATE_SOLVES", "0")
    ran = []
    monkeypatch.setattr(scheduling, "solve_cpsat", lambda *a, **k: ran.append(m.reserved_mb()) or wfm_pb2.ScheduleResponse(status="OPTIMAL"))
    with pytest.raises(resources.RequestTooLarge):
        scheduling.solve_cpsat_isolated(_wide(30000), {}, {}, None, None)
    assert ran == [], "nothing was started"
    scheduling.solve_cpsat_isolated(_wide(2000), {}, {}, None, None)
    assert ran and ran[0] > 0, "the memory was held while it ran"
    assert m.reserved_mb() == 0


def test_the_rpc_refuses_a_request_too_big_for_the_memory_budget_at_once(monkeypatch):
    m = manager(free=10 ** 6, total=1300, light=1000, ramp=0.0)
    monkeypatch.setattr(scheduling, "RM", m)
    with serving(_cfg()) as port:
        with pytest.raises(grpc.RpcError) as e:
            _stub(port).Schedule(_wide(30000))
    assert e.value.code() == grpc.StatusCode.RESOURCE_EXHAUSTED and "REQUEST_TOO_LARGE" in e.value.details()


def test_a_long_plan_is_judged_by_its_busiest_week_not_its_total_size():
    req = wfm_pb2.ScheduleRequest(days=28)
    for d in range(28):
        for _ in range(100):
            req.options.add(employee=1, day=d, start_slot=36, length_slots=32)
    assert scheduling.largest_window_options(req) == 700 and len(req.options) == 2800


# ---------------------------------------------------------------- a solver is not offered as an equivalent until it implements the rules

def test_a_solver_that_does_not_implement_a_rule_the_request_uses_is_not_used(monkeypatch):
    monkeypatch.delenv("TIMEFOLD_URL", raising=False)
    req = ts.build(n_emp=6, days=7)
    req.time_limit_sec = 6
    req.backend = "timefold,greedy"
    res = scheduling.solve(req)
    assert res.backend == "greedy" and any("timefold: not used" in n for n in res.capability_notes), res.capability_notes
    assert res.verdict.valid


def test_a_declared_gap_in_a_service_s_rules_keeps_it_out_only_when_the_request_needs_them(monkeypatch):
    monkeypatch.setenv("TIMEFOLD_URL", "http://timefold.invalid")
    capabilities._cache.clear()
    capabilities._cache["http://timefold.invalid"] = (1e18, frozenset({"history", "option_cost", "gaps", "fairness"}), "Timefold test")
    plain = ts.build(n_emp=4, days=7)
    assert capabilities.missing("timefold", plain) == []
    skills = ts.build(n_emp=4, days=7)
    skills.skill_requirements.add(id=1, required=list(skills.required))
    assert capabilities.missing("timefold", skills) == ["skills"]
    assert capabilities.missing("cpsat", skills) == [] and capabilities.missing("highs", skills) == []
    capabilities._cache.clear()


# ---------------------------------------------------------------- choosing the solver, and never going down with one

def test_the_automatic_order_adds_timefold_only_when_its_service_is_set_up_and_never_first(monkeypatch):
    req = wfm_pb2.ScheduleRequest()
    monkeypatch.delenv("TIMEFOLD_URL", raising=False)
    monkeypatch.delenv("SOLVER_CHAIN", raising=False)
    assert backends.chain_for(req) == ["cpsat", "highs", "scip", "greedy"]
    monkeypatch.setenv("TIMEFOLD_URL", "http://127.0.0.1:1")
    assert backends.chain_for(req) == ["cpsat", "highs", "scip", "timefold", "greedy"]
    req.backend = "auto"
    assert backends.chain_for(req)[0] == "cpsat"
    req.backend = "cpsat"
    assert backends.chain_for(req) == ["cpsat"], "an explicit choice is respected"


def test_the_breaker_leaves_a_failing_service_alone_then_tries_it_again():
    t = {"now": 0.0}
    b = backends.Breaker(threshold=3, cooloff=60.0, clock=lambda: t["now"])
    assert b.allow() and b.state() == "closed"
    for _ in range(3):
        b.failed()
    assert b.state() == "open" and not b.allow()
    t["now"] = 59
    assert not b.allow()
    t["now"] = 61
    assert b.allow() and not b.allow(), "one trial call after the cool-off, and no more until it answers"
    b.ok()
    assert b.state() == "closed" and b.allow()


def test_a_dead_timefold_service_never_stops_a_build_and_is_then_left_alone(monkeypatch):
    monkeypatch.setenv("TIMEFOLD_URL", "http://127.0.0.1:9")                      # nothing listens there
    monkeypatch.setattr(backends, "TIMEFOLD_BREAKER", backends.Breaker(threshold=2, cooloff=3600))
    monkeypatch.setitem(capabilities.DECLARED, "timefold", capabilities.NATIVE)
    capabilities._cache["http://127.0.0.1:9"] = (1e18, capabilities.NATIVE, "test")
    for n in range(3):
        req = ts.build(n_emp=6, days=7)
        req.time_limit_sec = 6
        req.backend = "timefold,greedy"
        res = scheduling.solve(req)
        assert res.backend == "greedy" and res.verdict.valid, res.attempts
        assert any(a.startswith("timefold:") for a in res.attempts)
    assert any("left alone" in a for a in res.attempts), res.attempts
    capabilities._cache.clear()


def test_every_answer_says_in_plain_words_which_solver_made_it_and_what_that_means():
    req = ts.build(n_emp=6, days=7)
    req.time_limit_sec = 10
    res = scheduling.solve(req)
    assert res.advice and ("CP-SAT" in res.advice)
    greedy = ts.build(n_emp=6, days=7)
    greedy.backend = "greedy"
    res = scheduling.solve(greedy)
    assert "starting roster" in res.advice and "backup" in res.advice
