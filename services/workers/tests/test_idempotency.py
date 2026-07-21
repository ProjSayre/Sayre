"""Broker-independent durable delivery-store tests."""

from datetime import datetime, timedelta, timezone

from workers.messaging.idempotency import SqliteDeliveryStore


def _future(seconds: float = 30) -> datetime:
    return datetime.now(timezone.utc) + timedelta(seconds=seconds)


def test_claim_busy_release_and_expired_reclaim(tmp_path):
    store = SqliteDeliveryStore(tmp_path / "claims.sqlite3")
    assert store.claim("queue-a", "key", "owner-a", _future()) == "acquired"
    assert store.claim("queue-a", "key", "owner-b", _future()) == "busy"
    store.release("queue-a", "key", "owner-a")
    assert store.claim("queue-a", "key", "owner-b", _future()) == "acquired"

    assert store.claim("queue-a", "expired", "owner-a", _future(0.01)) == "acquired"
    import time

    time.sleep(0.02)
    assert store.claim("queue-a", "expired", "owner-b", _future()) == "acquired"
    store.close()


def test_completion_survives_reopen_and_is_consumer_scoped(tmp_path):
    path = tmp_path / "claims.sqlite3"
    store = SqliteDeliveryStore(path)
    assert store.claim("realtime", "same-event", "a", _future()) == "acquired"
    assert store.complete("realtime", "same-event", "a")
    store.close()

    store = SqliteDeliveryStore(path)
    assert store.claim("realtime", "same-event", "b", _future()) == "completed"
    # The independent SNS enrichment subscription must process the same body once.
    assert store.claim("enrichment", "same-event", "c", _future()) == "acquired"
    assert store.complete("enrichment", "same-event", "c")
    store.close()

    store = SqliteDeliveryStore(path)
    assert store.claim("realtime", "same-event", "d", _future()) == "completed"
    assert store.claim("enrichment", "same-event", "e", _future()) == "completed"
    store.close()


def test_graph_watermark_is_consumer_scoped_and_monotonic(tmp_path):
    store = SqliteDeliveryStore(tmp_path / "claims.sqlite3")
    assert (
        store.claim(
            "realtime",
            "v2",
            "a",
            _future(),
            graph_scope_key="scope",
            graph_version=2,
        )
        == "acquired"
    )
    assert store.complete("realtime", "v2", "a")
    assert (
        store.claim(
            "realtime",
            "v1-new-key",
            "b",
            _future(),
            graph_scope_key="scope",
            graph_version=1,
        )
        == "stale"
    )
    assert (
        store.claim(
            "realtime",
            "v3",
            "c",
            _future(),
            graph_scope_key="scope",
            graph_version=3,
        )
        == "acquired"
    )
    assert (
        store.claim(
            "enrichment",
            "v1",
            "d",
            _future(),
            graph_scope_key="scope",
            graph_version=1,
        )
        == "acquired"
    )
    store.close()


def test_concurrent_versions_complete_out_of_order_preserve_maximum_watermark(tmp_path):
    """The protocol compares claims with the completed watermark, not active claims.

    Two versions may therefore be in flight concurrently. Completing the older one
    last must never move the durable watermark backwards.
    """
    store = SqliteDeliveryStore(tmp_path / "claims.sqlite3")
    assert (
        store.claim(
            "enrichment",
            "v2-active",
            "owner-v2",
            _future(),
            graph_scope_key="scope",
            graph_version=2,
        )
        == "acquired"
    )
    assert (
        store.claim(
            "enrichment",
            "v3-active",
            "owner-v3",
            _future(),
            graph_scope_key="scope",
            graph_version=3,
        )
        == "acquired"
    )
    assert store.complete("enrichment", "v3-active", "owner-v3")
    assert store.complete("enrichment", "v2-active", "owner-v2")
    assert (
        store.claim(
            "enrichment",
            "v3-redelivery",
            "owner-redelivery",
            _future(),
            graph_scope_key="scope",
            graph_version=3,
        )
        == "stale"
    )
    assert (
        store.claim(
            "enrichment",
            "v4-next",
            "owner-v4",
            _future(),
            graph_scope_key="scope",
            graph_version=4,
        )
        == "acquired"
    )
    store.close()


def test_renew_and_complete_are_owner_and_lease_fenced(tmp_path):
    store = SqliteDeliveryStore(tmp_path / "claims.sqlite3")
    assert store.claim("q", "key", "owner", _future()) == "acquired"
    assert not store.renew("q", "key", "other", _future())
    assert store.renew("q", "key", "owner", _future())
    assert not store.complete("q", "key", "other")
    assert store.complete("q", "key", "owner")
    store.close()
