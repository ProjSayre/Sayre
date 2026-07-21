import { defineConfig } from "drizzle-kit";

// This file is intentionally schema-generation-only. Credentialed migration
// execution goes through src/db/migrate.ts, which awaits the central secret loader
// before constructing a Postgres pool. Keeping credentials out of this synchronous
// CJS-loaded config avoids a second, sync-only secret path.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
