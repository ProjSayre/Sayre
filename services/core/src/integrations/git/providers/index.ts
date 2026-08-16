// W3-04 gapfill (GAP-6). The closed set of git provider adapters this build can
// register. Adding a provider is: one new adapter module in this directory + one entry
// here + a GIT_PROVIDER_CATALOG value. worker.ts, bullmq.ts, gitSyncService.ts, and
// packages/shared-types are all untouched.
//
// Deliberately a closed in-repo map rather than a config-supplied module path: a
// config-named import specifier is arbitrary code execution for anyone who can write
// configuration (.claude/rules/security-multitenancy.md). See spec.md's Open Question
// Q-1.

import type { GitProviderRegistration } from '../types';
import { GithubProviderAdapter } from './github';
import { FakeHubProviderAdapter } from './fakehub';

// Built with a null prototype (rather than a `{...}` object literal) so an indexed lookup
// against this manifest (providerCatalog.ts's `registrations[entry.provider]`) can never
// resolve an inherited Object.prototype member (e.g. "constructor", "toString") for a
// provider id that was never actually registered here — see W3-04 gapfill security finding
// FND-7c51522045f7.
const REGISTRATIONS: Record<string, GitProviderRegistration> = {
  github: { create: (context) => new GithubProviderAdapter({ context }) },
  fakehub: { create: () => new FakeHubProviderAdapter(), mockOnly: true },
};

export const GIT_PROVIDER_REGISTRATIONS: Readonly<Record<string, GitProviderRegistration>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, GitProviderRegistration>, REGISTRATIONS),
);
