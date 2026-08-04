import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

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

test('checker stages may write inside .pipeline/', () => {
  for (const agent of ['review', 'security-checker', 'security_checker', 'security']) {
    assert.equal(invoke(writePayload(agent, '.pipeline/review.md')).code, ALLOW, agent);
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

test('traversal out of .pipeline/ is blocked (the predecessor allowed this)', () => {
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
  for (const agent of ['dev', 'tester', 'planner', 'red', 'pr-review']) {
    assert.equal(invoke(writePayload(agent, 'services/core/src/index.ts')).code, ALLOW, agent);
  }
});

test('the main session (no agent_type) is unaffected', () => {
  assert.equal(invoke(writePayload(null, 'CLAUDE.md')).code, ALLOW);
});

test('Edit and NotebookEdit are guarded, not just Write', () => {
  assert.equal(invoke(writePayload('review', 'CLAUDE.md', 'Edit')).code, BLOCK);
  const notebook = { agent_type: 'review', cwd: REPO, tool_name: 'NotebookEdit', tool_input: { notebook_path: 'analysis.ipynb' } };
  assert.equal(invoke(notebook).code, BLOCK);
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
