import { and, eq } from 'drizzle-orm';
import type {
  ProviderJobReason,
  ProviderJobState,
  ProviderJobStatus,
  ProviderJobSurface,
} from '@sayre/shared-types';
import type { AuthContext } from '../auth/context';
import { createDb, createPoolFromSecret, type Db, withOrgContext } from '../db/client';
import { modelProviderJobStates, repositoryRefs } from '../db/schema';
import {
  canReadResource,
  PostgresPermissionStore,
  type PermissionStore,
  type ReadScope,
} from '../graph-query/permissions';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF_RE = /^refs\/[^\s]{1,500}$/;
const SURFACES = new Set<ProviderJobSurface>(['product', 'onboarding', 'chatbot']);
const STATUSES = new Set<ProviderJobStatus>(['generating', 'ready', 'degraded', 'failed']);
const REASONS = new Set<ProviderJobReason>([
  'timeout',
  'circuit_open',
  'provider_error',
  'retry_exhausted',
  'processing_error',
]);

export class ProviderJobStateInputError extends Error {
  constructor() {
    super('Invalid provider state request.');
    this.name = 'ProviderJobStateInputError';
  }
}

export class ProviderJobStateAccessDeniedError extends Error {
  constructor() {
    super('Provider state access denied.');
    this.name = 'ProviderJobStateAccessDeniedError';
  }
}

interface ProviderJobStateRow {
  repositoryId: string;
  refName: string;
  revisionSha: string;
  surface: string;
  status: string;
  reasonCode: string | null;
  updatedAt: Date;
}

export interface ProviderJobStateReader {
  find(
    orgId: string,
    repoId: string,
    refName: string,
    surface: ProviderJobSurface,
  ): Promise<ProviderJobStateRow | null>;
}

let defaultDbPromise: Promise<Db> | undefined;

async function getDefaultDb(): Promise<Db> {
  defaultDbPromise ??= createPoolFromSecret().then(createDb);
  return defaultDbPromise;
}

export class PostgresProviderJobStateReader implements ProviderJobStateReader {
  constructor(private readonly database: () => Promise<Db> = getDefaultDb) {}

  async find(
    orgId: string,
    repoId: string,
    refName: string,
    surface: ProviderJobSurface,
  ): Promise<ProviderJobStateRow | null> {
    const db = await this.database();
    const rows = await withOrgContext(db, orgId, (tx) =>
      tx
        .select({
          repositoryId: modelProviderJobStates.repositoryId,
          refName: modelProviderJobStates.refName,
          revisionSha: modelProviderJobStates.revisionSha,
          surface: modelProviderJobStates.surface,
          status: modelProviderJobStates.status,
          reasonCode: modelProviderJobStates.reasonCode,
          updatedAt: modelProviderJobStates.updatedAt,
        })
        .from(modelProviderJobStates)
        .innerJoin(
          repositoryRefs,
          and(
            eq(repositoryRefs.orgId, modelProviderJobStates.orgId),
            eq(repositoryRefs.repositoryId, modelProviderJobStates.repositoryId),
            eq(repositoryRefs.refName, modelProviderJobStates.refName),
            eq(repositoryRefs.revisionSha, modelProviderJobStates.revisionSha),
          ),
        )
        .where(
          and(
            eq(modelProviderJobStates.orgId, orgId),
            eq(modelProviderJobStates.repositoryId, repoId),
            eq(modelProviderJobStates.refName, refName),
            eq(modelProviderJobStates.surface, surface),
          ),
        )
        .limit(1),
    );
    return rows[0] ?? null;
  }
}

export interface ProviderJobStateDependencies {
  permissions: PermissionStore;
  states: ProviderJobStateReader;
}

const defaultDependencies: ProviderJobStateDependencies = {
  permissions: new PostgresPermissionStore(),
  states: new PostgresProviderJobStateReader(),
};

export function parseProviderJobStateQuery(query: {
  refName: unknown;
  surface: unknown;
}): { refName: string; surface: ProviderJobSurface } {
  if (typeof query.refName !== 'string' || !REF_RE.test(query.refName)) {
    throw new ProviderJobStateInputError();
  }
  if (typeof query.surface !== 'string' || !SURFACES.has(query.surface as ProviderJobSurface)) {
    throw new ProviderJobStateInputError();
  }
  return {
    refName: query.refName,
    surface: query.surface as ProviderJobSurface,
  };
}

function canSeeProviderState(scope: ReadScope, repoId: string, refName: string): boolean {
  return scope.allows.some((allow) =>
    canReadResource(scope, {
      repoId,
      refName,
      // Test an actually granted path. A more-specific matching deny still wins;
      // a deny beneath this path does not erase visibility of all authorized data.
      path: allow.pathPrefix ?? '',
    }),
  );
}

function mapRow(
  row: ProviderJobStateRow,
  expected: {
    repositoryId: string;
    refName: string;
    surface: ProviderJobSurface;
  },
): ProviderJobState {
  if (
    row.repositoryId !== expected.repositoryId ||
    row.refName !== expected.refName ||
    row.surface !== expected.surface
  ) {
    throw new Error('invalid provider state');
  }
  if (!SURFACES.has(row.surface as ProviderJobSurface)) throw new Error('invalid provider state');
  if (!STATUSES.has(row.status as ProviderJobStatus)) throw new Error('invalid provider state');
  if (row.reasonCode !== null && !REASONS.has(row.reasonCode as ProviderJobReason)) {
    throw new Error('invalid provider state');
  }
  if (
    ((row.status === 'generating' || row.status === 'ready') && row.reasonCode !== null) ||
    ((row.status === 'degraded' || row.status === 'failed') && row.reasonCode === null)
  ) {
    throw new Error('invalid provider state');
  }
  return {
    repositoryId: row.repositoryId,
    refName: row.refName,
    revisionSha: row.revisionSha,
    surface: row.surface as ProviderJobSurface,
    status: row.status as ProviderJobStatus,
    reasonCode: row.reasonCode as ProviderJobReason | null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getProviderJobState(
  repoId: string,
  query: { refName: string; surface: ProviderJobSurface },
  ctx: AuthContext,
  dependencies: ProviderJobStateDependencies = defaultDependencies,
): Promise<ProviderJobState | null> {
  if (!UUID_RE.test(repoId) || !REF_RE.test(query.refName) || !SURFACES.has(query.surface)) {
    throw new ProviderJobStateInputError();
  }

  const scope = await dependencies.permissions.getReadScope(ctx, repoId);
  if (!canSeeProviderState(scope, repoId, query.refName)) {
    throw new ProviderJobStateAccessDeniedError();
  }

  const row = await dependencies.states.find(ctx.orgId, repoId, query.refName, query.surface);
  return row === null
    ? null
    : mapRow(row, {
        repositoryId: repoId,
        refName: query.refName,
        surface: query.surface,
      });
}
