/**
 * Graph paths are repository-relative POSIX paths.
 *
 * The repository root is the empty string. Every non-root path is already
 * canonical: it has no leading/trailing separator, duplicate separator,
 * backslash, dot segment, control character, or traversal segment.
 */
export const MAX_GRAPH_PATH_LENGTH = 4_096;

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

export function canonicalRelativePath(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length > MAX_GRAPH_PATH_LENGTH ||
    hasControlCharacter(value)
  ) {
    return null;
  }
  if (value === '') return value;
  if (
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('//') ||
    value.includes('\\')
  ) {
    return null;
  }
  const segments = value.split('/');
  return segments.some((segment) => segment === '.' || segment === '..')
    ? null
    : value;
}

export interface NormalizedPermissionPath {
  valid: boolean;
  pathPrefix: string | null;
}

/**
 * Accepts the historical optional outer slash at the persistence boundary,
 * then emits only the canonical relative representation used by graph nodes.
 * Empty and "/" both mean repository root and are represented by null.
 */
export function normalizePermissionPathPrefix(
  prefix: string | null,
): NormalizedPermissionPath {
  if (prefix === null) return { valid: true, pathPrefix: null };

  const value = prefix;
  if (value === '' || value === '/') {
    return { valid: true, pathPrefix: null };
  }

  if (value.startsWith('//') || value.endsWith('//')) {
    return { valid: false, pathPrefix: null };
  }

  const withoutLeadingSlash = value.startsWith('/') ? value.slice(1) : value;
  const candidate = withoutLeadingSlash.endsWith('/')
    ? withoutLeadingSlash.slice(0, -1)
    : withoutLeadingSlash;
  const canonical = canonicalRelativePath(candidate);
  return canonical !== null && canonical !== ''
    ? { valid: true, pathPrefix: canonical }
    : { valid: false, pathPrefix: null };
}
