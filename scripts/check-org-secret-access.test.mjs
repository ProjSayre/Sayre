import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';

const checker = resolve(dirname(fileURLToPath(import.meta.url)), 'check-org-secret-access.mjs');
const roots = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function fixtureRepo(files) {
  const root = mkdtempSync(resolve(tmpdir(), 'sayre-org-secret-gate-'));
  roots.push(root);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'gate@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Gate Test'], { cwd: root });
  for (const [path, contents] of Object.entries(files)) {
    const destination = resolve(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
  }
  execFileSync('git', ['add', '--force', '.'], { cwd: root });
  return root;
}

function run(root) {
  return spawnSync(process.execPath, [checker], { cwd: root, encoding: 'utf8' });
}

// Built via concatenation, not as one contiguous literal string, so THIS test
// file's own source never matches the gate it exercises (the same technique
// scripts/check-secret-access.test.mjs already uses for its own forbidden
// patterns, e.g. `['process', 'env'].join('.')`). Fixture file CONTENT below
// still ends up containing the full identifier once written to disk.
const camelAccess = ['jiraAccessToken', 'Enc'].join('');
const camelRefresh = ['jiraRefreshToken', 'Enc'].join('');
const snakeAccess = ['jira_access_token', '_enc'].join('');
const snakeRefresh = ['jira_refresh_token', '_enc'].join('');

// @spec AC-1
test('ignores tracked source files deleted from the worktree', () => {
  const root = fixtureRepo({
    'services/core/src/services/deleted.ts':
      `export const row = { ${camelAccess}: 'removed' };`,
    'services/core/src/services/clean.ts': 'export const answer = 42;',
  });
  rmSync(resolve(root, 'services/core/src/services/deleted.ts'));

  const result = run(root);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /passed/);
});

test('allows only the three allowlisted store/loader/schema files', () => {
  const root = fixtureRepo({
    'services/core/src/db/jiraConnectionStore.ts':
      `export const row = { ${camelAccess}: null, ${camelRefresh}: null };`,
    'services/core/src/integrations/tickets/jira/orgSecrets.ts':
      `export const columns = ['${snakeAccess}', '${snakeRefresh}'];`,
    'services/core/src/db/schema.ts':
      `export const jiraConnections = { ${camelAccess}: 'text', ${camelRefresh}: 'text' };`,
  });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /passed/);
});

test('reports a non-allowlisted service referencing the camelCase columns with file:line', () => {
  const root = fixtureRepo({
    'services/core/src/services/foo.ts':
      `export function readToken(row) {\n  return row.${camelAccess};\n}`,
  });
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /services\/core\/src\/services\/foo\.ts:2/);
});

test('reports a raw SQL string naming the snake_case column in a non-allowlisted file', () => {
  const root = fixtureRepo({
    'services/core/src/services/rawQuery.ts':
      `export const query = 'select ${snakeRefresh} from jira_connections';`,
  });
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /services\/core\/src\/services\/rawQuery\.ts:1/);
});

test('does not flag the identifier when it appears only in a comment', () => {
  const root = fixtureRepo({
    'services/core/src/services/documented.ts':
      `// Never read ${camelAccess} directly -- use getOrgSecret.\n` +
      `/* ${camelRefresh} is also off-limits here. */\n` +
      'export const ok = 1;',
    'services/workers/some_module.py':
      `# ${snakeAccess} must never be read outside the store.\n` +
      'value = 1',
  });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /passed/);
});

test('never echoes the identifier text itself to stderr', () => {
  const root = fixtureRepo({
    'services/core/src/services/foo.ts': `export const bad = { ${camelAccess}: 1 };`,
  });
  const result = run(root);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, new RegExp(camelAccess));
  assert.match(result.stderr, /foo\.ts:1/);
});

test('reports the Python snake_case column outside a comment', () => {
  const root = fixtureRepo({
    'services/workers/leak.py': `value = row["${snakeAccess}"]`,
  });
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /services\/workers\/leak\.py:1/);
});

test('excludes node_modules/dist/build/generated/vendor segments same as the sibling gate', () => {
  const root = fixtureRepo({
    'node_modules/some-pkg/index.js': `export const x = { ${camelAccess}: 1 };`,
    'services/core/dist/bundled.js': `export const x = { ${camelRefresh}: 1 };`,
  });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /passed/);
});
