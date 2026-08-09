// Tests scripts/generate-secret-denylist.mjs — the .agentignore -> permissions.deny generator.
//
// The pure functions (parseIgnoreFile / ruleTargetFor / denyRulesFor / mergeSettings /
// renderSettings) are exported, so most cases need no fixture repo. The two tests that assert
// something about *this* repository's real .agentignore are marked as such.
//
// Conventions follow scripts/generate-agent-shims.test.mjs: node:test, assert/strict.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  denyRulesFor,
  mergeSettings,
  parseIgnoreFile,
  renderSettings,
  ruleTargetFor,
} from './generate-secret-denylist.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');

test('parseIgnoreFile drops comments and blank lines and trims the rest', () => {
  const patterns = parseIgnoreFile('# a comment\n\n  .env  \n\n# another\n*.pem\n');
  assert.deepEqual(patterns, ['.env', '*.pem']);
});

test('parseIgnoreFile rejects a negation pattern rather than emitting a dead rule', () => {
  // Claude Code evaluates deny before allow and a deny rule cannot carry an exception, so a
  // `!` pattern would silently enforce nothing. Fail loudly instead.
  assert.throws(() => parseIgnoreFile('.env\n!.env.example\n'), /negation patterns are not supported/);
});

test('parseIgnoreFile reports the source line of a negation', () => {
  assert.throws(() => parseIgnoreFile('# c\n\n.env\n!.env.example\n'), /\.agentignore:4/);
});

test('ruleTargetFor anchors a bare pattern at any depth below the project root', () => {
  assert.equal(ruleTargetFor('.env'), '/**/.env');
  assert.equal(ruleTargetFor('*.pem'), '/**/*.pem');
});

test('ruleTargetFor anchors a slash-bearing pattern at the project root only', () => {
  // Mirrors gitignore: a slash anywhere but the end anchors the pattern to the containing dir.
  assert.equal(ruleTargetFor('infra/*.txt'), '/infra/*.txt');
  assert.equal(ruleTargetFor('a/b/c.key'), '/a/b/c.key');
});

test('ruleTargetFor never emits a doubled leading slash', () => {
  // `//path` means "absolute from the filesystem root" to Claude Code, which would silently
  // widen every rule far beyond the repository.
  assert.equal(ruleTargetFor('/infra/secret.txt'), '/infra/secret.txt');
  assert.ok(!ruleTargetFor('/infra/secret.txt').startsWith('//'));
});

test('ruleTargetFor treats a trailing-slash directory pattern as its directory', () => {
  assert.equal(ruleTargetFor('secrets/'), '/**/secrets');
});

test('denyRulesFor emits Read and Edit per pattern, in source order', () => {
  // Read-deny implies Edit-deny on current Claude Code, but Write and NotebookEdit are checked
  // against Edit(...) rules only, so the explicit Edit rule is load-bearing.
  assert.deepEqual(denyRulesFor(['.env', 'infra/*.txt']), [
    'Read(/**/.env)',
    'Edit(/**/.env)',
    'Read(/infra/*.txt)',
    'Edit(/infra/*.txt)',
  ]);
});

test('mergeSettings preserves deny entries this generator does not own', () => {
  const merged = mergeSettings(
    { permissions: { deny: ['Bash(curl *)', 'Read(/**/stale)'] } },
    ['Read(/**/.env)'],
  );
  assert.deepEqual(merged.permissions.deny, ['Bash(curl *)', 'Read(/**/.env)']);
});

test('mergeSettings removes a stale negated Read/Edit rule', () => {
  // Regression: the first version of OWNED_RULE matched /^(?:Read|Edit)\(/ and so treated
  // `!Read(...)` as foreign, preserving a rule that enforces nothing into the committed
  // settings file — a dead rule that reads like a working exception.
  const merged = mergeSettings(
    { permissions: { deny: ['!Read(/**/.env.example)', '!Edit(/**/.env.example)'] } },
    ['Read(/**/.env)'],
  );
  assert.deepEqual(merged.permissions.deny, ['Read(/**/.env)']);
});

test('mergeSettings leaves unrelated settings keys untouched', () => {
  // .claude/settings.json also carries the PreToolUse hook that enforces read-only checker
  // stages (PL-03g). Dropping it while regenerating a deny list would silently disable that.
  const hooks = { PreToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'x' }] }] };
  const merged = mergeSettings({ hooks, permissions: { deny: [], allow: ['Read(//tmp/**)'] } }, [
    'Read(/**/.env)',
  ]);
  assert.deepEqual(merged.hooks, hooks);
  assert.deepEqual(merged.permissions.allow, ['Read(//tmp/**)']);
});

test('mergeSettings copes with a settings file that has no permissions block', () => {
  const merged = mergeSettings({ hooks: {} }, ['Read(/**/.env)']);
  assert.deepEqual(merged.permissions.deny, ['Read(/**/.env)']);
});

test('renderSettings emits 2-space JSON with a trailing newline', () => {
  const rendered = renderSettings({ permissions: { deny: ['Read(/**/.env)'] } });
  assert.ok(rendered.endsWith('\n'));
  assert.ok(rendered.includes('\n  "permissions"'));
  assert.ok(!rendered.includes('\r'));
});

// --- assertions about this repository's real .agentignore ---

/**
 * Minimal gitignore-glob matcher, used only to assert what this repo's own patterns do NOT
 * match. Deliberately not a general implementation: `*` matches within one path segment.
 */
function patternMatches(pattern, candidate) {
  const source = pattern
    .split('')
    .map((character) => {
      if (character === '*') return '[^/]*';
      return /[.+?^${}()|[\]\\]/.test(character) ? `\\${character}` : character;
    })
    .join('');
  return new RegExp(`^${source}$`).test(candidate);
}

test('no pattern matches a .env.example template', () => {
  // The guarantee that keeps onboarding working. Deny rules cannot carry exceptions, so the
  // only protection for the tracked placeholder templates is that nothing matches them. If
  // someone adds `.env.*` to .agentignore, this fails.
  const patterns = parseIgnoreFile(readFileSync(resolve(repoRoot, '.agentignore'), 'utf8'));
  for (const candidate of ['.env.example', 'infra/.env.example']) {
    const basename = candidate.split('/').pop();
    for (const pattern of patterns) {
      assert.ok(
        !patternMatches(pattern, basename) && !patternMatches(pattern, candidate),
        `.agentignore pattern "${pattern}" would block "${candidate}", which must stay readable`,
      );
    }
  }
});

test('the real .agentignore still covers the env and key files it is meant to', () => {
  const patterns = parseIgnoreFile(readFileSync(resolve(repoRoot, '.agentignore'), 'utf8'));
  const covered = (candidate) => {
    const basename = candidate.split('/').pop();
    return patterns.some(
      (pattern) => patternMatches(pattern, basename) || patternMatches(pattern, candidate),
    );
  };
  for (const candidate of ['.env', 'infra/.env', '.env.local', 'github-app.pem', 'tls.key']) {
    assert.ok(covered(candidate), `${candidate} should be covered by .agentignore`);
  }
});
