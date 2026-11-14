"""Fit warnings are kept, not hidden: real trouble is logged with the model's name, library deprecation notices stay at debug level, and nothing silences warnings globally."""
import logging
import warnings

import forecasting as fc


def test_warnings_are_not_switched_off_for_the_whole_process():
    assert not any(f[0] == "ignore" and f[2] is Warning and f[1] is None for f in warnings.filters)


def test_a_fit_warning_is_logged_with_the_model_name(caplog):
    fc._warned.clear()
    with caplog.at_level(logging.DEBUG, logger="wfm.forecast"):
        with fc.model_warnings("ets"):
            warnings.warn("did not converge", RuntimeWarning)
    rec = [r for r in caplog.records if "did not converge" in r.getMessage()]
    assert rec and rec[0].levelno == logging.WARNING and "ets" in rec[0].getMessage()


def test_library_deprecation_notices_stay_quiet(caplog):
    fc._warned.clear()
    with caplog.at_level(logging.DEBUG, logger="wfm.forecast"):
        with fc.model_warnings("gbm"):
            warnings.warn("old api", FutureWarning)
    rec = [r for r in caplog.records if "old api" in r.getMessage()]
    assert rec and rec[0].levelno == logging.DEBUG


def test_a_repeated_warning_is_counted_not_flooded(caplog):
    fc._warned.clear()
    with caplog.at_level(logging.WARNING, logger="wfm.forecast"):
        for _ in range(25):
            with fc.model_warnings("sarima"):
                warnings.warn("singular matrix", RuntimeWarning)
    assert len([r for r in caplog.records if "singular matrix" in r.getMessage()]) == 2      # the 1st and the 10th


def test_the_model_still_runs_and_its_warning_does_not_escape():
    import numpy as np, pandas as pd
    y = pd.Series(np.arange(1, 71, dtype=float) % 7 + 10, index=pd.date_range("2026-01-01", periods=70))
    with warnings.catch_warnings(record=True) as outer:
        warnings.simplefilter("always")
        out = fc.run_model("snaive", y, 7, set(), {})
    assert len(out) == 7 and not outer
