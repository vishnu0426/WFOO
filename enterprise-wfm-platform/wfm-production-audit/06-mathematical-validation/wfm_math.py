"""Independent WFM maths, written from the textbook definitions in the audit brief (section 8).

Deliberately NOT a copy of the application's code:
  * Erlang C uses the direct factorial-series formula in log space (the engine uses the Erlang B recursion).
  * Required agents is a plain upward search from ceil(A)+... with no caching.
Everything is pure Python (math only), so a disagreement points at one side or the other, never at a shared library.
"""
from __future__ import annotations

import math
from typing import Iterable, Sequence


# ---------- traffic / Erlang C ----------

def offered_traffic(volume: float, aht_sec: float, interval_sec: float) -> float:
    """A = volume * AHT / interval length (Erlangs)."""
    if interval_sec <= 0:
        raise ValueError("interval_sec must be > 0")
    if volume < 0 or aht_sec < 0:
        raise ValueError("volume and AHT cannot be negative")
    return volume * aht_sec / interval_sec


def erlang_c(n: int, a: float) -> float:
    """P(wait) = [A^N/N! * N/(N-A)] / [sum_{k<N} A^k/k! + A^N/N! * N/(N-A)], computed in log space."""
    if a <= 0:
        return 0.0
    if n <= a:
        return 1.0
    log_terms = [k * math.log(a) - math.lgamma(k + 1) for k in range(n)]
    log_top = n * math.log(a) - math.lgamma(n + 1) + math.log(n / (n - a))
    m = max(max(log_terms), log_top)
    s = sum(math.exp(t - m) for t in log_terms)
    top = math.exp(log_top - m)
    return top / (s + top)


def service_level(n: int, a: float, aht_sec: float, t_sec: float) -> float:
    """SL(T) = 1 - C * exp(-(N-A) * T / AHT). Unstable queue (N <= A) -> 0."""
    if a <= 0:
        return 1.0
    if n <= a:
        return 0.0
    return 1.0 - erlang_c(n, a) * math.exp(-(n - a) * t_sec / aht_sec)


def asa(n: int, a: float, aht_sec: float) -> float:
    """ASA = C * AHT / (N - A)."""
    if a <= 0:
        return 0.0
    if n <= a:
        return math.inf
    return erlang_c(n, a) * aht_sec / (n - a)


def occupancy(a: float, n: float) -> float:
    """Occupancy = A / N (workload hours / available agent hours)."""
    if n <= 0:
        raise ValueError("n must be > 0")
    return a / n


def required_agents(volume: float, aht_sec: float, interval_sec: float, target_sl: float, t_sec: float,
                    max_occupancy: float = 1.0, cap: int = 5000) -> int:
    """Smallest N with SL >= target and A/N <= max occupancy."""
    a = offered_traffic(volume, aht_sec, interval_sec)
    if a == 0:
        return 0
    n = max(1, math.floor(a) + 1, math.ceil(a / max_occupancy - 1e-12))
    while n <= cap:
        if service_level(n, a, aht_sec, t_sec) >= target_sl - 1e-12 and a / n <= max_occupancy + 1e-12:
            return n
        n += 1
    raise ValueError("target not reachable within cap")


# ---------- workload / staffing ----------

def workload_hours(contacts: float, aht_sec: float) -> float:
    return contacts * aht_sec / 3600.0


def net_staff(workload_h: float, productive_hours_per_agent: float) -> float:
    if productive_hours_per_agent <= 0:
        raise ValueError("productive hours must be > 0")
    return workload_h / productive_hours_per_agent


def gross_staff(net: float, shrinkage: float) -> float:
    """Gross = Net / (1 - shrinkage). 100% shrinkage is undefined and must be refused."""
    if not 0 <= shrinkage < 1:
        raise ValueError("shrinkage must be in [0, 1)")
    return net / (1.0 - shrinkage)


def shrinkage(unavailable_min: float, scheduled_min: float) -> float:
    if scheduled_min <= 0:
        raise ValueError("scheduled time must be > 0")
    return unavailable_min / scheduled_min


def fte(required_weekly_hours: float, full_time_hours: float) -> float:
    if full_time_hours <= 0:
        raise ValueError("full-time hours must be > 0")
    return required_weekly_hours / full_time_hours


def aht(talk_sec: float, hold_sec: float, acw_sec: float, handled: int) -> float:
    if handled <= 0:
        raise ValueError("handled must be > 0")
    return (talk_sec + hold_sec + acw_sec) / handled


def coverage(scheduled_qualified: float, required: float) -> float | None:
    """None when nothing is required (coverage is undefined, not infinite)."""
    return None if required == 0 else scheduled_qualified / required


def adherence(adherent_min: float, measured_scheduled_min: float) -> float:
    if measured_scheduled_min <= 0:
        raise ValueError("measured scheduled time must be > 0")
    return 100.0 * adherent_min / measured_scheduled_min


# ---------- forecast error ----------

def _pairs(actual: Sequence[float], forecast: Sequence[float]):
    if len(actual) != len(forecast):
        raise ValueError("actual and forecast differ in length")
    if not actual:
        raise ValueError("no data")
    return list(zip(actual, forecast))


def wape(actual, forecast) -> float | None:
    p = _pairs(actual, forecast)
    tot = sum(a for a, _ in p)
    return None if tot == 0 else 100.0 * sum(abs(a - f) for a, f in p) / tot


def accuracy_from_wape(actual, forecast) -> float | None:
    w = wape(actual, forecast)
    return None if w is None else 100.0 - w


def mape(actual, forecast) -> tuple[float | None, int]:
    """Returns (MAPE over non-zero actuals, number of zero-actual points excluded). Never divides by zero."""
    p = _pairs(actual, forecast)
    nz = [(a, f) for a, f in p if a != 0]
    if not nz:
        return None, len(p)
    return 100.0 * sum(abs(a - f) / abs(a) for a, f in nz) / len(nz), len(p) - len(nz)


def mae(actual, forecast) -> float:
    p = _pairs(actual, forecast)
    return sum(abs(a - f) for a, f in p) / len(p)


def rmse(actual, forecast) -> float:
    p = _pairs(actual, forecast)
    return math.sqrt(sum((a - f) ** 2 for a, f in p) / len(p))


def bias(actual, forecast) -> float | None:
    """Positive = over-forecast."""
    p = _pairs(actual, forecast)
    tot = sum(a for a, _ in p)
    return None if tot == 0 else 100.0 * sum(f - a for a, f in p) / tot


def rollup(values: Iterable[float]) -> float:
    return float(sum(values))
