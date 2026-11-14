"""Every backend is judged by one evaluator, and the evaluator agrees with the solvers about what an objective is.

For an input every backend can solve to the end, CP-SAT, HiGHS and SCIP must report the same business objective as each other and as the evaluator, which shares no code with any of
them. A backend that has not finished (a MIP solver at its time limit leaves slack in its own bookkeeping) may report a larger figure of its own than its roster is worth, never a
smaller one. Every roster, from any backend, must obey every hard rule as checked by code that shares nothing with the models.
"""
import pytest

import backends
import scheduling
import scoring
import test_scheduling as ts
import wfm_pb2


def _basic():
    r = ts.build(n_emp=8, days=7)
    r.time_limit_sec = 10
    return r


def _two_skills():
    r = ts.build(n_emp=8, days=7)
    r.time_limit_sec = 10
    need = [x // 2 for x in r.required]
    del r.required[:]
    r.required.extend(need)
    r.skill_requirements.add(id=1, required=need)
    r.skill_requirements.add(id=2, required=[0] * len(need))
    for e in r.employees:
        e.skill_ids.append(1 if e.id % 2 == 0 else 2)
    return r


def _every_term():
    """Consistency, preferences, a priced holiday, planned overtime and weekend fairness all in play."""
    r = ts.build(n_emp=8, days=14, weekend=True)
    r.time_limit_sec = 12
    r.w_overtime, r.w_consist, r.consistency_mode, r.start_tol_slots, r.end_tol_slots = 40, 200, 1, 2, 2
    for i, o in enumerate(r.options):
        if i % 5 == 0:
            o.preference = 1
        if o.day == 3:
            o.unsocial, o.cost = True, 300
    return r


def _solve(make, backend):
    r = make()
    r.backend = backend
    return r, scheduling.solve(r)


@pytest.mark.parametrize("make", [_basic, _two_skills], ids=["pooled", "two-skills"])
def test_solvers_that_finish_agree_with_each_other_and_with_the_evaluator(make):
    results = {b: _solve(make, b)[1] for b in ("cpsat", "highs", "scip")}
    for b, res in results.items():
        assert res.status == "OPTIMAL" and res.scored, f"{b}: {res.status}"
        assert res.objective == pytest.approx(res.score, abs=1e-6), f"{b} reports {res.objective} but its roster is worth {res.score}: {[(t.name, t.value) for t in res.score_terms]}"
    scores = {b: r.score for b, r in results.items()}
    assert max(scores.values()) == pytest.approx(min(scores.values()), rel=0.0051), scores


def test_cpsat_objective_is_the_evaluators_even_with_every_term_in_play():
    """Exactly equal when the solve was taken to the end; otherwise the evaluator can only be lower (the model's own bookkeeping variables, such as which usual start a person has,
    are not always at their best values in a solution found before time ran out)."""
    r, res = _solve(_every_term, "cpsat")
    assert res.status in ("OPTIMAL", "FEASIBLE")
    if res.status == "OPTIMAL":
        assert res.objective == pytest.approx(res.score, abs=1e-6)
    else:
        assert res.score <= res.objective + 1e-6
    names = {t.name for t in res.score_terms}
    assert {"consistency", "preference", "cost"} <= names, f"the scenario should exercise several terms: {names}"


@pytest.mark.parametrize("backend", ["cpsat", "highs", "scip", "greedy"])
def test_a_backend_never_reports_less_than_its_roster_is_worth_and_obeys_the_hard_rules(backend):
    r, res = _solve(_every_term, backend)
    assert res.status in ("OPTIMAL", "FEASIBLE") and res.scored
    if backend != "greedy":
        assert res.score <= res.objective + 1e-6, "the evaluator is the truth: a solver can leave slack in its own figure, never find less"
    ts.check(r, res)


def test_the_evaluator_prices_what_coverage_alone_cannot_see():
    """Two rosters with the same cover: one uses the person the organisation would rather not use. Coverage alone calls them equal."""
    req = wfm_pb2.ScheduleRequest(days=1, first_dow=0, time_limit_sec=5, w_under=100, w_over=10, workers=1)
    req.required.extend([1 if 36 <= g < 68 else 0 for g in range(96)])
    for e in (1, 2):
        req.employees.add(id=e, max_week_slots=400, max_consecutive=5, rest_slots=0, max_days_week=5)
    req.options.add(employee=1, day=0, template=0, start_slot=36, length_slots=32, cost=0)
    req.options.add(employee=2, day=0, template=0, start_slot=36, length_slots=32, cost=700)
    emps, opts, required, carry, wp, total = scheduling.prepare(req)
    prep = (emps, opts, required, carry, wp, total, dict(week_offset=scheduling.week_offset, paid=scheduling.paid, week_target=scheduling.week_target, effective_mode=scheduling.effective_mode))
    cheap, dear = scoring.evaluate(req, prep, {0}), scoring.evaluate(req, prep, {1})
    assert backends.coverage_gaps(req, opts, {0}, required, total) == backends.coverage_gaps(req, opts, {1}, required, total)
    assert dear.total - cheap.total == 700 and dear.terms["cost"] == 700


def test_the_chain_keeps_the_better_roster_when_cover_is_a_tie(monkeypatch):
    req = wfm_pb2.ScheduleRequest(days=1, first_dow=0, time_limit_sec=5, w_under=100, w_over=10, workers=1, backend="cpsat,highs")
    req.required.extend([1 if 36 <= g < 68 else 0 for g in range(96)])
    for e in (1, 2):
        req.employees.add(id=e, max_week_slots=400, max_consecutive=5, rest_slots=0, max_days_week=5)
    req.options.add(employee=1, day=0, template=0, start_slot=36, length_slots=32, cost=700)
    req.options.add(employee=2, day=0, template=0, start_slot=36, length_slots=32, cost=0)
    emps, opts, required, carry, wp, total = scheduling.prepare(req)
    prep = (emps, opts, required, carry, wp, total, dict(week_offset=scheduling.week_offset, paid=scheduling.paid, week_target=scheduling.week_target, effective_mode=scheduling.effective_mode))

    def answer(i, backend, gap):
        return backends.respond(req, opts, {i}, required, total, "FEASIBLE", backend, 0.0)

    weak_dear = answer(0, "cpsat", 1.0)
    weak_dear.gap = 1.0                                              # a first answer that is only the starting roster, so the chain goes on
    monkeypatch.setitem(backends.BACKUPS, "highs", lambda *a, **k: answer(1, "highs", 0.0))
    best = backends.run_chain(req, prep, {0}, lambda: weak_dear, __import__("time").time())
    assert best.backend == "highs" and best.assignments[0].employee == 2, "the cheaper roster wins although the cover is identical"
    assert best.score < weak_dear.score


def test_a_big_gap_on_an_improved_roster_is_not_called_a_starting_roster(monkeypatch):
    """A gap of 100% or more only says the bound is hard to prove. The answer is called the starting roster only when it is no better than the start; otherwise the chain stops there."""
    req = wfm_pb2.ScheduleRequest(days=1, first_dow=0, time_limit_sec=5, w_under=100, w_over=10, workers=1, backend="cpsat,highs")
    req.required.extend([1 if 36 <= g < 68 else 0 for g in range(96)])
    for e in (1, 2):
        req.employees.add(id=e, max_week_slots=400, max_consecutive=5, rest_slots=0, max_days_week=5)
    req.options.add(employee=1, day=0, template=0, start_slot=36, length_slots=32, cost=700)
    req.options.add(employee=2, day=0, template=0, start_slot=36, length_slots=32, cost=0)
    emps, opts, required, carry, wp, total = scheduling.prepare(req)
    prep = (emps, opts, required, carry, wp, total, dict(week_offset=scheduling.week_offset, paid=scheduling.paid, week_target=scheduling.week_target, effective_mode=scheduling.effective_mode))
    ran = []
    monkeypatch.setitem(backends.BACKUPS, "highs", lambda *a, **k: ran.append("highs") or backends.respond(req, opts, {0}, required, total, "FEASIBLE", "highs", 0.0))
    better = backends.respond(req, opts, {1}, required, total, "FEASIBLE", "cpsat", 0.0)      # the start is employee 0 (dear); this is cheaper
    better.gap = 1.0
    best = backends.run_chain(req, prep, {0}, lambda: better, __import__("time").time())
    assert best.backend == "cpsat" and not ran, "an improved roster ends the chain, no backup is run"
    assert not any("starting roster only" in a for a in best.attempts), best.attempts
    same = backends.respond(req, opts, {0}, required, total, "FEASIBLE", "cpsat", 0.0)       # no better than the start
    same.gap = 1.0
    best = backends.run_chain(req, prep, {0}, lambda: same, __import__("time").time())
    assert any("cpsat: feasible (starting roster only)" in a for a in best.attempts) and ran, best.attempts


def test_an_unfinished_answer_is_still_priced_by_what_it_is_worth():
    r, res = _solve(_every_term, "highs")
    names = {t.name for t in res.score_terms}
    assert res.score == pytest.approx(sum(t.value for t in res.score_terms), abs=1e-3)
    assert names, "a score always says what it is made of"
