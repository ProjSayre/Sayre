import type { HealthStatus } from '@sayre/shared-types';

// Business logic lives here (service-layer rule — .claude/rules/service-layer.md).
// Liveness only: this does NOT dial Neo4j/Postgres/Redis (D-5).
export function getHealthStatus(): HealthStatus {
  return { status: 'ok', service: 'core', version: '0.1.0', timestamp: new Date().toISOString() };
}
