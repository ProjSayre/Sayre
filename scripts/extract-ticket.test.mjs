// Smoke tests for scripts/extract-ticket.mjs — ticket-slice extraction for pipeline agents.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  extractBaseTemplate,
  extractTicketSection,
} from './extract-ticket.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(repoRoot, 'scripts', 'extract-ticket.mjs');

describe('extractTicketSection', () => {
  const sample = `# Backlog

### W0-00 — First
Body A

### W0-01 — Second
Body B

## Not a ticket
`;

  it('returns only the requested ticket block', () => {
    const slice = extractTicketSection(sample, 'W0-01');
    assert.match(slice, /### W0-01/);
    assert.match(slice, /Body B/);
    assert.doesNotMatch(slice, /Body A/);
    assert.doesNotMatch(slice, /W0-00/);
  });

  it('returns null when missing', () => {
    assert.equal(extractTicketSection(sample, 'W9-99'), null);
  });
});

describe('extractBaseTemplate', () => {
  it('pulls the fenced base template from the cheat sheet shape', () => {
    const md = `## 1 · Base template — prepend

\`\`\`
CONTEXT: hello
[ORIGINAL TICKET TEXT]
\`\`\`

## 2 · Overlays
`;
    const base = extractBaseTemplate(md);
    assert.match(base, /CONTEXT: hello/);
    assert.doesNotMatch(base, /## 2/);
  });
});

describe('extract-ticket CLI', () => {
  it('prints a real backlog ticket and fails closed on unknown ids', () => {
    const ok = spawnSync(process.execPath, [script, 'W2-04'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /### W2-04/);
    assert.doesNotMatch(ok.stdout, /### W2-01/);

    const bad = spawnSync(process.execPath, [script, 'W9-99'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /not found/);
  });

  it('--with-overlays refuses tickets absent from mvp-overlays.yml', () => {
    const res = spawnSync(process.execPath, [script, 'W9-01', '--with-overlays'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /mvp-overlays/);
  });
});
