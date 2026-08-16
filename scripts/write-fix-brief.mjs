#!/usr/bin/env node
// Coordinator-written fix-brief for a scoped fix-loop `dev` invoke (PL-FIXBRIEF).
//
// Reads only JSON sidecars (review.json / security.json / spec.json). Findings never come from
// review.md, security-report.md, or spec.md — those documents are not opened.
//
// Usage:
//   node scripts/write-fix-brief.mjs --source review|security --attempt <n> [--dir <pipelineDir>] [--cwd <repoRoot>]
//
// Exit 0: wrote fix-brief.json (then stamped), fix-brief.md, spec-slice.md.
// Exit 1: refuse (write nothing) — empty intersection, empty/missing findings, wrong verdict,
//         unknown relatedAc, missing source/spec sidecar.
// Exit 2: invocation/tooling error — unrecognized flag, --attempt not an integer >= 2, stamp failed.
//
// PL-CI-QUAL note: `allowedPaths` below (finding paths ∩ spec.json's affectedFiles) does not
// normally contain a red-authored test path, because planner writes affectedFiles before red authors
// tests — the two are computed at different points in the pipeline, and a test file red writes
// afterward is therefore, ordinarily, structurally absent from this intersection. A fix-loop
// `dev` that genuinely needs to amend a red test outside `allowedPaths` uses the carve-out
// `.sdd/stages/dev.md` step 3 documents instead: declared in changes.json's redTestChanges with a
// reason, judged by tester's existing declared-vs-undeclared integrity check. Nothing here changes
// the allowedPaths computation itself — this is a comment pointing at where that case is handled.

import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  SidecarError,
  knownSpecIds,
  readReviewJson,
  readSecurityJson,
  readSpecJson,
} from './pipeline-contracts.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');

function failRefuse(message) {
  process.stderr.write(`write-fix-brief: ${message}\n`);
  process.exit(1);
}

function failInvoke(message) {
  process.stderr.write(`write-fix-brief: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  let source = null;
  let attemptRaw = null;
  let dir = null;
  let cwd = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--source') {
      if (!next) failInvoke('--source requires a value (review|security).');
      source = next;
      i++;
    } else if (arg === '--attempt') {
      if (!next) failInvoke('--attempt requires an integer >= 2.');
      attemptRaw = next;
      i++;
    } else if (arg === '--dir') {
      if (!next) failInvoke('--dir requires a path.');
      dir = next;
      i++;
    } else if (arg === '--cwd') {
      if (!next) failInvoke('--cwd requires a path.');
      cwd = next;
      i++;
    } else {
      failInvoke(`unrecognized flag "${arg}".`);
    }
  }
  if (source !== 'review' && source !== 'security') {
    failInvoke('--source is required and must be exactly review or security.');
  }
  if (attemptRaw === null) {
    failInvoke('--attempt is required and must be an integer >= 2.');
  }
  if (!/^-?\d+$/.test(attemptRaw)) {
    failInvoke(`--attempt must be an integer >= 2 — got ${JSON.stringify(attemptRaw)}.`);
  }
  const attempt = Number(attemptRaw);
  if (!Number.isInteger(attempt) || attempt < 2) {
    failInvoke(`--attempt must be an integer >= 2 — got ${JSON.stringify(attemptRaw)}.`);
  }
  return {
    source,
    attempt,
    dir: dir ? resolve(dir) : join(cwd ? resolve(cwd) : repoRoot, '.pipeline'),
    cwd: cwd ? resolve(cwd) : repoRoot,
  };
}

function allowedPathsFrom(findings, affectedFiles) {
  const union = [];
  const seenUnion = new Set();
  for (const finding of findings) {
    for (const p of finding.paths) {
      if (!seenUnion.has(p)) {
        seenUnion.add(p);
        union.push(p);
      }
    }
  }
  const affected = new Set(affectedFiles);
  return [...new Set(union.filter((p) => affected.has(p)))].sort();
}

function renderFixBriefMd(brief) {
  const lines = [
    `# Fix brief (attempt ${brief.attempt}, source: ${brief.source})`,
    '',
    'fullSpecStillGoverns: true — tester/review/security still certify every AC/EC.',
    '',
    '## Findings',
    '',
  ];
  for (const finding of brief.findings) {
    lines.push(`### ${finding.id}`);
    lines.push('');
    lines.push(finding.summary);
    lines.push('');
    lines.push(`requiredOutcome: ${finding.requiredOutcome}`);
    lines.push('');
    lines.push('paths:');
    for (const p of finding.paths) lines.push(`- ${p}`);
    if (finding.relatedAc.length) {
      lines.push('');
      lines.push(`relatedAc: ${finding.relatedAc.join(', ')}`);
    }
    lines.push('');
  }
  lines.push('## allowedPaths');
  lines.push('');
  for (const p of brief.allowedPaths) lines.push(`- ${p}`);
  lines.push('');
  return lines.join('\n');
}

function renderSpecSliceMd(spec, brief) {
  const idText = new Map([
    ...spec.acceptanceCriteria.map((item) => [item.id, item.text]),
    ...spec.edgeCases.map((item) => [item.id, item.text]),
  ]);
  const cited = [];
  const seenCited = new Set();
  for (const finding of brief.findings) {
    for (const id of finding.relatedAc) {
      if (!seenCited.has(id)) {
        seenCited.add(id);
        cited.push(id);
      }
    }
  }
  const lines = [
    '# Spec slice (fix-loop)',
    '',
    `Goal: ${spec.goal}`,
    '',
    'fullSpecStillGoverns: true — tester/review/security still certify every AC/EC.',
    '',
    '## Findings',
    '',
  ];
  for (const finding of brief.findings) {
    lines.push(`### ${finding.id}`);
    lines.push('');
    lines.push(finding.summary);
    lines.push('');
    lines.push(`requiredOutcome: ${finding.requiredOutcome}`);
    lines.push('');
    lines.push('paths:');
    for (const p of finding.paths) lines.push(`- ${p}`);
    lines.push('');
  }
  lines.push('## relatedAc');
  lines.push('');
  if (cited.length === 0) {
    lines.push('(none cited)');
    lines.push('');
  } else {
    for (const id of cited) {
      lines.push(`### ${id}`);
      lines.push('');
      lines.push(idText.get(id) ?? '');
      lines.push('');
    }
  }
  lines.push('## allowedPaths');
  lines.push('');
  for (const p of brief.allowedPaths) lines.push(`- ${p}`);
  lines.push('');
  return lines.join('\n');
}

function main() {
  const { source, attempt, dir, cwd } = parseArgs(process.argv.slice(2));

  let spec;
  let sidecar;
  try {
    spec = readSpecJson(dir, { required: true });
    sidecar = source === 'review'
      ? readReviewJson(dir, { required: true })
      : readSecurityJson(dir, { required: true });
  } catch (error) {
    if (error instanceof SidecarError) failRefuse(error.message);
    throw error;
  }

  const expectedVerdict = source === 'review' ? 'NEEDS_FIXES' : 'BLOCKED';
  if (sidecar.verdict !== expectedVerdict) {
    failRefuse(
      `--source ${source} requires verdict ${expectedVerdict} — got ${JSON.stringify(sidecar.verdict)}.`,
    );
  }

  const findings = sidecar.findings;
  if (findings.length === 0) {
    failRefuse(
      'findings is empty or missing — write a non-empty findings array on the source JSON sidecar; do not scrape markdown.',
    );
  }

  const known = knownSpecIds(spec);
  for (const finding of findings) {
    for (const id of finding.relatedAc) {
      if (!known.has(id)) {
        failRefuse(
          `relatedAc id ${id} is not in knownSpecIds(spec.json) — every cited id must be a real AC-n/EC-n from this ticket.`,
        );
      }
    }
  }

  const allowedPaths = allowedPathsFrom(findings, spec.affectedFiles);
  if (allowedPaths.length === 0) {
    failRefuse(
      'allowedPaths would be empty — the intersection of finding paths with spec.json affectedFiles is empty (absent affectedFiles is treated as []).',
    );
  }

  const brief = {
    source,
    attempt,
    findings,
    allowedPaths,
    fullSpecStillGoverns: true,
  };

  const briefPath = join(dir, 'fix-brief.json');
  const mdPath = join(dir, 'fix-brief.md');
  const slicePath = join(dir, 'spec-slice.md');
  writeFileSync(briefPath, `${JSON.stringify(brief, null, 2)}\n`, 'utf8');
  writeFileSync(mdPath, renderFixBriefMd(brief), 'utf8');
  writeFileSync(slicePath, renderSpecSliceMd(spec, brief), 'utf8');

  const stamp = spawnSync(
    process.execPath,
    [join(scriptsDir, 'write-stamp.mjs'), briefPath, '--cwd', cwd],
    { encoding: 'utf8' },
  );
  if (stamp.status !== 0) {
    failInvoke(`write-stamp.mjs failed (exit ${stamp.status}): ${stamp.stderr || stamp.stdout}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`write-fix-brief: ${error.message}\n`);
    process.exit(2);
  }
}
