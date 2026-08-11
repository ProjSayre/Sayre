// CH-06 red suite — the two architecture-rule guarantees, enforced against the
// chat directory's own source text rather than asserted in a comment.
//
// AC-15 (.claude/rules/security-multitenancy.md: node-level RBAC and traversal
// live only in the Graph Query Service) and AC-17 (no dangerouslySetInnerHTML,
// no anchor/href built from model or citation text) are both properties of the
// shipped source, so this test reads the shipped source.
//
// Authored from .pipeline/spec.md before any implementation exists.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CHAT_DIR = fileURLToPath(new URL('.', import.meta.url));

const EXPECTED_MODULES = [
  'chatContract.ts',
  'answerMarkdown.ts',
  'citationTarget.ts',
  'chatClient.ts',
  'chatTranscript.ts',
  'ChatProvider.tsx',
  'AskSayrePanelBody.tsx',
  'ChatTranscriptList.tsx',
  'askSayreRenderers.tsx',
];

function sourceFiles(): string[] {
  return readdirSync(CHAT_DIR)
    .filter((name) => (name.endsWith('.ts') || name.endsWith('.tsx')) && !/\.test\.tsx?$/.test(name))
    .sort();
}

/**
 * Comments are stripped before the vocabulary scan so a module may legitimately
 * *explain* why it performs no authorization without tripping the guard. The
 * `[^:]` guard keeps `https://` out of the line-comment rule.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
    .join('\n');
}

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]!);
}

describe('chat directory source guarantees', () => {
  // @spec AC-17
  it('never injects HTML or constructs an anchor anywhere under app/workspace/chat', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = stripComments(readFileSync(join(CHAT_DIR, file), 'utf8'));
      expect(source, `${file} must not inject HTML`).not.toMatch(/dangerouslySetInnerHTML/);
      expect(source, `${file} must not build an href`).not.toMatch(/\bhref\b/);
      expect(source, `${file} must not render an anchor element`).not.toMatch(/<a[\s/>]/);
      expect(source, `${file} must not create an anchor element`).not.toMatch(/createElement\(\s*['"]a['"]/);
      expect(source, `${file} must not emit a javascript: url`).not.toMatch(/javascript:/i);
      expect(source, `${file} must not reach for innerHTML`).not.toMatch(/innerHTML/);
    }
  });

  // @spec AC-15
  it('performs no traversal, node-stripping, or permission predicate on the client', () => {
    const scanned = sourceFiles();
    expect(scanned.length, 'app/workspace/chat has no source to scan').toBeGreaterThan(0);
    for (const file of scanned) {
      const raw = readFileSync(join(CHAT_DIR, file), 'utf8');
      const source = stripComments(raw);
      for (const banned of [
        /\borgId\b/,
        /\borg_id\b/,
        /\brbac\b/i,
        /\bisAuthorized\b/,
        /\bcanAccess\b/,
        /\bhasPermission\b/,
        /\bpermissions?\b/i,
        /\bauthorize\w*\(/i,
      ]) {
        expect(source, `${file} must not carry ${banned} — RBAC belongs to the Graph Query Service`).not.toMatch(banned);
      }
      for (const specifier of importSpecifiers(source)) {
        expect(specifier, `${file} must not import a client-side graph algorithm`)
          .not.toMatch(/graphology|sigma|\/canvas(\/|$)/);
      }
    }
  });

  // @spec AC-16
  it('ships each module the panel is composed from', () => {
    const files = sourceFiles();
    for (const expected of EXPECTED_MODULES) {
      expect(files, `${expected} is missing from app/workspace/chat`).toContain(expected);
    }
  });
});
