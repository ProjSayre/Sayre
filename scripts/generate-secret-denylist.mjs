// Emits the Read()/Edit() entries of .claude/settings.json's permissions.deny from .agentignore.
//
// Usage:
//   node scripts/generate-secret-denylist.mjs            # writes .claude/settings.json
//   node scripts/generate-secret-denylist.mjs --check    # exit 1 + diff if the deny list is stale
//
// Why a generator rather than a hand-maintained deny list: .agentignore is meant to be the
// runtime-neutral statement of "secrets live here", but Claude Code has no .claudeignore — the
// only mechanism that actually enforces anything is permissions.deny. Two hand-maintained lists
// drift, and a drifted list is worse than no list, because it reads as coverage that isn't there.
// This script makes .agentignore load-bearing for the one runtime that can enforce it, and CI's
// --check makes the two provably identical.
//
// Behaviour notes, each of which is pinned by a test:
// - Only Read(...)/Edit(...) entries are owned by this script. Any other deny entry (a Bash(...)
//   rule, say) is preserved verbatim and in its original order, so this can coexist with rules
//   that have nothing to do with secret paths.
// - Both Read() and Edit() are emitted per pattern. Read-deny already implies Edit-deny in
//   Claude Code >= 2.1.208, but Write and NotebookEdit are checked against Edit(...) rules only,
//   so the explicit Edit rule is what stops an agent overwriting a key file on older builds and
//   via those two tools.
// - Patterns are anchored at the *project root* (a single leading slash), never at the process's
//   current directory. `Read(.env)` anchors at cwd, so launching an agent from a subdirectory
//   would silently stop covering the repo root. `/**/.env` cannot.
// - A `!` negation pattern is a hard failure. Claude Code evaluates deny before allow and a deny
//   rule cannot carry an exception, so a negation would silently enforce nothing.
// - Output uses `\n` line endings unconditionally so --check is byte-stable across platforms.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), '..');
const DEFAULT_IGNORE_PATH = join(repoRoot, '.agentignore');
const DEFAULT_SETTINGS_PATH = join(repoRoot, '.claude', 'settings.json');

// Also claims the `!`-prefixed forms. A negated Read()/Edit() rule enforces nothing (see
// parseIgnoreFile), so leaving one in place would be a dead rule masquerading as an exception —
// exactly the failure this generator exists to prevent. Owning it means regeneration deletes it.
const OWNED_RULE = /^!?(?:Read|Edit)\(/;

function fail(message) {
  process.stderr.write(`generate-secret-denylist: ${message}\n`);
  process.exit(1);
}

/**
 * Parse .agentignore into its meaningful patterns, dropping blank lines and comments.
 * Throws on a negation pattern rather than emitting a rule that would enforce nothing.
 */
export function parseIgnoreFile(text) {
  const patterns = [];
  const lines = text.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('!')) {
      throw new Error(
        `.agentignore:${index + 1}: negation patterns are not supported. Claude Code evaluates ` +
          `deny before allow and a deny rule cannot carry an exception, so "${line}" would ` +
          `silently enforce nothing. Narrow the positive patterns instead.`,
      );
    }
    patterns.push(line);
  }
  return patterns;
}

/**
 * Map one gitignore-style pattern to a permission-rule path anchored at the project root.
 *
 * Mirrors gitignore's own anchoring rule: a pattern containing a slash anywhere other than the
 * end is anchored to the file's directory (here, the repo root); a bare pattern matches at any
 * depth. A single leading `/` in the emitted rule means "relative to the settings source", which
 * for .claude/settings.json is the project root.
 */
export function ruleTargetFor(pattern) {
  const withoutTrailingSlash = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
  const anchored = withoutTrailingSlash.includes('/');
  const normalized = withoutTrailingSlash.replace(/^\/+/, '');
  return anchored ? `/${normalized}` : `/**/${normalized}`;
}

/** Build the full owned rule list, Read then Edit per pattern, in .agentignore order. */
export function denyRulesFor(patterns) {
  const rules = [];
  for (const pattern of patterns) {
    const target = ruleTargetFor(pattern);
    rules.push(`Read(${target})`, `Edit(${target})`);
  }
  return rules;
}

/**
 * Merge generated rules into an existing settings object without disturbing anything else.
 * Non-owned deny entries keep their relative order and precede the generated block.
 */
export function mergeSettings(settings, generatedRules) {
  const next = { ...settings };
  const permissions = { ...(next.permissions ?? {}) };
  const existingDeny = Array.isArray(permissions.deny) ? permissions.deny : [];
  const preserved = existingDeny.filter((rule) => !OWNED_RULE.test(String(rule)));
  permissions.deny = [...preserved, ...generatedRules];
  next.permissions = permissions;
  return next;
}

export function renderSettings(settings) {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function main(argv) {
  const checkMode = argv.includes('--check');
  const unknown = argv.filter((arg) => arg.startsWith('--') && arg !== '--check');
  if (unknown.length > 0) {
    fail(`unknown option(s): ${unknown.join(', ')}. Supported: --check`);
  }

  if (!existsSync(DEFAULT_IGNORE_PATH)) {
    fail('.agentignore does not exist. It is the source of truth for the secret deny list.');
  }
  if (!existsSync(DEFAULT_SETTINGS_PATH)) {
    fail('.claude/settings.json does not exist.');
  }

  let patterns;
  try {
    patterns = parseIgnoreFile(readFileSync(DEFAULT_IGNORE_PATH, 'utf8'));
  } catch (error) {
    fail(error.message);
  }
  if (patterns.length === 0) {
    fail('.agentignore contains no patterns. Refusing to emit an empty deny list.');
  }

  const current = readFileSync(DEFAULT_SETTINGS_PATH, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(current);
  } catch (error) {
    fail(`.claude/settings.json is not valid JSON: ${error.message}`);
  }

  const expected = renderSettings(mergeSettings(parsed, denyRulesFor(patterns)));

  if (checkMode) {
    if (current === expected) {
      process.stdout.write('Secret deny list is up to date.\n');
      return;
    }
    process.stderr.write(
      'generate-secret-denylist: .claude/settings.json is stale relative to .agentignore.\n' +
        'Run `npm run generate:agent-ignore` and commit the result.\n\n' +
        `--- .claude/settings.json (on disk)\n${current}\n` +
        `+++ .claude/settings.json (expected)\n${expected}\n`,
    );
    process.exit(1);
  }

  if (current === expected) {
    process.stdout.write('Secret deny list already up to date; nothing written.\n');
    return;
  }
  writeFileSync(DEFAULT_SETTINGS_PATH, expected, 'utf8');
  process.stdout.write(
    `Wrote ${denyRulesFor(patterns).length} deny rules from ${patterns.length} patterns.\n`,
  );
}

if (resolve(process.argv[1] ?? '') === resolve(__filename)) {
  main(process.argv.slice(2));
}
