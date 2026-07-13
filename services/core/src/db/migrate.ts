// Programmatic migrator: applies services/core/drizzle/*.sql (in order) against
// the admin/superuser DATABASE_URL. Idempotent — Drizzle tracks applied
// migrations in its own bookkeeping table, so re-running is a no-op for
// already-applied migrations (no error, no duplicate work; see 0001's
// pg_roles existence guard for the same idempotency property at the SQL level).
//
// Runnable standalone: `npm --prefix services/core run db:migrate`

import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, createPool } from "./client";

async function main() {
  const pool = createPool();
  try {
    const db = createDb(pool);
    await migrate(db, { migrationsFolder: "./drizzle" });
    // eslint-disable-next-line no-console
    console.log("Migrations applied successfully.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exitCode = 1;
});
