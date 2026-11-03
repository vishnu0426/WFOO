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

import backends
import forecasting
import scheduling
import simulation
import staffing
import wfm_pb2
import wfm_pb2_grpc


def load_env():
    """Reads the one backend/.env the gateway also reads, so ENGINE_ADDR only has to be set in one place.
    A real environment variable always wins; this only fills in what the shell didn't already set."""
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        if not line or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key and key not in os.environ:
            os.environ[key] = value.strip()


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


class Engine(wfm_pb2_grpc.EngineServicer):
    @counted
    def ForecastSeries(self, request, context):
        return forecasting.run(request)

    @counted
    def Staffing(self, request, context):
        return wfm_pb2.StaffingResponse(out=staffing.staff_intervals(request))

    @counted
    def Intraday(self, request, context):
        return forecasting.intraday(request)

    @counted
    def Simulate(self, request, context):
        if len(request.intervals) > 96 * 60:
            context.abort(grpc.StatusCode.RESOURCE_EXHAUSTED, "Simulate up to 60 days at a time.")
        return simulation.run(request)

    @counted
    def Schedule(self, request, context):
        if len(request.options) > scheduling.MAX_OPTIONS:      # a request this big would exhaust memory and take the whole engine down
            context.abort(grpc.StatusCode.RESOURCE_EXHAUSTED, f"{len(request.options):,} candidate shifts is more than the solver can take ({scheduling.MAX_OPTIONS:,}).")
        try:
            return scheduling.solve_period(request)
        except backends.Cancelled:
            context.abort(grpc.StatusCode.CANCELLED, "cancelled")

    @counted
    def ScheduleStream(self, request, context):
        """The same solve, reporting each finished week, and stopping when the caller cancels the call or goes away."""
        if len(request.options) > scheduling.MAX_OPTIONS:
            context.abort(grpc.StatusCode.RESOURCE_EXHAUSTED, f"{len(request.options):,} candidate shifts is more than the solver can take ({scheduling.MAX_OPTIONS:,}).")
        events, cancel = queue.Queue(), threading.Event()
        context.add_callback(cancel.set)           # fires when the client cancels, the deadline passes or the connection drops

        def work():
            try:
                res = scheduling.solve_period(request, cancel=cancel, progress=lambda done, total, note: events.put(wfm_pb2.ScheduleEvent(chunk=done, chunks=total, phase="SOLVING", note=note)))
                events.put(wfm_pb2.ScheduleEvent(done=True, phase="DONE", result=res))
            except backends.Cancelled:
                events.put(None)
            except Exception as e:                  # surfaced to the caller as a failed call, with the reason
                events.put(e)
        threading.Thread(target=work, daemon=True).start()
        while True:
            try:
                ev = events.get(timeout=0.5)
            except queue.Empty:
                if cancel.is_set():
                    return
                continue
            if ev is None:
                return
            if isinstance(ev, Exception):
                context.abort(grpc.StatusCode.INTERNAL, f"{type(ev).__name__}: {ev}")
            yield ev
            if ev.done:
                return


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
    cores = os.cpu_count() or 4
    threads = int(os.environ.get("ENGINE_GRPC_THREADS", "0") or 0) or min(128, max(32, cores * 4))
    raw = os.environ.get("ENGINE_MAX_RPCS")
    max_rpcs = threads * 4 if raw is None or raw == "" else int(raw)
    return threads, (max_rpcs or None)


def main():
    load_env()
    faulthandler.enable()   # if a native library does crash the process, at least say where
    # warming up is only a head start: if it fails (memory is tight, a worker dies) the engine still starts and the pool is created on first use
    try:
        forecasting.warm_up()  # import statsmodels/sklearn now so the first forecast request isn't a cold start
        forecasting.start_pool()
    except Exception as e:  # noqa: BLE001
        print(f"engine: warm-up skipped ({type(e).__name__}: {e}); the forecasting workers will start on first use", flush=True)
    host, _, port = os.environ.get("ENGINE_ADDR", "127.0.0.1:50051").partition(":")  # loopback by default; the gateway is the only client
    # a schedule part waiting for the solver holds a thread; short calls (staffing, forecasts) must still find a free one, so there are plenty of threads (the solver gate limits the real work)
    threads, max_rpcs = grpc_sizes()
    # Calls beyond max_rpcs are turned away at once with RESOURCE_EXHAUSTED ("ENGINE_BUSY"): the gateway tries another engine or asks the caller to retry,
    # which is kinder than letting hundreds of calls queue behind a few large solves and all time out together.
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=threads), maximum_concurrent_rpcs=max_rpcs, options=[
        ("grpc.max_receive_message_length", -1), ("grpc.max_send_message_length", -1)])
    wfm_pb2_grpc.add_EngineServicer_to_server(Engine(), server)
    server.add_insecure_port(f"{host}:{port}")
    server.start()
    try:
        mp = int(os.environ.get("ENGINE_METRICS_PORT", "9109"))
        if mp:
            serve_metrics(mp)
    except OSError as e:                      # a second engine on one machine, or the port is taken: the engine still works without it
        print(f"engine: metrics endpoint not started ({e})", flush=True)
    scheduling.prewarm()          # the first solve should not wait for the solver libraries to load
    print(f"engine gRPC listening on {host}:{port} ({threads} threads, at most {max_rpcs} calls in flight)", flush=True)
    # An autoscaler or a rolling update ends an engine with SIGTERM: stop taking new calls (the gateway sends them to another engine) and let the solves under way finish,
    # for up to ENGINE_DRAIN_SEC, instead of cutting them off.
    def drain(*_):
        print("engine: stopping, finishing the work under way", flush=True)
        server.stop(float(os.environ.get("ENGINE_DRAIN_SEC", "100")))
    try:
        import signal
        signal.signal(signal.SIGTERM, drain)
    except (ValueError, OSError):
        pass
    server.wait_for_termination()


if __name__ == "__main__":
    main()
