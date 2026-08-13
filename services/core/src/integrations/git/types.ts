import type { NormalizedRepoEvent } from '@sayre/shared-types';
import type { SecretRef } from '@sayre/config';

export type ProviderRepoEvent = Omit<NormalizedRepoEvent, 'provider'> & {
  provider: string;
};

export interface GitIdentity {
  name: string | null;
  email: string | null;
  login: string | null;
}

export interface PullRequestMetadata {
  number: number;
  title: string | null;
  url: string | null;
  mergedAt: string;
}

export interface ProviderFileEdit {
  path: string;
  commitSha: string;
  commitMessage: string | null;
  editedAt: string;
  author: GitIdentity;
  pullRequest: PullRequestMetadata | null;
}

export interface ProviderChangeSet {
  refName: string | null;
  edits: ProviderFileEdit[];
  /** GAP-5: the provider payload is known to be an incomplete view of the change (e.g. a
   *  push payload truncated at GITHUB_PUSH_COMMIT_CAP). Default false. */
  truncated?: boolean;
  /** GAP-5: history on this ref was rewritten (force-push); ownership derived from a MERGE
   *  delta may now be stale and a scoped ownership rebuild is owed. Default false. */
  rebuildRequired?: boolean;
}

export interface GitProviderAdapter {
  readonly provider: string;
  resolveChanges(event: ProviderRepoEvent, occurredAt: string): Promise<ProviderChangeSet>;
}

/**
 * W3-04 gapfill (GAP-8). Provider-agnostic auth seam. Constructed by the catalog loader
 * (providerCatalog.ts), handed to every adapter factory, so a config-registered provider
 * can obtain credentials without a code edit.
 */
export interface GitProviderContext {
  readonly provider: string;
  /** null when the catalog entry declared no credential. */
  readonly credentialRef: SecretRef | null;
  /** Rejects with GitProviderCredentialError when credentialRef is null or unresolvable.
   *  Never includes the secret value (or the resolved value) in its error message. */
  resolveCredential(): Promise<string>;
}

export type GitProviderAdapterFactory = (context: GitProviderContext) => GitProviderAdapter;

/**
 * W3-04 gapfill (GAP-6). One entry in the closed, in-repo registration manifest
 * (providers/index.ts's GIT_PROVIDER_REGISTRATIONS) that the catalog loader resolves
 * GIT_PROVIDER_CATALOG entries against.
 */
export interface GitProviderRegistration {
  readonly create: GitProviderAdapterFactory;
  /** true => refused whenever NODE_ENV === 'production'. `fakehub` sets this. */
  readonly mockOnly?: boolean;
}
