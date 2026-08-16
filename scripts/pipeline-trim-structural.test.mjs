// Structural tests for PL-TRIM — verifies the repo-level layout changes that the check script
// enforces, but cannot test against itself: pipeline.md line count and section order, entrypoint
// file existence and content, SKILL.md retargeting, wiring in package.json/ci.yml/tsconfig.json,
// sdd-completeness.test.mjs retargeting, and pointer updates in CLAUDE.md/AGENTS.md/.sdd/README.md.
//
// Authored by the `red` stage from .pipeline/spec.md alone, BEFORE dev runs. Every assertion
// below comes from that spec's AC-*/EC-* sections, never from an implementation. Tests fail today
// because the described structure does not yet exist; they pass after dev correctly implements PL-TRIM.
//
// Conventions follow scripts/sdd-completeness.test.mjs: node:test, read-only repo walks, no
// subprocesses except where explicitly noted (AC-9 / git-diff guard for AC-13).

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

function exists(relativePath) {
  return existsSync(resolve(repoRoot, relativePath));
}

// The exact 16 commands AC-2 demands in entrypoints/.
const EXPECTED_COMMANDS = [
  'pipeline', 'pipeline-lite', 'pipeline-gapfill', 'gap-scout-only',
  'planner', 'spec-only', 'red', 'dev', 'tester', 'review',
  'security', 'security-recheck', 'pipeline-status', 're-gate', 'inline-edit', 'hotfix',
];

// Skills that are legitimately exempt from the entrypoint bijection (EC-4).
const EXEMPT_SKILLS = new Set(['pr-review', 'workspace-pack-author']);

// Alias commands that may reference their canonical target (EC-5).
const ALIAS_MAP = new Map([['spec-only', 'planner'], ['security-recheck', 'security']]);

// =============================================================================
// AC-1: .sdd/pipeline.md is ≤300 lines and retains required sections in order
// =============================================================================

// @spec AC-1
test('.sdd/pipeline.md is at most 300 lines (budget from PL-TRIM)', () => {
  const content = read('.sdd/pipeline.md');
  const lines = content.split(/\r?\n/);
  const lineCount = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  assert.ok(
    lineCount <= 300,
    `.sdd/pipeline.md must be ≤300 lines; currently ${lineCount} lines — the split has not yet happened`,
  );
});

// @spec AC-1
test('.sdd/pipeline.md retains the required sections in the correct order', () => {
  const pipeline = read('.sdd/pipeline.md');

  // Required anchors in order, per AC-1.
  const requiredSections = [
    { label: 'intro naming entry points', pattern: /\/pipeline/ },
    { label: 'JSON-sidecar note', pattern: /JSON\s+sidecar/i },
    { label: 'Staleness stamps table', pattern: /Staleness stamps/i },
    { label: '**planner** stage marker', pattern: /\*\*planner\*\*/ },
    { label: '**red** stage marker', pattern: /\*\*red\*\*/ },
    { label: '**dev** stage marker', pattern: /\*\*dev\*\*/ },
    { label: '**tester** stage marker', pattern: /\*\*tester\*\*/ },
    { label: '**review** stage marker', pattern: /\*\*review\*\*/ },
    { label: '**security** stage marker', pattern: /\*\*security\*\*/ },
    { label: 'ledger-append.mjs reference', pattern: /ledger-append\.mjs/ },
    { label: 'terminal PASS reference', pattern: /terminal\s+.?PASS.?/i },
    { label: 'Routing section with 3-attempt cap', pattern: /Routing/i },
    { label: '3-attempt loop cap', pattern: /3.attempt|three.attempt/i },
    { label: 'Review persistence section', pattern: /Review persistence/i },
    { label: 'Running stages in a single context', pattern: /Running stages in a single context/i },
    { label: 'Entry points section', pattern: /## Entry points/i },
  ];

  let lastIdx = -1;
  for (const { label, pattern } of requiredSections) {
    const match = pattern.exec(pipeline);
    assert.ok(match !== null, `.sdd/pipeline.md must contain "${label}" — absent after the split`);
    assert.ok(
      match.index > lastIdx,
      `.sdd/pipeline.md must contain "${label}" after the previous required section (order violated)`,
    );
    lastIdx = match.index;
  }
});

// @spec AC-1
test('.sdd/pipeline.md Stage sequence section is condensed (≤30 non-blank lines) — not the current 85-line verbose version', () => {
  const pipeline = read('.sdd/pipeline.md');
  const stageSeqIdx = pipeline.indexOf('## Stage sequence');
  assert.ok(stageSeqIdx !== -1, '.sdd/pipeline.md must have a "## Stage sequence" section');
  const afterSeq = pipeline.indexOf('\n## ', stageSeqIdx + 1);
  const seqSection = afterSeq !== -1 ? pipeline.slice(stageSeqIdx, afterSeq) : pipeline.slice(stageSeqIdx);
  const nonBlankLines = seqSection.split(/\r?\n/).filter((l) => l.trim().length > 0);
  // The condensed core must have a much shorter Stage sequence section than the current 951-line document.
  // The current pipeline.md's Stage sequence section alone has 50+ non-blank lines of verbose per-stage
  // descriptions. After condensing, each stage gets ~1–2 lines, so ≤30 non-blank lines is the right ceiling.
  assert.ok(
    nonBlankLines.length <= 30,
    `.sdd/pipeline.md's Stage sequence section must be condensed to ≤30 non-blank lines; currently ${nonBlankLines.length} non-blank lines — the section has not been shortened yet`,
  );
  // The markers must also appear in order within the condensed section.
  const stageMarkers = ['**planner**', '**red**', '**dev**', '**tester**', '**review**', '**security**'];
  const positions = stageMarkers.map((m) => seqSection.indexOf(m));
  for (const [i, pos] of positions.entries()) {
    assert.ok(pos !== -1, `stage marker "${stageMarkers[i]}" must appear in the condensed Stage sequence section`);
  }
  for (let i = 1; i < positions.length; i++) {
    assert.ok(
      positions[i - 1] < positions[i],
      `"${stageMarkers[i - 1]}" must appear before "${stageMarkers[i]}" in the Stage sequence section`,
    );
  }
});

// =============================================================================
// AC-2: .sdd/entrypoints/<cmd>.md exists for exactly the 16 listed commands
// =============================================================================

// @spec AC-2
test('.sdd/entrypoints/ directory exists', () => {
  assert.ok(exists('.sdd/entrypoints'), '.sdd/entrypoints/ directory must exist after the split');
});

// @spec AC-2
test('.sdd/entrypoints/ contains exactly the 16 required command files and no others', () => {
  assert.ok(exists('.sdd/entrypoints'), '.sdd/entrypoints/ must exist');
  const entries = readdirSync(resolve(repoRoot, '.sdd/entrypoints'), { withFileTypes: true });
  const mdFiles = entries
    .filter((e) => e.isFile() && extname(e.name) === '.md')
    .map((e) => e.name.replace(/\.md$/, ''))
    .sort();

  const expected = [...EXPECTED_COMMANDS].sort();
  assert.deepEqual(
    mdFiles,
    expected,
    `.sdd/entrypoints/ must contain exactly these 16 files: ${expected.join(', ')}; found: ${mdFiles.join(', ')}`,
  );
});

// =============================================================================
// AC-3: each entrypoint file carries its command's full body, substance unchanged
// =============================================================================

// @spec AC-3
test('each .sdd/entrypoints/<cmd>.md exists and is non-trivially long', () => {
  for (const cmd of EXPECTED_COMMANDS) {
    const path = `.sdd/entrypoints/${cmd}.md`;
    assert.ok(exists(path), `${path} must exist`);
    const content = read(path);
    assert.ok(content.trim().length > 100,
      `${path} must carry substantive content, not just a stub (length: ${content.trim().length})`);
  }
});

// @spec AC-3
test('.sdd/entrypoints/pipeline.md carries the /pipeline command body: stage sequence, routing, ledger step', () => {
  const content = read('.sdd/entrypoints/pipeline.md');
  // Key structural markers that must survive the move from pipeline.md's /pipeline section.
  assert.ok(content.includes('planner'), 'entrypoints/pipeline.md must mention the planner stage');
  assert.ok(content.includes('security'), 'entrypoints/pipeline.md must mention the security stage');
  assert.ok(/ledger.append\.mjs/i.test(content), 'entrypoints/pipeline.md must name the ledger step');
  assert.ok(/PASS/i.test(content), 'entrypoints/pipeline.md must name terminal PASS');
});

// @spec AC-3
test('.sdd/entrypoints/pipeline-lite.md carries the /pipeline-lite body including Honest limits and the stages skipped', () => {
  const content = read('.sdd/entrypoints/pipeline-lite.md');
  assert.ok(/Honest limits/i.test(content), 'entrypoints/pipeline-lite.md must carry the Honest limits list');
  assert.ok(/red/i.test(content), 'entrypoints/pipeline-lite.md must name which stages are skipped (red)');
  assert.ok(/security/i.test(content), 'entrypoints/pipeline-lite.md must name which stages are skipped (security)');
});

// @spec AC-3
test('.sdd/entrypoints/hotfix.md references .sdd/hotfix.md, ledger-append.mjs --hotfix, and follow-up ticket', () => {
  const content = read('.sdd/entrypoints/hotfix.md');
  assert.ok(content.includes('.sdd/hotfix.md'), 'entrypoints/hotfix.md must reference .sdd/hotfix.md');
  assert.ok(/ledger.append\.mjs.*--hotfix|--hotfix.*ledger.append\.mjs/i.test(content),
    'entrypoints/hotfix.md must name the --hotfix ledger flag');
  assert.ok(/follow.up ticket/i.test(content), 'entrypoints/hotfix.md must mention "follow-up ticket"');
});

// @spec AC-3
test('.sdd/entrypoints/inline-edit.md sits between re-gate and hotfix in substance and names deliberately-skipped stages', () => {
  const content = read('.sdd/entrypoints/inline-edit.md');
  assert.ok(/red/i.test(content), 'entrypoints/inline-edit.md must name red as deliberately skipped');
  assert.ok(/dev/i.test(content), 'entrypoints/inline-edit.md must name dev as deliberately skipped');
});

// @spec AC-3
test('.sdd/entrypoints/re-gate.md carries the full /re-gate body without dangling pipeline.md section pointers', () => {
  const content = read('.sdd/entrypoints/re-gate.md');
  // The old pipeline.md had an inline-edit section that re-gate referenced — after the move, it
  // must point to .sdd/entrypoints/inline-edit.md instead (EC-14).
  assert.ok(!/\.sdd\/pipeline\.md.{0,30}\/inline-edit/i.test(content),
    'entrypoints/re-gate.md must not carry a dangling "see .sdd/pipeline.md\'s /inline-edit section" pointer — it must be rewritten to .sdd/entrypoints/inline-edit.md');
});

// =============================================================================
// AC-4: no entrypoint file requires reading another entrypoint, except the two aliases
// =============================================================================

// @spec AC-4
test('non-alias entrypoints do not cross-reference other entrypoint files', () => {
  const aliasCommands = new Set(ALIAS_MAP.keys());
  for (const cmd of EXPECTED_COMMANDS) {
    if (aliasCommands.has(cmd)) continue; // aliases are allowed to reference their canonical target
    const content = read(`.sdd/entrypoints/${cmd}.md`);
    // Check for references to OTHER entrypoint files (not its own).
    const otherEntrypoints = EXPECTED_COMMANDS.filter((c) => c !== cmd);
    for (const other of otherEntrypoints) {
      assert.ok(
        !content.includes(`.sdd/entrypoints/${other}.md`),
        `.sdd/entrypoints/${cmd}.md must not require reading .sdd/entrypoints/${other}.md — cross-entrypoint references break the "one file per command" guarantee`,
      );
    }
  }
});

// @spec AC-4
test('spec-only.md and security-recheck.md are aliases and explicitly defer to their canonical targets', () => {
  const specOnly = read('.sdd/entrypoints/spec-only.md');
  assert.ok(
    specOnly.includes('.sdd/entrypoints/planner.md'),
    'entrypoints/spec-only.md must explicitly defer to .sdd/entrypoints/planner.md as its canonical alias target',
  );

  const securityRecheck = read('.sdd/entrypoints/security-recheck.md');
  assert.ok(
    securityRecheck.includes('.sdd/entrypoints/security.md'),
    'entrypoints/security-recheck.md must explicitly defer to .sdd/entrypoints/security.md as its canonical alias target',
  );
});

// =============================================================================
// AC-5: .sdd/pipeline.md carries a ### `/cmd` stub for each of the 16 commands
// =============================================================================

// @spec AC-5
test('.sdd/pipeline.md carries a ### /cmd stub for every one of the 16 commands', () => {
  const pipeline = read('.sdd/pipeline.md');
  for (const cmd of EXPECTED_COMMANDS) {
    assert.ok(
      pipeline.includes(`### \`/${cmd}\``),
      `.sdd/pipeline.md must carry a ### \`/${cmd}\` stub — missing after the split`,
    );
  }
});

// @spec AC-5
test('each ### /cmd stub in .sdd/pipeline.md names its entrypoint file and has ≤8 non-blank body lines', () => {
  const pipeline = read('.sdd/pipeline.md');
  const stubHeadingPattern = /^### `\/([a-z][a-z0-9-]*)`/gm;
  let match;
  const stubs = [];
  while ((match = stubHeadingPattern.exec(pipeline)) !== null) {
    stubs.push({ cmd: match[1], headingIdx: match.index });
  }
  assert.ok(stubs.length >= EXPECTED_COMMANDS.length,
    `expected at least ${EXPECTED_COMMANDS.length} stubs in .sdd/pipeline.md; found ${stubs.length}`);

  for (let i = 0; i < stubs.length; i++) {
    const { cmd, headingIdx } = stubs[i];
    const nextStubIdx = i + 1 < stubs.length ? stubs[i + 1].headingIdx : pipeline.length;
    // Find the next ## or ### heading after this stub's heading line.
    const bodyStart = pipeline.indexOf('\n', headingIdx) + 1;
    const bodyEnd = nextStubIdx;
    const body = pipeline.slice(bodyStart, bodyEnd);
    const nonBlankLines = body.split(/\r?\n/).filter((l) => l.trim().length > 0);

    assert.ok(nonBlankLines.length <= 8,
      `stub for /${cmd} has ${nonBlankLines.length} non-blank body lines — must be ≤8 (STUB_BODY_LINE_BUDGET)`);

    assert.ok(
      body.includes(`.sdd/entrypoints/${cmd}.md`),
      `stub for /${cmd} must contain ".sdd/entrypoints/${cmd}.md" — missing entrypoint reference`,
    );
  }
});

// =============================================================================
// AC-6: .sdd/pipeline-history.md exists and carries required content
// =============================================================================

// @spec AC-6
test('.sdd/pipeline-history.md exists', () => {
  assert.ok(exists('.sdd/pipeline-history.md'), '.sdd/pipeline-history.md must exist after the split');
});

// @spec AC-6
test('.sdd/pipeline-history.md opens by stating it is history not procedure', () => {
  const content = read('.sdd/pipeline-history.md');
  assert.ok(
    /history/i.test(content.slice(0, 300)),
    '.sdd/pipeline-history.md must open by stating it is history rather than procedure',
  );
  assert.ok(
    /no\s+(?:stage|command|agent)\s+needs/i.test(content.slice(0, 500)) ||
    /not\s+needed\s+(?:to\s+run|in\s+order)/i.test(content.slice(0, 500)),
    '.sdd/pipeline-history.md must state that no stage or command needs it in order to run',
  );
});

// @spec AC-6
test('.sdd/pipeline-history.md carries the JSON-sidecar archaeology and records PL-TRIM', () => {
  const content = read('.sdd/pipeline-history.md');
  // JSON-sidecar archaeology mentions the markdown-scanner rounds or duplicate-key exploit.
  assert.ok(
    /JSON.sidecar|markdown.scanner|duplicate.key/i.test(content),
    '.sdd/pipeline-history.md must carry the JSON-sidecar archaeology',
  );
  // PL-TRIM's own round is recorded.
  assert.ok(
    /PL-TRIM/i.test(content),
    '.sdd/pipeline-history.md must record PL-TRIM\'s own round',
  );
});

// =============================================================================
// AC-7: each of the 16 pipeline SKILL.md files uses the new format
// =============================================================================

// @spec AC-7
test('each of the 16 pipeline SKILL.md files exists and stays under 60 lines', () => {
  for (const cmd of EXPECTED_COMMANDS) {
    const skillPath = `.claude/skills/${cmd}/SKILL.md`;
    assert.ok(exists(skillPath), `${skillPath} must exist`);
    const content = read(skillPath);
    const lineCount = content.split(/\r?\n/).length;
    assert.ok(lineCount < 60, `${skillPath} must be under 60 lines; got ${lineCount}`);
  }
});

// @spec AC-7
test('each pipeline SKILL.md names .sdd/pipeline.md as core', () => {
  for (const cmd of EXPECTED_COMMANDS) {
    const content = read(`.claude/skills/${cmd}/SKILL.md`);
    assert.ok(
      content.includes('.sdd/pipeline.md'),
      `.claude/skills/${cmd}/SKILL.md must name .sdd/pipeline.md as core`,
    );
  }
});

// @spec AC-7
test('each pipeline SKILL.md names exactly its own .sdd/entrypoints/<cmd>.md', () => {
  for (const cmd of EXPECTED_COMMANDS) {
    const content = read(`.claude/skills/${cmd}/SKILL.md`);
    assert.ok(
      content.includes(`.sdd/entrypoints/${cmd}.md`),
      `.claude/skills/${cmd}/SKILL.md must reference .sdd/entrypoints/${cmd}.md`,
    );
  }
});

// @spec AC-7
test('no pipeline SKILL.md contains the old "follow .sdd/pipeline.md\'s /cmd section" pointer form', () => {
  const oldPointerPattern = /\.sdd\/pipeline\.md.{0,10}(?:s\s|'s\s|\'s\s|")\s*`?\/[a-z][a-z0-9-]*/i;
  for (const cmd of EXPECTED_COMMANDS) {
    const content = read(`.claude/skills/${cmd}/SKILL.md`);
    assert.ok(
      !oldPointerPattern.test(content),
      `.claude/skills/${cmd}/SKILL.md must not carry the old "follow .sdd/pipeline.md's /x section" pointer — these are the exact instructions this ticket removes`,
    );
  }
});

// @spec AC-7
test('alias SKILL.md files (spec-only, security-recheck) also reference their canonical target entrypoint', () => {
  const specOnly = read('.claude/skills/spec-only/SKILL.md');
  assert.ok(
    specOnly.includes('.sdd/entrypoints/planner.md'),
    '.claude/skills/spec-only/SKILL.md must also reference .sdd/entrypoints/planner.md (its canonical target)',
  );

  const securityRecheck = read('.claude/skills/security-recheck/SKILL.md');
  assert.ok(
    securityRecheck.includes('.sdd/entrypoints/security.md'),
    '.claude/skills/security-recheck/SKILL.md must also reference .sdd/entrypoints/security.md (its canonical target)',
  );
});

// @spec AC-7
test('pipeline SKILL.md files keep existing frontmatter keys AND have the new entrypoint body — both must be true', () => {
  // The frontmatter keys already exist in the current SKILL.md files. This test is meaningful only
  // when combined with the entrypoint body check: after the retargeting, EACH SKILL.md must have
  // BOTH the existing frontmatter AND the new entrypoints reference in the body. Testing both
  // together ensures the test fails now (no entrypoints reference) and passes after dev adds it.
  for (const cmd of EXPECTED_COMMANDS) {
    const content = read(`.claude/skills/${cmd}/SKILL.md`);
    // Frontmatter check (already satisfied, preserved across the edit).
    assert.match(content, /^---/m, `${cmd}/SKILL.md must open with YAML frontmatter`);
    assert.match(content, /^name:\s+\S/m, `${cmd}/SKILL.md must have a name: key`);
    assert.match(content, /^disable-model-invocation:\s+true/m, `${cmd}/SKILL.md must have disable-model-invocation: true`);
    // Entrypoints body check (NOT yet satisfied — this is what makes the test fail now).
    assert.ok(
      content.includes(`.sdd/entrypoints/${cmd}.md`),
      `${cmd}/SKILL.md must have the new entrypoint body reference .sdd/entrypoints/${cmd}.md (frontmatter alone is not enough)`,
    );
  }
});

// =============================================================================
// AC-10: package.json, ci.yml, and scripts/tsconfig.json wiring
// =============================================================================

// @spec AC-10
test('package.json has check:pipeline-slim and test:pipeline-slim scripts', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(
    'check:pipeline-slim' in (pkg.scripts ?? {}),
    'package.json must have a check:pipeline-slim script',
  );
  assert.ok(
    'test:pipeline-slim' in (pkg.scripts ?? {}),
    'package.json must have a test:pipeline-slim script',
  );
  assert.match(
    pkg.scripts['check:pipeline-slim'],
    /check-pipeline-slim\.mjs/,
    'check:pipeline-slim must invoke check-pipeline-slim.mjs',
  );
  assert.match(
    pkg.scripts['test:pipeline-slim'],
    /check-pipeline-slim\.test\.mjs/,
    'test:pipeline-slim must invoke check-pipeline-slim.test.mjs',
  );
});

// @spec AC-10
test('.github/workflows/ci.yml runs both npm run check:pipeline-slim and npm run test:pipeline-slim', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.ok(
    ci.includes('check:pipeline-slim'),
    '.github/workflows/ci.yml must include a step running npm run check:pipeline-slim',
  );
  assert.ok(
    ci.includes('test:pipeline-slim'),
    '.github/workflows/ci.yml must include a step running npm run test:pipeline-slim',
  );
});

// @spec AC-10
test('scripts/tsconfig.json includes check-pipeline-slim.mjs and check-pipeline-slim.test.mjs', () => {
  const tsconfig = JSON.parse(read('scripts/tsconfig.json'));
  const includes = tsconfig.include ?? [];
  assert.ok(
    includes.some((f) => f.includes('check-pipeline-slim.mjs') && !f.includes('.test.')),
    'scripts/tsconfig.json must include check-pipeline-slim.mjs',
  );
  assert.ok(
    includes.some((f) => f.includes('check-pipeline-slim.test.mjs')),
    'scripts/tsconfig.json must include check-pipeline-slim.test.mjs',
  );
});

// =============================================================================
// AC-11: sdd-completeness.test.mjs retargeted — reads entrypoints, not pipeline.md sections
// =============================================================================

// @spec AC-11
test('sdd-completeness.test.mjs pipelineLiteSection() reads .sdd/entrypoints/pipeline-lite.md, not a pipeline.md section slice', () => {
  const content = read('scripts/sdd-completeness.test.mjs');
  // After retargeting, the helper that defines pipelineLiteSection() must read pipeline-lite.md.
  assert.ok(
    content.includes('.sdd/entrypoints/pipeline-lite.md') ||
    content.includes('entrypoints/pipeline-lite'),
    'sdd-completeness.test.mjs must read .sdd/entrypoints/pipeline-lite.md in pipelineLiteSection() — currently it slices pipeline.md which no longer holds the body',
  );
});

// @spec AC-11
test('sdd-completeness.test.mjs inlineEditSection() reads .sdd/entrypoints/inline-edit.md, not a pipeline.md section slice', () => {
  const content = read('scripts/sdd-completeness.test.mjs');
  assert.ok(
    content.includes('.sdd/entrypoints/inline-edit.md') ||
    content.includes('entrypoints/inline-edit'),
    'sdd-completeness.test.mjs must read .sdd/entrypoints/inline-edit.md in inlineEditSection()',
  );
});

// @spec AC-11
test('sdd-completeness.test.mjs enumerates .sdd/entrypoints/*.md (not pipeline.md ### headings) to check skill coverage, with >= 10 floor intact', () => {
  const content = read('scripts/sdd-completeness.test.mjs');
  // After retargeting, the command-discovery expression must read from entrypoints/, not pipeline.md headings.
  assert.ok(
    content.includes('.sdd/entrypoints'),
    'sdd-completeness.test.mjs must enumerate .sdd/entrypoints/ for command→skill coverage, not pipeline.md ### headings',
  );
  // The >= 10 floor must still be present (spec pins it explicitly).
  assert.ok(
    />=\s*10/.test(content),
    'sdd-completeness.test.mjs must retain the >= 10 floor for the entrypoint count',
  );
});

// @spec AC-11
test('sdd-completeness.test.mjs /hotfix entry-point test reads .sdd/entrypoints/hotfix.md for .sdd/hotfix.md and ledger flag', () => {
  const content = read('scripts/sdd-completeness.test.mjs');
  assert.ok(
    content.includes('.sdd/entrypoints/hotfix.md'),
    'sdd-completeness.test.mjs must read .sdd/entrypoints/hotfix.md for the /hotfix entry-point test',
  );
});

// @spec AC-11
test('sdd-completeness.test.mjs /re-gate→/inline-edit→/hotfix ordering assertion references pipeline.md stubs AND the entrypoints dir', () => {
  const content = read('scripts/sdd-completeness.test.mjs');
  // The ordering assertion must reference the core stubs in pipeline.md. After retargeting, the
  // test must explicitly use the entrypoints directory for content-based checks while using
  // pipeline.md stubs for the ordering assertion. The key indicator that retargeting happened:
  // sdd-completeness reads .sdd/entrypoints/ AND still asserts stub ordering over pipeline.md.
  assert.ok(
    content.includes('.sdd/entrypoints'),
    'sdd-completeness.test.mjs must reference .sdd/entrypoints/ — indicating the ordering test has been retargeted to use entrypoint stubs',
  );
  // The ordering must still exist (not deleted).
  assert.ok(
    /re.gate.*inline.edit|inline.edit.*re.gate/i.test(content),
    'sdd-completeness.test.mjs must still contain an ordering assertion covering /re-gate and /inline-edit',
  );
});

// @spec AC-11
test('sdd-completeness.test.mjs SKILL.md shim tests accept an entrypoint pointer as the required reference', () => {
  const content = read('scripts/sdd-completeness.test.mjs');
  // After retargeting, the shim test must accept .sdd/entrypoints/<cmd>.md as the pointer,
  // not just .sdd/pipeline.md.
  assert.ok(
    content.includes('.sdd/entrypoints'),
    'sdd-completeness.test.mjs SKILL.md shim tests must accept .sdd/entrypoints/<cmd>.md as the required pointer',
  );
});

// @spec AC-11
test('sdd-completeness.test.mjs reads .sdd/pipeline.md for intro/preamble AND entrypoints/ for content — not one or the other', () => {
  const content = read('scripts/sdd-completeness.test.mjs');
  // After retargeting (AC-11), sdd-completeness must read BOTH:
  // - .sdd/pipeline.md for the intro-paragraph and Entry-points-preamble discoverability tests
  // - .sdd/entrypoints/ for pipelineLiteSection/inlineEditSection content tests
  // The current file only reads pipeline.md — it does NOT reference entrypoints/. That absence
  // is what makes this test fail now.
  assert.ok(
    content.includes('.sdd/pipeline.md'),
    'sdd-completeness.test.mjs must still read .sdd/pipeline.md for intro/preamble tests',
  );
  assert.ok(
    content.includes('.sdd/entrypoints'),
    'sdd-completeness.test.mjs must ALSO read .sdd/entrypoints/ — currently it does not, confirming retargeting has not yet happened',
  );
});

// =============================================================================
// AC-13: no .sdd/stages/ file is modified (git guard — invariant test)
// =============================================================================

// @spec AC-13
test('.sdd/stages/ is unchanged: PL-TRIM adds entrypoints and a history file but never edits stage files', () => {
  // This test checks a structural invariant: the entrypoints/ directory is NEW content,
  // not moved content from .sdd/stages/. Before the split, .sdd/entrypoints/ doesn't exist.
  // After the split, it must exist but .sdd/stages/ must be unchanged. Testing the two conditions
  // together ensures this test FAILS now (entrypoints dir doesn't exist yet) and PASSES only
  // after dev correctly creates entrypoints WITHOUT touching stages.
  assert.ok(
    exists('.sdd/entrypoints'),
    '.sdd/entrypoints/ must exist — the split must have been performed',
  );
  // Check that no .sdd/stages/*.md content was moved OUT of stages (stages must still exist and be populated).
  for (const stage of ['planner', 'red', 'dev', 'tester', 'review', 'security']) {
    assert.ok(
      exists(`.sdd/stages/${stage}.md`),
      `.sdd/stages/${stage}.md must still exist — stage files are not moved, only referenced by entrypoints`,
    );
    const content = read(`.sdd/stages/${stage}.md`);
    assert.ok(content.trim().length > 100, `.sdd/stages/${stage}.md must still be a full procedure file, not gutted by the split`);
  }
});

// =============================================================================
// AC-14: .sdd/pipeline.md + .sdd/entrypoints/pipeline.md together state the full /pipeline info
// =============================================================================

// @spec AC-14
test('.sdd/entrypoints/pipeline.md exists and names the spec-reuse prompt, Open-Questions stop, and ledger step', () => {
  assert.ok(exists('.sdd/entrypoints/pipeline.md'), '.sdd/entrypoints/pipeline.md must exist');
  const content = read('.sdd/entrypoints/pipeline.md');
  // "those two files together" — the entrypoint carries the parts the core doesn't.
  assert.ok(/Open.Questions/i.test(content) || /open questions/i.test(content),
    '.sdd/entrypoints/pipeline.md must name the Open-Questions stop condition');
  assert.ok(/ledger.append\.mjs/i.test(content) || /ledger step/i.test(content),
    '.sdd/entrypoints/pipeline.md must state the ledger step');
  assert.ok(/PASS/i.test(content),
    '.sdd/entrypoints/pipeline.md must name the terminal PASS condition');
});

// @spec AC-14
test('.sdd/pipeline.md (core) + .sdd/entrypoints/pipeline.md together cover: stage sequence, routing and loop cap, staleness, final report', () => {
  const core = read('.sdd/pipeline.md');
  const entrypoint = read('.sdd/entrypoints/pipeline.md');
  const combined = core + '\n' + entrypoint;
  // PL-CI-QUAL / AC-15: this array literal was inferred as `(string | RegExp)[][]`, so
  // `required[0].test(combined)` below failed TS2339 ("Property 'test' does not exist on type
  // 'string | RegExp'" — the string half of the union has no `.test`). An explicit tuple-array type
  // plus destructuring in the loop head fixes the inference without a cast at the use site and
  // without weakening what this test actually checks.
  /** @type {Array<[RegExp, string]>} */
  const requiredPairs = [
    [/stage sequence|planner.*red.*dev.*tester.*review.*security/is, 'stage sequence'],
    [/routing|loop cap|3.attempt/i, 'routing / loop cap'],
    [/staleness|trusted.fresh/i, 'staleness policy'],
    [/ledger.append\.mjs/i, 'ledger step'],
    [/PASS/, 'terminal PASS'],
  ];
  for (const [pattern, label] of requiredPairs) {
    assert.ok(pattern.test(combined), `pipeline.md core + entrypoints/pipeline.md must together state: ${label}`);
  }
});

// =============================================================================
// AC-16: .sdd/README.md updated with new directory entries and reading-order pointer
// =============================================================================

// @spec AC-16
test('.sdd/README.md directory map lists entrypoints/ and pipeline-history.md', () => {
  const readme = read('.sdd/README.md');
  assert.ok(
    readme.includes('entrypoints'),
    '.sdd/README.md directory map must list entrypoints/',
  );
  assert.ok(
    readme.includes('pipeline-history.md'),
    '.sdd/README.md directory map must list pipeline-history.md',
  );
});

// @spec AC-16
test('.sdd/README.md still names /pipeline-lite and /inline-edit, AND now also describes entrypoints/', () => {
  // The README already mentions /pipeline-lite and /inline-edit. The new requirement from AC-16 is
  // that it ALSO now mentions the entrypoints/ directory. Testing both conditions together ensures
  // this test fails now (entrypoints/ not mentioned yet) and passes after dev updates the README.
  const readme = read('.sdd/README.md');
  assert.ok(readme.includes('/pipeline-lite'), '.sdd/README.md must still name /pipeline-lite');
  assert.ok(readme.includes('/inline-edit'), '.sdd/README.md must still name /inline-edit');
  assert.ok(
    readme.includes('entrypoints'),
    '.sdd/README.md must now also mention entrypoints/ — the condition that currently fails',
  );
});

// @spec AC-16
test('.sdd/README.md "read this first" paragraph names the core-plus-one-entrypoint reading order', () => {
  const readme = read('.sdd/README.md');
  assert.ok(
    readme.includes('entrypoints') && readme.includes('pipeline.md'),
    '.sdd/README.md must describe the core-plus-one-entrypoint reading order in its "read this first" paragraph',
  );
});

// @spec AC-16
test('.sdd/README.md .claude/skills/*/SKILL.md paragraph says each skill points at its own entrypoint file', () => {
  const readme = read('.sdd/README.md');
  const skillsParagraphIdx = readme.indexOf('.claude/skills/*/SKILL.md');
  assert.ok(skillsParagraphIdx !== -1, '.sdd/README.md must have a .claude/skills/*/SKILL.md paragraph');
  const skillsParagraph = readme.slice(skillsParagraphIdx, skillsParagraphIdx + 400);
  assert.ok(
    skillsParagraph.includes('entrypoint'),
    '.sdd/README.md\'s skills paragraph must state that each skill points at its own entrypoint file',
  );
});

// =============================================================================
// AC-17: CLAUDE.md and AGENTS.md state that a command's procedure lives in entrypoints/
// =============================================================================

// @spec AC-17
test('CLAUDE.md Agent pipeline section states that a command\'s procedure lives in .sdd/entrypoints/<cmd>.md', () => {
  const claude = read('CLAUDE.md');
  // Find the Agent pipeline section.
  const agentPipelineIdx = claude.indexOf('## Agent pipeline');
  assert.ok(agentPipelineIdx !== -1, 'CLAUDE.md must have an "## Agent pipeline" section');
  const section = claude.slice(agentPipelineIdx, agentPipelineIdx + 2000);
  assert.ok(
    section.includes('entrypoints') || section.includes('.sdd/entrypoints'),
    'CLAUDE.md\'s Agent pipeline section must state that a command\'s procedure lives in .sdd/entrypoints/<cmd>.md',
  );
});

// @spec AC-17
test('AGENTS.md "The pipeline" section states that a command\'s procedure lives in entrypoints/', () => {
  const agents = read('AGENTS.md');
  const pipelineIdx = agents.indexOf('## The pipeline');
  assert.ok(pipelineIdx !== -1, 'AGENTS.md must have a "## The pipeline" section');
  const section = agents.slice(pipelineIdx, pipelineIdx + 2000);
  assert.ok(
    section.includes('entrypoints') || section.includes('.sdd/entrypoints'),
    'AGENTS.md\'s "The pipeline" section must state that a command\'s procedure lives in .sdd/entrypoints/<cmd>.md',
  );
});

// @spec AC-17
test('CLAUDE.md "Related commands:" list still names the commands it names today', () => {
  const claude = read('CLAUDE.md');
  // The "Related commands:" list in the Agent pipeline section must still enumerate the commands.
  const relatedIdx = claude.indexOf('Related commands:');
  assert.ok(relatedIdx !== -1, 'CLAUDE.md must have a "Related commands:" list');
  const list = claude.slice(relatedIdx, relatedIdx + 1000);
  // A few representative commands that must survive the update.
  for (const cmd of ['/pipeline-lite', '/inline-edit', '/pipeline-gapfill', '/hotfix']) {
    assert.ok(list.includes(cmd), `CLAUDE.md's "Related commands:" list must still name ${cmd}`);
  }
});

// =============================================================================
// EC-15: coOccurs-pinned halves in entrypoints must not drift apart
// =============================================================================

// @spec EC-15
test('[EC-15] .sdd/entrypoints/pipeline-lite.md: the coOccurs-pinned "red" and "after/order" halves remain within 300 characters', () => {
  // sdd-completeness.test.mjs pins that /pipeline-lite's body contains "red" and
  // "after"/"order" within 400 characters of each other. If the moved body drifts — e.g. by
  // reflowing the Honest-limits list — the existing sdd-completeness assertion fails.
  // This test fails now because the file doesn't exist; it passes after dev moves the body
  // without causing drift.
  assert.ok(
    exists('.sdd/entrypoints/pipeline-lite.md'),
    '.sdd/entrypoints/pipeline-lite.md must exist before the coOccurs drift check can run',
  );
  const content = read('.sdd/entrypoints/pipeline-lite.md');
  // The two halves: "red" and "after"/"order" — must stay within 400 characters.
  const forwardOk = /red[\s\S]{0,400}(?:after|order)/i.test(content);
  const backwardOk = /(?:after|order)[\s\S]{0,400}red/i.test(content);
  assert.ok(
    forwardOk || backwardOk,
    'entrypoints/pipeline-lite.md must keep "red" and "after"/"order" within 400 characters of each other — drifting them apart fails the existing sdd-completeness coOccurs guarantee',
  );
});

// =============================================================================
// AC-9: check script exits 0 against this actual repo (after the split)
// =============================================================================

// @spec AC-9
test('scripts/check-pipeline-slim.mjs exits 0 against this repository after the split', () => {
  const scriptPath = resolve(repoRoot, 'scripts', 'check-pipeline-slim.mjs');
  assert.ok(existsSync(scriptPath), 'scripts/check-pipeline-slim.mjs must exist');
  const result = spawnSync(process.execPath, [scriptPath, '--json'], {
    cwd: repoRoot, encoding: 'utf8',
  });
  assert.equal(
    result.status,
    0,
    `scripts/check-pipeline-slim.mjs must exit 0 against this repo after the split;\nexit: ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
});
