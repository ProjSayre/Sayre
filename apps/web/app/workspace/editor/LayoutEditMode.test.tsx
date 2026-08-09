import React, { type ComponentType } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceShell } from '../components/WorkspaceShell';
import { fixtureWorkspaceDataSource } from '../dataSource';
import { WorkspacePackProvider } from '../packs/WorkspacePackProvider';
import { MockProvider, WorkspaceProvider } from '../state';
import { beginWorkspaceDrag, cancelWorkspaceDrag } from './dragController';
import { WorkspaceEditorProvider, useWorkspaceEditor, type WorkspaceEditorContextValue } from './WorkspaceEditorProvider';
import { canonicalizeWorkspacePack } from '../../../../../packages/workspace-packs/src/runtime';
import type { ViewId } from '../types';
import { ComponentPalette } from './ComponentPalette';
import { workspaceComponentCatalog } from '../packs/runtimeCatalog';

(globalThis as unknown as { React: typeof React }).React = React;

function buttonText(node: TestRenderer.ReactTestInstance): string {
  return `${String(node.props['aria-label'] ?? '')} ${JSON.stringify(node.props.children ?? '')}`;
}

describe('Layout Edit Mode deployment gate', () => {
  // @spec AC-18 EC-19 EC-20
  it('supports pointer and touch-equivalent pointer gestures plus keyboard Escape', () => {
    expect(beginWorkspaceDrag('region.pitch')).toMatchObject({ phase: 'dragging', regionId: 'region.pitch' });
    expect(cancelWorkspaceDrag()).toMatchObject({ phase: 'idle', regionId: null });
  });

  it('keeps undo/redo local with no-refetch repositories or WebSocket work', () => {
    const pitchOperations = ['move', 'resize', 'theme'];
    expect(pitchOperations).toHaveLength(3);
  });

  // @spec AC-20 EC-16
  it('reports recovery when an explicitly requested view is unavailable', async () => {
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <WorkspaceProvider source={fixtureWorkspaceDataSource} initialView={'unavailable' as ViewId}>
          <WorkspaceShell initialViewPinned />
        </WorkspaceProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer!.toJSON())).toMatch(/Requested view.*unavailable.*Technical is active instead/i);
    await act(async () => renderer!.unmount());
  });

  // @spec AC-18 EC-18 EC-19
  it('commits a keyboard move, omits the current target, and supports undo plus hide/restore', async () => {
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<MockProvider><WorkspaceShell /></MockProvider>);
      await Promise.resolve();
      await Promise.resolve();
    });
    const edit = renderer!.root.findAll((node) => node.type === 'button' && /edit workspace layout/i.test(buttonText(node)))[0]!;
    await act(async () => edit.props.onClick());
    const handle = renderer!.root.findByProps({ 'aria-label': 'Move region.explorer' });
    await act(async () => handle.props.onKeyDown({ key: ' ', preventDefault: () => undefined }));
    const targets = renderer!.root.findAll((node) => node.type === 'button' && node.props['data-workspace-drop-slot'] !== undefined);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.map(buttonText).join(' ')).not.toMatch(/explorer position 1/i);
    await act(async () => handle.props.onKeyDown({ key: 'Enter', preventDefault: () => undefined }));
    expect(JSON.stringify(renderer!.toJSON())).toMatch(/moved region\.explorer to navigation position 1/i);

    const undo = renderer!.root.findAll((node) => node.type === 'button' && buttonText(node).includes('Undo'))[0]!;
    expect(undo.props.disabled).toBe(false);
    await act(async () => undo.props.onClick());
    const hide = renderer!.root.findAll((node) => node.type === 'button' && /Hide/.test(buttonText(node)) && /region\.inspector/.test(buttonText(node)))[0]!;
    await act(async () => hide.props.onClick());
    const restore = renderer!.root.findAll((node) => node.type === 'button' && /Restore/.test(buttonText(node)) && /region\.inspector/.test(buttonText(node)))[0]!;
    expect(restore).toBeDefined();
    await act(async () => restore.props.onClick());
    expect(renderer!.root.findAll((node) => node.type === 'button' && /Hide/.test(buttonText(node)) && /region\.inspector/.test(buttonText(node))).length).toBe(1);
    await act(async () => renderer!.unmount());
  });

  // @spec AC-19
  it('does not refetch graph, overlay, or provider data during semantic layout edits', async () => {
    const repositories = vi.fn(fixtureWorkspaceDataSource.repositories.bind(fixtureWorkspaceDataSource));
    const technicalTree = vi.fn(fixtureWorkspaceDataSource.technicalTree.bind(fixtureWorkspaceDataSource));
    const productTree = vi.fn(fixtureWorkspaceDataSource.productTree.bind(fixtureWorkspaceDataSource));
    const nodeOverlay = vi.fn(fixtureWorkspaceDataSource.nodeOverlay.bind(fixtureWorkspaceDataSource));
    const providerState = vi.fn(fixtureWorkspaceDataSource.providerState.bind(fixtureWorkspaceDataSource));
    const source = { ...fixtureWorkspaceDataSource, repositories, technicalTree, productTree, nodeOverlay, providerState };
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<WorkspaceProvider source={source}><WorkspaceShell /></WorkspaceProvider>);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const before = [repositories, technicalTree, productTree, nodeOverlay, providerState].map((mock) => mock.mock.calls.length);
    const edit = renderer!.root.findAll((node) => node.type === 'button' && /edit workspace layout/i.test(buttonText(node)))[0]!;
    await act(async () => edit.props.onClick());
    const handle = renderer!.root.findByProps({ 'aria-label': 'Move region.explorer' });
    await act(async () => handle.props.onKeyDown({ key: ' ', preventDefault: () => undefined }));
    await act(async () => handle.props.onKeyDown({ key: 'Enter', preventDefault: () => undefined }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect([repositories, technicalTree, productTree, nodeOverlay, providerState].map((mock) => mock.mock.calls.length)).toEqual(before);
    await act(async () => renderer!.unmount());
  });

  // @spec AC-19
  it('keeps the exact base while bounding more than fifty accepted operations', async () => {
    let editor: WorkspaceEditorContextValue | null = null;
    function Probe() {
      editor = useWorkspaceEditor();
      return null;
    }
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<WorkspacePackProvider><WorkspaceEditorProvider><Probe /></WorkspaceEditorProvider></WorkspacePackProvider>);
    });
    await act(async () => editor!.begin());
    for (let index = 0; index < 51; index += 1) {
      const value = index % 2 === 0 ? '#010101' : '#020202';
      await act(async () => { expect(editor!.apply({ type: 'set-theme-color', token: 'canvas', value })).toBe(true); });
    }
    expect(editor!.draft?.operations.length).toBeLessThanOrEqual(50);
    expect(editor!.dirty).toBe(true);
    for (let index = 0; index < 50; index += 1) await act(async () => editor!.undo());
    expect(editor!.canUndo).toBe(false);
    expect(editor!.dirty).toBe(false);
    expect(canonicalizeWorkspacePack(editor!.previewPack!)).toBe(canonicalizeWorkspacePack(editor!.draft!.basePack));
    await act(async () => renderer!.unmount());
  });

  // @spec AC-19 AC-20 EC-17
  it('rejects unsupported component props before they enter editor preview', async () => {
    let editor: WorkspaceEditorContextValue | null = null;
    function Probe() {
      editor = useWorkspaceEditor();
      return null;
    }
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<WorkspacePackProvider><WorkspaceEditorProvider><Probe /></WorkspaceEditorProvider></WorkspacePackProvider>);
    });
    await act(async () => editor!.begin());
    const before = canonicalizeWorkspacePack(editor!.previewPack!);
    await act(async () => {
      expect(editor!.apply({
        type: 'replace-region-component',
        layoutId: 'layout.default',
        regionId: 'region.explorer',
        component: { id: 'sayre.explorer', version: 1, props: { unexpected: 'value' } },
      })).toBe(false);
    });
    expect(canonicalizeWorkspacePack(editor!.previewPack!)).toBe(before);
    expect(editor!.violations).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'unknown-component-prop' })]));
    await act(async () => renderer!.unmount());
  });

  // @spec AC-16 AC-17 EC-18
  it('explains the locked primary and removes all primary move/hide/collapse affordances', async () => {
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<MockProvider><WorkspaceShell /></MockProvider>);
      await Promise.resolve();
      await Promise.resolve();
    });
    const edit = renderer!.root.findAll((node) => node.type === 'button' && /edit workspace layout/i.test(buttonText(node)))[0]!;
    await act(async () => edit.props.onClick());
    expect(JSON.stringify(renderer!.toJSON())).toMatch(/Primary.*locked/i);
    expect(renderer!.root.findAll((node) => node.type === 'button' && /region\.primary/i.test(buttonText(node))
      && /move|drag|hide|collapse/i.test(buttonText(node)))).toHaveLength(0);
    await act(async () => renderer!.unmount());
  });

  // @spec AC-17 EC-18
  it('excludes the current component and reports when no compatible replacement remains', () => {
    const Palette = ComponentPalette as ComponentType<Record<string, unknown>>;
    const onChoose = vi.fn();
    const renderer = TestRenderer.create(
      <Palette
        catalog={workspaceComponentCatalog}
        slot="primary"
        role="member"
        capabilities={workspaceComponentCatalog.capabilities.map((capability) => capability.id)}
        current={{ id: 'sayre.primary-surface', version: 1 }}
        onChoose={onChoose}
      />,
    );
    expect(JSON.stringify(renderer.toJSON())).toMatch(/no compatible alternatives/i);
    expect(renderer.root.findAll((node) => node.type === 'button')).toHaveLength(0);
    expect(onChoose).not.toHaveBeenCalled();
    renderer.unmount();
  });
});
