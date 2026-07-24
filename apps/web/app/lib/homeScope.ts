const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF_RE = /^refs\/[^\s]{1,500}$/;

export function resolveHomeScope(searchParams?: {
  repoId?: string | string[];
  refName?: string | string[];
}): {
  repositoryId: string | null;
  refName: string;
} {
  const repositoryId =
    typeof searchParams?.repoId === 'string' && UUID_RE.test(searchParams.repoId)
      ? searchParams.repoId
      : null;
  const selectedRefName =
    typeof searchParams?.refName === 'string' && REF_RE.test(searchParams.refName)
      ? searchParams.refName
      : null;
  return {
    // A provider-state request is scoped by the complete tuple. A partial or
    // malformed URL selection leaves the structural fixture usable without
    // guessing a tenant-visible provider-state target.
    repositoryId: selectedRefName === null ? null : repositoryId,
    refName: selectedRefName ?? 'refs/heads/main',
  };
}
