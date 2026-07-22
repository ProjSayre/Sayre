import type { NormalizedRepoEvent } from '@sayre/shared-types';

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
}

export interface GitProviderAdapter {
  readonly provider: string;
  resolveChanges(event: ProviderRepoEvent, occurredAt: string): Promise<ProviderChangeSet>;
}
