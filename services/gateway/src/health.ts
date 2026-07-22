import type { HealthStatus } from '@sayre/shared-types';

// Liveness only — does NOT dial Redis/SQS/Core (mirrors services/core/src/services/health.ts's D-5 posture).
export function getGatewayHealth(): HealthStatus {
  return { status: 'ok', service: 'gateway', version: '0.1.0', timestamp: new Date().toISOString() };
}
