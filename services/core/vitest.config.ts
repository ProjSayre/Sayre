import { defineConfig } from 'vitest/config';

// node env (this package has no DOM/browser surface); longer hook timeout so the
// BullMQ round-trip integration test has time to spin up a real Redis-backed
// queue/worker pair instead of racing the broker.
export default defineConfig({
  test: {
    environment: 'node',
    hookTimeout: 20_000,
    testTimeout: 20_000,
    // src/db/ tests are node:test suites (run via `npm run test:rls`), not
    // vitest — excluding them here keeps the two runners from colliding.
    exclude: ['**/node_modules/**', 'src/db/**'],
  },
});
