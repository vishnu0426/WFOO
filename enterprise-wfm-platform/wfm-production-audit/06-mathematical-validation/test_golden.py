"""Golden (known-answer) tests and cross-checks of the application's maths against wfm_math.py.

Run:  python -m pytest -q wfm-production-audit/06-mathematical-validation
Writes results.csv next to this file: case, formula, inputs, expected, actual, diff, tolerance, result.
"""
from __future__ import annotations

import csv
import json
import math
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(HERE))
import wfm_math as M  # noqa: E402

ROWS: list[dict] = []


def record(case, formula, inputs, expected, actual, tol, source):
    diff = None if expected is None or actual is None or (isinstance(expected, float) and math.isinf(expected)) else abs(expected - actual)
    ok = (expected == actual) if diff is None else diff <= tol
    ROWS.append({"case": case, "formula": formula, "source": source, "inputs": json.dumps(inputs), "expected": expected,
                 "actual": actual, "diff": diff, "tolerance": tol, "result": "PASS" if ok else "FAIL"})
    return ok


@pytest.fixture(scope="session", autouse=True)
def _write_results():
    yield
    with open(HERE / "results.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(ROWS[0].keys()) if ROWS else ["case"])
        w.writeheader()
        w.writerows(ROWS)


# ---------- 1. hand-calculated golden values (exact fractions worked on paper) ----------

GOLDEN = [
    # case, formula, fn, args, expected, tol
    ("G-EC-01", "ErlangC(N=2,A=1) = 1/3", M.erlang_c, (2, 1.0), 1 / 3, 1e-12),
    ("G-EC-02", "ErlangC(N=3,A=2) = 4/9", M.erlang_c, (3, 2.0), 4 / 9, 1e-12),
    ("G-EC-03", "ErlangC(N=1,A=0.5) = 0.5 (M/M/1: rho)", M.erlang_c, (1, 0.5), 0.5, 1e-12),
    ("G-EC-04", "ErlangC(N<=A) = 1 (unstable)", M.erlang_c, (5, 5.0), 1.0, 0),
    ("G-SL-01", "SL(N=2,A=1,AHT=180,T=20) = 1 - exp(-1/9)/3", M.service_level, (2, 1.0, 180, 20), 1 - math.exp(-20 / 180) / 3, 1e-12),
    ("G-SL-02", "SL unstable = 0", M.service_level, (4, 4.0, 180, 20), 0.0, 0),
    ("G-ASA-01", "ASA(N=2,A=1,AHT=180) = 60 s", M.asa, (2, 1.0, 180), 60.0, 1e-9),
    ("G-ASA-02", "ASA(N=3,A=2,AHT=300) = 4/9*300 = 133.33 s", M.asa, (3, 2.0, 300), 400 / 3, 1e-9),
    ("G-TR-01", "A = 100 calls * 180 s / 1800 s = 10 E", M.offered_traffic, (100, 180, 1800), 10.0, 1e-12),
    ("G-TR-02", "zero contacts -> A = 0", M.offered_traffic, (0, 180, 1800), 0.0, 0),
    ("G-WL-01", "Workload = 400 * 270 / 3600 = 30 h", M.workload_hours, (400, 270), 30.0, 1e-12),
    ("G-GS-01", "Gross = 80 / 0.75 = 106.667", M.gross_staff, (80, 0.25), 80 / 0.75, 1e-9),
    ("G-GS-02", "Gross with 0% shrinkage = net", M.gross_staff, (80, 0.0), 80.0, 0),
    ("G-OC-01", "Occupancy = 10 / 12", M.occupancy, (10.0, 12), 10 / 12, 1e-12),
    ("G-FTE-01", "FTE = 1500 / 37.5 = 40", M.fte, (1500, 37.5), 40.0, 1e-12),
    ("G-AHT-01", "AHT = (3000+600+900)/20 = 225 s", M.aht, (3000, 600, 900, 20), 225.0, 1e-12),
    ("G-SH-01", "Shrinkage = 120/480 = 25%", M.shrinkage, (120, 480), 0.25, 1e-12),
    ("G-ADH-01", "Adherence = 432/480 = 90%", M.adherence, (432, 480), 90.0, 1e-12),
]


@pytest.mark.parametrize("case,formula,fn,args,expected,tol", GOLDEN, ids=[g[0] for g in GOLDEN])
def test_golden(case, formula, fn, args, expected, tol):
    assert record(case, formula, list(args), expected, fn(*args), tol, "independent")


A = [100, 120, 80, 0, 50]
F = [110, 100, 80, 10, 40]


def test_error_metrics_known_answers():
    # |err| = 10,20,0,10,10 -> 50 ; sum actual 350 ; signed f-a = 10,-20,0,10,-10 = -10
    assert record("G-WAPE-01", "WAPE = 50/350", {"a": A, "f": F}, 100 * 50 / 350, M.wape(A, F), 1e-12, "independent")
    assert record("G-ACC-01", "Accuracy = 100 - WAPE", {"a": A, "f": F}, 100 - 100 * 50 / 350, M.accuracy_from_wape(A, F), 1e-12, "independent")
    m, skipped = M.mape(A, F)   # non-zero: 10/100, 20/120, 0, 10/50 over 4 points
    assert skipped == 1
    assert record("G-MAPE-01", "MAPE skips zero actuals", {"a": A, "f": F}, 100 * (0.1 + 20 / 120 + 0 + 0.2) / 4, m, 1e-12, "independent")
    assert record("G-MAE-01", "MAE = 50/5", {"a": A, "f": F}, 10.0, M.mae(A, F), 1e-12, "independent")
    assert record("G-RMSE-01", "RMSE = sqrt(700/5)", {"a": A, "f": F}, math.sqrt(700 / 5), M.rmse(A, F), 1e-12, "independent")
    assert record("G-BIAS-01", "Bias = -10/350 (under-forecast)", {"a": A, "f": F}, -100 * 10 / 350, M.bias(A, F), 1e-12, "independent")
    assert M.wape([0, 0], [1, 2]) is None, "WAPE with zero actual volume must be undefined, not a division by zero"


@pytest.mark.parametrize("bad", [
    lambda: M.gross_staff(80, 1.0),      # 100% shrinkage
    lambda: M.gross_staff(80, -0.1),
    lambda: M.offered_traffic(-1, 180, 1800),
    lambda: M.aht(10, 0, 0, 0),
])
def test_invalid_inputs_are_refused(bad):
    with pytest.raises(ValueError):
        bad()


def test_rollups():
    intervals = [[3, 5, 7, 0] * 24 for _ in range(7)]  # 96 x 15-min slots a day
    days = [M.rollup(d) for d in intervals]
    assert record("G-ROLL-01", "daily = sum(intervals)", {}, 15 * 24, days[0], 0, "independent")
    assert record("G-ROLL-02", "weekly = sum(daily)", {}, 15 * 24 * 7, M.rollup(days), 0, "independent")


# ---------- 2. application engine (Python) vs independent ----------

ENGINE = REPO / "backend" / "engine"
GRID = [(n, a) for a in (0.5, 1.0, 2.5, 7.3, 10.0, 24.0, 55.5, 120.0, 400.0) for n in range(max(1, math.floor(a) + 1), math.floor(a) + 12)]


def _engine():
    sys.path.insert(0, str(ENGINE))
    try:
        import staffing  # type: ignore
    except Exception as e:  # pragma: no cover
        pytest.skip(f"engine staffing.py not importable here: {e}")
    return staffing


def test_engine_erlang_c_matches():
    s = _engine()
    bad = 0
    for n, a in GRID:
        ok = record(f"X-ENG-C-{n}-{a}", "engine erlang_c_wait_prob vs independent", {"n": n, "a": a}, M.erlang_c(n, a), s.erlang_c_wait_prob(n, a), 1e-9, "engine/staffing.py")
        bad += not ok
    assert bad == 0


def test_engine_sl_asa_match():
    s = _engine()
    bad = 0
    for n, a in GRID:
        sl, q, _ = s.erlang_c_metrics(n, a, 240.0, 20)
        bad += not record(f"X-ENG-SL-{n}-{a}", "engine SL(T=20,AHT=240)", {"n": n, "a": a}, M.service_level(n, a, 240, 20), sl, 1e-9, "engine/staffing.py")
        bad += not record(f"X-ENG-ASA-{n}-{a}", "engine ASA(AHT=240)", {"n": n, "a": a}, M.asa(n, a, 240), q, 1e-6, "engine/staffing.py")
    assert bad == 0


@pytest.mark.parametrize("cph,aht_s,target,t", [(0, 180, .8, 20), (10, 180, .8, 20), (360, 240, .8, 20), (1200, 300, .9, 15), (5000, 420, .8, 30), (60, 3600, .95, 60)])
def test_engine_required_agents(cph, aht_s, target, t):
    s = _engine()
    exp = M.required_agents(cph, aht_s, 3600, target, t)
    assert record(f"X-ENG-REQ-{cph}-{aht_s}", "engine required_agents (hourly)", {"cph": cph, "aht": aht_s, "sl": target, "t": t}, exp, s.required_agents(cph, aht_s, target, t), 0, "engine/staffing.py")


def test_engine_solve_with_occupancy_cap():
    s = _engine()

    class P:  # minimal ChannelParams stand-in
        service_level, answer_sec, occupancy_cap, patience_sec, chat_efficiency = 0.8, 20, 0.85, 120, 0
    bad = 0
    for a in (3.0, 9.5, 40.0, 150.0):
        n = s.solve_agents(a, 240, P, "erlang_c")[0]
        exp = M.required_agents(a * 1800 / 240, 240, 1800, 0.8, 20, max_occupancy=0.85)
        bad += not record(f"X-ENG-OCC-{a}", "engine solve_agents w/ 85% occupancy cap", {"a": a}, exp, n, 0, "engine/staffing.py")
    assert bad == 0


# ---------- 3. gateway (TypeScript) erlang.ts vs independent ----------

def test_gateway_erlang_ts_matches():
    node = shutil.which("node")
    tsx = REPO / "backend" / "gateway" / "node_modules" / ".bin" / ("tsx.cmd" if os.name == "nt" else "tsx")
    if not node or not tsx.exists():
        pytest.skip("node/tsx not available")
    script = HERE / "_erlang_probe.ts"
    script.write_text(
        "import { waitProbability, erlangC } from '../../backend/gateway/src/modules/erlang.ts';\n"
        f"const grid = {json.dumps(GRID)};\n"
        "console.log(JSON.stringify(grid.map(([n,a]) => [n, a, waitProbability(n,a), erlangC(n,a,240,20)])));\n")
    try:
        out = subprocess.run([str(tsx), str(script)], capture_output=True, text=True, timeout=120, cwd=str(REPO / "backend" / "gateway"), shell=os.name == "nt")
    finally:
        script.unlink(missing_ok=True)
    if out.returncode != 0:
        pytest.fail(out.stderr[-2000:])
    bad = 0
    for n, a, pw, r in json.loads(out.stdout.strip().splitlines()[-1]):
        bad += not record(f"X-GW-C-{n}-{a}", "gateway waitProbability", {"n": n, "a": a}, M.erlang_c(n, a), pw, 1e-9, "gateway/erlang.ts")
        bad += not record(f"X-GW-SL-{n}-{a}", "gateway erlangC().sl", {"n": n, "a": a}, M.service_level(n, a, 240, 20), r["sl"], 1e-9, "gateway/erlang.ts")
    assert bad == 0
