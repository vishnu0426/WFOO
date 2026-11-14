"""Startup configuration: read once, checked once, and in place before any other engine module looks at the environment.

Several modules (the solver, validation, the staffing limits) read ENGINE_* settings when they are imported to set their limits. If `backend/.env` were read afterwards, those
modules would already have taken their defaults and the file would apply to some settings and not others. So the server imports this module FIRST: importing it loads `.env`
(a real environment variable always wins over the file), and `load()` turns the settings the server itself uses into one frozen, validated object. A setting that cannot be used
(`ENGINE_MAX_SOLVES=lots`) stops the engine at start with every such problem listed, instead of surfacing as a crash on the first request.
"""
import os
from dataclasses import dataclass
from pathlib import Path


class ConfigError(RuntimeError):
    """One or more settings cannot be used. The message lists every one of them."""


def load_env_file(path=None, environ=None):
    """Fill the environment from backend/.env for the names the shell did not already set. Returns the names it set."""
    environ = os.environ if environ is None else environ
    env_path = Path(path) if path else Path(__file__).resolve().parent.parent / ".env"
    set_names = []
    if not env_path.exists():
        return set_names
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if not line or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key and key not in environ:
            environ[key] = value.strip().strip('"').strip("'")
            set_names.append(key)
    return set_names


load_env_file()      # at import: `import engine_config` before the modules that read their limits when they are imported


# (kind, lowest, highest) of every numeric ENGINE_* setting any module reads. Checked together at start.
NUMERIC = {
    "ENGINE_GRPC_THREADS": (int, 0, 1024), "ENGINE_MAX_RPCS": (int, 0, 100000), "ENGINE_MAX_MESSAGE_MB": (int, 1, 2048), "ENGINE_DRAIN_SEC": (float, 0, 3600),
    "ENGINE_SCHEDULE_DEADLINE_SEC": (float, 1, 86400), "ENGINE_FORECAST_DEADLINE_SEC": (float, 1, 3600), "ENGINE_UNARY_DEADLINE_SEC": (float, 1, 3600),
    "ENGINE_METRICS_PORT": (int, 0, 65535), "ENGINE_MAX_SOLVES": (int, 1, 64), "ENGINE_MAX_DAYS": (int, 1, 3660), "ENGINE_MAX_EMPLOYEES": (int, 1, 1000000),
    "ENGINE_MAX_TIME_LIMIT_SEC": (int, 1, 86400), "ENGINE_MAX_SKILLS": (int, 1, 1000), "ENGINE_MAX_STAFF_INPUTS": (int, 1, 10000000),
    "ENGINE_MAX_QUEUES": (int, 1, 5000), "ENGINE_MAX_HISTORY_DAYS": (int, 28, 20000), "ENGINE_MAX_HORIZON_DAYS": (int, 1, 3660),
    "ENGINE_MAX_SIM_REPLICATIONS": (int, 1, 5000), "ENGINE_MEMORY_WAIT_SEC": (float, 0, 86400), "ENGINE_WORKER_TRIES": (int, 1, 10),
    "ENGINE_MEMORY_BUDGET_PCT": (float, 10, 100), "ENGINE_LIGHT_RESERVE_MB": (float, 0, 1000000), "ENGINE_RESERVATION_RAMP_SEC": (float, 0, 600),
    "ENGINE_BACKUP_MIN_SEC": (float, 0, 3600), "ENGINE_BACKUP_MAX_OPTIONS": (int, 1, 100000000), "ENGINE_GAP_LIMIT": (float, 0, 1),
    "ENGINE_GAP_MIN_OPTIONS": (int, 0, 100000000), "ENGINE_STAGE_MIN_SEC": (float, 0, 3600), "ENGINE_STALL_PCT": (float, 0, 100),
}
FLAGS = ("ENGINE_REQUIRE_TLS", "ENGINE_ALLOW_INSECURE", "ENGINE_ISOLATE_SOLVES")
LOOPBACK = ("127.0.0.1", "localhost", "::1", "[::1]")


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    metrics_host: str
    metrics_port: int
    threads: int                 # 0 = sized from the cores
    max_rpcs: int                # 0 = sized from the threads, None-like -1 = no limit
    max_message_bytes: int       # the most one request or response may carry, in each direction
    drain_sec: float
    schedule_deadline_sec: float     # the longest a schedule build may take whatever the caller asks for
    forecast_deadline_sec: float
    unary_deadline_sec: float        # staffing, intraday, simulation
    tls_cert: str
    tls_key: str
    tls_client_ca: str           # set: clients must present a certificate signed by it (mutual TLS)
    require_tls: bool
    allow_insecure: bool

    @property
    def secure(self):
        return bool(self.tls_cert and self.tls_key)

    @property
    def loopback(self):
        return self.host in LOOPBACK


def load(environ=None) -> Settings:
    env = os.environ if environ is None else environ
    problems = []

    def number(name, default):
        raw = env.get(name)
        if raw is None or raw == "":
            return default
        kind, lo, hi = NUMERIC.get(name, (float, float("-inf"), float("inf")))
        try:
            v = kind(raw)
        except ValueError:
            problems.append(f"{name}={raw!r} is not a {'whole number' if kind is int else 'number'}")
            return default
        if not lo <= v <= hi:
            problems.append(f"{name}={raw} must be from {lo:g} to {hi:g}")
            return default
        return v

    for name in NUMERIC:                                     # every numeric setting is checked, whichever module reads it
        if env.get(name) not in (None, ""):
            number(name, 0)
    host, _, port_text = env.get("ENGINE_ADDR", "127.0.0.1:50051").rpartition(":")
    host = host or "127.0.0.1"
    try:
        port = int(port_text)
        if not 1 <= port <= 65535:
            raise ValueError
    except ValueError:
        problems.append(f"ENGINE_ADDR={env.get('ENGINE_ADDR')!r} must look like host:port (for example 127.0.0.1:50051)")
        port = 50051
    flag = lambda name: str(env.get(name, "")).strip().lower() in ("1", "true", "yes", "on")
    cert, key, ca = env.get("ENGINE_TLS_CERT", ""), env.get("ENGINE_TLS_KEY", ""), env.get("ENGINE_TLS_CLIENT_CA", "")
    if bool(cert) != bool(key):
        problems.append("ENGINE_TLS_CERT and ENGINE_TLS_KEY go together: one is set without the other")
    for name, path in (("ENGINE_TLS_CERT", cert), ("ENGINE_TLS_KEY", key), ("ENGINE_TLS_CLIENT_CA", ca)):
        if path and not Path(path).is_file():
            problems.append(f"{name}: no file at {path}")
    if ca and not (cert and key):
        problems.append("ENGINE_TLS_CLIENT_CA needs ENGINE_TLS_CERT and ENGINE_TLS_KEY: mutual TLS is a TLS connection first")
    s = Settings(
        host=host, port=port, metrics_host=env.get("ENGINE_METRICS_HOST", "127.0.0.1"), metrics_port=int(number("ENGINE_METRICS_PORT", 9109)),
        threads=int(number("ENGINE_GRPC_THREADS", 0)), max_rpcs=(-1 if env.get("ENGINE_MAX_RPCS") == "0" else int(number("ENGINE_MAX_RPCS", 0))),
        max_message_bytes=int(number("ENGINE_MAX_MESSAGE_MB", 256)) * 1024 * 1024, drain_sec=float(number("ENGINE_DRAIN_SEC", 100)),
        schedule_deadline_sec=float(number("ENGINE_SCHEDULE_DEADLINE_SEC", 7200)), forecast_deadline_sec=float(number("ENGINE_FORECAST_DEADLINE_SEC", 600)),
        unary_deadline_sec=float(number("ENGINE_UNARY_DEADLINE_SEC", 120)),
        tls_cert=cert, tls_key=key, tls_client_ca=ca, require_tls=flag("ENGINE_REQUIRE_TLS"), allow_insecure=flag("ENGINE_ALLOW_INSECURE"))
    if s.require_tls and not s.secure:
        problems.append("ENGINE_REQUIRE_TLS is on but ENGINE_TLS_CERT and ENGINE_TLS_KEY are not set")
    if not s.secure and not s.loopback and not s.allow_insecure:
        problems.append(f"ENGINE_ADDR {host}:{port} is reachable from other machines but has no TLS (ENGINE_TLS_CERT and ENGINE_TLS_KEY). The engine has no other authentication: bind it to "
                        f"127.0.0.1 behind the gateway, set up TLS, or (a private network you trust) set ENGINE_ALLOW_INSECURE=1")
    problems = list(dict.fromkeys(problems))        # a setting checked twice is reported once
    if problems:
        raise ConfigError("the engine's settings cannot be used:\n  - " + "\n  - ".join(problems))
    return s
