#!/bin/sh
# Idempotent LocalStack topology for the Python worker/event fleet.
set -eu
rm -f /tmp/sayre-messaging-ready

RETENTION_SECONDS=1209600
MAX_RECEIVE_COUNT=5

create_standard_queue() {
  name=$1
  awslocal sqs create-queue --queue-name "$name" >/dev/null
  awslocal sqs get-queue-url --queue-name "$name" --query QueueUrl --output text
}

create_fifo_queue() {
  name=$1
  awslocal sqs create-queue \
    --queue-name "$name" \
    --attributes FifoQueue=true,ContentBasedDeduplication=false >/dev/null
  awslocal sqs get-queue-url --queue-name "$name" --query QueueUrl --output text
}

queue_arn() {
  awslocal sqs get-queue-attributes \
    --queue-url "$1" \
    --attribute-names QueueArn \
    --query Attributes.QueueArn \
    --output text
}

configure_dlq() {
  awslocal sqs set-queue-attributes \
    --queue-url "$1" \
    --attributes MessageRetentionPeriod="$RETENTION_SECONDS"
}

set_json_attribute() {
  queue_url=$1
  attribute_name=$2
  attribute_value=$3
  escaped_value=$(printf '%s' "$attribute_value" | sed 's/\\/\\\\/g; s/"/\\"/g')
  attributes=$(printf '{"%s":"%s"}' "$attribute_name" "$escaped_value")
  awslocal sqs set-queue-attributes \
    --queue-url "$queue_url" \
    --attributes "$attributes"
}

configure_source() {
  source_url=$1
  dlq_arn=$2
  redrive_policy=$(printf \
    '{"deadLetterTargetArn":"%s","maxReceiveCount":"%s"}' \
    "$dlq_arn" "$MAX_RECEIVE_COUNT")
  set_json_attribute "$source_url" RedrivePolicy "$redrive_policy"
}

# DLQs are created before sources so every source is configured atomically by this hook.
ingestion_dlq_url=$(create_fifo_queue ingestion-dlq.fifo)
realtime_dlq_url=$(create_standard_queue graph-updated-realtime-dlq)
enrichment_default_dlq_url=$(create_standard_queue enrichment-default-dlq)
enrichment_priority_dlq_url=$(create_standard_queue enrichment-onboarding-priority-dlq)
embedding_dlq_url=$(create_standard_queue embedding-upserts-dlq)
dynamic_coverage_dlq_url=$(create_standard_queue dynamic-coverage-refresh-dlq)
# CH-03: the "Ask Sayre" chat-turns lane is FIFO with its own FIFO DLQ, same
# 5-receive redrive policy and 14-day retention as every other lane.
chat_turns_dlq_url=$(create_fifo_queue chat-turns-dlq.fifo)

for dlq_url in \
  "$ingestion_dlq_url" \
  "$realtime_dlq_url" \
  "$enrichment_default_dlq_url" \
  "$enrichment_priority_dlq_url" \
  "$embedding_dlq_url" \
  "$dynamic_coverage_dlq_url" \
  "$chat_turns_dlq_url"; do
  configure_dlq "$dlq_url"
done

ingestion_url=$(create_fifo_queue ingestion.fifo)
realtime_url=$(create_standard_queue graph-updated-realtime)
enrichment_default_url=$(create_standard_queue enrichment-default)
enrichment_priority_url=$(create_standard_queue enrichment-onboarding-priority)
embedding_url=$(create_standard_queue embedding-upserts)
dynamic_coverage_url=$(create_standard_queue dynamic-coverage-refresh)
chat_turns_url=$(create_fifo_queue chat-turns.fifo)
create_standard_queue w0-04-selftest >/dev/null

configure_source "$ingestion_url" "$(queue_arn "$ingestion_dlq_url")"
configure_source "$realtime_url" "$(queue_arn "$realtime_dlq_url")"
configure_source "$enrichment_default_url" "$(queue_arn "$enrichment_default_dlq_url")"
configure_source "$enrichment_priority_url" "$(queue_arn "$enrichment_priority_dlq_url")"
configure_source "$embedding_url" "$(queue_arn "$embedding_dlq_url")"
configure_source "$dynamic_coverage_url" "$(queue_arn "$dynamic_coverage_dlq_url")"
# CH-03: chat-turns.fifo is produced by services/core and consumed by CH-04's
# Python worker. Deliberately no allow_topic/ensure_raw_subscription below —
# this lane is never subscribed to the graph-updated SNS topic (spec.md "Out").
configure_source "$chat_turns_url" "$(queue_arn "$chat_turns_dlq_url")"

topic_arn=$(awslocal sns create-topic --name graph-updated --query TopicArn --output text)

allow_topic() {
  queue_url=$1
  target_arn=$(queue_arn "$queue_url")
  policy=$(printf \
    '{"Version":"2012-10-17","Statement":[{"Sid":"AllowGraphUpdatedTopic","Effect":"Allow","Principal":{"Service":"sns.amazonaws.com"},"Action":"sqs:SendMessage","Resource":"%s","Condition":{"ArnEquals":{"aws:SourceArn":"%s"}}}]}' \
    "$target_arn" "$topic_arn")
  set_json_attribute "$queue_url" Policy "$policy"
}

ensure_raw_subscription() {
  endpoint_arn=$(queue_arn "$1")
  subscription_arn=$(awslocal sns list-subscriptions-by-topic \
    --topic-arn "$topic_arn" \
    --query "Subscriptions[?Endpoint=='$endpoint_arn'].SubscriptionArn | [0]" \
    --output text)
  if [ "$subscription_arn" = "None" ] || [ -z "$subscription_arn" ]; then
    subscription_arn=$(awslocal sns subscribe \
      --topic-arn "$topic_arn" \
      --protocol sqs \
      --notification-endpoint "$endpoint_arn" \
      --query SubscriptionArn \
      --output text)
  fi
  awslocal sns set-subscription-attributes \
    --subscription-arn "$subscription_arn" \
    --attribute-name RawMessageDelivery \
    --attribute-value true
}

allow_topic "$realtime_url"
allow_topic "$enrichment_default_url"
ensure_raw_subscription "$realtime_url"
ensure_raw_subscription "$enrichment_default_url"
touch /tmp/sayre-messaging-ready
