"""The engine checks every roster it returns.

The validator (validator.py) shares nothing with the solvers. Here a finished roster, with the request it answers, is turned into a validation request and judged by it, so that:
  * the Schedule call itself carries the verdict (`ScheduleResponse.verdict`): a caller is never handed a roster without one;
  * the solver chain refuses a backend whose roster breaks a hard rule and tries the next one, so a backend that does not really implement a rule can never win by ignoring it;
  * a roster that no backend can make valid is still returned, honestly marked INVALID, never as a good answer.
ENGINE_VERIFY=0 turns the check off (the response then says it was not checked, and the gateway will not publish it).
"""
import os
import time

import wfm_pb2
import validator
from coverage import consistency_mode

VERIFY = os.environ.get("ENGINE_VERIFY", "1") != "0"
MAX_SHIFTS = int(os.environ.get("ENGINE_VERIFY_MAX_SHIFTS", "400000"))      # beyond this the check is skipped, and said to be (the gateway's own check still runs before publishing)
MAX_FINDINGS = 20


def to_validate_request(req, res):
    """The roster `res` (assignments) answering the scheduling request `req`, as the validator wants it."""
    v = wfm_pb2.ValidateRequest(days=req.days, first_dow=req.first_dow, week_start=req.week_start, weekend_mask=req.weekend_mask, wrap=req.wrap, target_coverage=0.0,
                                consistency_mode=req.consistency_mode, start_tol_slots=req.start_tol_slots, end_tol_slots=req.end_tol_slots)
    v.required.extend(req.required)
    v.dst_rest_adjust.extend(req.dst_rest_adjust)
    for sk in req.skill_requirements:
        v.skill_requirements.add(id=sk.id).required.extend(sk.required)
    for e in req.employees:
        ve = v.employees.add(allow_overnight=True, allow_weekend=True, name=f"employee {e.id}")
        ve.limits.CopyFrom(e)
    option_of = {(o.employee, o.day, o.template, o.start_slot, o.length_slots): o for o in req.options}
    for a in res.assignments:
        o = option_of.get((a.employee, a.day, a.template, a.start_slot, a.length_slots))
        s = v.shifts.add(employee=a.employee, day=a.day, start_slot=a.start_slot, length_slots=a.length_slots, ref=f"{a.employee}:{a.day}")
        if o is not None:
            s.paid_slots, s.unsocial = o.paid_slots, o.unsocial
            if o.gap_slots > 0:                                  # an unpaid meal, or the gap of a split shift: on shift, answering nothing
                s.activities.add(type="MEAL", start_slot=o.gap_start_slot, slots=o.gap_slots, explicit=True, paid=False, productive=False)
    return v


def check(req, res):
    """The validator's verdict on a roster (a ScheduleVerdict). Never raises: a check that cannot run says so, and such a roster is not publishable."""
    if not VERIFY:
        return wfm_pb2.ScheduleVerdict(checked=False, note="the engine's own check is switched off (ENGINE_VERIFY=0)")
    if len(res.assignments) > MAX_SHIFTS:
        return wfm_pb2.ScheduleVerdict(checked=False, note=f"{len(res.assignments):,} shifts is more than the engine checks in the answer itself ({MAX_SHIFTS:,}); validate it separately")
    t0 = time.time()
    try:
        r = validator.validate(to_validate_request(req, res))
    except Exception as e:                                       # a bug in the check must not look like a pass
        return wfm_pb2.ScheduleVerdict(checked=False, note=f"the check could not run: {type(e).__name__}: {str(e)[:200]}")
    out = wfm_pb2.ScheduleVerdict(checked=True, valid=r.valid, status=r.status, coverage_status=r.coverage_status, hard_violations=r.hard_violations, soft_warnings=r.soft_warnings,
                                  note=f"checked in {time.time() - t0:.2f}s")
    out.findings.extend([f for f in r.findings if f.severity == "HARD"][:MAX_FINDINGS])
    return out


def attach(req, res):
    """Put the verdict on the response. Returns it."""
    res.verdict.CopyFrom(check(req, res))
    return res.verdict


def first_problem(v):
    return v.findings[0].message if len(v.findings) else "a rule was broken"
