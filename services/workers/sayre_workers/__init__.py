"""Sayre Python worker fleet (ingestion, semantic enrichment, retrieval/RAG).

First source package for `services/workers` (W0-06). See CLAUDE.md "Structure"
for the fleet's place in the overall system, and `sayre_workers.telemetry` for
the vector-store concurrency/latency instrumentation this ticket introduces.
"""
