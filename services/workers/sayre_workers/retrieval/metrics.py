"""Low-cardinality token-efficiency metrics for Graph-Guided RAG."""

from __future__ import annotations

import math
from typing import Protocol

from opentelemetry import metrics
from opentelemetry.metrics import Histogram, MeterProvider

CONTEXT_TOKENS_METRIC = "retrieval_context_tokens_used"
PROMPT_TOKENS_METRIC = "retrieval_prompt_tokens_used"
FULL_REPO_TOKENS_METRIC = "retrieval_full_repo_tokens"
TOKEN_REDUCTION_RATIO_METRIC = "retrieval_token_reduction_ratio"

_METER_NAME = "sayre_workers.retrieval"
_cached_provider: MeterProvider | None = None
_cached_instruments: tuple[Histogram, Histogram, Histogram, Histogram] | None = None


class TokenUsageRecorder(Protocol):
    def record(
        self,
        *,
        org_id: str,
        context_tokens: int,
        prompt_tokens: int,
        full_repo_tokens: int,
        reduction_ratio: float,
    ) -> None: ...


def _instruments() -> tuple[Histogram, Histogram, Histogram, Histogram]:
    global _cached_provider, _cached_instruments

    provider = metrics.get_meter_provider()
    if _cached_instruments is None or provider is not _cached_provider:
        meter = provider.get_meter(_METER_NAME)
        _cached_instruments = (
            meter.create_histogram(CONTEXT_TOKENS_METRIC),
            meter.create_histogram(PROMPT_TOKENS_METRIC),
            meter.create_histogram(FULL_REPO_TOKENS_METRIC),
            meter.create_histogram(TOKEN_REDUCTION_RATIO_METRIC),
        )
        _cached_provider = provider
    return _cached_instruments


class OpenTelemetryTokenUsageRecorder:
    def record(
        self,
        *,
        org_id: str,
        context_tokens: int,
        prompt_tokens: int,
        full_repo_tokens: int,
        reduction_ratio: float,
    ) -> None:
        if not org_id.strip():
            raise ValueError("retrieval metrics require a server-derived org_id")
        if (
            context_tokens < 0
            or prompt_tokens < 0
            or full_repo_tokens < 0
            or not math.isfinite(reduction_ratio)
            or reduction_ratio < 1.0
        ):
            raise ValueError("retrieval token metrics must be finite and non-negative")

        context, prompt, baseline, ratio = _instruments()
        attributes = {"org_id": org_id}
        context.record(context_tokens, attributes)
        prompt.record(prompt_tokens, attributes)
        baseline.record(full_repo_tokens, attributes)
        ratio.record(reduction_ratio, attributes)


def reset_retrieval_metrics_for_tests() -> None:
    global _cached_provider, _cached_instruments
    _cached_provider = None
    _cached_instruments = None
