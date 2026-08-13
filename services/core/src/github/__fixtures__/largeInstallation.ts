// W7-01 — deterministic >=100-repo fixture installation, shared by the discovery/callback/
// reconcile end-to-end tests (spec.md's Scope "In" list: "A >=100-repo fixture install exercised
// end to end"; Approach step 14; Affected files -> Created). Not itself a test file — it produces
// a fake `GithubAppClient` whose `listInstallationReposPage` paginates a fixed repo list at
// `perPage` (default INSTALLATION_REPOS_PER_PAGE, i.e. the same 100 the real client defaults to),
// with a couple of "empty" repos (no default branch, no HEAD sha) mixed in so a consuming test
// can also exercise AC-5/EC-3's "registered but not enqueued" path without hand-rolling its own
// fixture. Generalizes the local `fixture()` + `makeGithubClient()` pair
// `githubInstallationDiscoveryService.test.ts` already uses for its own (non-shared,
// non-page-boundary-accurate) DI-mock tests.

import type { GithubAppClient, InstallationRepoPage, InstalledRepo } from '../appClient';

export const LARGE_INSTALLATION_DEFAULT_REPO_COUNT = 120;
/** Matches the real client's INSTALLATION_REPOS_PER_PAGE default. */
export const LARGE_INSTALLATION_PAGE_SIZE = 100;

const SHA_PLACEHOLDER = 'f'.repeat(40);

export interface LargeInstallationFixtureOptions {
  /** Total repos in the fake installation. Defaults to 120 (>=100, matching spec.md's Ticket
   *  Check: "we'll test with 120"). */
  repoCount?: number;
  /** Page size the fake client paginates at. Defaults to LARGE_INSTALLATION_PAGE_SIZE (100). */
  perPage?: number;
  /** 0-based indices (within the full repo list) that should come back as "empty" repos — no
   *  default branch, no HEAD sha (AC-5/EC-3: registered but never enqueued for parse). Defaults
   *  to two repos spread across the list so both land on different pages once repoCount > perPage. */
  emptyRepoIndices?: number[];
  /** Prefix for provider_repo_id / full_name, so two fixtures built for the same test file (e.g.
   *  two installations in one org) never collide on external id. */
  idPrefix?: string;
}

/** The full, ungraded repo list a fixture installation "has" on GitHub — independent of paging. */
export function makeLargeInstallationRepos(
  options: LargeInstallationFixtureOptions = {},
): InstalledRepo[] {
  const repoCount = options.repoCount ?? LARGE_INSTALLATION_DEFAULT_REPO_COUNT;
  const idPrefix = options.idPrefix ?? 'large';
  const emptyRepoIndices = new Set(
    options.emptyRepoIndices ?? [
      Math.floor(repoCount / 3),
      Math.floor((2 * repoCount) / 3),
    ],
  );
  return Array.from({ length: repoCount }, (_, index) => {
    const providerRepoId = `${idPrefix}-${index}`;
    const fullName = `acme-${idPrefix}/repo-${index}`;
    if (emptyRepoIndices.has(index)) {
      return {
        provider_repo_id: providerRepoId,
        full_name: fullName,
        default_branch: null,
        default_branch_head_sha: null,
      };
    }
    return {
      provider_repo_id: providerRepoId,
      full_name: fullName,
      default_branch: 'main',
      default_branch_head_sha: SHA_PLACEHOLDER,
    };
  });
}

/**
 * Deterministic fake `GithubAppClient` over a fixed >=100-repo list, paginating
 * `listInstallationReposPage` at `perPage` (default LARGE_INSTALLATION_PAGE_SIZE) exactly the way
 * the real client does (`hasNextPage` true iff the page came back full). `authorizeInstallation`,
 * `mintInstallationToken` and `getInstallationRepo` are unused by discovery and are stubbed only
 * so the fixture satisfies the full `GithubAppClient` interface for callback-path tests.
 */
export function makeLargeInstallationGithubClient(
  options: LargeInstallationFixtureOptions = {},
): GithubAppClient {
  const perPage = options.perPage ?? LARGE_INSTALLATION_PAGE_SIZE;
  const repos = makeLargeInstallationRepos(options);
  return {
    authorizeInstallation: async () => ({
      account_login: `acme-${options.idPrefix ?? 'large'}`,
      account_type: 'Organization',
    }),
    mintInstallationToken: async () => 'ghs_fake-large-installation-token',
    getInstallationRepo: async () => null,
    listInstallationReposPage: async (
      _installationId: number,
      page: number,
      requestedPerPage?: number,
    ): Promise<InstallationRepoPage> => {
      const size = requestedPerPage ?? perPage;
      const start = (page - 1) * size;
      const pageRepos = repos.slice(start, start + size);
      return {
        repos: pageRepos,
        page,
        hasNextPage: pageRepos.length === size,
        totalCount: repos.length,
      };
    },
  };
}
