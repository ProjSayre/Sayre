// Red-stage behavioral tests for W0-00 (Dependency & Environment Baseline — re-derivation / audit).
// Authored from .pipeline/spec.md alone, before `dev` implements anything, per .sdd/stages/red.md.
//
// This is the file-content half of the ticket: assertions over the manifests
// (apps/web, services/core, services/gateway, packages/config, packages/shared-types package.json +
// services/workers/pyproject.toml) and over DEPENDENCIES.md. The install-mechanics half (AC-1 and
// its edge cases, which "cannot be satisfied by inspection") lives in
// scripts/dependency-install.test.mjs, which actually runs `npm ci` / `poetry install`.
//
// Convention: node:test + plain assertions over files, matching the other repo-hygiene checks under
// scripts/*.test.mjs (e.g. generate-agent-shims.test.mjs, check-red-integrity.test.mjs). Run with
//   node --test scripts/dependency-baseline.test.mjs
//
// @spec-note: O-1 was resolved by human sign-off to "bump zod to 4.4.x", so AC-4/AC-5 assert that
// exact target rather than an either-or. O-2 (openai pin style) and O-4 (@sigma/node-border float)
// are dev-discretion/confirm items — the AC-3 float check below deliberately accepts either the
// current `^3.0.0` or a hard-pinned `3.0.x` for @sigma/node-border rather than hard-failing a
// reasonable documented decision to keep it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');

const NPM_MANIFEST_PATHS = {
  'apps/web': 'apps/web/package.json',
  'services/core': 'services/core/package.json',
  'services/gateway': 'services/gateway/package.json',
  'packages/config': 'packages/config/package.json',
  'packages/shared-types': 'packages/shared-types/package.json',
};

function readJson(relPath) {
  return JSON.parse(readFileSync(resolve(repoRoot, relPath), 'utf8'));
}

function readText(relPath) {
  return readFileSync(resolve(repoRoot, relPath), 'utf8');
}

/** { name: spec } across both dependencies and devDependencies of one npm manifest. */
function allNpmDeps(manifest) {
  return { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
}

/** Every npm package name declared anywhere across the five workspace-member manifests. */
function allNpmPackageNames() {
  const names = new Set();
  for (const relPath of Object.values(NPM_MANIFEST_PATHS)) {
    for (const name of Object.keys(allNpmDeps(readJson(relPath)))) names.add(name);
  }
  return names;
}

/** Parse the two dependency surfaces of pyproject.toml without a TOML lib:
 *  the `[project.dependencies]` array and the `[tool.poetry.group.dev.dependencies]` table.
 *  Returns the requirement token (name plus any extras, e.g. `PyJWT[crypto]`), version stripped. */
function pyprojectPackageTokens() {
  const toml = readText('services/workers/pyproject.toml');
  const tokens = [];

  // Anchor the closing bracket to a line-start `]` (the array's own closing line), so an entry
  // containing extras like `uvicorn[standard]` doesn't terminate the capture at its inner `]`.
  const arrayMatch = toml.match(/\bdependencies\s*=\s*\[([\s\S]*?)\n\]/);
  if (arrayMatch) {
    for (const strMatch of arrayMatch[1].matchAll(/"([^"]+)"/g)) {
      const token = strMatch[1].match(/^([A-Za-z0-9._-]+(?:\[[A-Za-z0-9,._-]+\])?)/);
      if (token) tokens.push(token[1]);
    }
  }

  const devMatch = toml.match(/\[tool\.poetry\.group\.dev\.dependencies\]([\s\S]*?)(?:\n\[|$)/);
  if (devMatch) {
    for (const line of devMatch[1].split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z0-9._-]+(?:\[[A-Za-z0-9,._-]+\])?)\s*=/);
      if (m) tokens.push(m[1]);
    }
  }
  return tokens;
}

/** Base package name: extras stripped, lowercased (pip-normalized-ish, enough for presence checks). */
function baseName(token) {
  return token.replace(/\[[^\]]*\]/, '').toLowerCase();
}

/** The raw version spec attached to a pyproject requirement `token` (extras included), operators
 *  left intact so a poetry caret/tilde is still visible. Returns undefined if the token has no
 *  spec. Array (PEP508) form: `"token==0.115.*"`; poetry table form: `token = "8.*"`. */
function pyprojectSpecFor(token) {
  const toml = readText('services/workers/pyproject.toml');
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const arr = toml.match(new RegExp(`"${escaped}\\s*([^"]*)"`));
  if (arr) return arr[1].trim();
  const tbl = toml.match(new RegExp(`^${escaped}\\s*=\\s*"([^"]*)"`, 'm'));
  if (tbl) return tbl[1].trim();
  return undefined;
}

/** Body of the first `## ` section whose heading contains `keyword`, up to the next `## `. */
function dependenciesMdSection(keyword) {
  const md = readText('DEPENDENCIES.md');
  const blocks = md.split(/\n(?=## )/);
  for (const block of blocks) {
    const heading = block.split('\n', 1)[0];
    if (heading.startsWith('## ') && heading.includes(keyword)) return block;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// AC-2 / EC-5 — DEPENDENCIES.md lists every package (the core regression this audit found broken).
// ---------------------------------------------------------------------------------------------

// @spec EC-5
test('[EC-5] every package in every manifest appears somewhere in DEPENDENCIES.md (mechanical set-difference)', () => {
  const md = readText('DEPENDENCIES.md').toLowerCase();

  const missing = [];
  for (const name of allNpmPackageNames()) {
    if (!md.includes(name.toLowerCase())) missing.push(name);
  }
  for (const token of pyprojectPackageTokens()) {
    if (!md.includes(baseName(token))) missing.push(token);
  }

  assert.deepEqual(
    missing.sort(),
    [],
    `DEPENDENCIES.md is missing a row for these packages present in a manifest: ${missing.sort().join(', ')}`,
  );
});

// @spec AC-2
test('[AC-2] the specific audit findings B1-B9 are resolved in the correct DEPENDENCIES.md sections', () => {
  const appsWeb = dependenciesMdSection('apps/web');
  const core = dependenciesMdSection('services/core');
  const workers = dependenciesMdSection('services/workers');
  const config = dependenciesMdSection('packages/config');

  assert.ok(appsWeb, 'DEPENDENCIES.md must have an apps/web section');
  assert.ok(core, 'DEPENDENCIES.md must have a services/core section');
  assert.ok(workers, 'DEPENDENCIES.md must have a services/workers section');

  // B1, B2, B3, B4, B5 — apps/web rows.
  assert.match(appsWeb, /@sigma\/node-border/, 'B1: @sigma/node-border missing from apps/web section');
  assert.match(appsWeb, /@sayre\/config/, 'B2: @sayre/config missing from apps/web section');
  assert.match(appsWeb, /@sayre\/shared-types/, 'B3: @sayre/shared-types missing as an apps/web row');
  assert.match(appsWeb, /react-test-renderer/, 'B4: react-test-renderer missing from apps/web section');
  assert.match(appsWeb, /@types\/react-test-renderer/, 'B5: @types/react-test-renderer missing from apps/web section');

  // B6 — services/core @sayre/config row.
  assert.match(core, /@sayre\/config/, 'B6: @sayre/config missing from services/core section');

  // B7 — packages/config section exists and lists the package + its devDeps.
  assert.ok(config, 'B7: DEPENDENCIES.md has no packages/config section');
  assert.match(config, /@sayre\/config/, 'B7: packages/config section must list @sayre/config');
  for (const dev of ['@types/node', 'typescript', 'vitest']) {
    assert.ok(config.includes(dev), `B7: packages/config section must document its devDep ${dev}`);
  }

  // B8 — PyJWT[crypto] row.
  assert.match(workers, /PyJWT/i, 'B8: PyJWT[crypto] missing from services/workers section');

  // B9 — httpx documented as a MAIN dependency, not a dev-only transitive.
  const httpxRow = workers.split(/\r?\n/).find((line) => /^\|\s*`httpx`/.test(line));
  assert.ok(httpxRow, 'B9: httpx row missing from services/workers section');
  assert.doesNotMatch(httpxRow, /dev group/, 'B9: httpx must be documented as a main dependency, not "(dev group)"');
});

// @spec EC-6
test('[EC-6] no DEPENDENCIES.md package row documents a package absent from every manifest', () => {
  const manifestNames = new Set([...allNpmPackageNames()].map((n) => n.toLowerCase()));
  for (const token of pyprojectPackageTokens()) manifestNames.add(baseName(token));
  // Workspace self-names + root orchestration package legitimately appear as rows without being a
  // dependency of the package whose section they head.
  for (const selfName of ['@sayre/config', '@sayre/shared-types', '@sayre/core', 'turbo']) {
    manifestNames.add(selfName.toLowerCase());
  }

  const stale = [];
  for (const keyword of ['apps/web', 'services/core', 'services/gateway', 'packages/config', 'packages/shared-types', 'services/workers']) {
    const section = dependenciesMdSection(keyword);
    if (!section) continue;
    for (const line of section.split(/\r?\n/)) {
      const rowName = line.match(/^\|\s*`([^`]+)`\s*\|/);
      if (!rowName) continue;
      const name = baseName(rowName[1]);
      if (!manifestNames.has(name)) stale.push(`${rowName[1]} (in ${keyword} section)`);
    }
  }
  assert.deepEqual(stale.sort(), [], `DEPENDENCIES.md has row(s) for package(s) no longer in any manifest: ${stale.join(', ')}`);
});

// ---------------------------------------------------------------------------------------------
// AC-4 / AC-5 — zod reconciled with the PRD, and every PRD-named package present at its version.
// ---------------------------------------------------------------------------------------------

// @spec AC-4
test('[AC-4] services/core pins zod to the PRD-named 4.4.x (O-1 resolved: bump to 4.4.x)', () => {
  const core = readJson('services/core/package.json');
  assert.equal(core.dependencies.zod, '4.4.x', 'zod must be reconciled to the PRD-named 4.4.x line');
});

// @spec AC-5
test('[AC-5] every PRD-named package is present in the correct manifest at its PRD-named version', () => {
  const web = allNpmDeps(readJson('apps/web/package.json'));
  const core = allNpmDeps(readJson('services/core/package.json'));

  // apps/web — presence, plus the versions the PRD/AC-5 names explicitly.
  for (const name of ['next', 'react', 'sigma', 'graphology', 'graphology-layout', 'tailwindcss', 'typescript']) {
    assert.ok(web[name], `apps/web must declare ${name}`);
  }
  assert.equal(web['@xyflow/react'], '12.11.x', 'apps/web @xyflow/react must be the PRD-named 12.11.x');

  // services/core — presence, plus the version AC-5 names explicitly.
  for (const name of [
    'express', 'bullmq', 'ioredis', 'neo4j-driver', 'pg', 'jsonwebtoken', 'zod',
    '@aws-sdk/client-sqs', '@aws-sdk/client-sns',
    '@opentelemetry/api', '@opentelemetry/sdk-metrics', '@opentelemetry/exporter-prometheus',
  ]) {
    assert.ok(core[name], `services/core must declare ${name}`);
  }
  assert.equal(core['@modelcontextprotocol/sdk'], '1.29.x', 'services/core MCP SDK must be the PRD-named 1.29.x');

  // services/workers — presence, plus the exact pin AC-5 names for graphifyy.
  const py = pyprojectPackageTokens().map(baseName);
  for (const name of ['fastapi', 'uvicorn', 'tree-sitter', 'tree-sitter-language-pack', 'langchain', 'langgraph', 'graphifyy', 'openai', 'boto3', 'psycopg', 'pgvector', 'anthropic']) {
    assert.ok(py.includes(name), `services/workers must declare ${name}`);
  }
  const pyproject = readText('services/workers/pyproject.toml');
  assert.match(pyproject, /graphifyy==0\.9\.16/, 'graphifyy must be pinned to the PRD-named 0.9.16');
  assert.match(pyproject, /openai[>=]{2}2\.45|openai==2\.45/, 'openai must resolve on the PRD-named 2.45 line');

  // infra images — PRD-named datastore images.
  const compose = readText('infra/docker-compose.yml');
  assert.match(compose, /pgvector\/pgvector:pg16/, 'infra must pin a pgvector-capable Postgres image');
  assert.match(compose, /redis:7\.\d+/, 'infra must pin Redis 7.x');
  assert.match(compose, /neo4j:5\.\d+-community/, 'infra must pin Neo4j 5 community');
});

// ---------------------------------------------------------------------------------------------
// AC-3 / EC-4 — every package pinned, no registry floats (except workspace-internal + PRD X.Y.*).
// ---------------------------------------------------------------------------------------------

// @spec AC-3 EC-4
test('[AC-3][EC-4] no bare *, no latest, no ^/~ float in any manifest (workspace @sayre/* excluded)', () => {
  const floats = [];
  for (const [location, relPath] of Object.entries(NPM_MANIFEST_PATHS)) {
    for (const [name, spec] of Object.entries(allNpmDeps(readJson(relPath)))) {
      // EC-4: legitimate workspace-internal reference, npm-workspace-resolved, not a registry float.
      if (name.startsWith('@sayre/')) continue;
      // O-4 dev-discretion: @sigma/node-border may stay ^3.0.0 or be hard-pinned to 3.0.x — accept both.
      if (name === '@sigma/node-border' && (spec === '^3.0.0' || spec === '3.0.x')) continue;
      if (spec === '*' || spec === 'latest' || /^[\^~]/.test(spec)) {
        floats.push(`${location}: ${name}@${spec}`);
      }
    }
  }
  // pyproject uses the PRD `==X.Y.*` minor-line style plus a couple of bounded ranges — both are
  // legitimate pins. Only a poetry caret/tilde (`^`/`~`) or a *bare* `*` version is an unpinned
  // float; a trailing `.*` (e.g. `0.24.*`) is a minor-line pin, NOT a float.
  for (const token of pyprojectPackageTokens()) {
    const spec = pyprojectSpecFor(token);
    if (spec === undefined) continue;
    if (/^[\^~]/.test(spec) || spec === '*') floats.push(`services/workers: ${token}@${spec}`);
  }
  assert.deepEqual(floats.sort(), [], `Unpinned float(s) found: ${floats.join(', ')}`);
});

// @spec AC-3
test('[AC-3] no Docker image is pinned to a floating/`latest` tag', () => {
  const compose = readText('infra/docker-compose.yml');
  for (const m of compose.matchAll(/image:\s*(\S+)/g)) {
    const image = m[1];
    assert.ok(image.includes(':'), `image ${image} has no explicit tag`);
    assert.doesNotMatch(image, /:latest$/, `image ${image} uses the floating :latest tag`);
  }
});

// ---------------------------------------------------------------------------------------------
// AC-7 — cross-runtime version consistency preserved across npm workspace members.
// ---------------------------------------------------------------------------------------------

// @spec AC-7
test('[AC-7] shared tooling stays on a single line across the packages that declare it', () => {
  const manifests = Object.fromEntries(
    Object.entries(NPM_MANIFEST_PATHS).map(([loc, p]) => [loc, allNpmDeps(readJson(p))]),
  );
  const shared = {
    typescript: '5.5.x',
    eslint: '8.57.x',
    vitest: '2.1.x',
    '@types/node': '20.x',
    ioredis: '5.4.x',
    '@aws-sdk/client-sqs': '3.1088.x',
    '@aws-sdk/client-sns': '3.1088.x',
  };
  for (const [pkg, expected] of Object.entries(shared)) {
    for (const [loc, deps] of Object.entries(manifests)) {
      if (deps[pkg] === undefined) continue;
      assert.equal(deps[pkg], expected, `${pkg} in ${loc} must stay on ${expected} (found ${deps[pkg]})`);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// AC-9 — DEPENDENCIES.md future-swap + deliberate-non-migration notes intact.
// ---------------------------------------------------------------------------------------------

// @spec AC-9
test('[AC-9] the three migration-trigger swaps and two deliberate-non-migration notes remain', () => {
  const md = readText('DEPENDENCIES.md');
  assert.match(md, /neo4j-driver/, 'neo4j-driver swap entry missing');
  assert.match(md, /Neptune/, 'Neo4j -> Neptune trigger missing');
  assert.match(md, /pgvector/, 'pgvector swap entry missing');
  assert.match(md, /OpenSearch/, 'pgvector -> OpenSearch trigger missing');
  assert.match(md, /GraphQL/, 'REST -> GraphQL trigger missing');
  assert.match(md, /Deliberate non-migrations/, 'deliberate-non-migrations section missing');
  assert.match(md, /React Flow/, 'React Flow / Sigma non-migration note missing');
  assert.match(md, /bullmq/i, 'SQS\/SNS vs BullMQ non-migration note missing');
});

// ---------------------------------------------------------------------------------------------
// AC-8 / EC-10 — out-of-scope surfaces (marketing site + infra images) stay untouched.
// (The positive "diff touches only allowed paths" half is verified by review against dev's diff;
//  this guards the specific values that must NOT move.)
// ---------------------------------------------------------------------------------------------

// @spec AC-8 EC-10
// PL-15: the marketing site moved from the repo root into apps/site/ (@sayre/site). The guarantee
// this test exists for is unchanged — only the manifest that holds the marketing site's scripts and
// dependencies moved. Declared as a red-test change in .pipeline/changes.json.
test('[AC-8][EC-10] the marketing site scripts/deps and infra image pins are unchanged', () => {
  const site = readJson('apps/site/package.json');
  assert.equal(site.scripts.dev, 'vite', 'marketing site dev script must stay `vite`');
  for (const script of ['og', 'test:waitlist', 'preview']) {
    assert.ok(site.scripts[script], `marketing site script ${script} must remain`);
  }
  for (const dep of ['d3-hierarchy', 'react-router-dom']) {
    assert.ok(site.dependencies[dep], `marketing site dependency ${dep} must remain`);
  }
  assert.ok(site.devDependencies.vite, 'marketing site vite devDependency must remain');

  // The workspace root must no longer carry the site's runtime dependencies — conflating the two
  // is exactly what PL-15 removed, and a silent regression back to it should fail here.
  const root = readJson('package.json');
  assert.equal(root.dependencies, undefined, 'the workspace root must declare no runtime dependencies');

  const compose = readText('infra/docker-compose.yml');
  for (const image of ['pgvector/pgvector:pg16', 'redis:7.4-alpine', 'neo4j:5.24-community']) {
    assert.ok(compose.includes(image), `infra image ${image} must stay unchanged`);
  }
});

// ---------------------------------------------------------------------------------------------
// EC-9 — no real secrets leaked into DEPENDENCIES.md / infra config (placeholders / ${VAR} only).
// ---------------------------------------------------------------------------------------------

// @spec EC-9
test('[EC-9] DEPENDENCIES.md and infra config carry only placeholders, never a real credential', () => {
  const env = readText('infra/.env.example');
  // Every secret-bearing var must be a placeholder, not a concrete credential. "Safe" = the value
  // carries an angle-bracket placeholder (`<...>`, possibly with a path suffix) or a `${VAR}`
  // reference, is a scheme/localhost URL, or simply contains no long high-entropy token that could
  // be a real key. This flags an actual leaked secret without false-positiving on placeholder URLs.
  for (const line of env.split(/\r?\n/)) {
    if (!/PASSWORD|SECRET|_KEY|AUTH|TOKEN|CLIENT_ID|_DSN/.test(line)) continue;
    if (/^\s*#/.test(line)) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const value = line.slice(eq + 1).trim();
    if (value === '') continue;
    const hasPlaceholder = /<[^>]+>/.test(value) || value.includes('${');
    const isSchemeUrl = /^(https?|bolt|redis):/.test(value);
    const hasHighEntropyToken = /[A-Za-z0-9+/=]{20,}/.test(value.replace(/<[^>]+>/g, ''));
    const safe = hasPlaceholder || isSchemeUrl || !hasHighEntropyToken;
    assert.ok(safe, `infra/.env.example line may contain a real secret value: ${line}`);
  }

  const depsMd = readText('DEPENDENCIES.md');
  assert.doesNotMatch(depsMd, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'DEPENDENCIES.md must not contain a private key');
  assert.doesNotMatch(depsMd, /\bAKIA[0-9A-Z]{16}\b/, 'DEPENDENCIES.md must not contain an AWS access key id');
});
