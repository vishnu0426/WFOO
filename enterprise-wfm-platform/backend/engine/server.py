"""WFM planning engine served over gRPC.

Stateless: forecasting (model tournament, reconciliation, intraday reforecast) and staffing (Erlang C/A, concurrency,
async workload, cross-skilled pooling). The gateway owns storage, auth and orchestration.
"""
import os
from concurrent import futures
from pathlib import Path

import grpc

import forecasting
import scheduling
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


class Engine(wfm_pb2_grpc.EngineServicer):
    def ForecastSeries(self, request, context):
        return forecasting.run(request)

    def Staffing(self, request, context):
        return wfm_pb2.StaffingResponse(out=staffing.staff_intervals(request))

    def Intraday(self, request, context):
        return forecasting.intraday(request)

    def Schedule(self, request, context):
        return scheduling.solve(request)


def main():
    load_env()
    forecasting.warm_up()  # import statsmodels/sklearn now so the first forecast request isn't a cold start
    forecasting.start_pool()
    host, _, port = os.environ.get("ENGINE_ADDR", "127.0.0.1:50051").partition(":")  # loopback by default; the gateway is the only client
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=4), options=[
        ("grpc.max_receive_message_length", -1), ("grpc.max_send_message_length", -1)])
    wfm_pb2_grpc.add_EngineServicer_to_server(Engine(), server)
    server.add_insecure_port(f"{host}:{port}")
    server.start()
    print(f"engine gRPC listening on {host}:{port}", flush=True)
    server.wait_for_termination()


if __name__ == "__main__":
    main()
