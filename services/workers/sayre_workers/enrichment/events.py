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
    # Reserved for W2-08 (Decision D1): the priority lane's producer/payload shape is
    # owned by that ticket. This worker only reserves the type -> lane mapping and
    # routes it through the same EnrichmentService.handle as the default lane -- it
    # does not invent onboarding.generate's internals beyond what handle() needs.
    "onboarding.generate": "priority",
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

    Accepts type 'graph.updated' (default lane). Reserves and, when present, accepts
    the priority-lane type 'onboarding.generate' (W2-08) by mapping it to
    lane='priority' without inventing its internals (Decision D1) -- it is routed
    through the same handler. org_id ALWAYS comes from envelope.org_id -- a payload
    org_id is ignored (see .claude/rules/security-multitenancy.md). Raises
    InvalidEnrichmentEventError on any other type or a missing scope field.
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
    # for graph.updated by MessageEnvelope's own validation. They are not enforced by
    # MessageEnvelope for the reserved priority-lane type, so this is re-checked here.
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
