"""WFM planning engine served over gRPC.

Stateless: forecasting (model tournament, reconciliation, intraday reforecast) and staffing (Erlang C/A, concurrency,
async workload, cross-skilled pooling). The gateway owns storage, auth and orchestration.
"""
import faulthandler
import os
import queue
import threading
from concurrent import futures
from pathlib import Path

import grpc

import engine_config      # first of ours: loading it reads backend/.env, before the modules below read their limits from the environment
import resources
import backends
import forecasting
import scheduling
import simulation
import staffing
import validator
import observe
import validation
import wfm_pb2
import wfm_pb2_grpc


def load_env():
    """Reads the one backend/.env the gateway also reads, so ENGINE_ADDR only has to be set in one place (see engine_config, which does it when it is imported)."""
    engine_config.load_env_file()


_SETTINGS = None


def settings():
    """The validated startup settings (read once)."""
    global _SETTINGS
    if _SETTINGS is None:
        _SETTINGS = engine_config.load()
    return _SETTINGS


class Guard:
    """What ends a call early: the caller cancelling, the connection dropping, the caller's own deadline, or the engine's own limit for that kind of call. `event` is what the
    solver watches; `expired` says it was a deadline (the engine's or the caller's), not the caller walking away."""
    def __init__(self, context, limit_sec):
        self.event, self.expired = threading.Event(), False
        context.add_callback(self.event.set)                   # the caller cancelled, its deadline passed, or the connection dropped
        left = context.time_remaining()
        self.limit = limit_sec if left is None else min(limit_sec, max(0.0, left))
        self._timer = threading.Timer(self.limit, self._expire)
        self._timer.daemon = True
        self._timer.start()

    def _expire(self):
        self.expired = True
        self.event.set()

    def close(self):
        self._timer.cancel()


def refuse_if_late(context):
    left = context.time_remaining()
    if left is not None and left <= 0:
        context.abort(grpc.StatusCode.DEADLINE_EXCEEDED, "the deadline had already passed when the call was received")


def counted(fn):
    """Counts calls in flight and received, for the metrics endpoint."""
    import functools
    import inspect
    st = scheduling.STATS
    if inspect.isgeneratorfunction(fn):
        @functools.wraps(fn)
        def gen(self, request, context):
            st["rpcs_active"] += 1
            st["rpcs_total"] += 1
            try:
                yield from fn(self, request, context)
            finally:
                st["rpcs_active"] -= 1
        return gen

    @functools.wraps(fn)
    def one(self, request, context):
        st["rpcs_active"] += 1
        st["rpcs_total"] += 1
        try:
            return fn(self, request, context)
        finally:
            st["rpcs_active"] -= 1
    return one


def check_schedule_request(request, context):
    """Refuse a request that cannot be solved as sent, saying why: too many candidate shifts (it would exhaust memory and take the whole engine down) is RESOURCE_EXHAUSTED,
    anything else wrong with it is INVALID_ARGUMENT."""
    try:
        validation.validate_schedule_request(request, scheduling.MAX_OPTIONS)
    except validation.InvalidRequest as e:
        too_big = len(request.options) > scheduling.MAX_OPTIONS
        context.abort(grpc.StatusCode.RESOURCE_EXHAUSTED if too_big else grpc.StatusCode.INVALID_ARGUMENT, str(e))
    # a request whose busiest stretch cannot be solved in the memory solves may hold, even with a single search thread, is refused now, before it queues behind others
    try:
        scheduling.admit_threads(scheduling.largest_window_options(request), 1)
    except backends.MemoryPressure as e:
        context.abort(grpc.StatusCode.RESOURCE_EXHAUSTED, str(e))


class DeadlineError(RuntimeError):
    pass


class Engine(wfm_pb2_grpc.EngineServicer):
    @counted
    def ForecastSeries(self, request, context):
        refuse_if_late(context)
        try:
            validation.validate_series_request(request)
        except validation.InvalidRequest as e:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, str(e))
        left = context.time_remaining()
        limit = settings().forecast_deadline_sec if left is None else min(settings().forecast_deadline_sec, left)
        try:
            return forecasting.run(request, deadline_sec=limit)
        except forecasting.DeadlineExceeded as e:
            context.abort(grpc.StatusCode.DEADLINE_EXCEEDED, str(e))

    @counted
    def Staffing(self, request, context):
        refuse_if_late(context)
        try:
            validation.validate_staffing_request(request)
        except validation.InvalidRequest as e:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, str(e))
        return wfm_pb2.StaffingResponse(out=staffing.staff_intervals(request))

    @counted
    def Intraday(self, request, context):
        refuse_if_late(context)
        try:
            validation.validate_intraday_request(request)
        except validation.InvalidRequest as e:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, str(e))
        return forecasting.intraday(request)

    @counted
    def Validate(self, request, context):
        refuse_if_late(context)
        try:
            validation.validate_validate_request(request)
        except validation.InvalidRequest as e:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT if len(request.shifts) <= 3_000_000 else grpc.StatusCode.RESOURCE_EXHAUSTED, str(e))
        return validator.validate(request)

    @counted
    def Simulate(self, request, context):
        refuse_if_late(context)
        try:
            validation.validate_sim_request(request)
        except validation.InvalidRequest as e:
            too_big = len(request.intervals) > 96 * 60 or request.replications > validation.MAX_SIM_REPLICATIONS
            context.abort(grpc.StatusCode.RESOURCE_EXHAUSTED if too_big else grpc.StatusCode.INVALID_ARGUMENT, str(e))
        return simulation.run(request)

    @counted
    def Schedule(self, request, context):
        observe.bind(*observe.ids_from(context))
        refuse_if_late(context)
        check_schedule_request(request, context)
        guard = Guard(context, settings().schedule_deadline_sec)
        try:
            return scheduling.solve_period(request, cancel=guard.event)       # a caller that cancels, or goes away, stops the solve, as it does on the streaming call
        except backends.Cancelled:
            if guard.expired:
                context.abort(grpc.StatusCode.DEADLINE_EXCEEDED, f"the schedule was not finished within {guard.limit:g} seconds")
            context.abort(grpc.StatusCode.CANCELLED, "cancelled")
        except backends.MemoryPressure as e:
            context.abort(grpc.StatusCode.RESOURCE_EXHAUSTED, str(e))
        finally:
            guard.close()

    @counted
    def ScheduleStream(self, request, context):
        """The same solve, reporting each finished week, and stopping when the caller cancels the call or goes away."""
        rid, tp = observe.ids_from(context)
        observe.bind(rid, tp)
        refuse_if_late(context)
        check_schedule_request(request, context)
        events = queue.Queue()
        guard = Guard(context, settings().schedule_deadline_sec)
        cancel = guard.event                        # set when the client cancels, a deadline passes (its own or the engine's) or the connection drops

        def work():
            observe.bind(rid, tp)                     # this thread logs under the request's id too
            try:
                res = scheduling.solve_period(request, cancel=cancel, progress=lambda done, total, note: events.put(wfm_pb2.ScheduleEvent(chunk=done, chunks=total, phase="SOLVING", note=note)))
                events.put(wfm_pb2.ScheduleEvent(done=True, phase="DONE", result=res))
            except backends.Cancelled:
                events.put(DeadlineError(f"the schedule was not finished within {guard.limit:g} seconds") if guard.expired else None)
            except Exception as e:                  # surfaced to the caller as a failed call, with the reason
                events.put(e)
        threading.Thread(target=work, daemon=True).start()
        try:
            while True:
                try:
                    ev = events.get(timeout=0.5)
                except queue.Empty:
                    if cancel.is_set() and not guard.expired:        # the caller has gone: nobody is waiting for an answer
                        return
                    continue
                if ev is None:
                    return
                if isinstance(ev, DeadlineError):
                    guard.close()
                    context.abort(grpc.StatusCode.DEADLINE_EXCEEDED, str(ev))
                if isinstance(ev, backends.MemoryPressure):
                    context.abort(grpc.StatusCode.RESOURCE_EXHAUSTED, str(ev))
                if isinstance(ev, Exception):
                    context.abort(grpc.StatusCode.INTERNAL, f"{type(ev).__name__}: {ev}")
                yield ev
                if ev.done:
                    return
        finally:
            guard.close()


def serve_metrics(port):
    """A tiny HTTP endpoint (GET /metrics, Prometheus text) beside the gRPC one. ENGINE_METRICS_PORT=0 turns it off. It carries no data about anyone: only counts and sizes."""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path.split("?")[0] != "/metrics":
                self.send_response(404)
                self.end_headers()
                return
            body = scheduling.metrics_text().encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; version=0.0.4")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass
    host = os.environ.get("ENGINE_METRICS_HOST", "127.0.0.1")
    srv = ThreadingHTTPServer((host, port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def grpc_sizes():
    """(threads, max calls in flight). A call that is waiting for the solver holds a thread but uses no CPU, so threads are cheap: four per core, between 32 and 128.
    ENGINE_GRPC_THREADS overrides it. The real limits on work are the solver gate and the forecasting pool, not this number, so it is not grown under load:
    more threads under load would only mean more solves competing for the same memory. ENGINE_MAX_RPCS (default four calls per thread; 0 = no limit) is the
    admission limit."""
    cores = resources.effective_cpus()
    threads = int(os.environ.get("ENGINE_GRPC_THREADS", "0") or 0) or min(128, max(32, cores * 4))
    raw = os.environ.get("ENGINE_MAX_RPCS")
    max_rpcs = threads * 4 if raw is None or raw == "" else int(raw)
    return threads, (max_rpcs or None)


def build_server(cfg, threads, max_rpcs):
    """The gRPC server for these settings, with its port bound but not started: (server, the port it is on). Finite message limits, TLS or mutual TLS when configured."""
    # Calls beyond max_rpcs are turned away at once with RESOURCE_EXHAUSTED ("ENGINE_BUSY"): the gateway tries another engine or asks the caller to retry,
    # which is kinder than letting hundreds of calls queue behind a few large solves and all time out together.
    # finite limits in both directions (ENGINE_MAX_MESSAGE_MB, 256 by default): a request larger than any real schedule or forecast is refused, not buffered
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=threads), maximum_concurrent_rpcs=max_rpcs, options=[
        ("grpc.max_receive_message_length", cfg.max_message_bytes), ("grpc.max_send_message_length", cfg.max_message_bytes),
        ("grpc.keepalive_time_ms", 60_000), ("grpc.keepalive_timeout_ms", 20_000), ("grpc.http2.min_ping_interval_without_data_ms", 30_000)])
    wfm_pb2_grpc.add_EngineServicer_to_server(Engine(), server)
    if cfg.secure:
        read = lambda path: Path(path).read_bytes()
        creds = grpc.ssl_server_credentials([(read(cfg.tls_key), read(cfg.tls_cert))], root_certificates=read(cfg.tls_client_ca) if cfg.tls_client_ca else None,
                                            require_client_auth=bool(cfg.tls_client_ca))
        bound = server.add_secure_port(f"{cfg.host}:{cfg.port}", creds)
    else:
        bound = server.add_insecure_port(f"{cfg.host}:{cfg.port}")
    if not bound:
        raise RuntimeError(f"could not listen on {cfg.host}:{cfg.port}")
    return server, bound


def main():
    try:
        cfg = engine_config.load()
    except engine_config.ConfigError as e:
        print(f"engine: {e}", flush=True)
        raise SystemExit(2)
    global _SETTINGS
    _SETTINGS = cfg
    faulthandler.enable()   # if a native library does crash the process, at least say where
    # warming up is only a head start: if it fails (memory is tight, a worker dies) the engine still starts and the pool is created on first use
    try:
        forecasting.warm_up()  # import statsmodels/sklearn now so the first forecast request isn't a cold start
        forecasting.start_pool()
    except Exception as e:  # noqa: BLE001
        print(f"engine: warm-up skipped ({type(e).__name__}: {e}); the forecasting workers will start on first use", flush=True)
    host, port = cfg.host, cfg.port                    # loopback by default; the gateway is the only client
    # a schedule part waiting for the solver holds a thread; short calls (staffing, forecasts) must still find a free one, so there are plenty of threads (the solver gate limits the real work)
    threads, max_rpcs = grpc_sizes()
    if cfg.threads:
        threads = cfg.threads
    server, _bound = build_server(cfg, threads, max_rpcs)
    server.start()
    try:
        mp = cfg.metrics_port
        if mp:
            serve_metrics(mp)
    except OSError as e:                      # a second engine on one machine, or the port is taken: the engine still works without it
        print(f"engine: metrics endpoint not started ({e})", flush=True)
    scheduling.prewarm()          # the first solve should not wait for the solver libraries to load
    mode = "mutual TLS" if cfg.tls_client_ca else "TLS" if cfg.secure else "no TLS (loopback only)" if cfg.loopback else "no TLS (ENGINE_ALLOW_INSECURE)"
    print(f"engine gRPC listening on {host}:{port} ({mode}; {threads} threads, at most {max_rpcs} calls in flight, messages up to {cfg.max_message_bytes // 1048576} MB)", flush=True)
    # An autoscaler or a rolling update ends an engine with SIGTERM: stop taking new calls (the gateway sends them to another engine) and let the solves under way finish,
    # for up to ENGINE_DRAIN_SEC, instead of cutting them off.
    def drain(*_):
        print("engine: stopping, finishing the work under way", flush=True)
        server.stop(cfg.drain_sec)
    try:
        import signal
        signal.signal(signal.SIGTERM, drain)
    except (ValueError, OSError):
        pass
    try:
        server.wait_for_termination()
    finally:
        scheduling.stop_all_workers()          # no solver process outlives the engine


if __name__ == "__main__":
    main()
