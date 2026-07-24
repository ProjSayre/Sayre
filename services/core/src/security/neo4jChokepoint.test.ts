// Architecture-fitness test (Resolved decision Q3, option 1 --
// docs/tenant-isolation.md "Neo4j has no engine backstop"). Neo4j Community
// has no engine-level RLS; the strongest structurally-achievable mitigation
// is to confine the raw driver and session to the two guarded executors, so a
// third module that talks to Neo4j directly (skipping assertOrgScopedCypher)
// is a failing build, not a silent leak.
//
// Source-text (grep-style) scan, not AST -- deliberately, per spec.md
// "Interfaces / signatures -> Neo4j driver/session chokepoint fitness test".
// These three markers are highly distinctive call sites (a real driver
// construction is `neo4j.driver(` / `neo4j.auth.basic(`, a live session open
// is `driver.session(` / `.session(`), so substring scanning is sufficiently
// robust and mirrors cypherOrgIdScan.test.ts's style.
//
// Test files are excluded from the forbidden-marker scan because unit/
// penetration tests reach Neo4j exclusively through the injected
// `Neo4jDriverFactory` seam (fake drivers, never a real `neo4j.driver(` call;
// the executor -- not the test -- is what calls `.session(`). To keep that
// exclusion from becoming a hole, this file ALSO positively asserts that both
// executor modules export `Neo4jDriverFactory` and that the guard/penetration
// test suite actually drives them via that factory (imports it), so "tests
// can use a fake" cannot silently become "tests can open a real session".
//
// Post-security-audit hardening (FND-8f00211cd735, 2026-07-23): the original
// (and sole) mechanism was the call-site substring scan below
// (`FORBIDDEN_MARKERS`). An adversarial audit proved ordinary (non-obfuscated)
// import-aliasing defeats it with zero markers found:
//   - `import n4j from 'neo4j-driver'` + `n4j['driver'](...)` + bracket-
//     notation `.session(` via a computed key.
//   - `import { driver as buildDriver, auth as authFactory } from
//     'neo4j-driver'` + computed session-property key.
// The PRIMARY gating mechanism is now an import-based check
// (`importsNeo4jDriverPackage`): it flags any non-allowlisted file that
// imports/requires the `neo4j-driver` package AT ALL -- default import,
// named import under any local alias, namespace import, dynamic `import()`,
// or `require()` -- regardless of the local binding name used to call it
// afterward. This closes the aliasing bypass because it doesn't care how the
// call site is spelled, only whether the module was ever pulled in. The old
// substring scan is retained below as a secondary/defense-in-depth signal
// (it still catches, e.g., a `.session(` call reached via some other import
// path this file doesn't anticipate), but it no longer alone gates the build.
//
// Second-round hardening (Gap 2a, remediation-verification pass #2,
// 2026-07-23): `importsNeo4jDriverPackage` requires a LITERAL quoted
// 'neo4j-driver' string directly inside the import()/require() call. Tester
// found -- and review escalated blocking, confirming it live today with NO
// precondition -- that a specifier computed into a variable first
// (`const modName = 'neo4j' + '-driver'; import(modName)`) is not a literal
// match and defeats BOTH the PRIMARY import check and the SECONDARY marker
// scan (the resulting driver/auth/session calls go through a property
// computed from the imported namespace object, not literal dotted-member
// text). A static text scanner cannot prove what a computed specifier
// resolves to at build time, so this fails closed: `hasNonLiteralDynamicImport`
// below flags ANY dynamic `import(...)` call in a non-allowlisted file whose
// argument is not a single, unconcatenated string literal -- regardless of
// whether the specifier text mentions "neo4j" at all, since "cannot prove
// it's safe" is the same fail-closed posture the rest of this ticket uses.
// Grepped `services/core/src/**` (non-test files) before adding this check:
// zero existing dynamic `import()` calls with a non-literal argument exist
// outside test files today, so this introduces no false positive against
// current code -- proven by the `[PRIMARY, Gap 2a]` test itself (it scans
// every real file and asserts zero offenders) rather than merely asserted in
// this comment.
//
// Gap 2b (re-export-of-driver + computed-property shape) is a SEPARATE,
// precondition-dependent finding tester also found: it is NOT fixed by this
// change and remains an accepted, documented residual -- see the
// `describe('tester-found residual gaps...')` block below and
// `docs/tenant-isolation.md`'s "Neo4j has no engine backstop" section. It is
// confirmed inert today (neither allowlisted file re-exports the raw
// driver), so, per review's explicit instruction, it is documented rather
// than fixed -- fixing a precondition that does not exist in the codebase
// would be over-engineering.
//
// Third-round hardening -- STRUCTURAL rewrite, not another regex
// (2026-07-23, review.md's explicit class-level recommendation): Gap 4a/4b/4c
// proved the PRIMARY import-based regex (`NEO4J_DRIVER_IMPORT_RE`) and the
// Gap 2a fail-closed dynamic-import regexes (`STATIC_LITERAL_DYNAMIC_IMPORT_RE`
// / `ANY_DYNAMIC_IMPORT_RE`) all shared one root cause: they only tolerated
// `\s*` (or, in the dynamic-import/require branches, literally NO whitespace
// at all) between the `import`/`require` keyword and its `(` -- but real
// JS/TS syntax also permits an arbitrary `/* ... */` comment in that
// position, and a single space was enough to defeat the branches that used a
// bare `\(`. Review's diagnosis after three consecutive rounds of "fix one
// textual shape, the next pass finds a neighboring one" in this exact file:
// composing regexes over source text is fundamentally the wrong tool for a
// question that is actually about TOKEN STRUCTURE ("is this an import/
// require call, and what is its argument"), because whitespace and comments
// between tokens are trivia to a real parser but meaningful gaps to a text
// pattern. The fix replaces `NEO4J_DRIVER_IMPORT_RE` / the Gap 2a regex pair
// with an AST walk using the TypeScript compiler's own parser (the
// `typescript` package -- already a `services/core` devDependency, see
// `package.json`; no new dependency added). `ts.createSourceFile` tokenizes
// exactly like the real TypeScript compiler does: whitespace and comments
// are trivia attached to tokens, never part of the token stream itself, so
// `import ('neo4j-driver')` (Gap 4a), `require ('neo4j-driver')` (Gap 4b),
// and `import/* webpackIgnore: true */(modName)` (Gap 4c) all parse to
// EXACTLY the same AST node shapes as their unspaced/uncommented
// equivalents. This closes the bug *class* (whitespace/comment placement as
// a viable escape dimension), not just the three reported instances --
// there is no fourth regex to write, because the underlying question is now
// answered structurally.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

const SRC_ROOT = path.resolve(__dirname, '..');

const ALLOWLISTED_FILES = new Set([
  path.join(SRC_ROOT, 'graph-write', 'neo4j.ts'),
  path.join(SRC_ROOT, 'graph-query', 'neo4j.ts'),
]);

const FORBIDDEN_MARKERS = ['neo4j.driver(', 'neo4j.auth', '.session('] as const;

const NEO4J_DRIVER_SPECIFIER = 'neo4j-driver';

function parseSource(source: string, fileName = 'source.ts'): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, /* setParentNodes */ false, ts.ScriptKind.TS);
}

/** True if `node` is a string literal (or no-substitution template) whose text equals the `neo4j-driver` specifier. */
function isNeo4jDriverStringLiteral(node: ts.Node | undefined): node is ts.StringLiteralLike {
  return !!node && ts.isStringLiteralLike(node) && node.text === NEO4J_DRIVER_SPECIFIER;
}

/**
 * Primary mechanism (structural rewrite of FND-8f00211cd735's fix; closes
 * Gap 4a/4b/4c). Walks the real TypeScript AST and returns true if `source`
 * contains ANY of the following forms of importing/requiring the
 * `neo4j-driver` package, under any local binding name and regardless of
 * whitespace/comment placement between tokens:
 *   - `import neo4j from 'neo4j-driver'`                    (default)
 *   - `import neo4j, { type Driver } from 'neo4j-driver'`   (default + named)
 *   - `import * as n4j from 'neo4j-driver'`                 (namespace)
 *   - `import { driver as buildDriver } from 'neo4j-driver'` (named, aliased)
 *   - `import type { Driver } from 'neo4j-driver'`          (type-only)
 *   - `import('neo4j-driver')` / `import ('neo4j-driver')` / `import/* c *\/('neo4j-driver')` (dynamic import, any spacing/comment)
 *   - `require('neo4j-driver')` / `require ('neo4j-driver')` / `require/* c *\/('neo4j-driver')` (CJS require, any spacing/comment)
 *   - `import('neo4j-driver').Driver` (inline import-type reference)
 * Deliberately indifferent to local binding names AND to whitespace/comment
 * placement -- an AST node either has a `neo4j-driver` string-literal module
 * specifier or it doesn't; there is no textual pattern to dodge.
 */
function importsNeo4jDriverPackage(source: string, fileName = 'source.ts'): boolean {
  const sourceFile = parseSource(source, fileName);
  let found = false;

  const visit = (node: ts.Node): void => {
    if (found) return;

    if (ts.isImportDeclaration(node)) {
      if (isNeo4jDriverStringLiteral(node.moduleSpecifier)) {
        found = true;
        return;
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      const ref = node.moduleReference;
      if (ts.isExternalModuleReference(ref) && isNeo4jDriverStringLiteral(ref.expression)) {
        found = true;
        return;
      }
    } else if (ts.isImportTypeNode(node)) {
      // `import('neo4j-driver').Driver` used as a type reference.
      const arg = node.argument;
      if (ts.isLiteralTypeNode(arg) && isNeo4jDriverStringLiteral(arg.literal)) {
        found = true;
        return;
      }
    } else if (ts.isCallExpression(node)) {
      const isDynamicImportCall = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequireCall = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if ((isDynamicImportCall || isRequireCall) && isNeo4jDriverStringLiteral(node.arguments[0])) {
        found = true;
        return;
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

/**
 * Gap 2a fail-closed check, structurally rewritten (closes Gap 4c, the
 * comment-between-`import`-and-`(` variant): walks the AST for a dynamic
 * `import(...)` call -- `ts.isCallExpression(node) && node.expression.kind
 * === ts.SyntaxKind.ImportKeyword`, a real parser construct that exists
 * regardless of whitespace/comment trivia between the `import` keyword and
 * its `(` -- whose argument is NOT a single string-literal-like node (i.e. a
 * computed, concatenated, or variable specifier that a static scan cannot
 * prove is safe). Fails closed: "cannot prove it's safe" is treated as
 * suspicious, regardless of whether the specifier text happens to mention
 * "neo4j" anywhere (Gap 2a, remediation-verification pass #2), and now
 * regardless of how the `import(...)` call is spaced/commented (Gap 4c,
 * third remediation round).
 */
function hasNonLiteralDynamicImport(source: string, fileName = 'source.ts'): boolean {
  const sourceFile = parseSource(source, fileName);
  let found = false;

  const visit = (node: ts.Node): void => {
    if (found) return;

    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (!arg || !ts.isStringLiteralLike(arg)) {
        found = true;
        return;
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

function walkTsFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      if (entry === 'node_modules') continue;
      files.push(...walkTsFiles(fullPath));
    } else if (stats.isFile() && fullPath.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function isTestFile(filePath: string): boolean {
  // Covers both **/*.test.ts and **/*.tester.test.ts (the latter is a suffix
  // match of the former).
  return filePath.endsWith('.test.ts');
}

describe('Neo4j driver/session chokepoint (Resolved decision Q3, option 1)', () => {
  it('[PRIMARY, FND-8f00211cd735] confines `neo4j-driver` package imports to exactly the two guarded executors', () => {
    const allTsFiles = walkTsFiles(SRC_ROOT);
    const nonTestFiles = allTsFiles.filter((file) => !isTestFile(file));
    const offenders: string[] = [];

    for (const file of nonTestFiles) {
      if (ALLOWLISTED_FILES.has(file)) continue;
      const content = readFileSync(file, 'utf-8');
      if (importsNeo4jDriverPackage(content, file)) {
        offenders.push(`${path.relative(SRC_ROOT, file)}: imports the 'neo4j-driver' package`);
      }
    }

    expect(
      offenders,
      offenders.length > 0
        ? `Found ${offenders.length} chokepoint violation(s) (import-based check) -- a new Neo4j ` +
          `bypass path was introduced outside graph-write/neo4j.ts and graph-query/neo4j.ts:\n${offenders.join('\n')}`
        : undefined,
    ).toEqual([]);
  });

  it('[PRIMARY, sanity] confirms the two allowlisted executor files really do import neo4j-driver (the import-based scan is not vacuously passing)', () => {
    for (const file of ALLOWLISTED_FILES) {
      const content = readFileSync(file, 'utf-8');
      expect(
        importsNeo4jDriverPackage(content),
        `${file} was expected to import the 'neo4j-driver' package`,
      ).toBe(true);
    }
  });

  it('[PRIMARY, Gap 2a] flags any non-literal (computed/dynamic) import() specifier in a non-allowlisted file -- fails closed since a static scan cannot prove what it resolves to', () => {
    const allTsFiles = walkTsFiles(SRC_ROOT);
    const nonTestFiles = allTsFiles.filter((file) => !isTestFile(file));
    const offenders: string[] = [];

    for (const file of nonTestFiles) {
      if (ALLOWLISTED_FILES.has(file)) continue;
      const content = readFileSync(file, 'utf-8');
      if (hasNonLiteralDynamicImport(content, file)) {
        offenders.push(`${path.relative(SRC_ROOT, file)}: contains a non-literal/computed dynamic import() specifier`);
      }
    }

    expect(
      offenders,
      offenders.length > 0
        ? `Found ${offenders.length} chokepoint violation(s) (non-literal dynamic import specifier) -- a ` +
          `static scan cannot prove these do not resolve to 'neo4j-driver' (or any other bypass) at ` +
          `runtime:\n${offenders.join('\n')}`
        : undefined,
    ).toEqual([]);
  });

  it('[PRIMARY, Gap 2a companion] a legitimate literal `import(\'neo4j-driver\')` dynamic import is NOT flagged by the non-literal-dynamic-import check (no false positive on the safe form)', () => {
    expect(hasNonLiteralDynamicImport("const n4j = await import('neo4j-driver');")).toBe(false);
    expect(hasNonLiteralDynamicImport('const n4j = await import("neo4j-driver");')).toBe(false);
  });

  it('[SECONDARY, defense-in-depth] confines neo4j.driver(/neo4j.auth/.session( call-site markers to exactly the two guarded executors', () => {
    const allTsFiles = walkTsFiles(SRC_ROOT);
    const nonTestFiles = allTsFiles.filter((file) => !isTestFile(file));
    const offenders: string[] = [];

    for (const file of nonTestFiles) {
      if (ALLOWLISTED_FILES.has(file)) continue;
      const content = readFileSync(file, 'utf-8');
      for (const marker of FORBIDDEN_MARKERS) {
        if (content.includes(marker)) {
          offenders.push(`${path.relative(SRC_ROOT, file)}: found forbidden marker '${marker}'`);
        }
      }
    }

    expect(
      offenders,
      offenders.length > 0
        ? `Found ${offenders.length} chokepoint violation(s) -- a new Neo4j bypass path was ` +
          `introduced outside graph-write/neo4j.ts and graph-query/neo4j.ts:\n${offenders.join('\n')}`
        : undefined,
    ).toEqual([]);
  });

  it('[SECONDARY, sanity] confirms the two allowlisted executor files really do contain the markers (scan is not vacuously passing)', () => {
    for (const file of ALLOWLISTED_FILES) {
      const content = readFileSync(file, 'utf-8');
      const hasAnyMarker = FORBIDDEN_MARKERS.some((marker) => content.includes(marker));
      expect(hasAnyMarker, `${file} was expected to contain at least one Neo4j driver/session marker`).toBe(
        true,
      );
    }
  });

  it('every non-test .ts file under services/core/src is covered by the scan or the allowlist (no directory is silently skipped)', () => {
    const allTsFiles = walkTsFiles(SRC_ROOT);
    expect(allTsFiles.length).toBeGreaterThan(0);
    // The two allowlisted files must actually exist on disk under SRC_ROOT --
    // otherwise the allowlist would be vacuous.
    for (const allowlisted of ALLOWLISTED_FILES) {
      expect(allTsFiles).toContain(allowlisted);
    }
  });

  it('positively asserts both guarded executors export Neo4jDriverFactory (the fake-driver injection seam)', () => {
    for (const file of ALLOWLISTED_FILES) {
      const content = readFileSync(file, 'utf-8');
      expect(
        content,
        `${file} must export Neo4jDriverFactory so tests can inject a fake driver instead of a real one`,
      ).toMatch(/export type Neo4jDriverFactory/);
    }
  });

  it('positively asserts the test suite actually drives the executors via the injected Neo4jDriverFactory seam, not a real driver', () => {
    const allTsFiles = walkTsFiles(SRC_ROOT);
    // Excludes this file itself: it necessarily mentions the marker strings
    // ('neo4j.driver(', 'Neo4jDriverFactory') as DATA (the things it searches
    // for), not as an actual driver construction -- a self-referential false
    // positive, not a real bypass.
    const testFiles = allTsFiles.filter((file) => isTestFile(file) && file !== __filename);
    const referencingFiles = testFiles.filter((file) =>
      readFileSync(file, 'utf-8').includes('Neo4jDriverFactory'),
    );
    expect(
      referencingFiles.length,
      'expected at least one test file to import/reference Neo4jDriverFactory to inject a fake driver ' +
        '(e.g. tenantIsolation.penetration.test.ts) -- proves "tests can use a fake" has not silently ' +
        'become "tests open a real, un-guarded session"',
    ).toBeGreaterThan(0);

    // None of those referencing test files may ALSO call the real driver
    // constructor directly -- injecting the factory type is not enough if the
    // test then ignores it and calls neo4j.driver(/neo4j.auth itself.
    for (const file of referencingFiles) {
      const content = readFileSync(file, 'utf-8');
      expect(
        content.includes('neo4j.driver(') || content.includes('neo4j.auth'),
        `${file} references Neo4jDriverFactory but also calls the real driver constructor directly -- ` +
          'it must only ever construct a FAKE driver behind the factory seam',
      ).toBe(false);
    }
  });
});

// --- Regression fixtures for FND-8f00211cd735 (2026-07-23 adversarial audit) ---
// Proves the import-based check catches ordinary (non-obfuscated) import-
// aliasing / bracket-notation bypasses that the old substring-only marker
// scan (FORBIDDEN_MARKERS) found zero matches for. All fixtures are in-memory
// strings only -- never written to disk / never a real bypass in the repo.
describe('import-based detection catches ordinary import-aliasing bypasses (regression for FND-8f00211cd735)', () => {
  const aliasedDefaultImportFixture = `
    import n4j from 'neo4j-driver';
    const driver = n4j['driver']('bolt://localhost:7687', n4j.auth.basic('u', 'p'));
    const sess = driver[('sess' + 'ion')]();
  `;

  const aliasedNamedImportFixture = `
    import { driver as buildDriver, auth as authFactory } from 'neo4j-driver';
    const sessionKey = 'sess' + 'ion';
    const driver = buildDriver('bolt://localhost:7687', authFactory.basic('u', 'p'));
    const sess = driver[sessionKey]();
  `;

  it('catches an aliased default import combined with bracket-notation member access (`n4j[\'driver\'](...)`)', () => {
    expect(importsNeo4jDriverPackage(aliasedDefaultImportFixture)).toBe(true);
  });

  it('catches aliased named imports (`driver as buildDriver, auth as authFactory`) combined with a computed session-property key', () => {
    expect(importsNeo4jDriverPackage(aliasedNamedImportFixture)).toBe(true);
  });

  it('catches a namespace import (`import * as n4j from \'neo4j-driver\'`)', () => {
    expect(importsNeo4jDriverPackage("import * as n4j from 'neo4j-driver';")).toBe(true);
  });

  it('catches a type-only import (`import type { Driver } from \'neo4j-driver\'`)', () => {
    expect(importsNeo4jDriverPackage("import type { Driver } from 'neo4j-driver';")).toBe(true);
  });

  it('catches a CommonJS require()', () => {
    expect(importsNeo4jDriverPackage("const n4j = require('neo4j-driver');")).toBe(true);
  });

  it('catches a dynamic import()', () => {
    expect(importsNeo4jDriverPackage("const n4j = await import('neo4j-driver');")).toBe(true);
  });

  it('[proof this was a real gap] the OLD substring-only markers find ZERO forbidden markers in either bypass fixture', () => {
    for (const fixture of [aliasedDefaultImportFixture, aliasedNamedImportFixture]) {
      const foundMarkers = FORBIDDEN_MARKERS.filter((marker) => fixture.includes(marker));
      expect(
        foundMarkers,
        `expected the OLD substring scan to find zero markers in this fixture (proving the ` +
          `old mechanism alone would have missed it) but found: ${foundMarkers.join(', ')}`,
      ).toEqual([]);
    }
  });

  it('does not false-positive on source text that merely mentions the string "neo4j-driver" outside an import/require context', () => {
    const source = [
      '// see the neo4j-driver package docs for details',
      "export const NOTE = 'we do not use neo4j-driver here';",
    ].join('\n');
    expect(importsNeo4jDriverPackage(source)).toBe(false);
  });

  it('does not false-positive on an unrelated import statement', () => {
    expect(importsNeo4jDriverPackage("import { z } from 'zod';")).toBe(false);
  });
});

// --- Tester-found gaps (remediation-verification pass, 2026-07-23) ---
// NOT proven against a real running Neo4j. Documented here, per the
// remediation-verification instructions, so these are visible to
// review/security-checker rather than silently dropped. Both fixtures are
// in-memory strings only.
describe('tester-found gaps: Gap 2a (fixed, this pass) and Gap 2b (documented residual, precondition-dependent)', () => {
  // Gap 2a -- FIXED this pass. The import-based regex requires a LITERAL
  // quoted 'neo4j-driver' string directly inside the import()/require()
  // call. A specifier computed into a variable first (a legal, if slightly
  // unusual, dynamic-import idiom) is not a literal match, and the resulting
  // driver/auth/session calls go through a property computed from the
  // imported namespace object rather than the literal dotted-member text the
  // SECONDARY scan looks for -- so neither the PRIMARY import-regex nor the
  // SECONDARY marker scan fires on their own. Live today, no precondition
  // needed -- review escalated this blocking. Fixed by
  // `hasNonLiteralDynamicImport` (see `[PRIMARY, Gap 2a]` above), which fails
  // closed on any non-literal dynamic import specifier in a non-allowlisted
  // file.
  it('[Gap 2a, was TESTER-FOUND residual] a require()/import() call whose specifier is a variable (not a literal string) is NOT caught by importsNeo4jDriverPackage or the marker scan on their own, but IS caught by the new fail-closed non-literal-dynamic-import check', () => {
    const dynamicSpecifierFixture = `
      const modName = 'neo4j' + '-driver';
      const n4j = await import(modName);
      const driver = n4j.default.driver('bolt://localhost:7687', n4j.default.auth.basic('u', 'p'));
    `;
    expect(importsNeo4jDriverPackage(dynamicSpecifierFixture)).toBe(false);
    const foundMarkers = FORBIDDEN_MARKERS.filter((marker) => dynamicSpecifierFixture.includes(marker));
    expect(
      foundMarkers,
      'the PRIMARY literal-import check and SECONDARY marker scan still miss this shape on their own',
    ).toEqual([]);
    expect(
      hasNonLiteralDynamicImport(dynamicSpecifierFixture),
      'expected the new [PRIMARY, Gap 2a] fail-closed non-literal-dynamic-import check to catch this shape',
    ).toBe(true);
  });

  // Gap 2b (compounded, precondition-dependent -- NOT exploitable against the
  // current codebase, see the sanity check below): if an allowlisted executor
  // file were ever changed to re-export a raw driver/session capability
  // (neither currently does -- both only export types, interfaces, and
  // guarded executor factories/classes), a third file could import that
  // re-export instead of 'neo4j-driver' directly (defeats the PRIMARY
  // import-based check, which only looks for a direct 'neo4j-driver'
  // specifier) and reach the session via a computed/bracket property key
  // instead of the literal `.session(` text (defeats the SECONDARY marker
  // scan too). Also defeats the new Gap 2a fail-closed check, since the
  // import specifier in this fixture (`'../graph-write/neo4j'`) is itself a
  // static, non-dynamic ES import, not a dynamic `import()` call. Recorded as
  // an ACCEPTED, DOCUMENTED residual per review's explicit instruction (not
  // fixed this pass -- the precondition it depends on does not currently
  // exist in the codebase, and fixing a nonexistent precondition would be
  // over-engineering): the chokepoint's guarantee currently rests partly on
  // an unenforced convention (the two allowlisted files never re-exporting
  // raw driver/session capability), tracked in
  // `docs/tenant-isolation.md`'s "Neo4j has no engine backstop" section, with
  // the sanity test below as the tripwire.
  it('[Gap 2b, TESTER-FOUND, residual, precondition-dependent, accepted -- not fixed this pass] a re-export-of-the-driver + computed session-property shape is NOT caught by any of the three checks', () => {
    const reExportPlusComputedPropertyFixture = `
      import { rawDriver } from '../graph-write/neo4j';
      const sessKey = 'sess' + 'ion';
      const sess = rawDriver[sessKey]();
    `;
    expect(importsNeo4jDriverPackage(reExportPlusComputedPropertyFixture)).toBe(false);
    const foundMarkers = FORBIDDEN_MARKERS.filter((marker) =>
      reExportPlusComputedPropertyFixture.includes(marker),
    );
    expect(foundMarkers).toEqual([]);
    expect(
      hasNonLiteralDynamicImport(reExportPlusComputedPropertyFixture),
      'the Gap 2a fail-closed check only looks at dynamic import() calls -- this fixture uses a static ES import, so it does not fire here either (confirms Gap 2b is a genuinely separate, unfixed residual)',
    ).toBe(false);
  });

  // --- Gap 4a/4b/4c (found during the second remediation-verification pass,
  // FIXED this pass via the structural AST rewrite -- 2026-07-23) ---
  //
  // All three shared one root cause: the old `NEO4J_DRIVER_IMPORT_RE`'s
  // dynamic-`import()`/`require()` branches and the old
  // `ANY_DYNAMIC_IMPORT_RE`/`STATIC_LITERAL_DYNAMIC_IMPORT_RE` regex pair
  // only tolerated `\s*` (or, in the dynamic-import/require branches,
  // literally NO whitespace at all) between the `import`/`require` keyword
  // and its `(` -- but real JS/TS syntax also allows an arbitrary `/* ... */`
  // comment in that position, and a single space was enough to defeat the
  // branches that used a bare `\(`. Fixed by replacing all of that with an
  // AST walk (`importsNeo4jDriverPackage`/`hasNonLiteralDynamicImport` above,
  // using the `typescript` package's own parser): whitespace and comments
  // are trivia to a real parser, never part of the token stream, so none of
  // these three shapes have anywhere left to hide.
  it('[Gap 4a, FIXED] a literal `import (\'neo4j-driver\')` with a SPACE between `import` and `(` is now caught by the AST-based PRIMARY import check (a real parser does not care about whitespace between tokens)', () => {
    const spacedLiteralImport = `
      const n4j = await import ('neo4j-driver');
      const driver = n4j.default.driver('bolt://localhost:7687', n4j.default.auth.basic('u', 'p'));
    `;
    expect(importsNeo4jDriverPackage(spacedLiteralImport)).toBe(true);
    // It's a genuine, literal, human-auditable specifier -- correctly NOT
    // flagged as a "non-literal/computed" import by the separate Gap 2a
    // check (that check exists for a DIFFERENT problem: an argument that
    // ISN'T a literal at all).
    expect(hasNonLiteralDynamicImport(spacedLiteralImport)).toBe(false);
  });

  it('[Gap 4b, FIXED] a literal `require (\'neo4j-driver\')` with a SPACE between `require` and `(` is now caught by the AST-based PRIMARY import check', () => {
    const spacedRequire = `const n4j = require ('neo4j-driver');`;
    expect(importsNeo4jDriverPackage(spacedRequire)).toBe(true);
  });

  it('[Gap 4c, FIXED] a `/* ... */` comment between `import` and `(` (legal JS/TS syntax, e.g. a webpack magic-comment idiom) no longer defeats the Gap 2a fail-closed non-literal-dynamic-import check -- the AST still sees a dynamic import() call with a computed (non-literal) argument regardless of the comment between the keyword and the paren', () => {
    const commentBetweenImportAndParen = `
      const modName = 'neo4j' + '-driver';
      const n4j = await import/* webpackIgnore: true */(modName);
      const driver = n4j.default.driver('bolt://localhost:7687', n4j.default.auth.basic('u', 'p'));
    `;
    // Not a literal 'neo4j-driver' specifier (it's the identifier `modName`),
    // so PRIMARY correctly does not claim to recognize it by name -- but the
    // Gap 2a fail-closed check must now catch it as an unproven computed
    // dynamic-import specifier, comment or no comment.
    expect(importsNeo4jDriverPackage(commentBetweenImportAndParen)).toBe(false);
    expect(hasNonLiteralDynamicImport(commentBetweenImportAndParen)).toBe(true);
  });

  // --- Additional adversarial whitespace/comment fixtures (dev-authored,
  // this pass) closing out combinations not already exercised by Gap
  // 4a/4b/4c above, per review's request to build confidence the CLASS is
  // closed, not just the three reported instances. ---

  it('[Gap 4, adversarial] a require() call with a comment (not just a space) between the keyword and the paren is caught', () => {
    const commentedRequire = `const n4j = require/* eslint-disable */('neo4j-driver');`;
    expect(importsNeo4jDriverPackage(commentedRequire)).toBe(true);
  });

  it('[Gap 4, adversarial] a static import with a line break and extra whitespace before "from" (multi-line named-import formatting) is still caught', () => {
    const multilineImport = `
      import {
        driver,
        auth,
      }
        from
          'neo4j-driver';
    `;
    expect(importsNeo4jDriverPackage(multilineImport)).toBe(true);
  });

  it('[Gap 4, adversarial] a dynamic import() with a line break and a leading comment between "import" and "(" is caught', () => {
    const multilineDynamicImport = `
      const n4j = await import
        // why is there a comment here
        ('neo4j-driver');
    `;
    expect(importsNeo4jDriverPackage(multilineDynamicImport)).toBe(true);
  });

  it('[Gap 4, adversarial] a require() whose specifier is a template literal with no substitutions (a legal ES2015+ string-literal-equivalent form) is caught', () => {
    // eslint-disable-next-line no-useless-escape -- deliberately using backtick quoting to prove template-literal specifiers are recognized too.
    const templateLiteralRequire = 'const n4j = require(`neo4j-driver`);';
    expect(importsNeo4jDriverPackage(templateLiteralRequire)).toBe(true);
  });

  it('[Gap 4, adversarial] not-over-strict: an ordinary comment mentioning "import" and "require" as plain English words, with no actual import/require call, is not flagged', () => {
    const proseOnly = `
      // don't forget to import your favorite driver, or require one via DI
      export const NOTE = 'neo4j-driver is mentioned here only as prose';
    `;
    expect(importsNeo4jDriverPackage(proseOnly)).toBe(false);
    expect(hasNonLiteralDynamicImport(proseOnly)).toBe(false);
  });

  // --- Gap 5 / Gap 6 (found during the THIRD remediation-verification pass,
  // 2026-07-23, adversarially probing the new AST-based
  // `importsNeo4jDriverPackage`). NOT fixed this pass -- per the
  // "document, don't silently fix" convention tester has followed every
  // prior round (see Gap 1/Gap 2a/Gap 2b/Gap 3/Gap 4 above), these assert
  // the CURRENT (vulnerable) behavior so the suite stays green while making
  // the gap visible to review/dev, rather than a red failing test that
  // looks like a test bug. Both are genuinely live today, no precondition
  // needed, and neither is a variant of the three previously-reported
  // whitespace/comment shapes (Gap 4a/4b/4c) -- they are a DIFFERENT root
  // cause: the AST walk only inspects `ImportDeclaration` /
  // `ImportEqualsDeclaration` / `ImportTypeNode` / a `CallExpression` whose
  // callee is literally the `import` keyword or an identifier spelled
  // `require` -- it does not resolve what an identifier is BOUND to (Gap 5)
  // and does not inspect `ExportDeclaration` at all (Gap 6).
  it('[Gap 5, TESTER-FOUND, round 3] `require` reassigned to a local variable, then called through the alias, is NOT caught by importsNeo4jDriverPackage -- the AST check matches on the callee being an Identifier literally spelled "require", not on which value that identifier is bound to', () => {
    const requireAliasFixture = `
      const req = require;
      const n4j = req('neo4j-driver');
      const driver = n4j['driver']('bolt://localhost:7687', n4j['auth']['basic']('u', 'p'));
      const sess = driver[('sess' + 'ion')]();
    `;
    expect(
      importsNeo4jDriverPackage(requireAliasFixture),
      'expected the current PRIMARY import-based check to MISS this (documenting the gap) -- ' +
        'req(...) is a CallExpression whose callee Identifier is "req", not "require", so the ' +
        'isRequireCall branch never matches even though req IS require',
    ).toBe(false);
    const foundMarkers = FORBIDDEN_MARKERS.filter((marker) => requireAliasFixture.includes(marker));
    expect(
      foundMarkers,
      'the SECONDARY marker scan also misses this shape when combined with bracket-notation ' +
        'member access (the same evasion technique FND-8f00211cd735 already proved works)',
    ).toEqual([]);
  });

  it('[Gap 6, TESTER-FOUND, round 3] `export * from \'neo4j-driver\'` (barrel re-export) is NOT caught by importsNeo4jDriverPackage -- the AST walk never inspects ExportDeclaration nodes at all, only ImportDeclaration/ImportEqualsDeclaration/ImportTypeNode/CallExpression', () => {
    const exportStarFixture = `export * from 'neo4j-driver';`;
    expect(
      importsNeo4jDriverPackage(exportStarFixture),
      'expected the current PRIMARY import-based check to MISS a barrel re-export (documenting the gap) -- ' +
        'this statement pulls the neo4j-driver module in and makes its exports available to any file ' +
        'that imports THIS (non-allowlisted) file instead, which is exactly the bypass shape the ' +
        'chokepoint is meant to prevent',
    ).toBe(false);
    const foundMarkers = FORBIDDEN_MARKERS.filter((marker) => exportStarFixture.includes(marker));
    expect(foundMarkers, 'the SECONDARY marker scan also finds nothing -- no call-site text exists in a re-export statement').toEqual([]);
  });

  it('[Gap 6, TESTER-FOUND, round 3] `export { default as driver } from \'neo4j-driver\'` (named re-export) is likewise NOT caught by importsNeo4jDriverPackage, for the same ExportDeclaration-blind-spot reason as the export-* case above', () => {
    const exportNamedFixture = `export { default as driver, auth } from 'neo4j-driver';`;
    expect(
      importsNeo4jDriverPackage(exportNamedFixture),
      'expected the current PRIMARY import-based check to MISS a named re-export (documenting the gap)',
    ).toBe(false);
    const foundMarkers = FORBIDDEN_MARKERS.filter((marker) => exportNamedFixture.includes(marker));
    expect(foundMarkers).toEqual([]);
  });

  it('[Gap 5/6, TESTER-FOUND, sanity] confirms this is genuinely a different root cause than Gap 4a/4b/4c: neither fixture is a whitespace/comment placement variant of an import()/require() call -- Gap 5 is an aliased-identifier-binding problem, Gap 6 is a missing-AST-node-kind (ExportDeclaration) problem', () => {
    const requireAliasFixture = `const req = require; req('neo4j-driver');`;
    const exportStarFixture = `export * from 'neo4j-driver';`;
    // Neither fixture is flagged by the Gap 2a fail-closed dynamic-import
    // check either -- both are static forms (a reassigned require() call and
    // an ES export declaration), not a dynamic import() call with a
    // non-literal argument, so hasNonLiteralDynamicImport is not the right
    // mechanism to catch these either.
    expect(hasNonLiteralDynamicImport(requireAliasFixture)).toBe(false);
    expect(hasNonLiteralDynamicImport(exportStarFixture)).toBe(false);
  });

  it('[Gap 2b, TESTER-FOUND, sanity] confirms Gap 2b is NOT currently exploitable: neither allowlisted executor file re-exports a raw driver/session-capable value today', () => {
    for (const file of ALLOWLISTED_FILES) {
      const content = readFileSync(file, 'utf-8');
      // Both files export only: interfaces/types (GraphWriteExecutor,
      // GraphReadExecutor, Neo4jDriverFactory, record/result shapes),
      // guarded factory functions (createNeo4j{Write,Read}Executor), and
      // (read side) LazyGraphReadExecutor -- never the raw `neo4j` default
      // import or a `Driver` instance. A future PR that adds e.g.
      // `export { default as rawDriver } from 'neo4j-driver';` (or exports a
      // constructed Driver instance directly) to either file would reopen
      // Gap 2 for real; this assertion exists so that change is at least
      // visible as a diff to this specific line, even though it can't detect
      // arbitrary future re-export syntax generically.
      expect(
        content,
        `${file} was not expected to re-export the raw neo4j-driver default export`,
      ).not.toMatch(/export\s*\{[^}]*\bdefault\s+as\b[^}]*\}\s*from\s*['"]neo4j-driver['"]/);
    }
  });
});
