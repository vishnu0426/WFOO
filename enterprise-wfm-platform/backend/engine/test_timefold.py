"""Timefold, run for real: the Java service is started, the engine sends it the compiled problem, and what comes back is judged by the engine's validator and scorer like any other
solver's roster. Skipped (with the reason) only when there is no Java or the service has not been built (`mvn package` in backend/timefold-service)."""
import json
import os
import shutil
import socket
import subprocess
import time
import urllib.request

import pytest

import capabilities
import scheduling
import test_scheduling as ts
import wfm_pb2

HERE = os.path.dirname(os.path.abspath(__file__))
JAR = os.environ.get("TIMEFOLD_JAR") or os.path.join(HERE, "..", "timefold-service", "target", "timefold-service.jar")


def _java():
    home = os.environ.get("TIMEFOLD_JAVA_HOME") or os.environ.get("JAVA_HOME")
    if home and os.path.exists(os.path.join(home, "bin", "java.exe" if os.name == "nt" else "java")):
        return os.path.join(home, "bin", "java.exe" if os.name == "nt" else "java")
    return shutil.which("java")


@pytest.fixture(scope="module")
def service():
    java = _java()
    if not java:
        pytest.skip("no Java on this machine (set JAVA_HOME or TIMEFOLD_JAVA_HOME)")
    if not os.path.exists(JAR):
        pytest.skip(f"the service is not built ({JAR}): run mvn package in backend/timefold-service")
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    env = dict(os.environ, PORT=str(port), BIND="127.0.0.1", TIMEFOLD_TOKEN="secret")
    log = open(os.environ.get("TIMEFOLD_TEST_LOG", os.devnull), "wb")
    proc = subprocess.Popen([java, "-Xmx1g", "-jar", JAR], env=env, stdout=log, stderr=subprocess.STDOUT)
    url = f"http://127.0.0.1:{port}"
    try:
        for _ in range(100):
            try:
                urllib.request.urlopen(url + "/health", timeout=1)
                break
            except Exception:
                if proc.poll() is not None:
                    pytest.fail("the service stopped (see TIMEFOLD_TEST_LOG)")
                time.sleep(0.3)
        else:
            pytest.fail("the service did not start")
        old = {k: os.environ.get(k) for k in ("TIMEFOLD_URL", "TIMEFOLD_TOKEN")}
        os.environ["TIMEFOLD_URL"], os.environ["TIMEFOLD_TOKEN"] = url, "secret"
        capabilities._cache.clear()
        yield url
    finally:
        for k, v in old.items() if "old" in dir() else []:
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        capabilities._cache.clear()
        proc.terminate()
        try:
            proc.wait(10)
        except Exception:
            proc.kill()


def _tf(req, limit=10):
    req.backend = "timefold,greedy"
    req.time_limit_sec = limit
    return scheduling.solve(req)


def test_the_service_declares_the_rules_it_implements_and_not_the_ones_it_does_not(service):
    caps = json.loads(urllib.request.urlopen(service + "/capabilities").read())
    assert "fairness" in caps["rules"] and "consistency_required" in caps["rules"] and "Community" in caps["version"]
    assert "skills" not in caps["rules"] and "consistency_preferred" not in caps["rules"]
    plain = ts.build(n_emp=6, days=7)
    assert capabilities.missing("timefold", plain) == []
    skills = ts.build(n_emp=6, days=7)
    skills.skill_requirements.add(id=1, required=list(skills.required))
    assert capabilities.missing("timefold", skills) == ["skills"]


def test_a_request_without_the_token_is_refused(service):
    r = urllib.request.Request(service + "/solve", data=b"{}", headers={"Content-Type": "application/json"})
    with pytest.raises(urllib.error.HTTPError) as e:
        urllib.request.urlopen(r)
    assert e.value.code == 401


def test_timefold_builds_a_roster_that_obeys_every_rule_and_the_engine_accepts_it(service):
    req = ts.build(n_emp=10, days=7)
    res = _tf(req)
    assert res.backend == "timefold", res.attempts
    assert res.verdict.checked and res.verdict.valid, [f.message for f in res.verdict.findings]
    ts.check(req, res)
    assert res.scored


def test_its_roster_is_close_to_what_cpsat_finds(service):
    req = ts.build(n_emp=10, days=7)
    res = _tf(req, 15)
    ref = ts.build(n_emp=10, days=7)
    ref.backend = "cpsat"
    ref.time_limit_sec = 10
    best = scheduling.solve(ref)
    assert res.backend == "timefold" and res.score <= best.score * 1.35 + 500, (res.score, best.score, res.attempts)


def _rich():
    r = ts.build(n_emp=10, days=14, weekend=True)
    r.w_overtime, r.w_consist, r.consistency_mode, r.start_tol_slots, r.end_tol_slots = 40, 200, 2, 4, 4
    for i, o in enumerate(r.options):
        if i % 5 == 0:
            o.preference = 1
        if o.day == 3:
            o.unsocial, o.cost = True, 300
    return r


def test_with_required_consistency_overtime_fairness_and_priced_holidays_the_roster_is_still_valid(service):
    req = _rich()
    res = _tf(req, 20)
    assert res.backend == "timefold", res.attempts
    assert res.verdict.valid, [f.message for f in res.verdict.findings]
    starts = {}
    for a in res.assignments:
        starts.setdefault(a.employee, set()).add(a.start_slot)
    assert all(max(s) - min(s) <= 8 for s in starts.values()), starts


def test_work_for_other_groups_and_the_run_before_the_period_are_honoured(service):
    req = ts.build(n_emp=8, days=7)
    for e in req.employees:
        e.prior_run = 3
        e.ext_paid.extend([0, 0, 28, 0, 0, 0, 0] if e.id % 2 else [0] * 7)
    keep = [o for o in req.options if not (req.employees[o.employee].ext_paid and req.employees[o.employee].ext_paid[o.day])]
    del req.options[:]
    req.options.extend(keep)
    res = _tf(req, 12)
    assert res.backend == "timefold", res.attempts
    assert res.verdict.valid, [f.message for f in res.verdict.findings]


def test_a_request_that_needs_a_rule_it_does_not_implement_never_reaches_it(service):
    req = ts.build(n_emp=6, days=7)
    req.skill_requirements.add(id=1, required=list(req.required))
    for e in req.employees:
        e.skill_ids.append(1)
    res = _tf(req)
    assert res.backend != "timefold" and any("timefold: not used, it does not implement skills" in n for n in res.capability_notes), res.capability_notes
    prefer = ts.build(n_emp=6, days=7)
    prefer.consistency_mode = 1
    res = _tf(prefer)
    assert res.backend != "timefold" and any("consistency_preferred" in n for n in res.capability_notes)
