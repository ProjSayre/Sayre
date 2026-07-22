// Thin gateway-local accessors over @sayre/config — no new secret loader (this
// module resolves REDIS_*/AWS_*/JWT_SIGNING_KEY the same way services/core does,
// through the shared @sayre/config package). See ./redis/pubsub.ts and
// ./sqs/consumer.ts for where REDIS_*/AWS_*/SQS_ENDPOINT_URL are actually read.

import { getConfig } from '@sayre/config';

export function getGatewayPort(): number {
  const port = Number(getConfig('GATEWAY_PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('GATEWAY_PORT must be an integer between 1 and 65535.');
  }
  return port;
}

export function getRealtimeQueueName(): string {
  return getConfig('SQS_GRAPH_UPDATED_REALTIME_QUEUE');
}

export function getGatewayRedisChannel(): string {
  return getConfig('GATEWAY_REDIS_CHANNEL');
}

export function getCoreInternalBaseUrl(): string {
  return getConfig('CORE_INTERNAL_BASE_URL');
}
