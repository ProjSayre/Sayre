export {
  Neo4jOwnershipGraphStore,
  createOwnershipGraphStore,
  OWNERSHIP_FILE_MATCH_KEYS,
} from './graphOwnershipStore';
export type { OwnershipApplyResult, OwnershipGraphStore, OwnershipGraphWrite } from './graphOwnershipStore';
export { GitProviderRegistry, UnknownGitProviderError } from './providerRegistry';
export {
  GitRepositoryNotRegisteredError,
  PostgresGitRepositoryResolver,
} from './repositoryResolver';
export { GithubProviderAdapter, GithubGitSyncError } from './providers/github';
// W3-04 gapfill (GAP-7): fakehub must not be unexported — a config-registered mock
// provider that is missing from the barrel would be undiscoverable by anything that
// imports the git package surface rather than reaching into providers/fakehub directly.
export { FakeHubProviderAdapter } from './providers/fakehub';
export { GIT_PROVIDER_REGISTRATIONS } from './providers/index';
export {
  GitProviderCatalogError,
  GitProviderCredentialError,
  loadGitProviderRegistry,
  parseGitProviderCatalog,
} from './providerCatalog';
export type { GitProviderCatalogEntry } from './providerCatalog';
export { GIT_SYNC_JOB_OPTIONS } from './jobPolicy';
export {
  GIT_PROVIDER_REQUEST_TIMEOUT_MS,
  GIT_SYNC_TARGET_MS,
  GITHUB_PUSH_COMMIT_CAP,
  MAX_PULL_REQUEST_FILE_PAGES,
} from './budgets';
export { startGitSyncWorker } from './worker';
export type {
  GitIdentity,
  GitProviderAdapter,
  GitProviderAdapterFactory,
  GitProviderContext,
  GitProviderRegistration,
  ProviderChangeSet,
  ProviderFileEdit,
  ProviderRepoEvent,
  PullRequestMetadata,
} from './types';
