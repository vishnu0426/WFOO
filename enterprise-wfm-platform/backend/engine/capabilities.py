"""Which rules each solver honours, so that no solver is offered as an equivalent of the others until it really is.

A request uses a set of rules (skill demand, a required usual start and end, a repeating period, overtime pricing, weekend fairness, hours worked for other groups, clock changes,
split shifts and meals, what was worked just before the period). Each solver declares the rules it implements. A solver asked for a request that uses a rule it does not declare is
not used: the chain says so and goes on to one that does. The built-in solvers share one model (CP-SAT) or its linear form (HiGHS, SCIP) or the greedy roster, and the parity tests hold
them to each other; Timefold runs as a separate service and tells the engine, at /capabilities, what it implements. Whatever a solver declares, its roster is also checked by the
validator before it can be returned as a good answer (see verdict.py).
"""
import json
import os
import time
import urllib.request

ALL_RULES = ("skills", "consistency_required", "consistency_preferred", "wrap", "overtime", "fairness", "external_hours", "dst_rest", "gaps", "history", "option_cost")
NATIVE = frozenset(ALL_RULES)
DECLARED = {"cpsat": NATIVE, "highs": NATIVE, "scip": NATIVE, "greedy": NATIVE}
_cache = {}                                        # url -> (time, rules or None, note)
CACHE_SEC = 60.0


def rules_used(req):
    """The rules this request makes the solver honour."""
    used = set()
    if len(req.skill_requirements):
        used.add("skills")
    from coverage import consistency_mode
    modes = {consistency_mode(req.consistency_mode, e.consist_mode) for e in req.employees} if len(req.employees) else {req.consistency_mode}
    if 2 in modes:
        used.add("consistency_required")
    if 1 in modes:
        used.add("consistency_preferred")
    if req.wrap:
        used.add("wrap")
    if req.w_overtime > 0:
        used.add("overtime")
    if req.w_fair > 0:
        used.add("fairness")
    if any(any(v > 0 for v in e.ext_paid) for e in req.employees):
        used.add("external_hours")
    if any(v != 0 for v in req.dst_rest_adjust):
        used.add("dst_rest")
    if any(o.gap_slots > 0 for o in req.options):
        used.add("gaps")
    if any(e.prior_run or e.prior_has_end or e.prior_week_slots or e.prior_week_days or e.prior_weekend for e in req.employees):
        used.add("history")
    if any(o.cost for o in req.options):
        used.add("option_cost")
    return used


def timefold_declared(url, now=None):
    """(rules the Timefold service declares, or None, note). Asked at {url}/capabilities and remembered for a minute."""
    now = time.time() if now is None else now
    hit = _cache.get(url)
    if hit and now - hit[0] < CACHE_SEC:
        return hit[1], hit[2]
    try:
        with urllib.request.urlopen(url.rstrip("/") + "/capabilities", timeout=5) as f:
            body = json.loads(f.read())
        rules = frozenset(r for r in body.get("rules", []) if r in ALL_RULES)
        note = f"Timefold {body.get('version', '')}".strip()
    except Exception as e:
        rules, note = None, f"Timefold could not be reached for its capabilities ({type(e).__name__})"
    _cache[url] = (now, rules, note)
    return rules, note


def missing(name, req):
    """Rules the request needs that this solver does not declare (empty: it can be used). A solver the engine does not know is never missing anything here (it fails on its own)."""
    need = rules_used(req)
    if name == "timefold":
        url = os.environ.get("TIMEFOLD_URL")
        if not url:
            return ["a configured service (TIMEFOLD_URL is not set)"]
        rules, note = timefold_declared(url)
        if rules is None:
            return [note]
        return sorted(need - rules)
    have = DECLARED.get(name)
    return sorted(need - have) if have is not None else []
