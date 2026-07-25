const CANONICAL_REF_RE = /^refs\/\S{1,1019}$/u;

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

/**
 * Accepts only an already-canonical full ref. Callers must not silently turn
 * arbitrary client input into a different branch.
 */
export function canonicalRefName(value: unknown): string | null {
  return typeof value === 'string' &&
    !containsControlCharacter(value) &&
    CANONICAL_REF_RE.test(value)
    ? value
    : null;
}
