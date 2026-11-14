"""The engine as a service: startup settings, message limits, TLS, deadlines and cancellation, through a real gRPC connection."""
import ast
import dataclasses
import datetime
import ipaddress
import time
from contextlib import contextmanager
from pathlib import Path

import grpc
import pytest

import engine_config
import forecasting
import scheduling
import server as server_mod
import wfm_pb2
import wfm_pb2_grpc

HERE = Path(__file__).resolve().parent


# ---------------------------------------------------------------- startup settings

def test_the_env_file_fills_only_what_the_shell_did_not_set(tmp_path):
    f = tmp_path / ".env"
    f.write_text("ENGINE_ADDR=10.0.0.5:6000  # the engine\nENGINE_MAX_SOLVES=\"3\"\n# a comment\nOTHER=x\n")
    env = {"ENGINE_MAX_SOLVES": "9"}
    assert sorted(engine_config.load_env_file(f, env)) == ["ENGINE_ADDR", "OTHER"]
    assert env["ENGINE_ADDR"] == "10.0.0.5:6000" and env["ENGINE_MAX_SOLVES"] == "9", "a real environment variable wins over the file"


def test_the_env_file_is_read_before_any_module_that_reads_its_limits_from_the_environment():
    tree = ast.parse((HERE / "server.py").read_text(encoding="utf-8"))
    ours = {p.stem for p in HERE.glob("*.py")}
    imports = [n.names[0].name for n in tree.body if isinstance(n, ast.Import) and n.names[0].name in ours]
    assert imports[0] == "engine_config", f"the first of our own modules imported is {imports[0]}"


def test_every_unusable_setting_is_reported_at_once():
    with pytest.raises(engine_config.ConfigError) as e:
        engine_config.load({"ENGINE_MAX_SOLVES": "lots", "ENGINE_GRPC_THREADS": "-4", "ENGINE_ADDR": "nonsense", "ENGINE_DRAIN_SEC": "9999999"})
    text = str(e.value)
    for needle in ("ENGINE_MAX_SOLVES", "ENGINE_GRPC_THREADS", "ENGINE_ADDR", "ENGINE_DRAIN_SEC"):
        assert needle in text
    assert text.count("ENGINE_MAX_SOLVES") == 1, "a setting is reported once"


def test_a_reachable_engine_without_tls_is_refused_unless_it_is_explicitly_allowed(tmp_path):
    with pytest.raises(engine_config.ConfigError, match="no TLS"):
        engine_config.load({"ENGINE_ADDR": "0.0.0.0:50051"})
    assert engine_config.load({"ENGINE_ADDR": "0.0.0.0:50051", "ENGINE_ALLOW_INSECURE": "1"}).host == "0.0.0.0"
    assert engine_config.load({"ENGINE_ADDR": "127.0.0.1:50051"}).loopback
    cert, key = tmp_path / "c.pem", tmp_path / "k.pem"
    cert.write_text("x")
    key.write_text("x")
    s = engine_config.load({"ENGINE_ADDR": "0.0.0.0:50051", "ENGINE_TLS_CERT": str(cert), "ENGINE_TLS_KEY": str(key)})
    assert s.secure
    with pytest.raises(engine_config.ConfigError, match="go together"):
        engine_config.load({"ENGINE_TLS_CERT": str(cert)})
    with pytest.raises(engine_config.ConfigError, match="no file"):
        engine_config.load({"ENGINE_TLS_CERT": str(cert), "ENGINE_TLS_KEY": str(tmp_path / "missing.pem")})
    with pytest.raises(engine_config.ConfigError, match="ENGINE_REQUIRE_TLS"):
        engine_config.load({"ENGINE_REQUIRE_TLS": "1"})


def test_message_limits_are_finite_by_default():
    assert 0 < engine_config.load({}).max_message_bytes <= 1024 * 1024 * 1024


# ---------------------------------------------------------------- a real server

def _cfg(**over):
    return dataclasses.replace(engine_config.load({}), port=0, metrics_port=0, **over)


@contextmanager
def serving(cfg):
    previous = server_mod._SETTINGS
    server_mod._SETTINGS = cfg
    srv, port = server_mod.build_server(cfg, 16, 64)
    srv.start()
    try:
        yield port
    finally:
        srv.stop(0)
        server_mod._SETTINGS = previous


def _stub(port, creds=None):
    ch = grpc.secure_channel(f"localhost:{port}", creds) if creds else grpc.insecure_channel(f"127.0.0.1:{port}")
    return wfm_pb2_grpc.EngineStub(ch)


def _staffing(n_inputs=1):
    r = wfm_pb2.StaffingRequest(interval_min=15, shrinkage=0.25)
    r.params.add(channel="voice", service_level=0.8, answer_sec=20)
    for k in range(n_inputs):
        r.inputs.add(channel="voice", day="2026-12-07", slot=k % 96, volume=100, aht_sec=300)
    return r


def _schedule():
    req = wfm_pb2.ScheduleRequest(days=1, first_dow=0, time_limit_sec=5, w_under=100, w_over=1, workers=2)
    req.required.extend([1 if 36 <= g < 68 else 0 for g in range(96)])
    req.employees.add(id=1, max_week_slots=400, max_consecutive=5, rest_slots=0, max_days_week=5)
    req.options.add(employee=1, day=0, template=0, start_slot=36, length_slots=32)
    return req


def _code(call):
    with pytest.raises(grpc.RpcError) as e:
        call()
    return e.value.code(), e.value.details() or ""


def test_a_request_larger_than_the_message_limit_is_refused():
    with serving(_cfg(max_message_bytes=1024 * 1024)) as port:
        assert _stub(port).Staffing(_staffing(10)).out
        code, _ = _code(lambda: _stub(port).Staffing(_staffing(60_000)))
        assert code == grpc.StatusCode.RESOURCE_EXHAUSTED


def test_requests_that_cannot_be_answered_say_why_over_the_wire():
    with serving(_cfg()) as port:
        s = _stub(port)
        bad = _staffing()
        bad.params[0].occupancy_cap = 1.3
        code, why = _code(lambda: s.Staffing(bad))
        assert code == grpc.StatusCode.INVALID_ARGUMENT and "occupancy limit" in why
        many = wfm_pb2.SeriesRequest(slots_per_day=96)
        many.dates.append("2026-12-07")
        for q in range(300):
            many.queues.add(queue_id=q + 1, channel="voice")
        code, why = _code(lambda: s.ForecastSeries(many))
        assert code == grpc.StatusCode.INVALID_ARGUMENT and "300 queues" in why
        sim = wfm_pb2.SimRequest(replications=100000)
        sim.intervals.add(volume=10, aht_sec=300, agents=3)
        code, _ = _code(lambda: s.Simulate(sim))
        assert code == grpc.StatusCode.RESOURCE_EXHAUSTED
        long_ = wfm_pb2.SimRequest()
        for _ in range(96 * 61):
            long_.intervals.add(volume=1, aht_sec=60, agents=1)
        assert _code(lambda: s.Simulate(long_))[0] == grpc.StatusCode.RESOURCE_EXHAUSTED


def test_the_simulation_uses_the_interval_length_it_is_given():
    sim = wfm_pb2.SimRequest(replications=40, seed=3, answer_sec=20, patience_sec=120, slots_per_day=48)
    for _ in range(48):
        sim.intervals.add(volume=60, aht_sec=300, agents=16)          # 60 calls of 5 minutes in an interval: 10 Erlangs in 30 minutes, 16 agents
    with serving(_cfg()) as port:
        sim.interval_sec = 1800
        half_hour = _stub(port).Simulate(sim)
        sim.slots_per_day = 96
        sim.interval_sec = 900                                       # the same volume squeezed into 15 minutes: twice the load
        quarter = _stub(port).Simulate(sim)
    assert quarter.occupancy > half_hour.occupancy * 1.4
    assert quarter.sl_mean < half_hour.sl_mean


def test_a_forecast_that_cannot_finish_in_time_is_a_deadline_error_and_drops_its_pool(monkeypatch):
    class Slow:
        def map(self, *a, **k):
            raise TimeoutError()

        def shutdown(self, **k):
            Slow.closed = True
    monkeypatch.setattr(forecasting, "_get_pool", lambda: Slow())
    monkeypatch.setattr(forecasting, "_pool", None, raising=False)
    req = wfm_pb2.SeriesRequest(slots_per_day=0, model="snaive")
    for d in range(10):
        req.dates.append((datetime.date(2026, 12, 7) + datetime.timedelta(days=d)).isoformat())
    for q in (1, 2):
        s = req.queues.add(queue_id=q, channel="voice")
        for d in range(60):
            s.daily.add(day=(datetime.date(2026, 10, 1) + datetime.timedelta(days=d)).isoformat(), slot=-1, volume=100 + d % 7)
    with serving(_cfg()) as port:
        code, why = _code(lambda: _stub(port).ForecastSeries(req))
    assert code == grpc.StatusCode.DEADLINE_EXCEEDED and "time allowed" in why


# ---------------------------------------------------------------- cancellation and deadlines while waiting for solver capacity

@contextmanager
def full_gate():
    held = scheduling._SOLVE_GATE.take(scheduling.MAX_SOLVES)
    try:
        yield
    finally:
        scheduling._SOLVE_GATE.give(held)


def _until(cond, seconds=4.0):
    end = time.time() + seconds
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.05)
    return False


def test_a_schedule_call_cancelled_while_it_waits_for_capacity_leaves_the_queue():
    with serving(_cfg()) as port, full_gate():
        fut = _stub(port).Schedule.future(_schedule())
        assert _until(lambda: len(scheduling._SOLVE_GATE.queue) == 1), "it queued behind the full gate"
        fut.cancel()
        assert _until(lambda: not scheduling._SOLVE_GATE.queue), "the plain Schedule call is cancellable, not just the streaming one"
        assert _until(lambda: scheduling.STATS["rpcs_active"] == 0)


def test_the_callers_own_deadline_ends_a_queued_schedule_call():
    with serving(_cfg()) as port, full_gate():
        t0 = time.time()
        code, _ = _code(lambda: _stub(port).Schedule(_schedule(), timeout=1.0))
        assert code == grpc.StatusCode.DEADLINE_EXCEEDED and time.time() - t0 < 3
        assert _until(lambda: not scheduling._SOLVE_GATE.queue)


def test_the_engines_own_limit_ends_a_schedule_call_that_set_no_deadline():
    with serving(_cfg(schedule_deadline_sec=1.0)) as port, full_gate():
        code, why = _code(lambda: _stub(port).Schedule(_schedule()))
        assert code == grpc.StatusCode.DEADLINE_EXCEEDED and "not finished within" in why
        assert _until(lambda: not scheduling._SOLVE_GATE.queue)


def test_the_streaming_call_has_the_same_limit():
    with serving(_cfg(schedule_deadline_sec=1.0)) as port, full_gate():
        def read():
            for _ in _stub(port).ScheduleStream(_schedule()):
                pass
        code, why = _code(read)
        assert code == grpc.StatusCode.DEADLINE_EXCEEDED and "not finished within" in why
        assert _until(lambda: not scheduling._SOLVE_GATE.queue)


def test_a_schedule_call_that_has_room_still_works():
    with serving(_cfg()) as port:
        res = _stub(port).Schedule(_schedule(), timeout=60)
        assert res.status in ("OPTIMAL", "FEASIBLE") and len(res.assignments) == 1


# ---------------------------------------------------------------- TLS and mutual TLS

def _pki(tmp_path):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    def key():
        return ec.generate_private_key(ec.SECP256R1())

    def name(cn):
        return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])
    now = datetime.datetime.now(datetime.timezone.utc)

    def cert(subject, subject_key, issuer, issuer_key, ca=False, san=None):
        b = x509.CertificateBuilder().subject_name(name(subject)).issuer_name(name(issuer)).public_key(subject_key.public_key()).serial_number(x509.random_serial_number())
        b = b.not_valid_before(now - datetime.timedelta(minutes=5)).not_valid_after(now + datetime.timedelta(days=1)).add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True)
        if san:
            b = b.add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), critical=False)
        return b.sign(issuer_key, hashes.SHA256())
    ca_key, srv_key, cli_key = key(), key(), key()
    ca = cert("test ca", ca_key, "test ca", ca_key, ca=True)
    srv = cert("localhost", srv_key, "test ca", ca_key, san=True)
    cli = cert("gateway", cli_key, "test ca", ca_key)
    pem = lambda c: c.public_bytes(serialization.Encoding.PEM)
    keypem = lambda k: k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    files = {}
    for name_, data in (("ca.pem", pem(ca)), ("srv.pem", pem(srv)), ("srv.key", keypem(srv_key)), ("cli.pem", pem(cli)), ("cli.key", keypem(cli_key))):
        (tmp_path / name_).write_bytes(data)
        files[name_] = str(tmp_path / name_)
    return files


def test_tls_and_mutual_tls_through_a_real_connection(tmp_path):
    f = _pki(tmp_path)
    ca = Path(f["ca.pem"]).read_bytes()
    with serving(_cfg(tls_cert=f["srv.pem"], tls_key=f["srv.key"])) as port:
        assert _stub(port, grpc.ssl_channel_credentials(root_certificates=ca)).Staffing(_staffing()).out, "TLS: a client that trusts the engine's CA is served"
        assert _code(lambda: _stub(port).Staffing(_staffing(), timeout=3))[0] == grpc.StatusCode.UNAVAILABLE, "a client that does not speak TLS is not"
    with serving(_cfg(tls_cert=f["srv.pem"], tls_key=f["srv.key"], tls_client_ca=f["ca.pem"])) as port:
        mine = grpc.ssl_channel_credentials(root_certificates=ca, private_key=Path(f["cli.key"]).read_bytes(), certificate_chain=Path(f["cli.pem"]).read_bytes())
        assert _stub(port, mine).Staffing(_staffing()).out, "mutual TLS: a client with a certificate signed by the client CA is served"
        no_cert = grpc.ssl_channel_credentials(root_certificates=ca)
        assert _code(lambda: _stub(port, no_cert).Staffing(_staffing(), timeout=3))[0] == grpc.StatusCode.UNAVAILABLE, "one without a certificate is not"
