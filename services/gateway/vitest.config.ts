import { defineConfig } from 'vitest/config';

// node env (this package has no DOM/browser surface); longer hook timeout so the
// in-process e2e test (real `ws` client <-> gateway <-> fake Redis bus <-> fake
// Core) has time to settle without racing setTimeout-based auth timeouts.
export default defineConfig({
  test: {
    environment: 'node',
    hookTimeout: 20_000,
    testTimeout: 20_000,
    exclude: ['**/node_modules/**'],
  },
});
