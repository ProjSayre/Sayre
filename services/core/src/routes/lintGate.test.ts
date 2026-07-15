// Permanent, CI-verifiable regression test for AC2 (spec.md): the
// `src/routes/**` ESLint `overrides` block must actually fail `eslint . --ext
// .ts` (and therefore the `core — lint` CI step) when a route handler exceeds
// the statement threshold or reaches for a banned import. This spawns the
// project's real ESLint against disposable fixture files written under
// src/routes/ at test time (never committed), and cleans them up afterward —
// so it's a real assertion, not a manual one-off that gets deleted.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const CORE_ROOT = path.resolve(__dirname, '..', '..');
const ROUTES_DIR = __dirname;

const FAT_FIXTURE = path.join(ROUTES_DIR, '__lintgate_fixture_fat.ts');
const IMPORT_FIXTURE = path.join(ROUTES_DIR, '__lintgate_fixture_import.ts');
const CLEAN_FIXTURE = path.join(ROUTES_DIR, '__lintgate_fixture_clean.ts');

const ALL_FIXTURES = [FAT_FIXTURE, IMPORT_FIXTURE, CLEAN_FIXTURE];

function cleanupFixtures(): void {
  for (const fixture of ALL_FIXTURES) {
    if (existsSync(fixture)) {
      unlinkSync(fixture);
    }
  }
}

interface EslintResult {
  status: number;
  output: string;
}

function runEslint(relativeFixturePath: string): EslintResult {
  try {
    const output = execFileSync('npx', ['--no-install', 'eslint', relativeFixturePath], {
      cwd: CORE_ROOT,
      encoding: 'utf-8',
    });
    return { status: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

afterEach(() => {
  cleanupFixtures();
});

describe('lint gate: src/routes/** overrides (AC2)', () => {
  it('fails eslint when a route handler exceeds 10 statements (max-statements)', () => {
    writeFileSync(
      FAT_FIXTURE,
      `import { Router } from 'express';
export const r = Router();
r.get('/fat', (req, res) => {
  const a = 1;
  const b = 2;
  const c = 3;
  const d = 4;
  const e = 5;
  const f = 6;
  const g = 7;
  const h = 8;
  const i = 9;
  const j = 10;
  const k = 11;
  res.json({ a, b, c, d, e, f, g, h, i, j, k });
});
`,
    );

    const result = runEslint('src/routes/__lintgate_fixture_fat.ts');

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/max-statements/);
  });

  it.each(['neo4j-driver', 'pg', 'drizzle-orm', 'bullmq', 'ioredis'])(
    'fails eslint when a route imports the banned package %s (no-restricted-imports)',
    (bannedPackage) => {
      writeFileSync(
        IMPORT_FIXTURE,
        `import x from '${bannedPackage}';\nexport const y = x;\n`,
      );

      const result = runEslint('src/routes/__lintgate_fixture_import.ts');

      expect(result.status).not.toBe(0);
      expect(result.output).toMatch(/no-restricted-imports/);
    },
  );

  it('fails eslint when a route imports the graph-query module directly', () => {
    writeFileSync(
      IMPORT_FIXTURE,
      `import { graphQueryService } from '../graph-query';\nexport const y = graphQueryService;\n`,
    );

    const result = runEslint('src/routes/__lintgate_fixture_import.ts');

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/no-restricted-imports/);
  });

  it('sanity control: a thin, compliant route fixture lints clean (the gate is not just always-failing)', () => {
    writeFileSync(
      CLEAN_FIXTURE,
      `import { Router } from 'express';
export const r = Router();
r.get('/clean', (_req, res) => {
  res.json({ ok: true });
});
`,
    );

    const result = runEslint('src/routes/__lintgate_fixture_clean.ts');

    expect(result.status).toBe(0);
  });
});
