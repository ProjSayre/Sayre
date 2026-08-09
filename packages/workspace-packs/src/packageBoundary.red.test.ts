/**
 * FE-ARCH-02 red suite — the presentation-only boundary of the contract package, checked
 * mechanically, plus the additive runtime re-export.
 *
 * AC-13's mechanical half: `shapes.ts` and `registry.ts` are pure, framework-free contract modules —
 * they import nothing from `apps/`, pull in no React/Next, escape neither the package nor the src
 * directory, and reach no network, storage, or environment. Review judges intent; this file only
 * measures the source text.
 *
 * AC-12's package half: `runtime.ts` re-exports the two new modules additively — every export the
 * runtime barrel carried before this ticket is still there, and the runtime contract version is
 * still 1.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const CONTRACT_MODULES = [
  'packages/workspace-packs/src/shapes.ts',
  'packages/workspace-packs/src/registry.ts',
] as const;

/** Every export the runtime barrel already carried, which this ticket may only add to. */
const EXISTING_RUNTIME_EXPORTS = [
  'WORKSPACE_PACK_SCHEMA_VERSION',
  'WORKSPACE_RUNTIME_CONTRACT_VERSION',
  'parseWorkspacePack',
  'validateWorkspacePackCompatibility',
  'roleAllows',
  'resolveWorkspaceExperience',
  'canonicalizeWorkspacePack',
  'applyWorkspaceEditOperation',
] as const;

const NEW_RUNTIME_EXPORTS = [
  'WORKSPACE_SHAPES',
  'isWorkspaceShapePayload',
  'createWorkspaceRegistry',
] as const;

/** Non-presentation reach: network, browser storage, and process environment. */
const FORBIDDEN_ACCESS: readonly (readonly [RegExp, string])[] = [
  [/\bfetch\s*\(/, 'network fetch'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bWebSocket\b/, 'WebSocket'],
  [/\blocalStorage\b/, 'localStorage'],
  [/\bsessionStorage\b/, 'sessionStorage'],
  [/\bindexedDB\b/, 'indexedDB'],
  [/\bprocess\s*\.\s*env\b/, 'process environment'],
  [/\brequire\s*\(/, 'CommonJS require'],
];

function repositoryRoot(): string {
  return existsSync(resolve(process.cwd(), 'packages/workspace-packs/src/contracts.ts'))
    ? process.cwd()
    : resolve(process.cwd(), '../..');
}

function requiredSource(relativePath: string): string {
  const path = resolve(repositoryRoot(), relativePath);
  expect(existsSync(path), `FE-ARCH-02 contract module is not implemented yet: ${relativePath}`).toBe(true);
  return readFileSync(path, 'utf8');
}

/** Every module specifier the source imports, re-exports, or dynamically imports. */
function moduleSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  for (const match of source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) specifiers.add(match[1]);
  for (const match of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.add(match[1]);
  for (const match of source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.add(match[1]);
  for (const match of source.matchAll(/^[ \t]*import\s+['"]([^'"]+)['"]/gm)) specifiers.add(match[1]);
  return [...specifiers];
}

describe('FE-ARCH-02 contract package boundary', () => {
  // @spec AC-13
  it('imports nothing from apps/, no UI framework, and nothing outside its own source directory', async () => {
    for (const relativePath of CONTRACT_MODULES) {
      const specifiers = moduleSpecifiers(requiredSource(relativePath));
      for (const specifier of specifiers) {
        expect(specifier.includes('apps/'), `${relativePath} imports from apps/: ${specifier}`).toBe(false);
        expect(
          ['react', 'react-dom', 'next'].some((framework) => specifier === framework || specifier.startsWith(`${framework}/`)),
          `${relativePath} imports a UI framework: ${specifier}`,
        ).toBe(false);
        expect(specifier.startsWith('node:'), `${relativePath} imports a Node built-in: ${specifier}`).toBe(false);
        if (specifier.startsWith('.')) {
          expect(specifier.startsWith('./'), `${relativePath} reaches outside its own directory: ${specifier}`).toBe(true);
        }
      }
    }
  });

  // @spec AC-13
  it('reaches no network, storage, or process environment', async () => {
    for (const relativePath of CONTRACT_MODULES) {
      const source = requiredSource(relativePath);
      for (const [pattern, label] of FORBIDDEN_ACCESS) {
        expect(pattern.test(source), `${relativePath} performs ${label} access`).toBe(false);
      }
    }
  });

  // @spec AC-12
  it('re-exports the shape contract and registry from runtime.ts without dropping an existing export', async () => {
    const runtime = await vi.importActual<Record<string, unknown>>('./runtime');
    const exported = Object.keys(runtime);
    expect(exported).toEqual(expect.arrayContaining([...EXISTING_RUNTIME_EXPORTS]));
    expect(runtime.WORKSPACE_RUNTIME_CONTRACT_VERSION).toBe(1);
    expect(exported).toEqual(expect.arrayContaining([...NEW_RUNTIME_EXPORTS]));
    expect(typeof runtime.createWorkspaceRegistry).toBe('function');
    expect(typeof runtime.isWorkspaceShapePayload).toBe('function');
    expect([...(runtime.WORKSPACE_SHAPES as readonly string[])]).toEqual(['collection', 'tree', 'graph', 'document']);
  });
});
