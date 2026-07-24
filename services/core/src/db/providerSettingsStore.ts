import { and, eq, inArray } from 'drizzle-orm';
import type { ProviderKind, ProviderPurpose } from '@sayre/shared-types';
import { withOrgContext, type Db } from './client';
import { getRuntimeDb } from './installations';
import { modelProviderConfigs } from './schema';

export interface StoredProviderSetting {
  purpose: ProviderPurpose;
  provider: ProviderKind;
  model: string;
  endpointUrl: string | null;
  credentialRef: string | null;
  dimension: number | null;
  updatedAt: Date;
}

export interface StoredProviderSettingInput {
  purpose: ProviderPurpose;
  provider: ProviderKind;
  model: string;
  endpointUrl: string | null;
  credentialRef: string | null;
  dimension: number | null;
}

export interface ProviderSettingsStore {
  list(orgId: string): Promise<StoredProviderSetting[]>;
  upsert(orgId: string, setting: StoredProviderSettingInput): Promise<StoredProviderSetting>;
}

export interface PostgresProviderSettingsStoreDeps {
  getDb: () => Promise<Db>;
  withOrg: <T>(db: Db, orgId: string, fn: (tx: Db) => Promise<T>) => Promise<T>;
}

const defaultDeps: PostgresProviderSettingsStoreDeps = {
  getDb: getRuntimeDb,
  withOrg: withOrgContext,
};

function toStored(
  row: typeof modelProviderConfigs.$inferSelect,
): StoredProviderSetting {
  return {
    purpose: row.purpose as ProviderPurpose,
    provider: row.provider as ProviderKind,
    model: row.model,
    endpointUrl: row.endpointUrl,
    credentialRef: row.credentialRef,
    dimension: row.dimension,
    updatedAt: row.updatedAt,
  };
}

export class PostgresProviderSettingsStore implements ProviderSettingsStore {
  constructor(
    private readonly deps: PostgresProviderSettingsStoreDeps = defaultDeps,
  ) {}

  async list(orgId: string): Promise<StoredProviderSetting[]> {
    const db = await this.deps.getDb();
    return this.deps.withOrg(db, orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(modelProviderConfigs)
        .where(
          and(
            eq(modelProviderConfigs.orgId, orgId),
            // Defensive closed purpose set in addition to the database CHECK.
            inArray(modelProviderConfigs.purpose, ['generation', 'embedding']),
          ),
        );
      return rows
        .filter((row) => row.purpose === 'generation' || row.purpose === 'embedding')
        .map(toStored);
    });
  }

  async upsert(
    orgId: string,
    setting: StoredProviderSettingInput,
  ): Promise<StoredProviderSetting> {
    const db = await this.deps.getDb();
    return this.deps.withOrg(db, orgId, async (tx) => {
      const [row] = await tx
        .insert(modelProviderConfigs)
        .values({
          orgId,
          purpose: setting.purpose,
          provider: setting.provider,
          model: setting.model,
          endpointUrl: setting.endpointUrl,
          credentialRef: setting.credentialRef,
          dimension: setting.dimension,
          config: {},
        })
        .onConflictDoUpdate({
          target: [modelProviderConfigs.orgId, modelProviderConfigs.purpose],
          set: {
            provider: setting.provider,
            model: setting.model,
            endpointUrl: setting.endpointUrl,
            credentialRef: setting.credentialRef,
            dimension: setting.dimension,
            // Provider settings do not own adapter/resilience options. Preserve
            // the existing JSON so a UI selection cannot silently erase W3-08's
            // timeout, retry, circuit-breaker, or fallback policy.
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!row) {
        throw new Error('Provider settings upsert returned no row.');
      }
      return toStored(row);
    });
  }
}

export const providerSettingsStore: ProviderSettingsStore =
  new PostgresProviderSettingsStore();
