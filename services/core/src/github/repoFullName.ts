// W1-02 gapfill (GAP-7 / AC-4): shared `owner/name` shape validator for GitHub's
// `repository.full_name`, called from webhooks/normalizeGithubEvent.ts before an
// (unauthenticated, attacker-reachable) webhook body's full_name is allowed to flow
// onward into path/URL construction (see github/appClient.ts's own
// `encodedRepositoryPath`, which enforces a similar but not identical shape on
// GitHub API responses rather than webhook bodies).

/** One `owner` or `name` segment: GitHub's own charset, 1..100 chars, no '/'. */
export const REPO_FULL_NAME_SEGMENT_RE = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * True iff `value` is a clean two-segment `owner/name`: exactly one '/', both
 * segments matching REPO_FULL_NAME_SEGMENT_RE, and neither segment '.' or '..'.
 * Rejects '../../evil', 'a/b/c', 'owner/', '/name', 'owner//name', and any segment
 * containing whitespace or a percent-escape.
 */
export function isValidRepoFullName(value: unknown): value is string {
  if (typeof value !== 'string') return false;

  const parts = value.split('/');
  if (parts.length !== 2) return false;

  return parts.every((segment) => {
    if (segment === '.' || segment === '..') return false;
    return REPO_FULL_NAME_SEGMENT_RE.test(segment);
  });
}
