"""The small-server search setting: on for a big model with few search threads, and never without a starting roster or in the deterministic mode."""
import scheduling

BIG = 11_200


def test_it_is_on_by_default_for_a_big_model_on_a_small_server(monkeypatch):
    monkeypatch.delenv("ENGINE_LNS_BELOW_WORKERS", raising=False)
    monkeypatch.delenv("ENGINE_LNS_MIN_OPTIONS", raising=False)
    assert scheduling.lns_only(1, False, True, BIG) and scheduling.lns_only(2, False, True, BIG)


def test_it_is_not_used_with_enough_threads_or_for_a_small_model(monkeypatch):
    monkeypatch.delenv("ENGINE_LNS_BELOW_WORKERS", raising=False)
    monkeypatch.delenv("ENGINE_LNS_MIN_OPTIONS", raising=False)
    assert not scheduling.lns_only(3, False, True, BIG) and not scheduling.lns_only(8, False, True, BIG)
    assert not scheduling.lns_only(2, False, True, 4_000), "a small model keeps the full search, which can prove the best answer"


def test_it_needs_a_starting_roster_and_is_never_deterministic():
    assert not scheduling.lns_only(2, False, False, BIG), "nothing to improve"
    assert not scheduling.lns_only(2, True, True, BIG), "the deterministic mode keeps its own search"


def test_the_environment_can_turn_it_off_or_move_the_limits(monkeypatch):
    monkeypatch.setenv("ENGINE_LNS_BELOW_WORKERS", "0")
    assert not scheduling.lns_only(1, False, True, BIG)
    monkeypatch.setenv("ENGINE_LNS_BELOW_WORKERS", "5")
    assert scheduling.lns_only(4, False, True, BIG)
    monkeypatch.setenv("ENGINE_LNS_MIN_OPTIONS", "20000")
    assert not scheduling.lns_only(4, False, True, BIG)


def test_a_bad_value_falls_back_to_the_default(monkeypatch):
    monkeypatch.setenv("ENGINE_LNS_BELOW_WORKERS", "lots")
    monkeypatch.delenv("ENGINE_LNS_MIN_OPTIONS", raising=False)
    assert scheduling.lns_only(2, False, True, BIG)
