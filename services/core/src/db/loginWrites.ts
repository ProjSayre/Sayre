// Tenant-scoped writers for the "Sign in with GitHub" login/signup flow
// (AUTH-01). Every export here takes a `tx: Db` that the CALLER has already
// produced via `withOrgContext(db, orgId, fn)` (services/core/src/db/client.ts)
// — neither function opens its own transaction or sets `app.org_id` itself.
// Direct analog of `db/githubAppInstallWrites.ts` (same "caller owns the
// transaction" contract).
//
// Neither writer swallows a unique-violation error (Postgres error code
// 23505) — both propagate so loginService.ts's create-vs-resolve retry loop
// can branch on which constraint was violated (external_auth_id -> re-resolve
// the concurrent winner; organizations.slug -> retry with the next
// de-duplicated slug).

import type { Db } from './client';
import { organizations, users } from './schema';

/**
 * Insert the tenant-root org. RLS on `organizations` keys on `id` (organizations
 * IS the org — see schema.ts:60), so this passes WITH CHECK when the
 * surrounding withOrgContext set app.org_id === row.id.
 */
export async function insertOrganization(
  tx: Db,
  row: { id: string; name: string; slug: string },
): Promise<void> {
  await tx.insert(organizations).values({
    id: row.id,
    name: row.name,
    slug: row.slug,
  });
}

/** Insert the owner user for a freshly-created org. org_role = 'owner'. */
export async function insertOwnerUser(
  tx: Db,
  row: { orgId: string; email: string; name: string | null; externalAuthId: string },
): Promise<{ userId: string }> {
  const [inserted] = await tx
    .insert(users)
    .values({
      orgId: row.orgId,
      email: row.email,
      name: row.name,
      externalAuthId: row.externalAuthId,
      orgRole: 'owner',
    })
    .returning({ id: users.id });

  return { userId: inserted.id };
}
