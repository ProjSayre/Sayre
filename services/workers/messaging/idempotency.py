"""Durable delivery claims for SQS consumers.

The SQLite implementation is a local-development/shared-volume reference. Production
multi-host workers must inject a shared durable implementation of ``DeliveryStore``;
there is deliberately no in-memory fallback.
"""

from __future__ import annotations

import os
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Protocol

ClaimStatus = Literal["acquired", "completed", "busy", "stale"]


class DeliveryStore(Protocol):
    """Consumer-scoped durable claim and graph-watermark contract."""

    def claim(
        self,
        consumer_id: str,
        idempotency_key: str,
        owner_id: str,
        lease_until: datetime,
        *,
        graph_scope_key: str | None = None,
        graph_version: int | None = None,
    ) -> ClaimStatus: ...

    def renew(
        self,
        consumer_id: str,
        idempotency_key: str,
        owner_id: str,
        lease_until: datetime,
    ) -> bool: ...

    def complete(self, consumer_id: str, idempotency_key: str, owner_id: str) -> bool: ...

    def release(self, consumer_id: str, idempotency_key: str, owner_id: str) -> None: ...


def _required(value: str, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must not be blank")
    return value


def _timestamp(value: datetime) -> float:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("lease_until must be timezone-aware")
    return value.astimezone(timezone.utc).timestamp()


def _validate_graph_pair(scope: str | None, version: int | None) -> None:
    if (scope is None) != (version is None):
        raise ValueError("graph_scope_key and graph_version must be supplied together")
    if scope is not None:
        _required(scope, "graph_scope_key")
    if version is not None and (
        isinstance(version, bool) or not isinstance(version, int) or version < 0
    ):
        raise ValueError("graph_version must be a nonnegative integer")


class SqliteDeliveryStore:
    """Transactional local reference store with consumer-scoped identities."""

    def __init__(self, path: str | os.PathLike[str]) -> None:
        db_path = Path(path)
        if str(db_path) != ":memory:":
            db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._closed = False
        self._connection = sqlite3.connect(
            str(db_path), timeout=5.0, isolation_level=None, check_same_thread=False
        )
        self._connection.execute("PRAGMA busy_timeout = 5000")
        self._connection.execute("PRAGMA journal_mode = WAL")
        self._connection.execute("PRAGMA synchronous = FULL")
        self._connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS delivery_claims (
                consumer_id TEXT NOT NULL,
                idempotency_key TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('processing', 'completed')),
                owner_id TEXT,
                lease_until REAL,
                graph_scope_key TEXT,
                graph_version INTEGER,
                PRIMARY KEY (consumer_id, idempotency_key)
            );
            CREATE TABLE IF NOT EXISTS graph_watermarks (
                consumer_id TEXT NOT NULL,
                graph_scope_key TEXT NOT NULL,
                graph_version INTEGER NOT NULL CHECK (graph_version >= 0),
                PRIMARY KEY (consumer_id, graph_scope_key)
            );
            """
        )

    def _begin(self) -> None:
        if self._closed:
            raise RuntimeError("Delivery store is closed.")
        self._connection.execute("BEGIN IMMEDIATE")

    def claim(
        self,
        consumer_id: str,
        idempotency_key: str,
        owner_id: str,
        lease_until: datetime,
        *,
        graph_scope_key: str | None = None,
        graph_version: int | None = None,
    ) -> ClaimStatus:
        consumer_id = _required(consumer_id, "consumer_id")
        idempotency_key = _required(idempotency_key, "idempotency_key")
        owner_id = _required(owner_id, "owner_id")
        lease_timestamp = _timestamp(lease_until)
        _validate_graph_pair(graph_scope_key, graph_version)
        now = datetime.now(timezone.utc).timestamp()
        if lease_timestamp <= now:
            raise ValueError("lease_until must be in the future")

        with self._lock:
            self._begin()
            try:
                row = self._connection.execute(
                    """SELECT status, owner_id, lease_until FROM delivery_claims
                       WHERE consumer_id = ? AND idempotency_key = ?""",
                    (consumer_id, idempotency_key),
                ).fetchone()
                if row is not None and row[0] == "completed":
                    self._connection.commit()
                    return "completed"
                if (
                    row is not None
                    and row[1] == owner_id
                    and row[2] is not None
                    and float(row[2]) > now
                ):
                    self._connection.execute(
                        """UPDATE delivery_claims SET lease_until = ?
                           WHERE consumer_id = ? AND idempotency_key = ? AND owner_id = ?""",
                        (lease_timestamp, consumer_id, idempotency_key, owner_id),
                    )
                    self._connection.commit()
                    return "acquired"
                if row is not None and row[2] is not None and float(row[2]) > now:
                    self._connection.commit()
                    return "busy"

                if graph_scope_key is not None:
                    watermark = self._connection.execute(
                        """SELECT graph_version FROM graph_watermarks
                           WHERE consumer_id = ? AND graph_scope_key = ?""",
                        (consumer_id, graph_scope_key),
                    ).fetchone()
                    if watermark is not None and graph_version is not None:
                        if graph_version <= int(watermark[0]):
                            self._connection.commit()
                            return "stale"

                self._connection.execute(
                    """INSERT INTO delivery_claims (
                           consumer_id, idempotency_key, status, owner_id, lease_until,
                           graph_scope_key, graph_version
                       ) VALUES (?, ?, 'processing', ?, ?, ?, ?)
                       ON CONFLICT (consumer_id, idempotency_key) DO UPDATE SET
                           status = 'processing', owner_id = excluded.owner_id,
                           lease_until = excluded.lease_until,
                           graph_scope_key = excluded.graph_scope_key,
                           graph_version = excluded.graph_version""",
                    (
                        consumer_id,
                        idempotency_key,
                        owner_id,
                        lease_timestamp,
                        graph_scope_key,
                        graph_version,
                    ),
                )
                self._connection.commit()
                return "acquired"
            except BaseException:
                self._connection.rollback()
                raise

    def renew(
        self,
        consumer_id: str,
        idempotency_key: str,
        owner_id: str,
        lease_until: datetime,
    ) -> bool:
        consumer_id = _required(consumer_id, "consumer_id")
        idempotency_key = _required(idempotency_key, "idempotency_key")
        owner_id = _required(owner_id, "owner_id")
        lease_timestamp = _timestamp(lease_until)
        now = datetime.now(timezone.utc).timestamp()
        if lease_timestamp <= now:
            raise ValueError("lease_until must be in the future")
        with self._lock:
            self._begin()
            try:
                cursor = self._connection.execute(
                    """UPDATE delivery_claims SET lease_until = ?
                       WHERE consumer_id = ? AND idempotency_key = ?
                         AND status = 'processing' AND owner_id = ? AND lease_until > ?""",
                    (lease_timestamp, consumer_id, idempotency_key, owner_id, now),
                )
                self._connection.commit()
                return cursor.rowcount == 1
            except BaseException:
                self._connection.rollback()
                raise

    def complete(self, consumer_id: str, idempotency_key: str, owner_id: str) -> bool:
        consumer_id = _required(consumer_id, "consumer_id")
        idempotency_key = _required(idempotency_key, "idempotency_key")
        owner_id = _required(owner_id, "owner_id")
        now = datetime.now(timezone.utc).timestamp()
        with self._lock:
            self._begin()
            try:
                row = self._connection.execute(
                    """SELECT graph_scope_key, graph_version FROM delivery_claims
                       WHERE consumer_id = ? AND idempotency_key = ?
                         AND status = 'processing' AND owner_id = ? AND lease_until > ?""",
                    (consumer_id, idempotency_key, owner_id, now),
                ).fetchone()
                if row is None:
                    self._connection.commit()
                    return False
                scope, version = row
                if scope is not None and version is not None:
                    self._connection.execute(
                        """INSERT INTO graph_watermarks (
                               consumer_id, graph_scope_key, graph_version
                           ) VALUES (?, ?, ?)
                           ON CONFLICT (consumer_id, graph_scope_key) DO UPDATE SET
                               graph_version = MAX(graph_watermarks.graph_version,
                                                   excluded.graph_version)""",
                        (consumer_id, scope, version),
                    )
                cursor = self._connection.execute(
                    """UPDATE delivery_claims
                       SET status = 'completed', owner_id = NULL, lease_until = NULL
                       WHERE consumer_id = ? AND idempotency_key = ?
                         AND status = 'processing' AND owner_id = ?""",
                    (consumer_id, idempotency_key, owner_id),
                )
                self._connection.commit()
                return cursor.rowcount == 1
            except BaseException:
                self._connection.rollback()
                raise

    def release(self, consumer_id: str, idempotency_key: str, owner_id: str) -> None:
        consumer_id = _required(consumer_id, "consumer_id")
        idempotency_key = _required(idempotency_key, "idempotency_key")
        owner_id = _required(owner_id, "owner_id")
        with self._lock:
            self._begin()
            try:
                self._connection.execute(
                    """DELETE FROM delivery_claims
                       WHERE consumer_id = ? AND idempotency_key = ?
                         AND status = 'processing' AND owner_id = ?""",
                    (consumer_id, idempotency_key, owner_id),
                )
                self._connection.commit()
            except BaseException:
                self._connection.rollback()
                raise

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._connection.close()

    def __enter__(self) -> "SqliteDeliveryStore":
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()
