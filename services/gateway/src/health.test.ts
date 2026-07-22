import { describe, expect, it } from 'vitest';
import { getGatewayHealth } from './health';

describe('getGatewayHealth', () => {
  it('returns { status: "ok", service: "gateway", ... } (AC8)', () => {
    const health = getGatewayHealth();
    expect(health.status).toBe('ok');
    expect(health.service).toBe('gateway');
    expect(health.version).toBe('0.1.0');
    expect(() => new Date(health.timestamp).toISOString()).not.toThrow();
  });
});
