#!/usr/bin/env node
// Extract a single ticket (and optional overlay framing) so pipeline agents never load an entire
// backlog or cheat-sheet markdown file into context.
//
// Usage:
//   node scripts/extract-ticket.mjs <TICKET-ID>
//   node scripts/extract-ticket.mjs <TICKET-ID> --with-overlays
//   node scripts/extract-ticket.mjs <TICKET-ID> --json
//
// Looks up ticket text in docs/product/Ticket-Backlog-by-Feature-2.md. Overlay framing comes
// from .sdd/mvp-overlays.yml plus the named sections of docs/product/Audit-Rebuild-Cheat-Sheet.md
// (base template only — never the whole cheat sheet).
//
// Exit 0 on success; 1 if the ticket id is missing / not found / overlays required but absent.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BACKLOG_CANDIDATES = ['docs/product/Ticket-Backlog-by-Feature-2.md'];
const CHEAT_SHEET_CANDIDATES = ['docs/product/Audit-Rebuild-Cheat-Sheet.md'];
const OVERLAYS_PATH = join(repoRoot, '.sdd', 'mvp-overlays.yml');

const KNOWN_FLAGS = new Set(['--with-overlays', '--json']);

function fail(msg) {
  process.stderr.write(`extract-ticket: ${msg}\n`);
  process.exit(1);
}

function readFirstExisting(candidates) {
  for (const rel of candidates) {
    const abs = join(repoRoot, rel);
    if (existsSync(abs)) return { path: abs, rel, text: readFileSync(abs, 'utf8') };
  }
  return null;
}

/** Slice from `### <id>` (or `### <id> —`) through the line before the next `### ` heading. */
export function extractTicketSection(markdown, ticketId) {
  const id = ticketId.trim();
  const headingRe = new RegExp(
    `^###\\s+${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|—|–|-|$)`,
    'im',
  );
  const lines = markdown.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^###\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trimEnd() + '\n';
}

/** Pull the fenced base-template block under "## 1 · Base template". */
export function extractBaseTemplate(cheatSheetMarkdown) {
  const marker = /##\s*1\s*·\s*Base template[\s\S]*?```\n([\s\S]*?)```/;
  const m = cheatSheetMarkdown.match(marker);
  if (!m) {
    const idx = cheatSheetMarkdown.search(/Base template/i);
    if (idx === -1) return null;
    const rest = cheatSheetMarkdown.slice(idx);
    const fence = rest.match(/```\n([\s\S]*?)```/);
    return fence ? fence[1].trimEnd() + '\n' : null;
  }
  return m[1].trimEnd() + '\n';
}

/** Pull a named overlay subsection's fenced block (e.g. INTERFACE-CONTRACT / SECURITY). */
export function extractOverlaySection(cheatSheetMarkdown, overlayKind) {
  const titles = {
    interface: /INTERFACE-CONTRACT TICKETS/,
    security: /SECURITY\s*\/\s*RBAC\s*\/\s*TENANT-ISOLATION TICKETS/,
    spot_check: /SPOT-CHECK CLAUSE/,
  };
  const title = titles[overlayKind];
  if (!title) return null;
  const idx = cheatSheetMarkdown.search(title);
  if (idx === -1) return null;
  const rest = cheatSheetMarkdown.slice(idx);
  const cut = rest.search(/\n###\s+[A-Z]|\n##\s*3\s*·/);
  const slice = cut === -1 ? rest : rest.slice(0, cut);
  const fence = slice.match(/```\n([\s\S]*?)```/);
  return fence ? fence[1].trimEnd() + '\n' : null;
}

function loadOverlaysYaml() {
  if (!existsSync(OVERLAYS_PATH)) fail(`.sdd/mvp-overlays.yml not found`);
  return yaml.load(readFileSync(OVERLAYS_PATH, 'utf8'));
}

function main() {
  const argv = process.argv.slice(2);
  const flags = [];
  let ticketId = null;
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      if (!KNOWN_FLAGS.has(arg)) fail(`unrecognized flag "${arg}" — known: ${[...KNOWN_FLAGS].join(', ')}`);
      flags.push(arg);
    } else if (!ticketId) {
      ticketId = arg;
    } else {
      fail(`unexpected argument "${arg}"`);
    }
  }
  if (!ticketId) fail('usage: node scripts/extract-ticket.mjs <TICKET-ID> [--with-overlays] [--json]');
  if (!/^W\d+-\d+[a-z]?$/i.test(ticketId)) {
    fail(`ticket id must look like W2-04 (got ${JSON.stringify(ticketId)})`);
  }
  ticketId = ticketId.replace(/^w/, 'W');

  const backlog = readFirstExisting(BACKLOG_CANDIDATES);
  if (!backlog) fail(`no backlog file found (tried ${BACKLOG_CANDIDATES.join(', ')})`);
  const section = extractTicketSection(backlog.text, ticketId);
  if (!section) fail(`ticket ${ticketId} not found in ${backlog.rel}`);

  const withOverlays = flags.includes('--with-overlays');
  const asJson = flags.includes('--json');

  let overlaysMeta = null;
  let framing = null;
  if (withOverlays) {
    const yamlDoc = loadOverlaysYaml();
    const entry = yamlDoc?.tickets?.[ticketId];
    if (!entry) {
      fail(
        `${ticketId} is not listed in .sdd/mvp-overlays.yml — ineligible for gapfill/scout; use /pipeline`,
      );
    }
    overlaysMeta = {
      overlays: entry.overlays ?? ['base'],
      securityRequired: entry.security_required !== false,
      auditFirst: Boolean(entry.audit_first) || (yamlDoc.audit_first ?? []).includes(ticketId),
      note: entry.note ?? null,
      spotCheck: yamlDoc.spot_checks?.[ticketId] ?? null,
    };
    const cheat = readFirstExisting(CHEAT_SHEET_CANDIDATES);
    if (!cheat) fail(`no cheat sheet found (tried ${CHEAT_SHEET_CANDIDATES.join(', ')})`);
    const base = extractBaseTemplate(cheat.text);
    if (!base) fail(`could not extract base template from ${cheat.rel}`);
    const parts = [`# Framing for ${ticketId}\n`, '## Base template\n', base];
    for (const kind of overlaysMeta.overlays) {
      if (kind === 'base') continue;
      if (kind === 'interface') {
        const block = extractOverlaySection(cheat.text, 'interface');
        if (block) parts.push('## INTERFACE-CONTRACT overlay\n', block);
      } else if (kind === 'security') {
        const block = extractOverlaySection(cheat.text, 'security');
        if (block) parts.push('## SECURITY overlay\n', block);
      } else if (kind === 'spot-check' || kind === 'spot_check') {
        parts.push(
          '## Spot-check clause\n',
          overlaysMeta.spotCheck ??
            extractOverlaySection(cheat.text, 'spot_check') ??
            '(no spot-check text found)\n',
        );
      }
    }
    if (overlaysMeta.note) parts.push('## Overlay note\n', overlaysMeta.note, '\n');
    framing = parts.join('\n');
  }

  if (asJson) {
    const out = {
      ticketId,
      backlogPath: backlog.rel,
      ticketMarkdown: section,
      overlays: overlaysMeta,
      framingMarkdown: framing,
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }

  process.stdout.write(`# Ticket ${ticketId}\n`);
  process.stdout.write(`Source: ${backlog.rel}\n\n`);
  process.stdout.write(section);
  if (framing) {
    process.stdout.write('\n---\n\n');
    process.stdout.write(framing);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
