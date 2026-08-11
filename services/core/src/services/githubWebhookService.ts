// Orchestration for the GitHub webhook receiver: validate -> resolve org -> normalize
// -> publish. Business logic lives here per .claude/rules/service-layer.md; the route
// (routes/githubWebhook.ts) is a thin HTTP adapter that only calls this function.
//
// Tenant-isolation invariant (.claude/rules/security-multitenancy.md): org_id is
// resolved ONLY from `github_app_installations` (installation id -> org), server-side,
// after signature validation succeeds. It is NEVER read from the webhook body — the
// normalizer never even looks at an org_id/organization/owner claim in the payload.

import type { NormalizedRepoEvent, RepoEventType } from '@sayre/shared-types';
import { getSecret } from '@sayre/config';
import { verifyGithubSignature, WebhookSignatureError } from '../webhooks/githubSignature';
import { githubWebhookIdempotencyKey } from '../webhooks/githubDeliveryIdentity';
import {
  MalformedGithubPayloadError,
  normalizeGithubEvent,
  type IgnoreReason,
  type NormalizationResult,
} from '../webhooks/normalizeGithubEvent';
import {
  parseInstallationRepositoriesEvent,
  type InstallationRepositoriesEvent,
} from '../webhooks/parseInstallationRepositoriesEvent';
import { makeEnvelope, type MessageEnvelope } from '../queue/envelope';
import { publishIngestionEvent } from '../queue/sqs';
import { enqueue } from '../queue/bullmq';
import { getRuntimeDb, resolveInstallationOrg } from '../db/installations';
import {
  applyInstallationLifecycleEvent,
  type InstallationLifecycleResult,
} from './githubInstallationLifecycleService';
import {
  applyInstallationRepositoriesEvent,
  type InstallationRepositoriesResult,
} from './githubInstallationRepositoriesService';

export class WebhookBadRequestError extends Error {
  constructor(message = 'Malformed GitHub webhook request.') {
    super(message);
    this.name = 'WebhookBadRequestError';
  }
}

export type WebhookOutcome =
  | { status: 'published'; type: RepoEventType; destinations: Array<'ingestion' | 'ownership'> }
  | {
      status: 'ignored';
      reason:
        | IgnoreReason
        | 'unknown_installation'
        | 'revoked_installation'
        | 'noop_action'
        | 'no_repositories';
    }
  | { status: 'installation'; result: InstallationLifecycleResult }
  | { status: 'installation_repositories'; result: InstallationRepositoriesResult };

export interface WebhookDeps {
  getWebhookSecret: () => Promise<string>; // default: getSecret('env://GITHUB_WEBHOOK_SECRET')
  resolveOrg: (installationId: number) => Promise<{ orgId: string; active: boolean } | null>;
  publishIngestion: (envelope: MessageEnvelope<NormalizedRepoEvent>) => Promise<void>;
  publishOwnership: (envelope: MessageEnvelope<NormalizedRepoEvent>) => Promise<void>;
  // W1-06: `installation` events (deleted/suspend/unsuspend) delegate here
  // instead of the normalize -> enqueue path. Default: applyInstallationLifecycleEvent.
  applyInstallationLifecycle: (input: {
    action: string;
    installationId: number;
  }) => Promise<InstallationLifecycleResult>;
  // W2-09: `installation_repositories` events (added/removed) delegate here, sibling to
  // `applyInstallationLifecycle` above. Default: applyInstallationRepositoriesEvent.
  applyInstallationRepositories: (
    input: InstallationRepositoriesEvent,
  ) => Promise<InstallationRepositoriesResult>;
}

const defaultDeps: WebhookDeps = {
  getWebhookSecret: () => getSecret('env://GITHUB_WEBHOOK_SECRET'),
  resolveOrg: async (installationId) =>
    resolveInstallationOrg(await getRuntimeDb(), installationId),
  publishIngestion: async (envelope) => {
    await publishIngestionEvent(envelope);
  },
  publishOwnership: async (envelope) => {
    await enqueue('github-sync', envelope, { jobId: envelope.idempotency_key });
  },
  applyInstallationLifecycle: (input) => applyInstallationLifecycleEvent(input),
  applyInstallationRepositories: (input) => applyInstallationRepositoriesEvent(input),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Validate signature FIRST, then parse/normalize/resolve-org/publish.
 * Throws WebhookSignatureError (→401) on signature failure, WebhookBadRequestError (→400) on
 * malformed JSON or missing X-GitHub-Event / X-GitHub-Delivery, and rethrows infra/publish errors
 * (→500). All other cases resolve to a WebhookOutcome (route responds 2xx).
 */
export async function handleGithubWebhook(
  input: { rawBody: Buffer; signature?: string; githubEvent?: string; deliveryId?: string },
  deps: Partial<WebhookDeps> = {},
): Promise<WebhookOutcome> {
  const resolvedDeps: WebhookDeps = { ...defaultDeps, ...deps };

  // (a) Resolve the secret exclusively via the loader. A loader failure (missing/empty
  // secret = misconfig) propagates as-is -> 500. Never logged.
  const secret = await resolvedDeps.getWebhookSecret();

  // (b) Signature FIRST. Nothing after this point can run for a bad signature — no
  // parse, no DB lookup, no publish.
  if (!verifyGithubSignature(input.rawBody, input.signature, secret)) {
    throw new WebhookSignatureError();
  }

  // (c) Required headers.
  const githubEvent = input.githubEvent?.trim();
  const deliveryId = input.deliveryId?.trim();
  if (!githubEvent || !deliveryId) {
    throw new WebhookBadRequestError();
  }

  // (d) Parse the raw bytes (only now that the signature is proven valid).
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody.toString('utf8'));
  } catch {
    throw new WebhookBadRequestError();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new WebhookBadRequestError();
  }

  // (d.5) W1-06: `installation` events (deleted/suspend/unsuspend/etc.) are a
  // lifecycle mutation, not a repo event — delegate to the lifecycle service
  // INSTEAD of the normalize -> resolve-org(active-gated) -> enqueue path
  // below. `normalizeGithubEvent` has no case for this event type, so it must
  // be intercepted here. installation.id / action missing or malformed is
  // treated the same as `no_installation` (2xx ignored, never throws).
  if (githubEvent === 'installation') {
    const body = parsed as Record<string, unknown>;
    const installation = isRecord(body.installation) ? body.installation : null;
    // GAP-6: mirror normalizeGithubEvent's extractInstallationId guard here — a plain
    // `typeof === 'number'` admits NaN straight through to applyInstallationLifecycle.
    const rawInstallationId = installation?.id;
    const installationId =
      typeof rawInstallationId === 'number' &&
      Number.isSafeInteger(rawInstallationId) &&
      rawInstallationId > 0
        ? rawInstallationId
        : null;
    if (installationId === null) {
      return { status: 'ignored', reason: 'no_installation' };
    }
    const action = typeof body.action === 'string' ? body.action : '';
    const result = await resolvedDeps.applyInstallationLifecycle({ action, installationId });
    return { status: 'installation', result };
  }

  // (d.6) W2-09: `installation_repositories` (added/removed via GitHub's Configure page)
  // is likewise a repository-catalog mutation, not a repo content event — delegate to
  // `applyInstallationRepositories` INSTEAD of the normalize -> resolve-org(active-gated)
  // -> enqueue path below. `normalizeGithubEvent` has no case for this event type either,
  // so it must be intercepted here, sibling to the `installation` branch above.
  if (githubEvent === 'installation_repositories') {
    const parsedRepositoriesEvent = parseInstallationRepositoriesEvent(
      parsed as Record<string, unknown>,
    );
    if ('ignored' in parsedRepositoriesEvent) {
      return { status: 'ignored', reason: parsedRepositoriesEvent.ignored };
    }
    const result = await resolvedDeps.applyInstallationRepositories(parsedRepositoriesEvent);
    return { status: 'installation_repositories', result };
  }

  // (e) Normalize. A structurally malformed but otherwise-supported event (missing
  // repository.id/full_name) is a 400, distinct from a routine "nothing to do" ignore.
  let normalized: NormalizationResult | { ignored: IgnoreReason };
  try {
    normalized = normalizeGithubEvent({
      githubEvent,
      deliveryId,
      parsed: parsed as Record<string, unknown>,
    });
  } catch (error) {
    if (error instanceof MalformedGithubPayloadError) {
      throw new WebhookBadRequestError();
    }
    throw error;
  }
  if ('ignored' in normalized) {
    return { status: 'ignored', reason: normalized.ignored };
  }
  const { event, destinations } = normalized;

  // (f) Resolve org server-side from the installation id — never from the payload.
  const resolved = await resolvedDeps.resolveOrg(Number(event.installation_id));
  if (!resolved) {
    return { status: 'ignored', reason: 'unknown_installation' };
  }
  if (!resolved.active) {
    return { status: 'ignored', reason: 'revoked_installation' };
  }

  // (g) event.repo.repo_id resolution against a registered repository is out of scope
  // for this ticket (W1-06 owns repository registration) — it stays null.

  // (h) Build the envelope. org_id is the resolved value only — never copied from the
  // payload, even if the payload carries a forged organization/org_id/owner claim.
  //
  // GAP-4: idempotency_key comes from the signed BYTES (githubWebhookIdempotencyKey),
  // never from X-GitHub-Delivery. The delivery id is not covered by the HMAC — anyone
  // who captures a valid (body, signature) pair could otherwise mint a fresh dedup
  // identity just by editing that header. deliveryId stays as trace_id / the
  // payload's own delivery_id for attribution only.
  const envelope = makeEnvelope<NormalizedRepoEvent>({
    org_id: resolved.orgId,
    type: `repo.${event.type}`,
    source: 'github-webhook',
    trace_id: deliveryId,
    idempotency_key: githubWebhookIdempotencyKey(input.rawBody),
    payload: event,
  });

  // (i) Publish per destinations. Await both regardless of outcome, then rethrow the
  // first failure so a partial success (one queue got it, the other didn't) still
  // surfaces as a 500 — GitHub retries the whole delivery, and idempotency de-dupes
  // on whichever queue already received it.
  const publishTasks: Array<Promise<void>> = [];
  if (destinations.includes('ingestion')) {
    publishTasks.push(resolvedDeps.publishIngestion(envelope));
  }
  if (destinations.includes('ownership')) {
    publishTasks.push(resolvedDeps.publishOwnership(envelope));
  }
  const results = await Promise.allSettled(publishTasks);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) {
    throw failure.reason;
  }

  // (j)
  return { status: 'published', type: event.type, destinations };
}
