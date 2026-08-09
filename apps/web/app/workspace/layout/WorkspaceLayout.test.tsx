import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedWorkspaceLayout } from '../../../../../packages/workspace-packs/src/runtime';
import { WorkspaceLayout } from './WorkspaceLayout';

(globalThis as unknown as { React: typeof React }).React = React;

type RegionInput = {
  id: string;
  slot: 'top' | 'bottom' | 'navigation' | 'explorer' | 'primary' | 'inspector' | 'overlay';
  order?: number;
  resize?: 'horizontal' | 'vertical' | 'none';
  collapsible?: boolean;
  collapsed?: boolean;
  size?: number;
};

function layout(...inputs: RegionInput[]): ResolvedWorkspaceLayout {
  return {
    id: 'layout.behavior',
    regions: inputs.map((input) => ({
      id: input.id,
      slot: input.slot,
      order: input.order ?? 0,
      component: { id: input.slot === 'primary' ? 'sayre.primary-surface' : 'sayre.test', version: 1, props: {} },
      defaultSize: input.size ?? 180,
      minimumSize: 44,
      maximumSize: 500,
      size: input.size ?? 180,
      resize: input.resize ?? 'none',
      collapsible: input.collapsible ?? false,
      collapsed: input.collapsed ?? false,
      hidden: false,
      compactBehavior: 'overlay',
      visibleInViews: null,
    })),
  } as unknown as ResolvedWorkspaceLayout;
}

describe('WorkspaceLayout compositor contract', () => {
  // @spec AC-3 EC-1 EC-2 EC-3
  it('omits every explicitly inactive contribution before allocating a dock or landmark', () => {
    const renderer = TestRenderer.create(
      <WorkspaceLayout
        layout={layout(
          { id: 'region.explorer', slot: 'explorer' },
          { id: 'region.primary', slot: 'primary' },
          { id: 'region.inspector', slot: 'inspector' },
        )}
        viewId="technical"
        renderRegion={(id) => id === 'region.primary' ? <main>Primary</main> : null}
      />,
    );

    expect(renderer.root.findAll((node) => node.props['data-workspace-dock'] === 'region.explorer')).toHaveLength(0);
    expect(renderer.root.findAll((node) => node.props['data-workspace-dock'] === 'region.inspector')).toHaveLength(0);
    expect(renderer.root.findAll((node) => node.props['data-workspace-dock'] === 'region.primary')).toHaveLength(1);
    renderer.unmount();
  });

  // @spec AC-6 AC-7 EC-4 EC-5
  it('composes same-slot regions in deterministic groups and sizes the declared axis', () => {
    const renderer = TestRenderer.create(
      <WorkspaceLayout
        layout={layout(
          { id: 'region.z', slot: 'top', order: 1, resize: 'vertical', size: 90 },
          { id: 'region.b', slot: 'top', order: 0, resize: 'vertical', size: 80 },
          { id: 'region.a', slot: 'top', order: 0, resize: 'vertical', size: 70 },
          { id: 'region.primary', slot: 'primary' },
          { id: 'region.overlay', slot: 'overlay', resize: 'horizontal', size: 120 },
        )}
        viewId="technical"
        renderRegion={(id) => <span>{id}</span>}
      />,
    );

    const topGroup = renderer.root.findByProps({ 'data-workspace-slot-group': 'top' });
    const topDocks = topGroup.findAll((node) => typeof node.props['data-workspace-dock'] === 'string');
    expect(topDocks.map((node) => node.props['data-workspace-dock'])).toEqual(['region.a', 'region.b', 'region.z']);
    expect(topDocks[0]!.props.style.blockSize).toBe('70px');
    expect(renderer.root.findByProps({ 'data-workspace-dock': 'region.overlay' }).props.style.inlineSize).toBe('120px');
    renderer.unmount();
  });

  // @spec AC-10 EC-11
  it('never offers collapse for primary or non-collapsible regions but restores valid collapsible regions', async () => {
    const collapse = vi.fn();
    const renderer = TestRenderer.create(
      <WorkspaceLayout
        layout={layout(
          { id: 'region.fixed', slot: 'explorer', resize: 'horizontal', collapsible: false },
          { id: 'region.primary', slot: 'primary', resize: 'horizontal', collapsible: false },
          { id: 'region.optional', slot: 'inspector', resize: 'horizontal', collapsible: true },
        )}
        viewId="technical"
        renderRegion={(id) => <span>{id}</span>}
        onCollapse={collapse}
      />,
    );

    const fixed = renderer.root.findByProps({ 'aria-controls': 'region.fixed' });
    const primary = renderer.root.findByProps({ 'aria-controls': 'region.primary' });
    const optional = renderer.root.findByProps({ 'aria-controls': 'region.optional' });
    await act(async () => fixed.props.onKeyDown({ key: 'Enter', preventDefault: vi.fn() }));
    await act(async () => primary.props.onKeyDown({ key: 'Enter', preventDefault: vi.fn() }));
    await act(async () => optional.props.onKeyDown({ key: 'Enter', preventDefault: vi.fn() }));

    expect(collapse.mock.calls).toEqual([['region.optional']]);
    renderer.unmount();
  });
});
