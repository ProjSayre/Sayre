import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rendererFor } from './rendererRegistry';

function repositoryRoot(): string {
  return existsSync(resolve(process.cwd(), 'apps/web/package.json'))
    ? process.cwd()
    : resolve(process.cwd(), '../..');
}

function repo(relative: string): string {
  return resolve(repositoryRoot(), relative);
}

function source(relative: string): string {
  const path = repo(relative);
  expect(existsSync(path), `Expected architecture file is missing: ${relative}`).toBe(true);
  return readFileSync(path, 'utf8');
}

describe('Workspace Pack product-client architecture — leading red', () => {
  // @spec AC-1 AC-46
  it('keeps the migration inside the product client and declared shared/docs/tooling boundaries', () => {
    expect(existsSync(repo('packages/workspace-packs/package.json'))).toBe(true);
    const changed = execFileSync(
      'git',
      ['diff', '--name-only', '--', '.'],
      { cwd: repositoryRoot(), encoding: 'utf8' },
    ).trim().split(/\r?\n/).filter(Boolean);
    const allowed = /^(apps\/web\/|packages\/workspace-packs\/|docs\/workspace-pack|\.claude\/skills\/workspace-pack-author\/|\.sdd\/ledger\/|scripts\/check-(?:org-)?secret-access(?:\.test)?\.mjs$|package(-lock)?\.json$)/;
    expect(changed.filter((path) => !allowed.test(path.replace(/\\/g, '/')))).toEqual([]);
  });

  // @spec AC-9 AC-10 AC-11 AC-12 AC-13 AC-45 EC-19 EC-20
  it('turns the current three views into trusted contributions while retaining renderer and node-kind invariants', () => {
    const shell = source('apps/web/app/workspace/components/WorkspaceShell.tsx');
    for (const forbidden of [
      'TechnicalTreeCanvas', 'ProductTreeCanvas', 'OnboardingTreeCanvas',
      'warmGraphiteTheme', 'mock-body-explorer', 'mock-body-drawer',
    ]) expect(shell).not.toContain(forbidden);

    for (const view of ['Technical', 'Product', 'Onboarding']) {
      expect(existsSync(repo(`apps/web/app/workspace/views/${view}WorkspaceView.tsx`))).toBe(true);
    }
    expect(rendererFor('technical', 500).id).toBe('react-flow');
    expect(rendererFor('technical', 501).id).toBe('sigma');
    expect(rendererFor('product', 50_000).id).toBe('react-flow');

    const types = source('apps/web/app/workspace/types.ts');
    expect(types).toMatch(/kind:\s*'Folder'\s*\|\s*'File'/);
    expect(types).not.toMatch(/kind:\s*[^\n]*(Function|Class)/);
  });

  // @spec AC-14 AC-63 EC-18 EC-47
  it('builds the pitch experience from semantic operations and authorized Product data only', () => {
    const pitchPath = repo('apps/web/workspace-packs/pitch/sayre.workspace.json');
    const operationsPath = repo('apps/web/workspace-packs/pitch/from-default.operations.json');
    expect(existsSync(pitchPath)).toBe(true);
    expect(existsSync(operationsPath)).toBe(true);
    const pitch = JSON.parse(readFileSync(pitchPath, 'utf8')) as Record<string, unknown>;
    expect(pitch.defaultViewId).toBe('product');
    expect(JSON.stringify(pitch)).toContain('pitch-summary');
    const operations = JSON.parse(readFileSync(operationsPath, 'utf8')) as unknown[];
    expect(operations.length).toBeGreaterThan(0);
    expect(operations.every((operation) =>
      typeof operation === 'object' && operation !== null && 'type' in operation,
    )).toBe(true);

    const summary = source('apps/web/app/workspace/views/PitchSummaryPanel.tsx');
    expect(summary).not.toMatch(/fetch\(|coreFetch|nodeOverlay|repositoryId|tenantId/);
    expect(summary).toMatch(/feature|team|recent/i);
  });

  // @spec AC-24 AC-25 AC-44 EC-43
  it('separates focused state so layout edits cannot restart queries, realtime, or product operations', () => {
    for (const file of [
      'contracts.ts', 'session.tsx', 'navigation.tsx', 'selection.tsx',
      'queries.tsx', 'realtime.tsx', 'operations.tsx', 'fixture.tsx',
      'WorkspaceProvider.tsx', 'index.ts',
    ]) expect(existsSync(repo(`apps/web/app/workspace/state/${file}`))).toBe(true);
    expect(existsSync(repo('apps/web/app/workspace/state.tsx'))).toBe(false);

    const realtime = source('apps/web/app/workspace/state/realtime.tsx');
    expect(realtime).not.toMatch(/layout|regionSize|collapsed|editorDraft|packDocument/);
    const queries = source('apps/web/app/workspace/state/queries.tsx');
    expect(queries).not.toMatch(/layout|regionSize|collapsed|editorDraft/);
  });

  // @spec AC-27 AC-43 EC-17 EC-23 EC-44 EC-45 EC-46
  it('keeps global/deep-link truth outside pack control and fixture controls outside the live route', () => {
    const globalStates = source('apps/web/app/workspace/components/GlobalStates.tsx');
    for (const state of ['signed-out', 'session-expired', 'unavailable', 'forbidden']) {
      expect(globalStates).toContain(state);
    }
    const page = source('apps/web/app/page.tsx');
    expect(page).not.toMatch(/ControlPanel|mock\/fixtures|fixtureWorkspaceDataSource/);
    expect(page).toMatch(/initialPackRef|pack/);
    const layoutCss = source('apps/web/app/workspace/layout/workspace-layout.css');
    expect(layoutCss).toMatch(/prefers-reduced-motion/);
  });

  // @spec AC-28 EC-12 EC-42
  it('keeps pack management member-visible while integration settings remain catalog-owned and role-gated', () => {
    const registry = source('apps/web/app/workspace/settingsRegistry.ts');
    expect(registry).toMatch(/workspace-packs[\s\S]*minimumRole:\s*['"]member['"]/);
    for (const id of ['github', 'providers', 'mcp']) {
      expect(registry).toMatch(new RegExp(`${id}[\\s\\S]*minimumRole:\\s*['\"](?:admin|owner)['\"]`));
    }
    const settings = source('apps/web/app/workspace/settings/WorkspacePackSettings.tsx');
    expect(settings).toMatch(/import|install|activate|fork|export|uninstall/i);
  });

  // @spec EC-48
  it('preserves system recovery when a catalog component throws', () => {
    const shell = source('apps/web/app/workspace/components/WorkspaceShell.tsx');
    expect(shell).toMatch(/ErrorBoundary|componentDidCatch|getDerivedStateFromError/);
    expect(shell).toMatch(/SystemRecoveryMenu/);
  });
});
