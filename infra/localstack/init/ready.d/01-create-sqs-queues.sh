#!/bin/sh
# LocalStack ready-hook: provisions the baseline SQS queues for local dev.
# Runs once LocalStack's SQS service is ready (init/ready.d convention).
# Queues are per-work-type, NOT per-tenant — org_id lives in the message envelope,
# never in the queue name (see .claude/rules/security-multitenancy.md).
set -e

for q in ingestion enrichment graph-events w0-04-selftest; do
  awslocal sqs create-queue --queue-name "$q"
done
