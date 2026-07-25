import { describe, expect, it } from 'vitest';
import { canonicalRefName } from './refName';

describe('canonicalRefName', () => {
  it.each([
    ['refs/heads/main', 'refs/heads/main'],
    ['refs/tags/v1.0.0', 'refs/tags/v1.0.0'],
    ['main', null],
    [' refs/heads/main', null],
    ['refs/heads/release candidate', null],
    ['refs/heads/main\u0000other', null],
    [undefined, null],
    [['refs/heads/main'], null],
  ])('parses %j as %j', (value, expected) => {
    expect(canonicalRefName(value)).toBe(expected);
  });
});
