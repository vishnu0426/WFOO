"""
Logging that can be followed from a request: every line the engine writes while serving a call carries the request id and trace id the gateway sent with it, so a slow or failed
schedule can be traced from the browser through the gateway to the solver. ENGINE_LOG_FORMAT=json writes one JSON object per line (what a log collector wants).
"""
import contextvars
import json
import os
import sys
import time

_ids = contextvars.ContextVar("wfm_trace", default=(None, None))


def bind(request_id, traceparent):
    """Make these ids the ones logged by the current thread of work."""
    return _ids.set((request_id, traceparent))


def ids_from(context):
    """The request id and traceparent the caller sent with a gRPC call (None when it sent none)."""
    try:
        md = {k.lower(): v for k, v in (context.invocation_metadata() or ())}
    except Exception:       # noqa: BLE001
        md = {}
    return md.get("x-request-id"), md.get("traceparent")


def trace_id(traceparent):
    parts = (traceparent or "").split("-")
    return parts[1] if len(parts) == 4 else None


def log(message, **fields):
    rid, tp = _ids.get()
    if os.environ.get("ENGINE_LOG_FORMAT", "").lower() == "json":
        line = json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z", "level": fields.pop("level", "info"), "msg": message,
                           "requestId": rid, "traceId": trace_id(tp), **fields})
    else:
        extra = "".join(f" {k}={v}" for k, v in fields.items())
        line = f"[engine]{' rid=' + rid if rid else ''} {message}{extra}"
    print(line, file=sys.stderr if fields.get("level") in ("warn", "error") else sys.stdout, flush=True)
