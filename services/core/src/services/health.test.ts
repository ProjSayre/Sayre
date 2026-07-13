import { describe, expect, it } from 'vitest';
import { getHealthStatus } from './health';

describe('getHealthStatus', () => {
  it('returns an ok status for the core service', () => {
    const result = getHealthStatus();
    expect(result.status).toBe('ok');
    expect(result.service).toBe('core');
    expect(typeof result.version).toBe('string');
    expect(typeof result.timestamp).toBe('string');
  });

  it('returns a fresh ISO timestamp on each call', () => {
    const first = getHealthStatus();
    const second = getHealthStatus();
    expect(() => new Date(first.timestamp).toISOString()).not.toThrow();
    expect(new Date(first.timestamp).toISOString()).toBe(first.timestamp);
    expect(new Date(second.timestamp).toISOString()).toBe(second.timestamp);
  });
});
