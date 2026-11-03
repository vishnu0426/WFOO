"""How the engine sizes its call pool and shares the cores between solves."""
import os

import scheduling
import server


def _with_env(**env):
    class Ctx:
        def __enter__(self):
            self.old = {k: os.environ.get(k) for k in env}
            for k, v in env.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

        def __exit__(self, *a):
            for k, v in self.old.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
    return Ctx()


def test_pool_is_sized_from_the_machine_within_bounds(monkeypatch):
    with _with_env(ENGINE_GRPC_THREADS=None, ENGINE_MAX_RPCS=None):
        monkeypatch.setattr(os, "cpu_count", lambda: 2)
        assert server.grpc_sizes() == (32, 128), "a small machine still gets enough threads for calls that wait"
        monkeypatch.setattr(os, "cpu_count", lambda: 16)
        assert server.grpc_sizes() == (64, 256)
        monkeypatch.setattr(os, "cpu_count", lambda: 96)
        assert server.grpc_sizes() == (128, 512), "never more than 128 threads"


def test_pool_size_and_admission_limit_can_be_set():
    with _with_env(ENGINE_GRPC_THREADS="10", ENGINE_MAX_RPCS="25"):
        assert server.grpc_sizes() == (10, 25)
    with _with_env(ENGINE_GRPC_THREADS="10", ENGINE_MAX_RPCS=None):
        assert server.grpc_sizes() == (10, 40), "four calls per thread unless said otherwise"
    with _with_env(ENGINE_GRPC_THREADS="10", ENGINE_MAX_RPCS="0"):
        assert server.grpc_sizes() == (10, None), "0 switches the limit off"


def test_solves_that_run_together_share_the_cores():
    with _with_env(ENGINE_SOLVER_THREADS="8"):
        assert scheduling.workers_for(10_000, 8) == 8, "one solve alone may use every core"
        assert scheduling.workers_for(10_000, 8, share=2) == 4, "two at once split them"
        assert scheduling.workers_for(10_000, 8, share=16) == 1, "never below one"
        assert scheduling.workers_for(10_000, 2, share=2) == 2, "still never more than asked for"
