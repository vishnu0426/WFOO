"""A request can be followed from the caller into the engine's logs, and what the engine did shows in its metrics."""
import json
from concurrent import futures

import grpc
import pytest

import observe
import scheduling
import server
import wfm_pb2
import wfm_pb2_grpc
from test_validation import good


@pytest.fixture()
def engine():
    srv = grpc.server(futures.ThreadPoolExecutor(max_workers=4))
    wfm_pb2_grpc.add_EngineServicer_to_server(server.Engine(), srv)
    port = srv.add_insecure_port("127.0.0.1:0")
    srv.start()
    chan = grpc.insecure_channel(f"127.0.0.1:{port}")
    yield wfm_pb2_grpc.EngineStub(chan)
    chan.close()
    srv.stop(0)


def test_the_callers_request_and_trace_ids_appear_in_the_engines_log(engine, capsys, monkeypatch):
    monkeypatch.setenv("ENGINE_LOG_FORMAT", "json")
    tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
    req = good(days=1)
    req.backend = "greedy"
    engine.Schedule(req, metadata=(("x-request-id", "req-abc-123"), ("traceparent", tp)))
    lines = [json.loads(l) for l in capsys.readouterr().out.splitlines() if l.startswith("{")]
    done = [l for l in lines if l["msg"] == "solve finished"]
    assert done and done[0]["requestId"] == "req-abc-123" and done[0]["traceId"] == "4bf92f3577b34da6a3ce929d0e0e4736", lines
    assert done[0]["status"] in ("OPTIMAL", "FEASIBLE") and done[0]["backend"] == "greedy"


def test_the_stream_logs_under_the_callers_id_too(engine, capsys):
    req = good(days=1)
    req.backend = "greedy"
    events = list(engine.ScheduleStream(req, metadata=(("x-request-id", "job-77"),)))
    assert events[-1].done
    out = capsys.readouterr().out
    assert "rid=job-77" in out and "solve finished" in out


def test_a_request_the_engine_cannot_use_is_refused_with_the_reason(engine):
    req = good()
    req.options[0].employee = 99
    with pytest.raises(grpc.RpcError) as e:
        engine.Schedule(req)
    assert e.value.code() == grpc.StatusCode.INVALID_ARGUMENT and "employee 99 is not in the request" in e.value.details()


def test_what_the_engine_did_is_in_its_metrics():
    before = scheduling.SOLVE_SECONDS["count"]
    req = good(days=1)
    req.backend = "greedy"
    scheduling.solve(req)
    text = scheduling.metrics_text()
    assert scheduling.SOLVE_SECONDS["count"] == before + 1
    assert 'wfm_engine_solves_total{backend="greedy",status="FEASIBLE"}' in text or 'wfm_engine_solves_total{backend="greedy",status="OPTIMAL"}' in text
    assert "wfm_engine_solve_seconds_bucket" in text and "wfm_engine_solver_process_timeouts_total" in text


def test_text_logs_stay_readable(capsys, monkeypatch):
    monkeypatch.delenv("ENGINE_LOG_FORMAT", raising=False)
    observe.bind("r1", None)
    observe.log("hello", n=3)
    assert capsys.readouterr().out.strip() == "[engine] rid=r1 hello n=3"
