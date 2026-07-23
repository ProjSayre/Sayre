"""Vendor-neutral TTFC metric emitted when cold-start onboarding is ready."""

from __future__ import annotations

import logging
import math

from opentelemetry import metrics
from opentelemetry.metrics import Histogram, MeterProvider

TTFC_METRIC_NAME = "ttfc_cold_start_to_onboarding_ready_ms"
ORG_ID_ATTR = "org_id"
REPO_ID_ATTR = "repo_id"

_METER_NAME = "sayre_workers.telemetry.onboarding_metrics"
_cached_provider: MeterProvider | None = None
_cached_histogram: Histogram | None = None
logger = logging.getLogger(__name__)


def _get_histogram() -> Histogram:
    global _cached_provider, _cached_histogram
    provider = metrics.get_meter_provider()
    if _cached_histogram is None or _cached_provider is not provider:
        _cached_histogram = provider.get_meter(_METER_NAME).create_histogram(TTFC_METRIC_NAME)
        _cached_provider = provider
    return _cached_histogram


def record_onboarding_ready(org_id: str, repo_id: str, duration_ms: float) -> None:
    """Record one successful cold-start readiness observation."""
    if not org_id or not org_id.strip():
        raise ValueError("org_id must be a non-blank server-derived tenant identifier")
    if not repo_id or not repo_id.strip():
        raise ValueError("repo_id must be a non-blank server-derived repository identifier")
    if not math.isfinite(duration_ms) or duration_ms < 0:
        raise ValueError("duration_ms must be finite and non-negative")

    attributes = {ORG_ID_ATTR: org_id, REPO_ID_ATTR: repo_id}
    _get_histogram().record(duration_ms, attributes)
    logger.info(
        "%s=%s org_id=%s repo_id=%s",
        TTFC_METRIC_NAME,
        duration_ms,
        org_id,
        repo_id,
    )


def reset_instruments_cache() -> None:
    """Test hook for rebinding instruments to a fresh global provider."""
    global _cached_provider, _cached_histogram
    _cached_provider = None
    _cached_histogram = None
