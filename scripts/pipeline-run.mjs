#!/usr/bin/env node
/**
 * Lean, run-scoped control plane for Sayre's development pipeline.
 *
 * The previous pipeline used one shared set of .pipeline/*.md and *.json files as both state and
 * handoff. That made a stale artifact from another ticket indistinguishable from the current run,
 * required agents to author Markdown and JSON independently, and left routing decisions in prose.
 *
 * This CLI owns those mechanical concerns:
 *   init -> planner -> optional red -> dev -> verify -> review -> security -> finalize
 *
 * Agents write one draft JSON payload and call "emit". The CLI validates it, attaches run identity
 * and a tree stamp, writes canonical JSON, renders Markdown, records an attempt snapshot, and moves
 * the state machine. Verification runs recorded argv arrays without a shell. Finalize promotes the
 * completed run to .sdd/ledger and regenerates the file-to-spec index.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildStamp,
  parseJsonOrThrow,
  requireArray,
  requireEnum,
  requireObject,
  requireString,
  stampFreshness,
  STAMP_FRESH,
} from './pipeline-contracts.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDir, '..');
const SCHEMA_VERSION = 2;
const PROFILES = ['auto', 'fast', 'standard', 'sensitive', 'milestone'];
const STAGES = ['planner', 'red', 'dev', 'verify', 'review', 'security', 'finalize'];
const EMIT_STAGES = new Set(['planner', 'red', 'dev', 'review', 'security']);
const VERDICTS = {
  review: ['PASS', 'NEEDS_FIXES'],
  security: ['PASS', 'BLOCKED'],
};
const MAX_ATTEMPTS = 3;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const ALLOWED_COMMANDS = new Set(['node', 'npm', 'npx', 'poetry', 'python', 'python3', 'git']);
const SENSITIVE_PATH_PATTERNS = [
  /^services\/core\/src\/(?:security|graph-query|mcp|webhooks|auth|middleware)\//,
  /^services\/core\/src\/db\//,
  /^packages\/graph-schema\//,
  /^infra\//,
  /^\.github\/workflows\//,
  /^\.claude\/settings\.json$/,
  /^scripts\/(?:guard-checker-readonly|pipeline-run|ledger-append|pipeline-contracts)\.mjs$/,
  /^\.sdd\/(?:pipeline\.md|runtimes\.yml|stages\/security(?:-full)?\.md)$/,
  /(?:^|\/)(?:secret|credential|rbac|tenant|org-id|org_id|webhook)(?:[./_-]|$)/i,
];
const TENANT_PATH_PATTERN =
  /(?:^|\/)(?:security|graph-query|mcp|auth|middleware|db)(?:\/|$)|(?:tenant|rbac|org[_-]?id)/i;
const WEBHOOK_PATH_PATTERN = /(?:^|\/)(?:webhooks?|github|integrations?)(?:\/|$)/i;
const INGESTION_PATH_PATTERN = /(?:^|\/)(?:ingestion|parsing|workers)(?:\/|$)/i;

function fail(message, code = 1) {
  const error = Object.assign(new Error(message), { exitCode: code });
  throw error;
}

function normalizePath(value) {
  return value.split('\\').join('/').replace(/^\.\//, '');
}

function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}

function ensureInside(parent, child, label) {
  if (!isInside(parent, child)) fail(label + ' must stay inside ' + parent + ': ' + child);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readText(path, label = path) {
  if (!existsSync(path)) fail(label + ' does not exist.');
  if (!statSync(path).isFile()) fail(label + ' is not a regular file.');
  return readFileSync(path, 'utf8');
}

function readJson(path, label = path) {
  return parseJsonOrThrow(readText(path, label), label);
}

function writeTextAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + '.tmp-' + process.pid + '-' + randomBytes(3).toString('hex');
  writeFileSync(temp, content, 'utf8');
  renameSync(temp, path);
}

function writeJsonAtomic(path, value) {
  writeTextAtomic(path, JSON.stringify(value, null, 2) + '\n');
}

function git(root, args, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', options.quietStderr ? 'ignore' : 'pipe'],
    }).trim();
  } catch (error) {
    const detail = error.stderr ? String(error.stderr).trim() : error.message;
    fail('git ' + args.join(' ') + ' failed: ' + detail);
  }
}

function gitStatus(root) {
  return git(root, ['status', '--porcelain']);
}

function currentCommit(root) {
  return {
    sha: git(root, ['rev-parse', 'HEAD']),
    branch: git(root, ['branch', '--show-current']) || '(detached)',
  };
}

function changedFiles(root, baseSha) {
  const tracked = git(root, ['diff', '--name-only', baseSha])
    .split(/\r?\n/)
    .map(normalizePath)
    .filter(Boolean);
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard'])
    .split(/\r?\n/)
    .map(normalizePath)
    .filter(Boolean);
  return [...new Set([...tracked, ...untracked])].sort();
}

function timestampForId() {
  return new Date().toISOString().replace(/[-:.]/g, '');
}

function createRunId(root) {
  const sha = currentCommit(root).sha.slice(0, 12);
  return timestampForId() + '-' + sha + '-pipeline-' + randomBytes(4).toString('hex');
}

function extractTicketId(title) {
  const match = title.match(/^\s*([A-Z][A-Z0-9]*-\d+[a-z]?)\b/);
  if (match) return match[1];
  return 'DIRECT-' + sha256(title.trim()).slice(0, 10).toUpperCase();
}

function parseGlobalArgs(rawArgv) {
  const argv = [...rawArgv];
  let root = defaultRepoRoot;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--cwd') continue;
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) fail('--cwd requires a path.', 2);
    root = resolve(value);
    argv.splice(i, 2);
    i -= 1;
  }
  if (!existsSync(join(root, '.git')) && !existsSync(join(root, '.git', 'HEAD'))) {
    // Linked worktrees use a .git file, ordinary repositories use a directory.
    if (!existsSync(join(root, '.git'))) fail('--cwd is not a git worktree: ' + root, 2);
  }
  return { argv, root };
}

function parseFlags(argv, definitions) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const definition = definitions[arg];
    if (!definition) fail('unrecognized argument "' + arg + '".', 2);
    if (definition === 'boolean') {
      result[arg.slice(2)] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) fail(arg + ' requires a value.', 2);
    result[arg.slice(2)] = value;
    i += 1;
  }
  return result;
}

function paths(root) {
  const pipelineDir = join(root, '.pipeline');
  return {
    root,
    pipelineDir,
    runsDir: join(pipelineDir, 'runs'),
    currentPath: join(pipelineDir, 'current.json'),
    ledgerDir: join(root, '.sdd', 'ledger'),
    ledgerIndexPath: join(root, '.sdd', 'ledger', 'index.json'),
  };
}

function runPaths(root, runId) {
  const base = paths(root);
  const runDir = join(base.runsDir, runId);
  return {
    ...base,
    runDir,
    statePath: join(runDir, 'state.json'),
    artifactsDir: join(runDir, 'artifacts'),
    draftsDir: join(runDir, 'drafts'),
    historyDir: join(runDir, 'history'),
    logsDir: join(runDir, 'logs'),
    securityHistoryDir: join(runDir, 'security-history'),
  };
}

function readCurrentId(root) {
  const currentPath = paths(root).currentPath;
  if (!existsSync(currentPath)) fail('no current pipeline run; initialize one with "pipeline-run init".');
  const current = readJson(currentPath, '.pipeline/current.json');
  requireObject(current, '.pipeline/current.json');
  return requireString(current.runId, '.pipeline/current.json', 'runId');
}

function resolveRunId(root, explicitRunId) {
  return explicitRunId || readCurrentId(root);
}

function readState(root, runId) {
  const p = runPaths(root, runId);
  const state = readJson(p.statePath, '.pipeline/runs/' + runId + '/state.json');
  requireObject(state, 'pipeline state');
  if (state.runId !== runId) fail('state runId does not match its directory.');
  if (state.schemaVersion !== SCHEMA_VERSION) {
    fail('unsupported pipeline state schema ' + state.schemaVersion + '; expected ' + SCHEMA_VERSION + '.');
  }
  return { state, p };
}

function writeState(p, state) {
  state.currentStage = nextPendingStage(state);
  state.updatedAt = new Date().toISOString();
  writeJsonAtomic(p.statePath, state);
}

function artifactPath(p, stage, extension = 'json') {
  const names = {
    planner: 'spec',
    red: 'red',
    dev: 'dev',
    verify: 'verify',
    review: 'review',
    security: 'security',
  };
  if (!names[stage]) fail('stage has no artifact: ' + stage);
  return join(p.artifactsDir, names[stage] + '.' + extension);
}

function readArtifact(p, stage, required = true) {
  const path = artifactPath(p, stage);
  if (!existsSync(path)) {
    if (required) fail(stage + ' artifact does not exist for this run.');
    return null;
  }
  return readJson(path, stage + ' artifact');
}

function snapshotArtifact(p, stage, artifact, markdown, attempt) {
  mkdirSync(p.historyDir, { recursive: true });
  const stem = String(attempt).padStart(2, '0') + '-' + stage;
  writeJsonAtomic(join(p.historyDir, stem + '.json'), artifact);
  writeTextAtomic(join(p.historyDir, stem + '.md'), markdown);
}

function stageMap() {
  return Object.fromEntries(
    STAGES.map((stage) => [stage, { status: stage === 'planner' ? 'pending' : 'blocked' }]),
  );
}

function setStage(state, stage, status, detail = null) {
  state.stages[stage] = {
    status,
    ...(detail ? { detail } : {}),
    updatedAt: new Date().toISOString(),
  };
}

function nextPendingStage(state) {
  if (state.status === 'complete' || state.status === 'blocked') return null;
  for (const stage of STAGES) {
    if (state.stages[stage].status === 'pending' || state.stages[stage].status === 'failed') {
      return stage;
    }
  }
  return null;
}

function profileRank(profile) {
  return { fast: 0, standard: 1, sensitive: 2, milestone: 3 }[profile];
}

function maxProfile(a, b) {
  return profileRank(a) >= profileRank(b) ? a : b;
}

function pathRiskProfile(files) {
  if (files.length && files.every((file) => /^(?:docs\/|README(?:\.|$)|[^/]+\.md$)/i.test(file))) {
    return 'fast';
  }
  return files.some((file) => SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(file)))
    ? 'sensitive'
    : 'standard';
}

function resolveProfile(requested, planner) {
  let inferred = planner.changeKind === 'docs' ? 'fast' : pathRiskProfile(planner.affectedFiles);
  if (planner.risk === 'sensitive') inferred = 'sensitive';
  if (planner.risk === 'milestone') inferred = 'milestone';
  if (requested === 'auto') return inferred;
  return maxProfile(requested, inferred);
}

function securityPlan(files, profile) {
  const normalized = files.map(normalizePath);
  const tenant = normalized.some((file) => TENANT_PATH_PATTERN.test(file));
  const webhook = normalized.some((file) => WEBHOOK_PATH_PATTERN.test(file));
  const ingestion = normalized.some((file) => INGESTION_PATH_PATTERN.test(file));
  const packageChange = normalized.some((file) => /(?:^|\/)(?:package(?:-lock)?\.json|pyproject\.toml|poetry\.lock)$/.test(file));
  const pipelineControl = normalized.some((file) =>
    /^(?:\.sdd\/|\.claude\/|scripts\/(?:pipeline|ledger|guard|check-red|build-ledger|generate-agent))/.test(file),
  );

  if (profile === 'sensitive' || profile === 'milestone') {
    return {
      mode: profile === 'milestone' ? 'MILESTONE' : 'FULL',
      requiredChecks: ['CORE-01', 'CORE-02', 'CORE-03', 'CORE-04', 'CORE-05', 'CORE-06'],
      surfaces: [
        ...(tenant ? ['tenant-isolation', 'rbac-boundary'] : []),
        ...(webhook ? ['webhook-trust'] : []),
        ...(ingestion ? ['ingestion-ephemerality'] : []),
        ...(packageChange ? ['supply-chain-infrastructure'] : []),
        ...(pipelineControl ? ['pipeline-control'] : []),
      ],
    };
  }

  const checks = ['FAST-SECRET-DIFF', 'FAST-INJECTION-DIFF'];
  if (tenant) checks.push('CORE-01', 'CORE-02');
  if (webhook) checks.push('CORE-04');
  if (ingestion) checks.push('CORE-05');
  if (packageChange) checks.push('FAST-SUPPLY-CHAIN');
  if (pipelineControl) checks.push('FAST-PIPELINE-CONTROL');
  return {
    mode: 'FAST',
    requiredChecks: [...new Set(checks)],
    surfaces: [
      ...(tenant ? ['tenant-isolation', 'rbac-boundary'] : []),
      ...(webhook ? ['webhook-trust'] : []),
      ...(ingestion ? ['ingestion-ephemerality'] : []),
      ...(packageChange ? ['supply-chain-infrastructure'] : []),
      ...(pipelineControl ? ['pipeline-control'] : []),
    ],
  };
}

function assertAllowedKeys(object, allowed, label) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) fail(label + ': unrecognized field "' + key + '".');
  }
}

function stringArray(value, label, field, { allowEmpty = true } = {}) {
  const items = requireArray(value, label, field).map((item, index) =>
    requireString(item, label, field + '[' + index + ']'),
  );
  if (!allowEmpty && items.length === 0) fail(label + ': field "' + field + '" must not be empty.');
  return items;
}

function repoPath(value, root, label) {
  const normalized = normalizePath(requireString(value, label, 'path'));
  if (isAbsolute(normalized)) fail(label + ': path must be repository-relative.');
  ensureInside(root, resolve(root, normalized), label + ' path');
  return normalized;
}

function validateSpecItems(value, label, field) {
  const ids = new Set();
  return requireArray(value, label, field).map((raw, index) => {
    const itemLabel = label + ': ' + field + '[' + index + ']';
    requireObject(raw, itemLabel);
    assertAllowedKeys(raw, ['id', 'text', 'verification'], itemLabel);
    const id = requireString(raw.id, itemLabel, 'id');
    const expected = field === 'acceptanceCriteria' ? /^AC-\d+[a-z]?$/ : /^EC-\d+[a-z]?$/;
    if (!expected.test(id)) fail(itemLabel + ': invalid id "' + id + '".');
    if (ids.has(id)) fail(label + ': duplicate requirement id "' + id + '".');
    ids.add(id);
    return {
      id,
      text: requireString(raw.text, itemLabel, 'text'),
      verification: requireEnum(raw.verification, itemLabel, 'verification', ['test', 'review', 'manual']),
    };
  });
}

function validatePlanner(raw, state) {
  const label = 'planner draft';
  requireObject(raw, label);
  assertAllowedKeys(
    raw,
    [
      'goal',
      'ticketCheck',
      'scopeIn',
      'scopeOut',
      'affectedFiles',
      'interfaces',
      'approach',
      'acceptanceCriteria',
      'edgeCases',
      'openQuestions',
      'lane',
      'changeKind',
      'risk',
    ],
    label,
  );
  requireObject(raw.ticketCheck, label + ': ticketCheck');
  assertAllowedKeys(
    raw.ticketCheck,
    ['build', 'notDoing', 'worked', 'guesses'],
    label + ': ticketCheck',
  );
  const affectedFiles = stringArray(raw.affectedFiles, label, 'affectedFiles', { allowEmpty: false })
    .map((value, index) => repoPath(value, state.repoRoot, label + ': affectedFiles[' + index + ']'));
  const acceptanceCriteria = validateSpecItems(raw.acceptanceCriteria, label, 'acceptanceCriteria');
  const edgeCases = validateSpecItems(raw.edgeCases, label, 'edgeCases');
  const allIds = [...acceptanceCriteria, ...edgeCases].map((item) => item.id);
  if (new Set(allIds).size !== allIds.length) fail(label + ': requirement IDs must be globally unique.');
  return {
    schemaVersion: SCHEMA_VERSION,
    pipelineRunId: state.runId,
    ticket: state.ticket,
    goal: requireString(raw.goal, label, 'goal'),
    ticketCheck: {
      build: requireString(raw.ticketCheck.build, label, 'ticketCheck.build'),
      notDoing: requireString(raw.ticketCheck.notDoing, label, 'ticketCheck.notDoing'),
      worked: requireString(raw.ticketCheck.worked, label, 'ticketCheck.worked'),
      guesses: requireString(raw.ticketCheck.guesses, label, 'ticketCheck.guesses'),
    },
    scopeIn: stringArray(raw.scopeIn, label, 'scopeIn'),
    scopeOut: stringArray(raw.scopeOut, label, 'scopeOut'),
    affectedFiles,
    interfaces: stringArray(raw.interfaces, label, 'interfaces'),
    approach: stringArray(raw.approach, label, 'approach', { allowEmpty: false }),
    acceptanceCriteria,
    edgeCases,
    openQuestions: stringArray(raw.openQuestions, label, 'openQuestions'),
    lane: raw.lane === null || raw.lane === undefined ? null : requireString(raw.lane, label, 'lane'),
    changeKind: requireEnum(raw.changeKind, label, 'changeKind', ['docs', 'internal', 'behavioral']),
    risk: requireEnum(raw.risk, label, 'risk', ['low', 'standard', 'sensitive', 'milestone']),
    stamp: buildStamp(state.repoRoot),
  };
}

function commandPackageJson(root, command) {
  if (command.command !== 'npm' || command.args[0] !== 'run') return null;
  const packagePath = join(root, command.cwd, 'package.json');
  if (!existsSync(packagePath)) {
    fail('verification command "' + command.id + '" uses npm run in a directory with no package.json: ' + command.cwd);
  }
  const packageJson = readJson(packagePath, normalizePath(relative(root, packagePath)));
  const script = command.args[1];
  if (!script || !packageJson.scripts || typeof packageJson.scripts[script] !== 'string') {
    fail(
      'verification command "' + command.id + '" names missing npm script "' +
        String(script || '') + '" in ' + normalizePath(relative(root, packagePath)),
    );
  }
  return packagePath;
}

function validateCommand(raw, root, label, index) {
  const itemLabel = label + ': commands[' + index + ']';
  requireObject(raw, itemLabel);
  assertAllowedKeys(raw, ['id', 'command', 'args', 'cwd', 'reason', 'specIds', 'timeoutMs'], itemLabel);
  const command = requireString(raw.command, itemLabel, 'command');
  if (!ALLOWED_COMMANDS.has(command)) {
    fail(itemLabel + ': command "' + command + '" is not allowed; use an argv-safe supported runner.');
  }
  const cwd = normalizePath(raw.cwd || '.');
  const absoluteCwd = resolve(root, cwd);
  ensureInside(root, absoluteCwd, itemLabel + ' cwd');
  if (!existsSync(absoluteCwd) || !statSync(absoluteCwd).isDirectory()) {
    fail(itemLabel + ': cwd does not exist: ' + cwd);
  }
  const validated = {
    id: requireString(raw.id, itemLabel, 'id'),
    command,
    args: stringArray(raw.args, itemLabel, 'args'),
    cwd,
    reason: requireString(raw.reason, itemLabel, 'reason'),
    specIds: raw.specIds ? stringArray(raw.specIds, itemLabel, 'specIds') : [],
    timeoutMs:
      Number.isInteger(raw.timeoutMs) && raw.timeoutMs > 0
        ? raw.timeoutMs
        : 15 * 60 * 1000,
  };
  commandPackageJson(root, validated);
  return validated;
}

function validateRed(raw, state, spec) {
  const label = 'red draft';
  requireObject(raw, label);
  assertAllowedKeys(raw, ['coverage', 'tests', 'commands', 'impactMap'], label);
  const knownIds = new Set(
    [...spec.acceptanceCriteria, ...spec.edgeCases].map((item) => item.id),
  );
  const requiredTestIds = new Set(
    [...spec.acceptanceCriteria, ...spec.edgeCases]
      .filter((item) => item.verification === 'test')
      .map((item) => item.id),
  );
  const covered = new Set();
  const coverage = requireArray(raw.coverage, label, 'coverage').map((entry, index) => {
    const itemLabel = label + ': coverage[' + index + ']';
    requireObject(entry, itemLabel);
    assertAllowedKeys(entry, ['specIds', 'mode', 'testPath', 'reason'], itemLabel);
    const specIds = stringArray(entry.specIds, itemLabel, 'specIds', { allowEmpty: false });
    for (const id of specIds) {
      if (!knownIds.has(id)) fail(itemLabel + ': unknown spec ID "' + id + '".');
      covered.add(id);
    }
    const mode = requireEnum(entry.mode, itemLabel, 'mode', ['new', 'existing', 'manual', 'deferred']);
    const reason = requireString(entry.reason, itemLabel, 'reason');
    const testPath = entry.testPath ? normalizePath(requireString(entry.testPath, itemLabel, 'testPath')) : null;
    if ((mode === 'new' || mode === 'existing') && !testPath) {
      fail(itemLabel + ': testPath is required for mode ' + mode + '.');
    }
    return { specIds, mode, ...(testPath ? { testPath } : {}), reason };
  });
  const missing = [...requiredTestIds].filter((id) => !covered.has(id));
  if (missing.length) fail(label + ': test-verification requirements lack coverage: ' + missing.join(', '));

  const tests = requireArray(raw.tests, label, 'tests').map((entry, index) => {
    const itemLabel = label + ': tests[' + index + ']';
    requireObject(entry, itemLabel);
    assertAllowedKeys(entry, ['path', 'specIds', 'source', 'sha256', 'classification'], itemLabel);
    const path = repoPath(entry.path, state.repoRoot, itemLabel);
    const absolutePath = resolve(state.repoRoot, path);
    ensureInside(state.repoRoot, absolutePath, itemLabel + ' path');
    if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
      fail(itemLabel + ': test file does not exist: ' + path);
    }
    const specIds = stringArray(entry.specIds, itemLabel, 'specIds', { allowEmpty: false });
    for (const id of specIds) if (!knownIds.has(id)) fail(itemLabel + ': unknown spec ID "' + id + '".');
    const expectedHash = requireString(entry.sha256, itemLabel, 'sha256');
    if (!/^[0-9a-f]{64}$/i.test(expectedHash)) {
      fail(itemLabel + ': sha256 must be a 64-character hex digest.');
    }
    const actualHash = sha256(readFileSync(absolutePath));
    if (actualHash !== expectedHash) {
      fail(itemLabel + ': sha256 does not match the current file content for ' + path + '.');
    }
    return {
      path,
      specIds,
      source: requireEnum(entry.source, itemLabel, 'source', ['new', 'existing']),
      sha256: expectedHash,
      classification: requireEnum(
        entry.classification,
        itemLabel,
        'classification',
        ['RED-CORRECT', 'EXISTING-COVERAGE', 'RED-DEFERRED'],
      ),
    };
  });
  const commands = requireArray(raw.commands, label, 'commands').map((entry, index) =>
    validateCommand(entry, state.repoRoot, label, index),
  );
  const testByPath = new Map(tests.map((test) => [test.path, test]));
  for (const entry of coverage) {
    if (entry.mode !== 'new' && entry.mode !== 'existing') continue;
    const test = testByPath.get(entry.testPath);
    if (!test) fail(label + ': ' + entry.mode + ' coverage path is missing from tests: ' + entry.testPath);
    for (const id of entry.specIds) {
      if (!test.specIds.includes(id)) fail(label + ': test ' + entry.testPath + ' does not cite covered ID ' + id + '.');
    }
  }
  for (const command of commands) {
    for (const id of command.specIds) if (!knownIds.has(id)) fail(label + ': command ' + command.id + ' cites unknown spec ID ' + id + '.');
  }
  requireObject(raw.impactMap, label + ': impactMap');
  assertAllowedKeys(raw.impactMap, ['status', 'summary'], label + ': impactMap');
  return {
    schemaVersion: SCHEMA_VERSION,
    pipelineRunId: state.runId,
    coverage,
    tests,
    commands,
    impactMap: {
      status: requireEnum(raw.impactMap.status, label, 'impactMap.status', ['usable', 'unavailable', 'not-needed']),
      summary: requireString(raw.impactMap.summary, label, 'impactMap.summary'),
    },
    stamp: buildStamp(state.repoRoot),
  };
}

function validateDev(raw, state, spec, red) {
  const label = 'dev draft';
  requireObject(raw, label);
  assertAllowedKeys(
    raw,
    ['summary', 'decisions', 'deviations', 'redTestChanges', 'fixesApplied', 'notDone', 'verificationCommands'],
    label,
  );
  const actualFiles = changedFiles(state.repoRoot, state.base.headSha);
  if (!actualFiles.length) fail(label + ': the working tree has no changes relative to the run base.');
  const redTestChanges = requireArray(raw.redTestChanges, label, 'redTestChanges').map((entry, index) => {
    const itemLabel = label + ': redTestChanges[' + index + ']';
    requireObject(entry, itemLabel);
    assertAllowedKeys(entry, ['path', 'reason'], itemLabel);
    return {
      path: repoPath(entry.path, state.repoRoot, itemLabel),
      reason: requireString(entry.reason, itemLabel, 'reason'),
    };
  });
  const verificationCommands = requireArray(raw.verificationCommands, label, 'verificationCommands').map(
    (entry, index) => validateCommand(entry, state.repoRoot, label, index),
  );
  const knownIds = new Set([...spec.acceptanceCriteria, ...spec.edgeCases].map((item) => item.id));
  for (const command of verificationCommands) {
    for (const id of command.specIds) if (!knownIds.has(id)) fail(label + ': command ' + command.id + ' cites unknown spec ID ' + id + '.');
  }
  const redPaths = new Set((red?.tests || []).map((test) => test.path));
  for (const declaration of redTestChanges) {
    if (!redPaths.has(declaration.path)) fail(label + ': redTestChanges names a path not recorded by red: ' + declaration.path);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    pipelineRunId: state.runId,
    attempt: state.attempt,
    summary: requireString(raw.summary, label, 'summary'),
    filesChanged: actualFiles,
    decisions: stringArray(raw.decisions, label, 'decisions'),
    deviations: stringArray(raw.deviations, label, 'deviations'),
    redTestChanges,
    fixesApplied: stringArray(raw.fixesApplied, label, 'fixesApplied'),
    notDone: stringArray(raw.notDone, label, 'notDone'),
    verificationCommands,
    stamp: buildStamp(state.repoRoot),
  };
}

function validateFindings(raw, label) {
  return requireArray(raw, label, 'findings').map((entry, index) => {
    const itemLabel = label + ': findings[' + index + ']';
    requireObject(entry, itemLabel);
    assertAllowedKeys(entry, ['severity', 'message', 'file', 'line', 'fix'], itemLabel);
    const finding = {
      severity: requireEnum(entry.severity, itemLabel, 'severity', ['critical', 'warning', 'suggestion']),
      message: requireString(entry.message, itemLabel, 'message'),
    };
    if (entry.file) finding.file = normalizePath(requireString(entry.file, itemLabel, 'file'));
    if (entry.line !== undefined) {
      if (!Number.isInteger(entry.line) || entry.line < 1) fail(itemLabel + ': line must be a positive integer.');
      finding.line = entry.line;
    }
    if (entry.fix) finding.fix = requireString(entry.fix, itemLabel, 'fix');
    return finding;
  });
}

function validateReview(raw, state, verify) {
  const label = 'review draft';
  requireObject(raw, label);
  assertAllowedKeys(raw, ['verdict', 'summary', 'findings'], label);
  const verdict = requireEnum(raw.verdict, label, 'verdict', VERDICTS.review);
  if (verdict === 'PASS' && verify.result !== 'PASS') {
    fail(label + ': PASS is impossible while deterministic verification is not PASS.');
  }
  const findings = validateFindings(raw.findings, label);
  if (verdict === 'NEEDS_FIXES' && !findings.some((finding) => finding.severity === 'critical')) {
    fail(label + ': NEEDS_FIXES requires at least one critical finding.');
  }
  if (verdict === 'PASS' && findings.some((finding) => finding.severity === 'critical')) {
    fail(label + ': PASS cannot carry a critical finding.');
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    pipelineRunId: state.runId,
    attempt: state.attempt,
    verdict,
    summary: requireString(raw.summary, label, 'summary'),
    findings,
    stamp: buildStamp(state.repoRoot),
  };
}

function validateSecurity(raw, state, p) {
  const label = 'security draft';
  requireObject(raw, label);
  assertAllowedKeys(raw, ['verdict', 'summary', 'checks', 'findings', 'limitations', 'auditRunId'], label);
  const verdict = requireEnum(raw.verdict, label, 'verdict', VERDICTS.security);
  const checks = requireArray(raw.checks, label, 'checks').map((entry, index) => {
    const itemLabel = label + ': checks[' + index + ']';
    requireObject(entry, itemLabel);
    assertAllowedKeys(entry, ['id', 'result', 'evidence'], itemLabel);
    return {
      id: requireString(entry.id, itemLabel, 'id'),
      result: requireEnum(entry.result, itemLabel, 'result', ['PASS', 'FAIL', 'UNVERIFIED', 'NOT_APPLICABLE']),
      evidence: requireString(entry.evidence, itemLabel, 'evidence'),
    };
  });
  if (new Set(checks.map((check) => check.id)).size !== checks.length) {
    fail(label + ': check IDs must be unique.');
  }
  const byId = new Map(checks.map((check) => [check.id, check]));
  const missing = state.securityPlan.requiredChecks.filter((id) => !byId.has(id));
  if (missing.length) fail(label + ': missing required checks: ' + missing.join(', '));
  if (state.securityPlan.mode === 'FAST' && verdict === 'PASS') {
    const notPass = state.securityPlan.requiredChecks.filter((id) => byId.get(id).result !== 'PASS');
    if (notPass.length) fail(label + ': FAST PASS requires affirmative PASS for: ' + notPass.join(', '));
  }
  let auditRunId = null;
  if (state.securityPlan.mode !== 'FAST') {
    auditRunId = requireString(raw.auditRunId, label, 'auditRunId');
    if (!/^[A-Za-z0-9._-]+$/.test(auditRunId)) fail(label + ': auditRunId contains unsupported characters.');
    const auditDir = join(p.securityHistoryDir, auditRunId);
    ensureInside(p.securityHistoryDir, auditDir, label + ' audit directory');
    for (const file of ['manifest.json', 'results.json', 'report.md']) {
      if (!existsSync(join(auditDir, file))) fail(label + ': full audit is missing ' + file + ' under ' + auditRunId + '.');
    }
    try {
      execFileSync(process.execPath, [join(scriptDir, 'validate-security-audit-run.mjs'), auditDir], {
        cwd: state.repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      fail(label + ': full audit validation failed: ' + String(error.stderr || error.message).trim());
    }
    const auditResults = readJson(join(auditDir, 'results.json'), label + ' full audit results');
    if (auditResults.verdict !== verdict) {
      fail(label + ': draft verdict ' + verdict + ' disagrees with full audit verdict ' + auditResults.verdict + '.');
    }
  } else if (raw.auditRunId !== undefined) {
    fail(label + ': FAST security does not create a full immutable audit run.');
  }
  const findings = validateFindings(raw.findings, label);
  if (verdict === 'PASS' && findings.some((finding) => finding.severity === 'critical')) {
    fail(label + ': PASS cannot carry a critical finding.');
  }
  if (verdict === 'BLOCKED' && !findings.some((finding) => finding.severity === 'critical')) {
    fail(label + ': BLOCKED requires at least one critical finding.');
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    pipelineRunId: state.runId,
    attempt: state.attempt,
    mode: state.securityPlan.mode,
    verdict,
    summary: requireString(raw.summary, label, 'summary'),
    checks,
    findings,
    limitations: stringArray(raw.limitations, label, 'limitations'),
    ...(auditRunId ? { auditRunId } : {}),
    stamp: buildStamp(state.repoRoot),
  };
}

function bulletList(items, empty = 'None.') {
  return items.length ? items.map((item) => '- ' + item).join('\n') : empty;
}

function renderSpec(spec) {
  const criteria = (items) =>
    items.length
      ? items.map((item) => '- **' + item.id + '** [' + item.verification + '] — ' + item.text).join('\n')
      : 'None.';
  return [
    '# ' + spec.ticket.title,
    '',
    '## Ticket Check',
    '',
    '- **What I am about to build:** ' + spec.ticketCheck.build,
    '- **What I am explicitly not doing:** ' + spec.ticketCheck.notDoing,
    '- **How you will know it worked:** ' + spec.ticketCheck.worked,
    '- **What I had to guess:** ' + spec.ticketCheck.guesses,
    '',
    '## Goal',
    '',
    spec.goal,
    '',
    '## Lane',
    '',
    spec.lane || 'Not declared.',
    '',
    '## Scope',
    '',
    '**In**',
    '',
    bulletList(spec.scopeIn),
    '',
    '**Out**',
    '',
    bulletList(spec.scopeOut),
    '',
    '## Affected files',
    '',
    bulletList(spec.affectedFiles),
    '',
    '## Interfaces',
    '',
    bulletList(spec.interfaces),
    '',
    '## Approach',
    '',
    spec.approach.map((item, index) => String(index + 1) + '. ' + item).join('\n'),
    '',
    '## Acceptance criteria',
    '',
    criteria(spec.acceptanceCriteria),
    '',
    '## Edge cases',
    '',
    criteria(spec.edgeCases),
    '',
    '## Open questions',
    '',
    bulletList(spec.openQuestions),
    '',
    '_Generated from canonical spec.json for pipeline run ' + spec.pipelineRunId + '._',
    '',
  ].join('\n');
}

function renderRed(red) {
  const coverage = red.coverage.map((entry) => {
    const path = entry.testPath ? ' — ' + entry.testPath : '';
    return '- ' + entry.specIds.join(', ') + ': **' + entry.mode + '**' + path + ' — ' + entry.reason;
  });
  const commands = red.commands.map(
    (command) => '- ' + command.id + ': ' + command.command + ' ' + command.args.join(' ') + ' (' + command.cwd + ')',
  );
  return [
    '# Red / coverage map',
    '',
    '## Impact map',
    '',
    '**' + red.impactMap.status + '** — ' + red.impactMap.summary,
    '',
    '## Requirement coverage',
    '',
    bulletList(coverage),
    '',
    '## Verification commands',
    '',
    bulletList(commands),
    '',
    '_Generated from canonical red.json._',
    '',
  ].join('\n');
}

function renderDev(dev) {
  return [
    '# Development handoff — attempt ' + dev.attempt,
    '',
    '## Summary',
    '',
    dev.summary,
    '',
    '## Files changed',
    '',
    bulletList(dev.filesChanged),
    '',
    '## Decisions',
    '',
    bulletList(dev.decisions),
    '',
    '## Deviations',
    '',
    bulletList(dev.deviations),
    '',
    '## Fixes applied',
    '',
    bulletList(dev.fixesApplied),
    '',
    '## Not done',
    '',
    bulletList(dev.notDone),
    '',
    '_Generated from canonical dev.json; the file list is derived from git._',
    '',
  ].join('\n');
}

function renderVerify(verify) {
  const lines = verify.commands.map(
    (entry) =>
      '- **' + entry.id + ': ' + entry.result + '** (' + entry.durationMs + ' ms) — log: ' + entry.log,
  );
  return [
    '# Deterministic verification — attempt ' + verify.attempt,
    '',
    '## Result',
    '',
    verify.result,
    '',
    '## Commands',
    '',
    bulletList(lines, 'No automated commands were required for this fast, review-only run.'),
    '',
    '_Generated by pipeline-run verify; no tester agent participated._',
    '',
  ].join('\n');
}

function renderFindings(findings) {
  return findings.length
    ? findings
        .map((finding) => {
          const location = finding.file ? ' (' + finding.file + (finding.line ? ':' + finding.line : '') + ')' : '';
          return '- **' + finding.severity + '**' + location + ' — ' + finding.message +
            (finding.fix ? ' Fix: ' + finding.fix : '');
        })
        .join('\n')
    : 'None.';
}

function renderReview(review) {
  return [
    '# Review — attempt ' + review.attempt,
    '',
    '## Verdict',
    '',
    review.verdict,
    '',
    '## Summary',
    '',
    review.summary,
    '',
    '## Findings',
    '',
    renderFindings(review.findings),
    '',
    '_Generated from canonical review.json._',
    '',
  ].join('\n');
}

function renderSecurity(security) {
  const checks = security.checks.map(
    (check) => '- **' + check.id + ': ' + check.result + '** — ' + check.evidence,
  );
  return [
    '# Security — ' + security.mode + ', attempt ' + security.attempt,
    '',
    '## Verdict',
    '',
    security.verdict,
    '',
    '## Summary',
    '',
    security.summary,
    '',
    '## Checks',
    '',
    bulletList(checks),
    '',
    '## Findings',
    '',
    renderFindings(security.findings),
    '',
    '## Limitations',
    '',
    bulletList(security.limitations),
    '',
    '_Generated from canonical security.json._',
    '',
  ].join('\n');
}

function renderForStage(stage, artifact) {
  return {
    planner: renderSpec,
    red: renderRed,
    dev: renderDev,
    review: renderReview,
    security: renderSecurity,
  }[stage](artifact);
}

function routeBackToDev(state, reason) {
  if (state.attempt >= state.maxAttempts) {
    state.status = 'blocked';
    state.blockedReason = reason + '; maximum of ' + state.maxAttempts + ' development attempts reached.';
    setStage(state, 'finalize', 'blocked', state.blockedReason);
    return;
  }
  state.attempt += 1;
  state.lastOutcome = reason;
  setStage(state, 'dev', 'pending', reason);
  setStage(state, 'verify', 'blocked');
  setStage(state, 'review', 'blocked');
  setStage(state, 'security', 'blocked');
  setStage(state, 'finalize', 'blocked');
}

function emitStage(root, stage, flags) {
  if (!EMIT_STAGES.has(stage)) fail('emit supports planner, red, dev, review, or security.', 2);
  const runId = resolveRunId(root, flags.run);
  const { state, p } = readState(root, runId);
  state.repoRoot = root;
  if (state.status !== 'active') fail('run is not active: ' + state.status);
  if (state.stages[stage].status !== 'pending' && state.stages[stage].status !== 'failed') {
    fail(stage + ' is not pending; current next stage is ' + String(nextPendingStage(state)) + '.');
  }
  const inputPath = resolve(root, flags.input);
  const raw = readJson(inputPath, 'draft input');
  let artifact;
  if (stage === 'planner') artifact = validatePlanner(raw, state);
  if (stage === 'red') artifact = validateRed(raw, state, readArtifact(p, 'planner'));
  if (stage === 'dev') {
    artifact = validateDev(raw, state, readArtifact(p, 'planner'), readArtifact(p, 'red', false));
  }
  if (stage === 'review') {
    const verify = readArtifact(p, 'verify');
    if (stampFreshness(verify.stamp, root) !== STAMP_FRESH) {
      fail('review cannot consume stale deterministic verification; route the current tree through dev/verify.');
    }
    artifact = validateReview(raw, state, verify);
  }
  if (stage === 'security') {
    const review = readArtifact(p, 'review');
    if (review.verdict !== 'PASS') fail('security requires review PASS.');
    if (stampFreshness(review.stamp, root) !== STAMP_FRESH) {
      fail('security cannot consume a stale review; route the current tree through dev/verify/review.');
    }
    artifact = validateSecurity(raw, state, p);
  }
  const markdown = renderForStage(stage, artifact);
  writeJsonAtomic(artifactPath(p, stage), artifact);
  writeTextAtomic(artifactPath(p, stage, 'md'), markdown);
  snapshotArtifact(p, stage, artifact, markdown, state.attempt);
  setStage(state, stage, 'passed');

  if (stage === 'planner') {
    state.profile = resolveProfile(state.requestedProfile, artifact);
    state.securityPlan = securityPlan(artifact.affectedFiles, state.profile);
    const needsRed = [...artifact.acceptanceCriteria, ...artifact.edgeCases]
      .some((item) => item.verification === 'test');
    if (needsRed) {
      setStage(state, 'red', 'pending');
      setStage(state, 'dev', 'blocked');
    } else {
      setStage(state, 'red', 'skipped', 'No requirement is classified for automated-test verification.');
      setStage(state, 'dev', 'pending');
    }
  }
  if (stage === 'red') setStage(state, 'dev', 'pending');
  if (stage === 'dev') {
    state.profile = maxProfile(state.profile, pathRiskProfile(artifact.filesChanged));
    state.securityPlan = securityPlan(artifact.filesChanged, state.profile);
    setStage(state, 'verify', 'pending');
  }
  if (stage === 'review') {
    if (artifact.verdict === 'PASS') setStage(state, 'security', 'pending');
    else routeBackToDev(state, 'review returned NEEDS_FIXES');
  }
  if (stage === 'security') {
    if (artifact.verdict === 'PASS') setStage(state, 'finalize', 'pending');
    else routeBackToDev(state, 'security returned BLOCKED');
  }
  delete state.repoRoot;
  writeState(p, state);
  console.log(
    JSON.stringify(
      {
        runId,
        emitted: stage,
        artifact: normalizePath(relative(root, artifactPath(p, stage))),
        profile: state.profile,
        next: nextPendingStage(state),
        attempt: state.attempt,
        status: state.status,
      },
      null,
      2,
    ),
  );
}

function collectVerificationCommands(p, state) {
  const red = readArtifact(p, 'red', false);
  const dev = readArtifact(p, 'dev');
  const commands = [...(red ? red.commands : []), ...dev.verificationCommands];
  const seen = new Set();
  return commands.filter((command) => {
    validateCommand(command, state.repoRoot, 'verification plan', 0);
    const key = JSON.stringify([command.command, command.args, command.cwd]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function checkRedIntegrity(root, p) {
  const red = readArtifact(p, 'red', false);
  if (!red) return { result: 'PASS', checked: 0, declaredChanges: [] };
  const dev = readArtifact(p, 'dev');
  const declarations = new Map(dev.redTestChanges.map((entry) => [entry.path, entry.reason]));
  const declaredChanges = [];
  for (const test of red.tests) {
    const absolutePath = resolve(root, test.path);
    ensureInside(root, absolutePath, 'red test path');
    if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
      fail('red integrity: test file no longer exists: ' + test.path);
    }
    const currentHash = sha256(readFileSync(absolutePath));
    if (currentHash === test.sha256) continue;
    if (!declarations.has(test.path)) {
      fail('red integrity: ' + test.path + ' changed after red without a dev redTestChanges declaration.');
    }
    declaredChanges.push({ path: test.path, reason: declarations.get(test.path) });
  }
  return { result: 'PASS', checked: red.tests.length, declaredChanges };
}

function checkRedDirectory(root, flags) {
  let directory;
  if (flags.dir) {
    directory = resolve(root, flags.dir);
    ensureInside(root, directory, 'red-integrity directory');
  } else {
    const runId = resolveRunId(root, flags.run);
    directory = runPaths(root, runId).artifactsDir;
  }
  const redPath = join(directory, 'red.json');
  if (!existsSync(redPath)) {
    console.log(JSON.stringify({ result: 'NOT_PRESENT', directory: normalizePath(relative(root, directory)) }, null, 2));
    return;
  }
  const spec = readJson(join(directory, 'spec.json'), 'v2 spec artifact');
  const red = readJson(redPath, 'v2 red artifact');
  const dev = readJson(join(directory, 'dev.json'), 'v2 dev artifact');
  for (const [name, artifact] of [['spec', spec], ['red', red], ['dev', dev]]) {
    requireObject(artifact, 'v2 ' + name + ' artifact');
    if (artifact.schemaVersion !== SCHEMA_VERSION) {
      fail('check-red supports v2 artifacts; use scripts/check-red-integrity.mjs for a legacy v1 run.');
    }
  }
  if (spec.pipelineRunId !== red.pipelineRunId || spec.pipelineRunId !== dev.pipelineRunId) {
    fail('v2 red-integrity artifacts belong to different pipeline runs.');
  }
  const knownIds = new Set([...spec.acceptanceCriteria, ...spec.edgeCases].map((item) => item.id));
  const declarations = new Map(dev.redTestChanges.map((entry) => [entry.path, entry.reason]));
  const declaredChanges = [];
  const violations = [];
  for (const item of red.tests) {
    for (const id of item.specIds) if (!knownIds.has(id)) violations.push(item.path + ' cites unknown spec ID ' + id + '.');
    const absolutePath = resolve(root, item.path);
    if (!isInside(root, absolutePath) || !existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
      violations.push(item.path + ' no longer exists as a repository file.');
      continue;
    }
    const currentHash = sha256(readFileSync(absolutePath));
    if (currentHash === item.sha256) continue;
    if (declarations.has(item.path)) declaredChanges.push({ path: item.path, reason: declarations.get(item.path) });
    else violations.push(item.path + ' changed after red without a dev declaration.');
  }
  const report = {
    result: violations.length ? 'FAIL' : 'PASS',
    pipelineRunId: spec.pipelineRunId,
    directory: normalizePath(relative(root, directory)),
    checked: red.tests.length,
    declaredChanges,
    violations,
  };
  console.log(JSON.stringify(report, null, 2));
  if (violations.length) process.exitCode = 1;
}

function writeBoundedLog(path, stdout, stderr) {
  let content = '';
  if (stdout) content += '--- stdout ---\n' + stdout;
  if (stderr) content += (content ? '\n' : '') + '--- stderr ---\n' + stderr;
  if (Buffer.byteLength(content, 'utf8') > MAX_LOG_BYTES) {
    content = content.slice(0, MAX_LOG_BYTES) + '\n\n[log truncated at ' + MAX_LOG_BYTES + ' bytes]\n';
  }
  writeTextAtomic(path, content || '(no output)\n');
}

function commandInvocation(command) {
  if (process.platform !== 'win32' || (command.command !== 'npm' && command.command !== 'npx')) {
    return { executable: command.command, args: command.args };
  }
  const cliName = command.command + '-cli.js';
  const candidates = [];
  if (process.env.npm_execpath) {
    candidates.push(join(dirname(process.env.npm_execpath), cliName));
  }
  candidates.push(join(dirname(process.execPath), 'node_modules', 'npm', 'bin', cliName));
  try {
    for (const shim of execFileSync('where.exe', [command.command + '.cmd'], { encoding: 'utf8' }).split(/\r?\n/)) {
      if (shim.trim()) candidates.push(join(dirname(shim.trim()), 'node_modules', 'npm', 'bin', cliName));
    }
  } catch {
    // The explicit candidates below produce the actionable failure if npm is unavailable.
  }
  const cli = candidates.find((candidate) => existsSync(candidate));
  if (!cli) fail('cannot locate ' + cliName + ' for argv-safe execution on Windows.');
  return { executable: process.execPath, args: [cli, ...command.args] };
}

function runVerification(root, flags) {
  const runId = resolveRunId(root, flags.run);
  const { state, p } = readState(root, runId);
  state.repoRoot = root;
  if (state.status !== 'active') fail('run is not active: ' + state.status);
  if (state.stages.verify.status !== 'pending' && state.stages.verify.status !== 'failed') {
    fail('verify is not pending; current next stage is ' + String(nextPendingStage(state)) + '.');
  }
  const commands = collectVerificationCommands(p, state);
  const redIntegrity = checkRedIntegrity(root, p);
  const spec = readArtifact(p, 'planner');
  const hasTestRequirement = [...spec.acceptanceCriteria, ...spec.edgeCases]
    .some((item) => item.verification === 'test');
  if (!commands.length && (state.profile !== 'fast' || hasTestRequirement)) {
    fail('verification plan is empty; record at least one argv-safe command in red or dev.');
  }
  mkdirSync(p.logsDir, { recursive: true });
  const results = [];
  const verificationEnv = { ...process.env };
  // A pipeline runner exercised from a node:test control-plane suite must launch the recorded test
  // as an independent run, not inherit Node's recursive-test sentinel and silently skip it.
  delete verificationEnv.NODE_TEST_CONTEXT;
  for (const command of commands) {
    const started = Date.now();
    const invocation = commandInvocation(command);
    const result = spawnSync(invocation.executable, invocation.args, {
      cwd: resolve(root, command.cwd),
      encoding: 'utf8',
      shell: false,
      timeout: command.timeoutMs,
      maxBuffer: MAX_LOG_BYTES,
      env: verificationEnv,
    });
    const logName = 'verify-' + String(results.length + 1).padStart(2, '0') + '-' +
      command.id.replace(/[^A-Za-z0-9._-]/g, '-') + '.log';
    const logPath = join(p.logsDir, logName);
    writeBoundedLog(logPath, result.stdout, result.stderr);
    results.push({
      id: command.id,
      command: command.command,
      args: command.args,
      cwd: command.cwd,
      result: result.status === 0 && !result.error ? 'PASS' : 'FAIL',
      exitCode: result.status,
      signal: result.signal || null,
      error: result.error ? result.error.message : null,
      durationMs: Date.now() - started,
      log: normalizePath(relative(root, logPath)),
    });
    if (results.at(-1).result === 'FAIL') break;
  }
  const artifact = {
    schemaVersion: SCHEMA_VERSION,
    pipelineRunId: state.runId,
    attempt: state.attempt,
    result: results.every((entry) => entry.result === 'PASS') ? 'PASS' : 'FAIL',
    commands: results,
    redIntegrity,
    stamp: buildStamp(root),
  };
  const markdown = renderVerify(artifact);
  writeJsonAtomic(artifactPath(p, 'verify'), artifact);
  writeTextAtomic(artifactPath(p, 'verify', 'md'), markdown);
  snapshotArtifact(p, 'verify', artifact, markdown, state.attempt);
  if (artifact.result === 'PASS') {
    setStage(state, 'verify', 'passed');
    setStage(state, 'review', 'pending');
  } else {
    setStage(state, 'verify', 'failed', 'One or more deterministic verification commands failed.');
    routeBackToDev(state, 'deterministic verification failed');
  }
  delete state.repoRoot;
  writeState(p, state);
  console.log(
    JSON.stringify(
      {
        runId,
        result: artifact.result,
        commands: results.map((entry) => ({ id: entry.id, result: entry.result, log: entry.log })),
        next: nextPendingStage(state),
        attempt: state.attempt,
        status: state.status,
      },
      null,
      2,
    ),
  );
  if (artifact.result !== 'PASS') process.exitCode = 1;
}

function entryMarkdown(entry) {
  return [
    '# Pipeline ledger entry — ' + entry.ticket,
    '',
    '## Run',
    '',
    '- Run ID: ' + entry.runId,
    '- Date: ' + entry.date,
    '- Profile: ' + entry.profile,
    '- Commit: ' + entry.commit.sha + ' (' + entry.commit.branch + ')',
    '',
    '## Goal',
    '',
    entry.goal,
    '',
    '## Verdicts',
    '',
    '- review: ' + entry.verdicts.review,
    '- security: ' + entry.verdicts.security + ' (' + entry.security.mode + ')',
    '- verification: ' + entry.verification.result,
    '',
    '## Files touched',
    '',
    bulletList(entry.filesTouched),
    '',
    '## Red tests',
    '',
    bulletList(entry.redTestPaths),
    '',
    '_Generated atomically from the canonical run-scoped artifacts._',
    '',
  ].join('\n');
}

function rebuildLedgerIndex(root) {
  const ledgerDir = paths(root).ledgerDir;
  const index = {};
  if (existsSync(ledgerDir)) {
    for (const entry of readdirSync(ledgerDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const runDir = join(ledgerDir, entry.name);
      const entryJsonPath = join(runDir, 'entry.json');
      const entryMdPath = join(runDir, 'entry.md');
      if (!existsSync(entryJsonPath) || !existsSync(entryMdPath)) {
        fail('ledger run ' + entry.name + ' is incomplete.');
      }
      const data = readJson(entryJsonPath, '.sdd/ledger/' + entry.name + '/entry.json');
      requireObject(data, 'ledger entry');
      if (data.bypass === true) continue;
      if (!data.verdicts || data.verdicts.review !== 'PASS' || data.verdicts.security !== 'PASS') {
        fail('ledger run ' + entry.name + ' is not a PASS/PASS entry.');
      }
      for (const file of data.filesTouched || []) {
        const normalized = normalizePath(String(file));
        if (!index[normalized]) index[normalized] = [];
        const record = {
          runId: entry.name,
          ticket: data.ticket,
          date: data.date,
          spec: '.sdd/ledger/' + entry.name + '/spec.md',
        };
        if (data.regate) record.regate = { testerRan: data.regate.testerRan };
        index[normalized].push(record);
      }
    }
  }
  const sorted = {};
  for (const file of Object.keys(index).sort()) {
    sorted[file] = index[file].sort((a, b) => a.runId.localeCompare(b.runId));
  }
  writeJsonAtomic(paths(root).ledgerIndexPath, sorted);
  return sorted;
}

function finalizeRun(root, flags) {
  const runId = resolveRunId(root, flags.run);
  const { state, p } = readState(root, runId);
  if (state.status !== 'active') fail('run is not active: ' + state.status);
  if (state.stages.finalize.status !== 'pending') {
    fail('finalize is not pending; current next stage is ' + String(nextPendingStage(state)) + '.');
  }
  const spec = readArtifact(p, 'planner');
  const red = readArtifact(p, 'red', false);
  const dev = readArtifact(p, 'dev');
  const verify = readArtifact(p, 'verify');
  const review = readArtifact(p, 'review');
  const security = readArtifact(p, 'security');
  if (verify.result !== 'PASS' || review.verdict !== 'PASS' || security.verdict !== 'PASS') {
    fail('finalize requires verification PASS, review PASS, and security PASS.');
  }
  if (stampFreshness(review.stamp, root) !== STAMP_FRESH) fail('review artifact is stale.');
  if (stampFreshness(security.stamp, root) !== STAMP_FRESH) fail('security artifact is stale.');
  if (stampFreshness(verify.stamp, root) !== STAMP_FRESH) fail('verification artifact is stale.');

  const ledgerTarget = join(p.ledgerDir, runId);
  if (existsSync(ledgerTarget)) fail('ledger entry already exists: .sdd/ledger/' + runId);
  const temp = join(p.ledgerDir, '.' + runId + '.tmp-' + process.pid);
  ensureInside(p.ledgerDir, temp, 'temporary ledger path');
  mkdirSync(temp, { recursive: true });
  try {
    const commit = currentCommit(root);
    const entry = {
      schemaVersion: SCHEMA_VERSION,
      runId,
      date: state.createdAt.slice(0, 10),
      ticket: state.ticket.id,
      ticketTitle: state.ticket.title,
      ticketId: state.ticket.id,
      goal: spec.goal,
      profile: state.profile,
      filesTouched: dev.filesChanged,
      redTestPaths: red ? red.tests.map((test) => test.path) : [],
      redAbsenceNote: red ? null : 'No requirement was classified for automated-test verification.',
      securityRunId: security.auditRunId || runId,
      commit: { ...commit, dirty: gitStatus(root).length > 0 },
      verdicts: { review: review.verdict, security: security.verdict },
      overrides: [],
      regate: null,
      verification: { result: verify.result, commandCount: verify.commands.length },
      security: { mode: security.mode, auditRunId: security.auditRunId || null },
      attempts: state.attempt,
      bypass: false,
    };
    copyFileSync(artifactPath(p, 'planner'), join(temp, 'spec.json'));
    copyFileSync(artifactPath(p, 'planner', 'md'), join(temp, 'spec.md'));
    if (red) copyFileSync(artifactPath(p, 'red'), join(temp, 'red.json'));
    copyFileSync(artifactPath(p, 'dev'), join(temp, 'dev.json'));
    copyFileSync(artifactPath(p, 'verify'), join(temp, 'verify.json'));
    copyFileSync(artifactPath(p, 'review'), join(temp, 'review.json'));
    copyFileSync(artifactPath(p, 'security'), join(temp, 'security.json'));
    writeJsonAtomic(join(temp, 'entry.json'), entry);
    writeTextAtomic(join(temp, 'entry.md'), entryMarkdown(entry));
    if (security.auditRunId) {
      cpSync(join(p.securityHistoryDir, security.auditRunId), join(temp, 'security'), { recursive: true });
    }
    renameSync(temp, ledgerTarget);
    const index = rebuildLedgerIndex(root);
    setStage(state, 'finalize', 'passed');
    state.status = 'complete';
    state.completedAt = new Date().toISOString();
    writeState(p, state);
    console.log(
      JSON.stringify(
        {
          runId,
          status: state.status,
          ledger: normalizePath(relative(root, ledgerTarget)),
          indexedFiles: Object.keys(index).length,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    if (existsSync(temp)) {
      ensureInside(p.ledgerDir, temp, 'temporary ledger cleanup path');
      rmSync(temp, { recursive: true, force: true });
    }
    throw error;
  }
}

function initRun(root, flags) {
  const ticketTitle = requireString(flags.ticket, 'init', 'ticket');
  const requestedProfile = flags.profile || 'auto';
  if (!PROFILES.includes(requestedProfile)) {
    fail('--profile must be one of ' + PROFILES.join(', ') + '.', 2);
  }
  const dirty = gitStatus(root);
  if (dirty && !flags['allow-dirty']) {
    fail('refusing to initialize on a dirty worktree; use a clean ticket worktree or pass --allow-dirty explicitly.');
  }
  const basePaths = paths(root);
  if (existsSync(basePaths.currentPath)) {
    const currentId = readCurrentId(root);
    const current = readState(root, currentId).state;
    if (current.status === 'active' && current.ticket.title === ticketTitle && !flags.new) {
      console.log(
        JSON.stringify(
          {
            runId: currentId,
            reused: true,
            status: current.status,
            next: nextPendingStage(current),
            message: 'The active run already has this exact independently supplied ticket.',
          },
          null,
          2,
        ),
      );
      return;
    }
    if (current.status === 'active' && !flags.new) {
      fail(
        'another run is active for "' + current.ticket.title +
          '"; finish it or pass --new to preserve it and start a different run.',
      );
    }
  }
  const runId = flags['run-id'] || createRunId(root);
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) fail('--run-id contains unsupported characters.', 2);
  const p = runPaths(root, runId);
  if (existsSync(p.runDir)) fail('run directory already exists: ' + runId);
  mkdirSync(p.artifactsDir, { recursive: true });
  mkdirSync(p.draftsDir, { recursive: true });
  mkdirSync(p.historyDir, { recursive: true });
  mkdirSync(p.logsDir, { recursive: true });
  const commit = currentCommit(root);
  const createdAt = new Date().toISOString();
  const state = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    ticket: { id: extractTicketId(ticketTitle), title: ticketTitle },
    requestedProfile,
    profile: null,
    status: 'active',
    currentStage: 'planner',
    attempt: 1,
    maxAttempts: MAX_ATTEMPTS,
    createdAt,
    updatedAt: createdAt,
    base: {
      headSha: commit.sha,
      branch: commit.branch,
      treeHash: buildStamp(root).treeHash,
      dirty: Boolean(dirty),
    },
    stages: stageMap(),
    securityPlan: null,
  };
  writeJsonAtomic(p.statePath, state);
  writeJsonAtomic(basePaths.currentPath, { schemaVersion: SCHEMA_VERSION, runId });
  console.log(
    JSON.stringify(
      {
        runId,
        ticket: state.ticket,
        requestedProfile,
        runDir: normalizePath(relative(root, p.runDir)),
        next: 'planner',
      },
      null,
      2,
    ),
  );
}

function statusRun(root, flags) {
  const runId = resolveRunId(root, flags.run);
  const { state, p } = readState(root, runId);
  const report = {
    runId,
    ticket: state.ticket,
    requestedProfile: state.requestedProfile,
    profile: state.profile,
    status: state.status,
    attempt: state.attempt,
    maxAttempts: state.maxAttempts,
    next: nextPendingStage(state),
    securityPlan: state.securityPlan,
    stages: state.stages,
    artifactsDir: normalizePath(relative(root, p.artifactsDir)),
    runDir: normalizePath(relative(root, p.runDir)),
  };
  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log('Pipeline run: ' + report.runId);
  console.log('Ticket: ' + report.ticket.title);
  console.log('Status: ' + report.status + '; profile: ' + String(report.profile || report.requestedProfile));
  console.log('Attempt: ' + report.attempt + '/' + report.maxAttempts + '; next: ' + String(report.next));
  for (const stage of STAGES) console.log('- ' + stage + ': ' + state.stages[stage].status);
  console.log('Artifacts: ' + report.artifactsDir);
}

function reopenRun(root, flags) {
  const runId = resolveRunId(root, flags.run);
  const { state, p } = readState(root, runId);
  if (state.status !== 'active') {
    fail('only an active, unfinalized run can be reopened; start a new run for changes after ledger promotion.');
  }
  const reason = requireString(flags.reason, 'reopen', 'reason');
  if (!['review', 'security', 'finalize'].includes(nextPendingStage(state))) {
    fail('reopen is only for a hand edit after verification/review; current next stage is ' + String(nextPendingStage(state)) + '.');
  }
  routeBackToDev(state, 'hand edit: ' + reason);
  writeState(p, state);
  console.log(JSON.stringify({ runId, status: state.status, attempt: state.attempt, next: nextPendingStage(state) }, null, 2));
}

function schemaExample(stage) {
  const commonCommand = {
    id: 'focused-tests',
    command: 'npm',
    args: ['run', 'test:example'],
    cwd: '.',
    reason: 'Focused verification for the changed control.',
    specIds: ['AC-1'],
  };
  const examples = {
    planner: {
      goal: 'Human-facing outcome.',
      ticketCheck: {
        build: 'What changes.',
        notDoing: 'Boundary.',
        worked: 'Observable proof.',
        guesses: 'Assumptions, or None.',
      },
      scopeIn: ['Included item'],
      scopeOut: ['Excluded item'],
      affectedFiles: ['path/to/file.ts'],
      interfaces: ['Exact signature or None.'],
      approach: ['First implementation step'],
      acceptanceCriteria: [{ id: 'AC-1', text: 'Observable behavior.', verification: 'test' }],
      edgeCases: [{ id: 'EC-1', text: 'Boundary behavior.', verification: 'review' }],
      openQuestions: [],
      lane: 'full',
      changeKind: 'behavioral',
      risk: 'standard',
    },
    red: {
      coverage: [
        { specIds: ['AC-1'], mode: 'new', testPath: 'path/to/file.test.ts', reason: 'Regression proof.' },
      ],
      tests: [
        {
          path: 'path/to/file.test.ts',
          specIds: ['AC-1'],
          source: 'new',
          sha256: '64-character SHA-256',
          classification: 'RED-CORRECT',
        },
      ],
      commands: [commonCommand],
      impactMap: { status: 'usable', summary: 'Ranked affected tests were consulted.' },
    },
    dev: {
      summary: 'What was implemented.',
      decisions: [],
      deviations: [],
      redTestChanges: [],
      fixesApplied: [],
      notDone: [],
      verificationCommands: [commonCommand],
    },
    review: {
      verdict: 'PASS',
      summary: 'Why the diff and evidence meet the spec.',
      findings: [],
    },
    security: {
      verdict: 'PASS',
      summary: 'Why the required security plan passed.',
      checks: [{ id: 'FAST-SECRET-DIFF', result: 'PASS', evidence: 'No new secret path.' }],
      findings: [],
      limitations: [],
    },
  };
  if (!examples[stage]) fail('schema stage must be planner, red, dev, review, or security.', 2);
  return examples[stage];
}

function printHelp() {
  console.log(
    [
      'Usage:',
      '  node scripts/pipeline-run.mjs init --ticket <text> [--profile auto|fast|standard|sensitive|milestone]',
      '  node scripts/pipeline-run.mjs schema <planner|red|dev|review|security>',
      '  node scripts/pipeline-run.mjs emit <stage> --input <draft.json> [--run <id>]',
      '  node scripts/pipeline-run.mjs verify [--run <id>]',
      '  node scripts/pipeline-run.mjs check-red [--run <id> | --dir <v2-artifact-directory>]',
      '  node scripts/pipeline-run.mjs status [--json] [--run <id>]',
      '  node scripts/pipeline-run.mjs next [--run <id>]',
      '  node scripts/pipeline-run.mjs reopen --reason <hand-edit reason> [--run <id>]',
      '  node scripts/pipeline-run.mjs finalize [--run <id>]',
      '',
      'Global test-only option: --cwd <git-worktree>',
    ].join('\n'),
  );
}

function main() {
  const { argv, root } = parseGlobalArgs(process.argv.slice(2));
  const command = argv.shift();
  if (!command || command === 'help' || command === '--help') {
    printHelp();
    return;
  }
  if (command === 'init') {
    const flags = parseFlags(argv, {
      '--ticket': 'value',
      '--profile': 'value',
      '--run-id': 'value',
      '--allow-dirty': 'boolean',
      '--new': 'boolean',
    });
    initRun(root, flags);
    return;
  }
  if (command === 'schema') {
    if (argv.length !== 1) fail('schema requires exactly one stage.', 2);
    console.log(JSON.stringify(schemaExample(argv[0]), null, 2));
    return;
  }
  if (command === 'emit') {
    const stage = argv.shift();
    const flags = parseFlags(argv, { '--input': 'value', '--run': 'value' });
    if (!flags.input) fail('emit requires --input <draft.json>.', 2);
    emitStage(root, stage, flags);
    return;
  }
  if (command === 'verify') {
    const flags = parseFlags(argv, { '--run': 'value' });
    runVerification(root, flags);
    return;
  }
  if (command === 'check-red') {
    const flags = parseFlags(argv, { '--run': 'value', '--dir': 'value' });
    if (flags.run && flags.dir) fail('check-red accepts either --run or --dir, not both.', 2);
    checkRedDirectory(root, flags);
    return;
  }
  if (command === 'status') {
    const flags = parseFlags(argv, { '--run': 'value', '--json': 'boolean' });
    statusRun(root, flags);
    return;
  }
  if (command === 'next') {
    const flags = parseFlags(argv, { '--run': 'value' });
    const runId = resolveRunId(root, flags.run);
    const { state } = readState(root, runId);
    console.log(JSON.stringify({ runId, status: state.status, next: nextPendingStage(state) }, null, 2));
    return;
  }
  if (command === 'reopen') {
    const flags = parseFlags(argv, { '--run': 'value', '--reason': 'value' });
    if (!flags.reason) fail('reopen requires --reason <text>.', 2);
    reopenRun(root, flags);
    return;
  }
  if (command === 'finalize') {
    const flags = parseFlags(argv, { '--run': 'value' });
    finalizeRun(root, flags);
    return;
  }
  fail('unknown command "' + command + '". Run with --help.', 2);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write('pipeline-run: ' + error.message + '\n');
    process.exit(error.exitCode || 1);
  }
}

export {
  extractTicketId,
  nextPendingStage,
  pathRiskProfile,
  rebuildLedgerIndex,
  renderDev,
  renderRed,
  renderReview,
  renderSecurity,
  renderSpec,
  renderVerify,
  resolveProfile,
  schemaExample,
  securityPlan,
};
