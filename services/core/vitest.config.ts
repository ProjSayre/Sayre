import { defineConfig } from 'vitest/config';

// node env (this package has no DOM/browser surface); longer hook timeout so the
// BullMQ round-trip integration test has time to spin up a real Redis-backed
// queue/worker pair instead of racing the broker.
//
// fileParallelism: false (W0-04, GAP-3a/GAP-5) — bullmq.priority.test.ts asserts EXACT
// live-queue counts (getPrioritizedCount() === 21, getWaitingCount() === 0) on the same
// `github-sync` BullMQ queue that bullmq.roundtrip.test.ts obliterates/enqueues on.
// QUEUE_NAMES is a closed 3-name set every existing integration test already spans
// (bullmq.roundtrip.test.ts's own "all three physical queues" test uses all of them), so
// there is no spare queue name either file could move to instead. Vitest runs test FILES
// in parallel by default with no isolation between them beyond process/module scope, which
// is not enough when two files share live external state — this disables cross-FILE
// parallelism only (not in-file test concurrency), which is what actually makes both
// files' exact counts deterministic, in CI and in any local run that exercises both.
export default defineConfig({
  test: {
    environment: 'node',
    hookTimeout: 20_000,
    testTimeout: 20_000,
    fileParallelism: false,
    // The RLS suites under src/db/ are node:test suites (run via
    // `npm run test:rls*`), not vitest — excluded here so the two runners
    // don't collide. Narrowed to *rls*.test.ts specifically (not all of
    // src/db/**) so ordinary vitest-style tests that happen to live in this
    // directory, like agentSkillMdMigration.test.ts, still run as part of
    // the normal suite instead of silently never executing anywhere.
    exclude: ['**/node_modules/**', 'src/db/**/*rls*.test.ts'],
  },
});
