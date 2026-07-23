"""Trusted-envelope parsing for the enrichment worker.

org_id ALWAYS comes from `envelope.org_id` (server-resolved) -- a payload `org_id` is
never trusted (`.claude/rules/security-multitenancy.md`).
"""

from __future__ import annotations

from typing import Any

from messaging.envelope import MessageEnvelope
from sayre_workers.ingestion.models import GraphScope

from .models import LANE, EnrichmentJob, InvalidEnrichmentEventError

_ENRICHABLE_TYPES: dict[str, LANE] = {
    "graph.updated": "default",
    # D6 supersedes D1's mechanism: this worker's own parser no longer accepts
    # "onboarding.generate" at all. W2-08 built its own dedicated priority-lane
    # consumer (sayre_workers.enrichment.onboarding.parse_onboarding_generate) with
    # its own payload shape; reserving the type here too would let a second,
    # differently-shaped parser silently succeed on the same message type. If an
    # "onboarding.generate" envelope ever reaches this parser directly, it must raise
    # InvalidEnrichmentEventError (see events.py's docstring and the D6 regression-
    # guard test in test_enrichment.py).
}


def _record(value: object, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise InvalidEnrichmentEventError(f"{name} must be an object")
    return value


def _required_string(value: object, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise InvalidEnrichmentEventError(f"{name} must be a non-blank string")
    return value.strip()


def parse_enrichment_envelope(envelope: MessageEnvelope) -> EnrichmentJob:
    """Translate a trusted queue envelope into an enrichment job.

    Accepts only type 'graph.updated' (default lane). Does NOT accept
    'onboarding.generate' (D6 supersedes D1's mechanism): the priority lane is
    exclusively parsed by W2-08's own `parse_onboarding_generate`, whose payload shape
    differs from this parser's ('graph.updated' carries `full_rebuild`/
    `changed_paths`; 'onboarding.generate' carries `cold_start_started_at_ms` and
    neither of those). Priority-lane `EnrichmentJob`s are instead built directly by
    `onboarding_bridge.build_onboarding_generator`, bypassing this function entirely.
    org_id ALWAYS comes from envelope.org_id -- a payload org_id is ignored (see
    .claude/rules/security-multitenancy.md). Raises InvalidEnrichmentEventError on any
    other type (including 'onboarding.generate') or a missing scope field.
    """
    lane = _ENRICHABLE_TYPES.get(envelope.type)
    if lane is None:
        raise InvalidEnrichmentEventError("unsupported enrichment message type")

    payload = _record(envelope.payload, "payload")
    repository_id = _required_string(payload.get("repository_id"), "payload.repository_id")
    ref_name = _required_string(payload.get("ref_name"), "payload.ref_name")
    revision_sha = _required_string(payload.get("revision_sha"), "payload.revision_sha")

    full_rebuild = payload.get("full_rebuild", False)
    if not isinstance(full_rebuild, bool):
        raise InvalidEnrichmentEventError("payload.full_rebuild must be a boolean")

    raw_changed_paths = payload.get("changed_paths", [])
    if not isinstance(raw_changed_paths, list) or not all(
        isinstance(item, str) for item in raw_changed_paths
    ):
        raise InvalidEnrichmentEventError("payload.changed_paths must be a list of strings")

    # graph_scope_key/graph_version are top-level envelope fields, guaranteed present
    # for graph.updated by MessageEnvelope's own validation. Re-checked here anyway as
    # defense in depth, now that this is the only type this parser accepts.
    graph_scope_key = envelope.graph_scope_key
    graph_version = envelope.graph_version
    if graph_scope_key is None or graph_version is None:
        raise InvalidEnrichmentEventError(
            "enrichment envelope requires graph_scope_key and graph_version"
        )

    scope = GraphScope(
        org_id=envelope.org_id,
        repository_id=repository_id,
        ref_name=ref_name,
        revision_sha=revision_sha,
    )
    return EnrichmentJob(
        scope=scope,
        graph_scope_key=graph_scope_key,
        graph_version=graph_version,
        full_rebuild=full_rebuild,
        changed_paths=tuple(raw_changed_paths),
        lane=lane,
        trace_id=envelope.trace_id,
        idempotency_key=envelope.idempotency_key or envelope.message_id,
    )
