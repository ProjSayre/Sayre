import { defineConfig } from 'vitest/config';

// node env (this package has no DOM/browser surface); longer hook timeout so the
// BullMQ round-trip integration test has time to spin up a real Redis-backed
// queue/worker pair instead of racing the broker.
export default defineConfig({
  test: {
    environment: 'node',
    hookTimeout: 20_000,
    testTimeout: 20_000,
    // The RLS suites under src/db/ are node:test suites (run via
    // `npm run test:rls*`), not vitest — excluded here so the two runners
    // don't collide. Narrowed to *rls*.test.ts specifically (not all of
    // src/db/**) so ordinary vitest-style tests that happen to live in this
    // directory, like agentSkillMdMigration.test.ts, still run as part of
    // the normal suite instead of silently never executing anywhere.
    exclude: ['**/node_modules/**', 'src/db/**/*rls*.test.ts'],
  },
});
