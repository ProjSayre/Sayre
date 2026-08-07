#!/usr/bin/env node

// W3-10 per-org credential gate — a SIBLING to scripts/check-secret-access.mjs
// (kept separate so that gate's env-access lexer stays untouched and each gate
// stays rigorous on its own narrow concern). Fails CI on any reference to the
// raw Jira OAuth token columns (`jiraAccessTokenEnc`/`jiraRefreshTokenEnc` /
// `jira_access_token_enc`/`jira_refresh_token_enc`) outside the three
// allowlisted files — every other consumer must resolve Jira credentials
// through `getOrgSecret`/`resolveJiraConnectionContext`
// (services/core/src/integrations/tickets/jira/orgSecrets.ts), never these
// columns directly (.claude/rules/security-multitenancy.md).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Only these files may reference the raw columns: the store that reads/
// writes them (encrypting/decrypting at the boundary), the org-scoped loader
// that performs the locked refresh dance, schema.ts's definition site, and
// the RLS test that asserts Postgres blocks cross-org raw reads at the
// database level (mirrors src/db/rls.test.ts's conventions) — that assertion
// is only meaningful if the test queries the raw columns directly, bypassing
// the application-layer store the same way a misconfigured policy would let
// a real cross-org read slip through.
const ALLOWLIST = new Set([
  'services/core/src/db/jiraConnectionStore.ts',
  'services/core/src/integrations/tickets/jira/orgSecrets.ts',
  'services/core/src/db/schema.ts',
  'services/core/src/db/jiraConnectionStore.rls.test.ts',
]);

// Same extensions/exclusions as scripts/check-secret-access.mjs.
const SOURCE_EXTENSION = /\.(?:ts|tsx|js|jsx|mjs|cjs|py)$/i;
const EXCLUDED_SEGMENT = /(?:^|\/)(?:node_modules|\.venv|venv|__pycache__|dist|build|coverage|generated|vendor)(?:\/|$)/i;

// Built via concatenation, not as one contiguous literal, so THIS file's own
// source never matches its own scan — mirrors check-secret-access.mjs's own
// avoidance of ever spelling its forbidden pattern out contiguously in its
// regex source (see that file's DIRECT_FORBIDDEN patterns).
const FORBIDDEN_IDENTIFIERS = [
  'jiraAccessToken' + 'Enc',
  'jiraRefreshToken' + 'Enc',
  'jira_access_token' + '_enc',
  'jira_refresh_token' + '_enc',
];

function trackedFiles() {
  const output = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
  return output.split('\0').filter(Boolean).map((file) => file.replaceAll('\\', '/'));
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Lighter regex-plus-comment-strip masking (spec.md "CI gate"): blanks line
 * and block comments (JS/TS) or `#` comments (Python) — replacing every
 * non-newline character with a space so line numbers stay stable — so
 * documentation that mentions these Jira-unique column names for guidance
 * (e.g. "never read jiraAccessTokenEnc directly") doesn't fail CI.
 *
 * Deliberately does NOT mask string/template literal content: a raw SQL
 * string or tagged template naming the column directly (e.g. a hand-rolled
 * `sql`select jira_refresh_token_enc ...`` in a non-allowlisted file) is
 * exactly the bypass this gate exists to catch, not a false positive to
 * suppress — these identifiers are unique enough that a real match is never
 * incidental prose.
 */
function maskComments(source, isPython) {
  const masked = source.split('');

  function blank(start, end) {
    for (let index = start; index < end; index += 1) {
      if (source[index] !== '\n' && source[index] !== '\r') masked[index] = ' ';
    }
  }

  if (isPython) {
    let index = 0;
    while (index < source.length) {
      if (source[index] === '#') {
        const start = index;
        while (index < source.length && source[index] !== '\n' && source[index] !== '\r') {
          index += 1;
        }
        blank(start, index);
        continue;
      }
      index += 1;
    }
    return masked.join('');
  }

  let index = 0;
  while (index < source.length) {
    if (source[index] === '/' && source[index + 1] === '/') {
      const start = index;
      index += 2;
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') {
        index += 1;
      }
      blank(start, index);
      continue;
    }
    if (source[index] === '/' && source[index + 1] === '*') {
      const start = index;
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        index += 1;
      }
      if (index < source.length) index += 2;
      blank(start, index);
      continue;
    }
    index += 1;
  }
  return masked.join('');
}

function violationLines(source, isPython) {
  const masked = maskComments(source, isPython);
  const lines = new Set();
  for (const identifier of FORBIDDEN_IDENTIFIERS) {
    const pattern = new RegExp(escapeRegExp(identifier), 'g');
    let match = pattern.exec(masked);
    while (match !== null) {
      lines.add(lineNumberAt(source, match.index));
      match = pattern.exec(masked);
    }
  }
  return lines;
}

const violations = [];
for (const file of trackedFiles()) {
  if (!SOURCE_EXTENSION.test(file) || EXCLUDED_SEGMENT.test(file) || ALLOWLIST.has(file)) {
    continue;
  }
  const source = readFileSync(file, 'utf8');
  const lines = violationLines(source, file.toLowerCase().endsWith('.py'));
  for (const line of [...lines].sort((a, b) => a - b)) violations.push(`${file}:${line}`);
}

if (violations.length > 0) {
  console.error(
    'Jira OAuth token columns may only be referenced from the allowlisted store/loader/schema files:',
  );
  for (const violation of violations) console.error(`  ${violation}`);
  process.exitCode = 1;
} else {
  console.log('Org-secret access gate passed.');
}
