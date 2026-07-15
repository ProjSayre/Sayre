import { describe, expect, it } from 'vitest';
import { parseViewport, ViewportParseError } from './viewport';

describe('parseViewport', () => {
  it('parses a fully specified viewport', () => {
    const viewport = parseViewport({ x: '1', y: '2', width: '100', height: '50', zoom: '2' });
    expect(viewport).toEqual({ x: 1, y: 2, width: 100, height: 50, zoom: 2 });
  });

  it('defaults zoom to 1 when absent', () => {
    const viewport = parseViewport({ x: 0, y: 0, width: 100, height: 100 });
    expect(viewport.zoom).toBe(1);
  });

  it('ignores extra/unknown query params', () => {
    const viewport = parseViewport({ x: 0, y: 0, width: 10, height: 10, orgId: 'attacker' });
    expect(viewport).toEqual({ x: 0, y: 0, width: 10, height: 10, zoom: 1 });
    expect((viewport as Record<string, unknown>).orgId).toBeUndefined();
  });

  it('throws when width is missing', () => {
    expect(() => parseViewport({ x: 0, y: 0, height: 10 })).toThrow(ViewportParseError);
  });

  it('throws when x is non-numeric', () => {
    expect(() => parseViewport({ x: 'abc', y: 0, width: 10, height: 10 })).toThrow(
      ViewportParseError,
    );
  });

  it('throws when width is 0', () => {
    expect(() => parseViewport({ x: 0, y: 0, width: 0, height: 10 })).toThrow(ViewportParseError);
  });

  it('throws when height is negative', () => {
    expect(() => parseViewport({ x: 0, y: 0, width: 10, height: -5 })).toThrow(
      ViewportParseError,
    );
  });

  it('throws when zoom is 0', () => {
    expect(() => parseViewport({ x: 0, y: 0, width: 10, height: 10, zoom: 0 })).toThrow(
      ViewportParseError,
    );
  });

  it('never reads orgId out of the query object', () => {
    const viewport = parseViewport({ x: 0, y: 0, width: 10, height: 10, orgId: 'evil-org' });
    expect(Object.keys(viewport)).not.toContain('orgId');
  });
});
