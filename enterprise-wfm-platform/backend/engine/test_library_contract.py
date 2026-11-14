"""What the engine relies on from its libraries, written down as tests. A library upgrade that breaks one of these fails here, not in production (see UPGRADING.md)."""
import importlib.metadata as md
import re
from pathlib import Path

import pytest

import wfm_pb2

PINS = dict(re.findall(r"^([A-Za-z0-9_.\-]+)==([^\s#]+)", (Path(__file__).parent / "requirements.txt").read_text(), flags=re.M))


def test_every_dependency_is_pinned_to_the_version_that_is_installed():
    assert {"ortools", "grpcio", "protobuf", "numpy", "scipy", "pandas", "statsmodels", "scikit-learn"} <= set(PINS), "an unpinned dependency"
    for name, version in PINS.items():
        assert md.version(name) == version, f"{name} {md.version(name)} is installed but requirements.txt pins {version}: follow UPGRADING.md"


def test_cp_sat_has_every_parameter_and_method_the_engine_uses():
    from ortools.sat.python import cp_model
    solver = cp_model.CpSolver()
    for name in ("max_time_in_seconds", "num_workers", "cp_model_presolve", "random_seed", "relative_gap_limit"):
        assert hasattr(solver.parameters, name), f"CP-SAT no longer has the parameter {name}"
    m = cp_model.CpModel()
    a, b = m.NewBoolVar("a"), m.NewBoolVar("b")
    n = m.NewIntVar(0, 5, "n")
    m.AddAtMostOne([a, b]); m.Add(n >= 2); m.AddHint(a, 1); m.Minimize(n + a)
    status = solver.Solve(m)
    assert solver.StatusName(status) == "OPTIMAL" and solver.ObjectiveValue() == 2 and solver.BestObjectiveBound() == 2
    assert solver.Value(n) == 2 and solver.Value(a) == 0
    assert hasattr(cp_model.CpSolverSolutionCallback, "StopSearch")


def test_the_backup_solvers_are_there_and_agree_on_a_reference_problem():
    import numpy as np
    from ortools.linear_solver import pywraplp
    from scipy import sparse
    from scipy.optimize import Bounds, LinearConstraint, milp
    # minimise x + 2y subject to x + y >= 3, both whole numbers 0..5: the answer is x=3, y=0, cost 3
    res = milp(c=np.array([1.0, 2.0]), constraints=LinearConstraint(sparse.csr_matrix([[1.0, 1.0]]), lb=3, ub=np.inf), bounds=Bounds(0, 5), integrality=np.ones(2))
    assert res.success and round(res.fun) == 3, "HiGHS (scipy.optimize.milp)"
    scip = pywraplp.Solver.CreateSolver("SCIP")
    assert scip is not None, "SCIP (ortools.linear_solver)"
    x, y = scip.IntVar(0, 5, "x"), scip.IntVar(0, 5, "y")
    scip.Add(x + y >= 3); scip.Minimize(x + 2 * y)
    assert scip.Solve() == pywraplp.Solver.OPTIMAL and round(scip.Objective().Value()) == 3


def test_the_generated_protocol_code_matches_the_proto_file():
    proto = (Path(__file__).parent.parent / "proto" / "wfm.proto").read_text()
    for message in ("ShiftOption", "SchedEmployee", "ScheduleRequest", "ScheduleResponse"):
        fields = re.search(rf"message {message} \{{(.*?)\n\}}", proto, flags=re.S).group(1)
        names = re.findall(r"^\s*(?:repeated\s+)?[A-Za-z0-9_]+\s+(\w+)\s*=\s*\d+;", fields, flags=re.M)
        generated = {f.name for f in getattr(wfm_pb2, message).DESCRIPTOR.fields}
        assert set(names) <= generated, f"{message}: {sorted(set(names) - generated)} are in wfm.proto but not in the generated code: regenerate (see UPGRADING.md)"
