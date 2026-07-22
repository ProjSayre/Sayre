import { afterEach, describe, expect, it } from 'vitest';
import { resetConfigForTests, setConfigOverrideForTests } from '@sayre/config';
import { getCoreInternalBaseUrl, getGatewayPort, getGatewayRedisChannel, getRealtimeQueueName } from './config';

afterEach(() => {
  resetConfigForTests();
});

describe('gateway config accessors', () => {
  it('resolves documented safe defaults', () => {
    expect(getGatewayPort()).toBe(4100);
    expect(getRealtimeQueueName()).toBe('graph-updated-realtime');
    expect(getGatewayRedisChannel()).toBe('sayre:graph.updated');
    expect(getCoreInternalBaseUrl()).toBe('http://localhost:4000');
  });

  it('respects overrides', () => {
    setConfigOverrideForTests('GATEWAY_PORT', '4200');
    expect(getGatewayPort()).toBe(4200);
  });

  it('throws when GATEWAY_PORT is out of range', () => {
    setConfigOverrideForTests('GATEWAY_PORT', '0');
    expect(() => getGatewayPort()).toThrow(/GATEWAY_PORT/);
  });
});
