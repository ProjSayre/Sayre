import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceShell } from './components/WorkspaceShell';
import { MockProvider } from './state';

(globalThis as unknown as { React: typeof React }).React = React;

function repositoryRoot(): string {
  return existsSync(resolve(process.cwd(), 'apps/web/package.json'))
    ? process.cwd()
    : resolve(process.cwd(), '../..');
}

function repo(relative: string): string {
  return resolve(repositoryRoot(), relative);
}

function renderedText(renderer: TestRenderer.ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

async function renderWorkspace(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    renderer = TestRenderer.create(
      <MockProvider>
        <WorkspaceShell />
      </MockProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer!;
}

describe('Workspace layout and recovery surface — leading red', () => {
  // @spec AC-18 AC-21 EC-22 EC-23 EC-25
  it('ships a dock resolver and compact/standard/wide layout rules that preserve the primary and recovery controls', () => {
    const component = repo('apps/web/app/workspace/layout/WorkspaceLayout.tsx');
    const cssPath = repo('apps/web/app/workspace/layout/workspace-layout.css');
    expect(existsSync(component), 'WorkspaceLayout is not implemented yet.').toBe(true);
    expect(existsSync(cssPath)).toBe(true);
    const css = readFileSync(cssPath, 'utf8');
    expect(css).toMatch(/container-type|@container/);
    expect(css).toMatch(/320px|compact/);
    expect(css).toMatch(/736px|standard/);
    expect(css).toMatch(/44px/);
    expect(css).toMatch(/prefers-reduced-motion/);
  });

  // @spec AC-19 AC-20 EC-21 EC-24
  it('makes resize pointer/touch/keyboard accessible, clamped, collapsible, and focus-safe', async () => {
    const path = repo('apps/web/app/workspace/layout/ResizeHandle.tsx');
    expect(existsSync(path), 'ResizeHandle is not implemented yet.').toBe(true);
    const { ResizeHandle } = await vi.importActual<{
      ResizeHandle: React.ComponentType<Record<string, unknown>>;
    }>('./layout/ResizeHandle');
    const onChange = vi.fn();
    const onCollapse = vi.fn();
    const onExpand = vi.fn();
    const renderer = TestRenderer.create(
      <ResizeHandle
        regionId="region.explorer"
        axis="horizontal"
        value={200}
        minimum={180}
        maximum={240}
        collapsed={false}
        onChange={onChange}
        onCollapse={onCollapse}
        onExpand={onExpand}
      />,
    );
    const separator = renderer.root.findByProps({ role: 'separator' });
    expect(separator.props['aria-orientation']).toBe('vertical');
    expect(separator.props['aria-valuemin']).toBe(180);
    expect(separator.props['aria-valuemax']).toBe(240);
    expect(separator.props['aria-valuenow']).toBe(200);
    expect(separator.props.onPointerDown).toEqual(expect.any(Function));
    expect(separator.props.onTouchStart ?? separator.props.onPointerDown).toEqual(expect.any(Function));

    separator.props.onKeyDown({ key: 'ArrowRight', shiftKey: false, preventDefault: vi.fn() });
    separator.props.onKeyDown({ key: 'ArrowRight', shiftKey: true, preventDefault: vi.fn() });
    separator.props.onKeyDown({ key: 'Home', shiftKey: false, preventDefault: vi.fn() });
    separator.props.onKeyDown({ key: 'End', shiftKey: false, preventDefault: vi.fn() });
    separator.props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault: vi.fn() });
    expect(onChange.mock.calls.map((call) => call[0])).toEqual([208, 232, 180, 240]);
    expect(onCollapse).toHaveBeenCalledOnce();
    renderer.unmount();
  });

  // @spec AC-22 EC-26
  it('persists size/collapse preferences per exact pack/layout/viewport and drops stale regions', () => {
    const provider = repo('apps/web/app/workspace/packs/WorkspacePackProvider.tsx');
    expect(existsSync(provider), 'Workspace preference layering is not implemented yet.').toBe(true);
    const source = readFileSync(provider, 'utf8');
    expect(source).toMatch(/pack[^\n]*(version|ref)/i);
    expect(source).toMatch(/viewportClass/);
    expect(source).toMatch(/minimumSize|maximumSize|clamp/);
    expect(source).toMatch(/regionSizes|collapsedRegionIds/);
  });

  // @spec AC-23 AC-24 AC-25 EC-43
  it('keeps layout interactions out of remote query and realtime dependencies', () => {
    const layoutProvider = repo('apps/web/app/workspace/packs/WorkspacePackProvider.tsx');
    expect(existsSync(layoutProvider)).toBe(true);
    const source = readFileSync(layoutProvider, 'utf8');
    expect(source).not.toMatch(/repositories\(|technicalTree\(|productTree\(|nodeOverlay\(|providerState\(|new WebSocket/);
  });

  // @spec AC-26 AC-27 AC-51 EC-13 EC-17 EC-48
  it('always exposes system-owned recovery/edit entry while keeping edit chrome out of blocked global states', async () => {
    const recoveryPath = repo('apps/web/app/workspace/components/SystemRecoveryMenu.tsx');
    expect(existsSync(recoveryPath), 'SystemRecoveryMenu is not implemented yet.').toBe(true);
    const renderer = await renderWorkspace();
    const text = renderedText(renderer);
    expect(text).toMatch(/switch to default/i);
    expect(text).toMatch(/reset.*layout/i);
    expect(text).toMatch(/edit.*(layout|workspace)/i);
    expect(text).toMatch(/workspace pack/i);
    await act(async () => renderer.unmount());
  });

  // @spec AC-68 EC-54
  it('keeps edit/recovery actions keyboard reachable at all fixture viewport classes', () => {
    const editorCssPath = repo('apps/web/app/workspace/editor/editor.css');
    expect(existsSync(editorCssPath), 'Responsive editor chrome is not implemented yet.').toBe(true);
    const css = readFileSync(editorCssPath, 'utf8');
    expect(css).toMatch(/compact|320px/);
    expect(css).toMatch(/standard|736px/);
    expect(css).toMatch(/focus-visible/);
    expect(css).not.toMatch(/pointer-events:\s*none[^}]*edit/i);
  });
});
