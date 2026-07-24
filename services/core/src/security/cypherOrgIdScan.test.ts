// Static-source-scan test (W2-06) -- asserts every graph Cypher literal that
// runs against Neo4j references org_id. Analogous in spirit/style to the
// architecture-fitness scan in neo4jChokepoint.test.ts, but answers a
// different question: not "can this file reach Neo4j at all" but "is every
// Cypher literal that DOES reach Neo4j org-scoped".
//
// Scans:
//   - Node write-side: services/core/src/graph-write/** and
//     services/core/src/integrations/** (both authoring '*_CYPHER' consts).
//   - Node read-side: every export from services/core/src/graph-query/index.ts
//     whose name ends in '_CYPHER' -- imported directly (not regex-scanned),
//     so a renamed/added export is caught by a compile error or by this
//     scan's own dynamic enumeration, never silently skipped.
//   - Python: services/workers/sayre_workers/** (the Ingestion Worker owns
//     all Neo4j writes per CLAUDE.md "Structure").
//
// Also asserts the schema-anchor sentinel org
// (00000000-0000-0000-0000-000000000000, packages/graph-schema/schema.md
// "Schema-anchor nodes") appears ONLY in the two anchor migration files,
// never in a runtime query.
//
// Post-security-audit hardening (FND-5da52fce61f4, 2026-07-23): this scan
// previously did a raw `body.includes('$org_id')` / `literal.includes('$org_id')`
// substring test -- the same class of bypass proven against the runtime guard
// (graphOrgGuard.ts): a `$org_id` mention inside a `//`/`/* */` comment, or in
// a non-predicate position (e.g. a RETURN projection), would satisfy the old
// check without the query actually being filtered by org. The scan now
// delegates to `referencesOrgIdPredicate` (the same comment-stripping +
// structural-predicate check used by the runtime guard), so the static scan
// and the runtime guard can never silently disagree about what "org-scoped"
// means.
//
// Second-round hardening (Gap 1, remediation-verification pass #2,
// 2026-07-23): `referencesOrgIdPredicate` now ALSO strips Cypher string
// literal contents (not just comments) before matching, closing a decoy-
// string-literal bypass found by tester and escalated blocking by review.
// Because this scan calls the shared function directly, the fix applies here
// automatically -- proven by the dedicated regression `describe` block near
// the bottom of this file rather than left implicit.
//
// Third-round hardening (Gap 3, third remediation round, 2026-07-23):
// `referencesOrgIdPredicate` now runs `stripCypherNoise`, a single linear
// left-to-right state-machine scan, instead of two independent global-regex
// passes (one for comments, one for string literals) that could desync when
// a string of one quote type contained an embedded quote of the other type.
// Again, because this scan calls the shared function directly, the fix
// applies here automatically -- proven by its own dedicated regression
// `describe` block below.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import * as graphQueryModule from '../graph-query';
import { referencesOrgIdPredicate } from './graphOrgGuard';

const SRC_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(SRC_ROOT, '..', '..', '..');
const WORKERS_ROOT = path.join(REPO_ROOT, 'services', 'workers', 'sayre_workers');

const SENTINEL_ORG_ID = '00000000-0000-0000-0000-000000000000';
const ANCHOR_MIGRATION_FILES = new Set([
  path.join(REPO_ROOT, 'services', 'workers', 'graph-migrations', '001_init_node_labels.cypher'),
  path.join(REPO_ROOT, 'services', 'workers', 'graph-migrations', '002_init_edge_types.cypher'),
]);

function walkFiles(dir: string, extension: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      if (entry === 'node_modules' || entry === '__pycache__') continue;
      files.push(...walkFiles(fullPath, extension));
    } else if (stats.isFile() && fullPath.endsWith(extension)) {
      files.push(fullPath);
    }
  }
  return files;
}

function isTestFile(filePath: string): boolean {
  return filePath.endsWith('.test.ts') || /(^|[\\/])test_[^\\/]*\.py$/.test(filePath);
}

/** Extracts top-level `(export )?const NAME_CYPHER = \`...\`;` template literals. */
function extractTsCypherConstants(source: string): Array<{ name: string; body: string }> {
  const results: Array<{ name: string; body: string }> = [];
  const re = /(?:export\s+)?const\s+([A-Z][A-Z0-9_]*_CYPHER)\s*=\s*`([\s\S]*?)`/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    results.push({ name: match[1], body: match[2] });
  }
  return results;
}

/**
 * Extracts Python string literals (triple- or single-quoted, optionally
 * f-prefixed) and returns only the INNER body of the ones that look like real
 * Cypher (contain `MATCH (` or `MERGE (`, which every genuine Cypher literal
 * in this codebase does -- distinguishing them from prose mentioning "MERGE"
 * in a docstring or comment, e.g. graph_migrations/runner.py's own
 * docstring).
 *
 * Returns the literal's INNER content only, with Python's own quote
 * delimiters (`"""`/`'''`/`"`/`'`, optional `f` prefix) stripped off --
 * mirroring `extractTsCypherConstants` above, which likewise returns the
 * template literal's body, not the surrounding backticks. This matters as of
 * the Gap 1 fix (`stripCypherStringLiterals` in graphOrgGuard.ts): passing
 * the RAW literal (Python quotes still attached) into the shared
 * `referencesOrgIdPredicate` used to work only because that function never
 * looked for quote characters at all. Now that it strips CYPHER string
 * literals before matching, Python's own outer quoting (especially `"""`,
 * which is three separate `"` characters, not one) would be misread as
 * Cypher string-literal syntax and could wipe out the real predicate inside.
 * Stripping Python's quoting here, before handing the body to
 * `referencesOrgIdPredicate`, keeps that function operating on the same kind
 * of input in all three call sites: pure embedded-Cypher text, never
 * host-language quote noise.
 */
function extractPythonCypherLiterals(source: string): string[] {
  const literalRe =
    /f?"""([\s\S]*?)"""|f?'''([\s\S]*?)'''|f?"([^"\n]*)"|f?'([^'\n]*)'/g;
  const bodies: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = literalRe.exec(source)) !== null) {
    const body = match[1] ?? match[2] ?? match[3] ?? match[4] ?? '';
    if (body.includes('MATCH (') || body.includes('MERGE (')) {
      bodies.push(body);
    }
  }
  return bodies;
}

describe('Cypher org_id static scan (W2-06)', () => {
  it('every *_CYPHER template literal under graph-write/** references $org_id', () => {
    const files = walkFiles(path.join(SRC_ROOT, 'graph-write'), '.ts').filter(
      (file) => !isTestFile(file),
    );
    const offenders: string[] = [];
    let checked = 0;
    for (const file of files) {
      const constants = extractTsCypherConstants(readFileSync(file, 'utf-8'));
      for (const { name, body } of constants) {
        checked += 1;
        if (!referencesOrgIdPredicate(body)) {
          offenders.push(`${path.relative(SRC_ROOT, file)}: ${name} does not reference $org_id as a real filter predicate`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // graph-write/neo4j.ts itself has no *_CYPHER constant (it's the generic
    // executor) -- this scan's real coverage of write-side Cypher is under
    // integrations/**, asserted in the next test. No assertion on `checked`
    // here since 0 is an expected, valid count for this directory today.
    void checked;
  });

  it('every *_CYPHER template literal under integrations/** references $org_id', () => {
    const files = walkFiles(path.join(SRC_ROOT, 'integrations'), '.ts').filter(
      (file) => !isTestFile(file),
    );
    const offenders: string[] = [];
    let checked = 0;
    for (const file of files) {
      const constants = extractTsCypherConstants(readFileSync(file, 'utf-8'));
      for (const { name, body } of constants) {
        checked += 1;
        if (!referencesOrgIdPredicate(body)) {
          offenders.push(`${path.relative(SRC_ROOT, file)}: ${name} does not reference $org_id as a real filter predicate`);
        }
      }
    }
    expect(offenders).toEqual([]);
    expect(checked, 'expected at least one *_CYPHER constant under integrations/** (regression: the scan must not be vacuous)').toBeGreaterThan(0);
  });

  it('every exported *_CYPHER constant from graph-query/index.ts references $org_id (read-side; imported directly, not regex-scanned)', () => {
    const cypherExports = Object.entries(graphQueryModule).filter(
      ([name, value]) => name.endsWith('_CYPHER') && typeof value === 'string',
    ) as Array<[string, string]>;

    expect(
      cypherExports.length,
      'expected at least one *_CYPHER export from graph-query/index.ts -- regression: the scan must not be vacuous',
    ).toBeGreaterThanOrEqual(3);

    const offenders = cypherExports
      .filter(([, body]) => !referencesOrgIdPredicate(body))
      .map(([name]) => name);
    expect(offenders).toEqual([]);

    // Sanity: the three constants named in spec.md are present (a rename would
    // still be caught by the generic *_CYPHER enumeration above, but this also
    // documents the currently-known set for a human reader of test output).
    const names = cypherExports.map(([name]) => name);
    expect(names).toEqual(
      expect.arrayContaining([
        'GET_NODES_IN_VIEWPORT_CYPHER',
        'GET_STRUCTURAL_EDGES_CYPHER',
        'GET_AFFECTED_NODES_CYPHER',
      ]),
    );
  });

  it('every Cypher-shaped literal under services/workers/sayre_workers/** references $org_id', () => {
    const files = walkFiles(WORKERS_ROOT, '.py').filter((file) => !isTestFile(file));
    const offenders: string[] = [];
    let checked = 0;
    for (const file of files) {
      const literals = extractPythonCypherLiterals(readFileSync(file, 'utf-8'));
      for (const literal of literals) {
        checked += 1;
        if (!referencesOrgIdPredicate(literal)) {
          offenders.push(`${path.relative(WORKERS_ROOT, file)}: literal does not reference $org_id as a real filter predicate: ${literal.slice(0, 80)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    expect(
      checked,
      'expected at least one Cypher-shaped literal under sayre_workers/** (regression: the scan must not be vacuous)',
    ).toBeGreaterThan(0);
  });

  it('the schema-anchor sentinel org appears only in the two anchor migration files, never in a runtime query', () => {
    const graphMigrationsDir = path.join(REPO_ROOT, 'services', 'workers', 'graph-migrations');
    const candidateFiles = [
      ...walkFiles(SRC_ROOT, '.ts').filter((file) => !isTestFile(file)),
      ...walkFiles(WORKERS_ROOT, '.py').filter((file) => !isTestFile(file)),
      // Every OTHER migration file (003, 004, ...) besides the two anchors --
      // the sentinel must not have leaked into any non-anchor migration either.
      ...walkFiles(graphMigrationsDir, '.cypher').filter((file) => !ANCHOR_MIGRATION_FILES.has(file)),
    ];
    const offenders = candidateFiles.filter((file) =>
      readFileSync(file, 'utf-8').includes(SENTINEL_ORG_ID),
    );
    expect(
      offenders,
      `the schema-anchor sentinel org must never appear outside the two anchor migration files: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('the schema-anchor sentinel org DOES appear in exactly the two allowlisted anchor migration files (sanity: not vacuous)', () => {
    for (const file of ANCHOR_MIGRATION_FILES) {
      const content = readFileSync(file, 'utf-8');
      expect(content.includes(SENTINEL_ORG_ID), `${file} was expected to contain the schema-anchor sentinel org`).toBe(
        true,
      );
    }
  });

  // --- Regression tests for FND-5da52fce61f4 (2026-07-23 adversarial audit) ---
  // The scan's underlying check (`referencesOrgIdPredicate`, shared with the
  // runtime guard in graphOrgGuard.ts) previously would have been a raw
  // `.includes('$org_id')` substring test. These prove the scan itself would
  // now catch the same class of bypass that fooled the old runtime guard, if
  // it were ever introduced as a *_CYPHER constant or Python literal.
  describe('scan-level regression: comment-only / non-predicate $org_id references are flagged, not silently accepted', () => {
    it('a *_CYPHER-shaped body with $org_id only in a // comment does NOT satisfy the scan check', () => {
      const body = `
        // TODO: this should filter by $org_id but the WHERE clause was never added
        MATCH (n:File)
        RETURN n
      `;
      expect(referencesOrgIdPredicate(body)).toBe(false);
    });

    it('a *_CYPHER-shaped body with $org_id only in a /* */ block comment does NOT satisfy the scan check', () => {
      const body = '/* filter by $org_id here eventually */\nMATCH (n:File)\nRETURN n';
      expect(referencesOrgIdPredicate(body)).toBe(false);
    });

    it('a Python-literal-shaped Cypher string with $org_id only in a non-predicate position (RETURN projection) does NOT satisfy the scan check', () => {
      const literal = 'MATCH (n:File {uid: $uid}) RETURN n, $org_id AS debugOrgId';
      expect(referencesOrgIdPredicate(literal)).toBe(false);
    });

    it('all currently-scanned real *_CYPHER exports still satisfy the scan check after the fix (regression: not over-strict)', () => {
      const cypherExports = Object.entries(graphQueryModule).filter(
        ([name, value]) => name.endsWith('_CYPHER') && typeof value === 'string',
      ) as Array<[string, string]>;
      expect(cypherExports.length).toBeGreaterThanOrEqual(3);
      for (const [name, body] of cypherExports) {
        expect(referencesOrgIdPredicate(body), `${name} unexpectedly failed the hardened check`).toBe(true);
      }
    });
  });

  // --- Regression test for Gap 1 (tester-found residual, escalated blocking
  // by review, remediation-verification pass #2, 2026-07-23) ---
  // Proves the string-literal-stripping fix to `referencesOrgIdPredicate`
  // (graphOrgGuard.ts) propagates to THIS static scan too, rather than
  // relying implicitly on "both consume the same shared function" -- per
  // review's explicit suggestion, prove it with a test. A *_CYPHER-shaped
  // body containing the org_id/$org_id text only inside a decoy string
  // literal (no real property-match/filter predicate) must be flagged by the
  // scan check, exactly as it now is by the runtime guard.
  describe('scan-level regression: Gap 1 (decoy string-literal $org_id mention) is flagged, not silently accepted', () => {
    it('a *_CYPHER-shaped body with "org_id: $org_id" only inside a decoy double-quoted string literal does NOT satisfy the scan check', () => {
      const body = 'MATCH (n:File) SET n.debugNote = "org_id: $org_id" RETURN n';
      expect(referencesOrgIdPredicate(body)).toBe(false);
    });

    it('a *_CYPHER-shaped body with "org_id = $org_id" only inside a decoy single-quoted string literal does NOT satisfy the scan check', () => {
      const body = "MATCH (n:File) SET n.debugNote = 'the org_id = $org_id filter was removed' RETURN n";
      expect(referencesOrgIdPredicate(body)).toBe(false);
    });

    it('a *_CYPHER-shaped body with a REAL predicate plus an unrelated string literal containing a colon/equals sign still satisfies the scan check (not over-strict)', () => {
      const body = `
        MATCH (n:File {org_id: $org_id, uid: $uid})
        SET n.debugNote = "unrelated note: status = pending"
        RETURN n
      `;
      expect(referencesOrgIdPredicate(body)).toBe(true);
    });
  });

  // --- Regression test for Gap 3 (third remediation round, 2026-07-23) ---
  // Proves the structural rewrite of the shared stripper (`stripCypherNoise`
  // in graphOrgGuard.ts, replacing the desync-prone two-independent-regex-
  // pass `stripCypherStringLiterals`) propagates to THIS static scan too,
  // exactly as Gap 1's propagation was proven with a dedicated test rather
  // than relying implicitly on "both consume the same shared function."
  describe('scan-level regression: Gap 3 (cross-quote-type string desync) is closed, not silently accepted', () => {
    it('a *_CYPHER-shaped body where a single-quoted literal with an embedded unescaped double-quote precedes a double-quoted decoy does NOT satisfy the scan check', () => {
      const body = `SET n.a = 'y"z' SET n.debug = "org_id: $org_id" RETURN n`;
      expect(referencesOrgIdPredicate(body)).toBe(false);
    });

    it('a *_CYPHER-shaped body with the same cross-quote-type string but a REAL predicate afterward still satisfies the scan check (not over-strict)', () => {
      const body = `SET n.a = 'y"z' MATCH (n:File {org_id: $org_id, uid: $uid}) RETURN n`;
      expect(referencesOrgIdPredicate(body)).toBe(true);
    });
  });

  // --- Regression test for Gap 7 (found during the THIRD remediation-
  // verification pass, 2026-07-23, NOT fixed) ---
  // Proves the RETURN/WITH/UNWIND decoy-map-literal gap (see graphOrgGuard.
  // test.ts's `[TESTER-FOUND, Gap 7, NOT fixed, round 3]` block for the full
  // writeup) propagates to THIS static scan too -- a `*_CYPHER`-shaped body
  // whose only `org_id: $org_id` occurrence sits inside a RETURN/WITH/UNWIND
  // projection, never inside a MATCH/MERGE node pattern or a WHERE/SET
  // clause, is NOT flagged by the scan, exactly as it is NOT rejected by the
  // runtime guard. Documented here (not fixed) for the same reason: closing
  // this requires actual Cypher clause-structure parsing, not a lexical scan.
  describe('scan-level regression: Gap 7 (decoy map literal in a RETURN/WITH/UNWIND projection) is NOT flagged (documents the gap, NOT fixed)', () => {
    it('a *_CYPHER-shaped body whose only org_id:$org_id occurrence is a decoy RETURN-projection map literal is NOT flagged by the scan check', () => {
      const body = 'MATCH (n:File {uid: $uid}) RETURN n, {org_id: $org_id} AS debugMap';
      expect(
        referencesOrgIdPredicate(body),
        'expected the current scan check to be satisfied by the decoy map literal (documenting the gap, NOT fixed)',
      ).toBe(true);
    });
  });
});
