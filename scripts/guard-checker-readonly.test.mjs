import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Tests for the PL-03g read-only guard.
 *
 * These matter more than a normal unit suite. A PreToolUse hook blocks on exit 2; every other
 * non-zero exit is a non-blocking error. So a guard that fails to load — a syntax error, a bad
 * import — exits 1 and enforces nothing, silently. That is indistinguishable from "no guard", and
 * it is exactly the failure this ticket exists to eliminate. The `loads at all` test below is the
 * canary; the rest verify behavior.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = join(HERE, 'guard-checker-readonly.mjs');
const REPO = resolve(HERE, '..');

/** Invokes the guard exactly as the hook runtime does: JSON on stdin, meaning in the exit code. */
function invoke(payload) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const result = spawnSync(process.execPath, [GUARD], { input, encoding: 'utf8' });
  return { code: result.status, stderr: (result.stderr ?? '').trim() };
}

function writePayload(agentType, filePath, toolName = 'Write') {
  const payload = { cwd: REPO, tool_name: toolName, tool_input: { file_path: filePath } };
  if (agentType !== null) payload.agent_type = agentType;
  return payload;
}

const ALLOW = 0;
const BLOCK = 2;

test('the guard loads and runs at all (canary: a broken guard exits 1 and enforces nothing)', () => {
  const { code } = invoke(writePayload('dev', 'services/core/src/index.ts'));
  assert.notEqual(code, 1, 'exit 1 means the script failed to load — the hook would silently allow everything');
  assert.equal(code, ALLOW);
});

// PL-04 / C2: combined with the OS-temp-directory allowance test that used to sit separately near
// the bottom of this file (same agent list, same ALLOW expectation, only the target path differs) —
// one table of writable locations, checked against every checker agent.
test('checker stages may write inside .pipeline/ and the OS temp directory', () => {
  const tempTarget = join(tmpdir(), 'sayre-guard-checker-readonly-test', 'scratch.json');
  for (const location of ['.pipeline/review.md', tempTarget]) {
    for (const agent of ['review', 'security-checker', 'security_checker', 'security', 'pr-review']) {
      assert.equal(invoke(writePayload(agent, location)).code, ALLOW, `${agent} @ ${location}`);
    }
  }
});

// --- pr-review (PL-03d/PL-03i): registered as read-only at the same time it is registered as a ----
// stage at all. Its own stage file (.sdd/stages/pr-review.md) explicitly warns this enforcement
// silently does not apply until pr-review is added to READ_ONLY_AGENTS — these tests are what
// "extend the test suite to cover the new agent type" (the wiring-pass task) actually means: the
// full set of guarantees review/security-checker already get, verified for pr-review too, not just
// a name added to a set with nothing checking it.

test('pr-review is read-only exactly like review/security-checker: allowed inside .pipeline/, blocked on source', () => {
  assert.equal(invoke(writePayload('pr-review', '.pipeline/pr-review.md')).code, ALLOW);
  const { code, stderr } = invoke(writePayload('pr-review', 'services/core/src/index.ts'));
  assert.equal(code, BLOCK);
  assert.match(stderr, /read-only/);
});

test('pr-review cannot escape .pipeline/ via traversal (the predecessor allowed this)', () => {
  for (const escape of ['.pipeline/../../etc/passwd', '.pipeline/../CLAUDE.md']) {
    assert.equal(invoke(writePayload('pr-review', escape)).code, BLOCK, escape);
  }
});

test('checker stages may write inside .pipeline/ given the native absolute path the tools actually pass', () => {
  // The predecessor guard pattern-matched the raw string and blocked this form, which meant
  // `review` could not write its own report once the guard was live.
  const nativeAbsolute = join(REPO, '.pipeline', 'review.md');
  assert.equal(invoke(writePayload('review', nativeAbsolute)).code, ALLOW, nativeAbsolute);
});

test('checker stages are blocked from writing source', () => {
  const { code, stderr } = invoke(writePayload('review', 'services/core/src/index.ts'));
  assert.equal(code, BLOCK);
  assert.match(stderr, /read-only/);
});

// PL-04 / C2: the first two escapes here also cover what used to be a separate, later test ("...is
// still blocked, not merely toward temp") added once .pipeline/-adjacent temp writes became allowed
// (G1/A1 below) — same agent, same two paths, so it added no assertion this test didn't already make.
test('traversal out of .pipeline/ is blocked (the predecessor allowed this), including after the OS-temp allowance below was added', () => {
  for (const escape of [
    '.pipeline/../../etc/passwd',
    '.pipeline/../CLAUDE.md',
    join('.pipeline', '..', 'scripts', 'guard-checker-readonly.mjs'),
  ]) {
    assert.equal(invoke(writePayload('review', escape)).code, BLOCK, escape);
  }
});

test('a sibling directory sharing the .pipeline prefix is not inside it', () => {
  for (const sibling of ['.pipeline-notes/x.md', '.pipelines/x.md']) {
    assert.equal(invoke(writePayload('review', sibling)).code, BLOCK, sibling);
  }
});

test('non-checker agents are unaffected — dev must be able to write code', () => {
  // Migrated: pr-review was listed here as unconstrained before it was a registered stage at all.
  // Now that PL-03d/PL-03i registers it in READ_ONLY_AGENTS (see the dedicated pr-review tests
  // above), leaving it in this list would assert the opposite of its own stage file's requirement —
  // the premise changed, so pr-review moved to the checker-stage tests instead of staying here.
  for (const agent of ['dev', 'tester', 'planner', 'red']) {
    assert.equal(invoke(writePayload(agent, 'services/core/src/index.ts')).code, ALLOW, agent);
  }
});

test('the main session (no agent_type) is unaffected', () => {
  assert.equal(invoke(writePayload(null, 'CLAUDE.md')).code, ALLOW);
});

// PL-04 / C2: merged with the pr-review-specific version of this test that used to sit near the
// pr-review section above — same two assertions, only the agent differed.
test('Edit and NotebookEdit are guarded, not just Write, for checker agents (review, pr-review)', () => {
  for (const agent of ['review', 'pr-review']) {
    assert.equal(invoke(writePayload(agent, 'CLAUDE.md', 'Edit')).code, BLOCK, agent);
    const notebook = { agent_type: agent, cwd: REPO, tool_name: 'NotebookEdit', tool_input: { notebook_path: 'analysis.ipynb' } };
    assert.equal(invoke(notebook).code, BLOCK, agent);
  }
});

test('fails closed when the payload cannot be parsed', () => {
  for (const junk of ['not json at all', '', '{"unterminated": ']) {
    const { code, stderr } = invoke(junk);
    assert.equal(code, BLOCK, JSON.stringify(junk));
    assert.match(stderr, /could not parse/);
  }
});

test('fails closed when a checker call has no resolvable target path', () => {
  const { code } = invoke({ agent_type: 'review', cwd: REPO, tool_name: 'Write', tool_input: {} });
  assert.equal(code, BLOCK);
});

test('an unknown agent_type is treated as unconstrained, not as a checker', () => {
  // Deliberate: the constrained set is a whitelist. A future stage is unconstrained until it is
  // added here, which is a visible omission rather than a silent over-block that breaks the
  // pipeline for everyone.
  assert.equal(invoke(writePayload('some-future-stage', 'services/core/src/index.ts')).code, ALLOW);
});

// --- G1 / A1: the OS temp directory is also writable for a checker stage --------------------------
//
// Before this change, a checker's only writable path was .pipeline/, which has no scratch space —
// so security-checker, needing one, found the OS temp directory blocked and fell back to Bash, the
// one write path this guard has never covered. A control that makes the compliant path impossible
// and the bypass convenient trains the habit of routing around the guard. Writing to temp cannot
// corrupt source, cause a review of a stale artifact, or forge a verdict — nothing downstream ever
// reads from there — and it does not widen the Bash hole, since anything reachable that way was
// already reachable. (The "checker stages may write inside the OS temp directory, for every checker
// agent" case now lives in the combined .pipeline/-and-temp table near the top of this file.)

test('a relative path that resolves into the OS temp directory is also allowed', () => {
  // Exercises the same resolve(cwd, targetPath) codepath a repo-relative Write call uses, just
  // landing outside the repo once resolved — not only an already-absolute temp path. `cwd` is the
  // real repo (NOT itself under the OS temp directory — see the C4 tests below for that case, which
  // this one must stay distinct from), and `file_path` is relative, computed to land inside temp via
  // ordinary `../` traversal, the same shape a real relative tool-call argument would take.
  const tempTarget = join(tmpdir(), 'sayre-guard-checker-readonly-test', 'scratch.json');
  const relativeFromRepo = relative(REPO, tempTarget);
  const payload = { agent_type: 'review', cwd: REPO, tool_name: 'Write', tool_input: { file_path: relativeFromRepo } };
  assert.equal(invoke(payload).code, ALLOW, relativeFromRepo);
});

test('the OS temp allowance does not widen anything inside the repo but outside .pipeline/', () => {
  // The fail-closed posture this guard exists for is completely unchanged: only the OS temp
  // directory gained a new allowance, not "anywhere outside .pipeline/."
  for (const outside of ['services/core/src/index.ts', 'CLAUDE.md', '.pipeline-notes/x.md', '.pipelines/x.md']) {
    const { code, stderr } = invoke(writePayload('review', outside));
    assert.equal(code, BLOCK, outside);
    assert.match(stderr, /read-only/);
  }
});

// --- C4 (review pass 1, Blocker 4): repo-containment must win when the checkout itself lives under
// the OS temp directory, or the temp allowance above swallows every path in the repo -----------------

test('[C4] a checkout that itself lives under the OS temp directory does NOT get the temp allowance: source outside .pipeline/ is still BLOCKED', () => {
  // Reproduction from review.md: cwd inside os.tmpdir() + a source file path used to ALLOW, because
  // resolve(cwd, targetPath) put the resolved target inside OS_TMP_ROOT too, by construction — the
  // temp allowance can't distinguish "real scratch space" from "the whole repo happens to be under
  // temp" without this check.
  const checkoutUnderTemp = join(tmpdir(), 'sayre-checkout-under-temp-test');
  const payload = { agent_type: 'review', cwd: checkoutUnderTemp, tool_name: 'Write', tool_input: { file_path: 'services/core/src/index.ts' } };
  const { code, stderr } = invoke(payload);
  assert.equal(code, BLOCK);
  assert.match(stderr, /read-only/);
});

test('[C4] a checkout under the OS temp directory still allows writes inside its own .pipeline/', () => {
  // The fix must not also break the ordinary, always-allowed case for a checkout in this location.
  const checkoutUnderTemp = join(tmpdir(), 'sayre-checkout-under-temp-test');
  const payload = { agent_type: 'review', cwd: checkoutUnderTemp, tool_name: 'Write', tool_input: { file_path: '.pipeline/review.md' } };
  assert.equal(invoke(payload).code, ALLOW);
});

test('[C4] a checkout whose cwd IS the OS temp root itself (not merely nested under it) also loses the temp allowance for source paths', () => {
  const payload = { agent_type: 'security-checker', cwd: tmpdir(), tool_name: 'Write', tool_input: { file_path: 'services/core/src/index.ts' } };
  const { code, stderr } = invoke(payload);
  assert.equal(code, BLOCK);
  assert.match(stderr, /read-only/);
});

test('[C4] a normal checkout (not under the OS temp directory) is unaffected by this fix — the temp allowance still applies', () => {
  const payload = { agent_type: 'review', cwd: REPO, tool_name: 'Write', tool_input: { file_path: join(tmpdir(), 'sayre-guard-c4-normal-checkout-test', 'scratch.json') } };
  assert.equal(invoke(payload).code, ALLOW);
});

// --- C4-mirror (security-precondition fix round, this branch — advisory finding 2): C4 above only ---
// ever guarded the checkout-nested-under-temp direction. Its unguarded mirror — the OS temp directory
// itself nested INSIDE the checkout (`TMP`/`TEMP` pointed at a path under the repo) — reproduced
// identically: `repoIsUnderOsTmp` is false in that configuration, so the old code let the temp
// allowance through unguarded. `os.tmpdir()` reads `TMP`/`TEMP`/`TMPDIR` at call time, and this guard
// resolves `OS_TMP_ROOT` at module load — so, unlike every other test in this file, these need to
// override the *environment* the guard process itself starts with, not just the payload.

/** Same shape as `invoke()` above, but spawns the guard with `env` overrides merged over the current
 * process's own environment — required to make `os.tmpdir()` (and therefore this file's own
 * `OS_TMP_ROOT`) resolve to a path the test controls, since that is computed once at the guard's own
 * module-load time from `TMP`/`TEMP`/`TMPDIR`, not from anything in the JSON payload. */
function invokeWithEnv(payload, env) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const result = spawnSync(process.execPath, [GUARD], { input, encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: result.status, stderr: (result.stderr ?? '').trim() };
}

test('[C4-mirror] TMP/TEMP pointed at a path INSIDE the checkout no longer ALLOWs a source-path write outside .pipeline/ — the exact mirror of C4, reproduced via the real env vars tmpdir() reads', () => {
  // Reproduction from the security finding: TMP="<repo>/.repo-tmp-scratch-test" TEMP=... previously
  // exited 0 (ALLOWED) against a source file outside .pipeline/, contradicting this file's own header
  // claim that anything resolving inside the repository but outside .pipeline/ is still blocked.
  const tempUnderRepo = join(REPO, '.repo-tmp-scratch-test');
  const payload = writePayload('review', 'services/core/src/index.ts');
  const { code, stderr } = invokeWithEnv(payload, { TMP: tempUnderRepo, TEMP: tempUnderRepo, TMPDIR: tempUnderRepo });
  assert.equal(code, BLOCK);
  assert.match(stderr, /read-only/);
});

test('[C4-mirror] the fix does not also break the ordinary, always-allowed case: .pipeline/ still writable when TMP/TEMP happen to point inside the checkout', () => {
  const tempUnderRepo = join(REPO, '.repo-tmp-scratch-test');
  const payload = writePayload('review', '.pipeline/review.md');
  const { code } = invokeWithEnv(payload, { TMP: tempUnderRepo, TEMP: tempUnderRepo, TMPDIR: tempUnderRepo });
  assert.equal(code, ALLOW);
});

test('[C4-mirror] a path genuinely inside the (repo-nested) OS temp directory, but outside .pipeline/, is still blocked — the mirror case is not a second, wider allowance', () => {
  const tempUnderRepo = join(REPO, '.repo-tmp-scratch-test');
  const payload = writePayload('review', join(tempUnderRepo, 'scratch.json'));
  const { code, stderr } = invokeWithEnv(payload, { TMP: tempUnderRepo, TEMP: tempUnderRepo, TMPDIR: tempUnderRepo });
  assert.equal(code, BLOCK);
  assert.match(stderr, /read-only/);
});

