// Unit tests for parseAuthCompleteHash: token extraction and the
// redirect_to open-redirect guard (mirrors core's
// src/auth/loginState.ts::isSafeRelativePath rules).

import { describe, expect, it } from 'vitest';
import { parseAuthCompleteHash } from './authComplete';

describe('parseAuthCompleteHash', () => {
  it('parses a token with no redirect_to, defaulting redirectTo to /', () => {
    const result = parseAuthCompleteHash('#token=abc.def.ghi');
    expect(result).toEqual({ token: 'abc.def.ghi', redirectTo: '/' });
  });

  it('parses a token and a valid redirect_to', () => {
    const result = parseAuthCompleteHash('#token=abc&redirect_to=%2Fdashboard');
    expect(result).toEqual({ token: 'abc', redirectTo: '/dashboard' });
  });

  it('works without a leading #', () => {
    const result = parseAuthCompleteHash('token=abc&redirect_to=%2Fx');
    expect(result).toEqual({ token: 'abc', redirectTo: '/x' });
  });

  it('returns token: null when there is no #token', () => {
    const result = parseAuthCompleteHash('');
    expect(result.token).toBeNull();
    expect(result.redirectTo).toBe('/');
  });

  it('forces redirectTo to / for an absolute URL', () => {
    const result = parseAuthCompleteHash(`#token=abc&redirect_to=${encodeURIComponent('https://evil.com')}`);
    expect(result.redirectTo).toBe('/');
  });

  it('forces redirectTo to / for a protocol-relative //evil.com', () => {
    const result = parseAuthCompleteHash(`#token=abc&redirect_to=${encodeURIComponent('//evil.com')}`);
    expect(result.redirectTo).toBe('/');
  });

  it('forces redirectTo to / for a backslash trick /\\evil', () => {
    const result = parseAuthCompleteHash(`#token=abc&redirect_to=${encodeURIComponent('/\\evil')}`);
    expect(result.redirectTo).toBe('/');
  });

  it('forces redirectTo to / for a path containing a scheme colon', () => {
    const result = parseAuthCompleteHash(`#token=abc&redirect_to=${encodeURIComponent('/x:y')}`);
    expect(result.redirectTo).toBe('/');
  });

  it('forces redirectTo to / for a path with control characters', () => {
    const result = parseAuthCompleteHash(`#token=abc&redirect_to=${encodeURIComponent('/a\nb')}`);
    expect(result.redirectTo).toBe('/');
  });

  it('forces redirectTo to / for an empty redirect_to', () => {
    const result = parseAuthCompleteHash('#token=abc&redirect_to=');
    expect(result.redirectTo).toBe('/');
  });

  it('accepts a nested safe relative path', () => {
    const result = parseAuthCompleteHash(`#token=abc&redirect_to=${encodeURIComponent('/a/b/c')}`);
    expect(result.redirectTo).toBe('/a/b/c');
  });
});
