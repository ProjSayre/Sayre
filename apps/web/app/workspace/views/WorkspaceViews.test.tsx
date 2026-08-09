import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { ViewRail } from '../components/ViewRail';
import { workspaceComponentCatalog } from '../packs/componentCatalog';
import { WorkspacePackProvider } from '../packs/WorkspacePackProvider';
import { MockProvider, useWorkspaceFixture, useWorkspaceNavigation, useWorkspaceSelection } from '../state';

(globalThis as unknown as { React: typeof React }).React = React;

describe('Workspace view interaction parity', () => {
  // @spec AC-3 AC-4 EC-1 EC-2 EC-14
  it('resolves explorer and inspector presence from runtime state before composition', () => {
    const explorer = workspaceComponentCatalog.components.get('sayre.explorer@1') as unknown as {
      isPresent?: (state: Record<string, unknown>) => boolean;
    };
    const inspector = workspaceComponentCatalog.components.get('sayre.inspector@1') as unknown as {
      isPresent?: (state: Record<string, unknown>) => boolean;
    };
    expect(explorer.isPresent).toEqual(expect.any(Function));
    expect(inspector.isPresent).toEqual(expect.any(Function));
    expect(explorer.isPresent?.({ fileTreeOpen: false })).toBe(false);
    expect(explorer.isPresent?.({ fileTreeOpen: true })).toBe(true);
    expect(inspector.isPresent?.({ inspectorOpen: true, settingsOpen: false, selectedNodeId: 'node', selectedFeatureId: null })).toBe(true);
    expect(inspector.isPresent?.({ inspectorOpen: true, settingsOpen: true, selectedNodeId: 'node', selectedFeatureId: null })).toBe(false);
    expect(inspector.isPresent?.({ inspectorOpen: true, settingsOpen: false, selectedNodeId: null, selectedFeatureId: null })).toBe(false);
  });

  // @spec AC-4 EC-7 EC-14
  it('removes the explorer dock when Files closes it and restores it coherently from Product', async () => {
    let fixture: NonNullable<ReturnType<typeof useWorkspaceFixture>> | null = null;
    function Probe() {
      fixture = useWorkspaceFixture()!;
      return null;
    }
    let renderer: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      renderer = TestRenderer.create(
        <MockProvider><WorkspacePackProvider><ViewRail /><Probe /></WorkspacePackProvider></MockProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    const files = renderer!.root.findByProps({ 'aria-label': 'Repository explorer' });
    await act(async () => files.props.onClick());
    expect(renderer!.root.findByProps({ 'aria-label': 'Repository explorer' }).props['aria-pressed']).toBe(false);
    expect(fixture!.state.fileTreeOpen).toBe(false);
    const explorer = workspaceComponentCatalog.components.get('sayre.explorer@1') as unknown as {
      isPresent?: (state: Record<string, unknown>) => boolean;
    };
    expect(explorer.isPresent?.(fixture!.state as unknown as Record<string, unknown>)).toBe(false);

    const product = renderer!.root.findByProps({ 'aria-label': 'Product Tree' });
    await act(async () => product.props.onClick());
    await act(async () => renderer!.root.findByProps({ 'aria-label': 'Repository explorer' }).props.onClick());
    expect(renderer!.root.findByProps({ 'aria-label': 'Repository explorer' }).props['aria-pressed']).toBe(true);
    expect(fixture!.state).toMatchObject({ view: 'technical', fileTreeOpen: true });
    await act(async () => renderer!.unmount());
  });

  // @spec AC-5 EC-12 EC-13
  it('opens a Product file in Technical atomically and returns to the originating feature', async () => {
    let api: {
      navigation: ReturnType<typeof useWorkspaceNavigation>;
      selection: ReturnType<typeof useWorkspaceSelection> & { openNodeInTechnicalView?: (nodeId: string) => void };
      fixture: NonNullable<ReturnType<typeof useWorkspaceFixture>>;
    } | null = null;
    function Probe() {
      const navigation = useWorkspaceNavigation();
      const selection = useWorkspaceSelection() as ReturnType<typeof useWorkspaceSelection> & {
        openNodeInTechnicalView?: (nodeId: string) => void;
      };
      const fixture = useWorkspaceFixture()!;
      api = { navigation, selection, fixture };
      return null;
    }
    let renderer: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => { renderer = TestRenderer.create(<MockProvider><Probe /></MockProvider>); });
    await act(async () => {
      api!.navigation.selectView('product');
      api!.selection.selectFeature('feat_checkout');
    });
    expect(api!.selection.openNodeInTechnicalView).toEqual(expect.any(Function));
    await act(async () => api!.selection.openNodeInTechnicalView?.('n_payment_form'));
    expect(api!.fixture.state).toMatchObject({
      view: 'technical',
      selectedNodeId: 'n_payment_form',
      selectedFeatureId: null,
      returnFeatureId: 'feat_checkout',
      drawerOpen: true,
      fileTreeOpen: true,
      search: '',
    });
    await act(async () => api!.selection.returnToFeature());
    expect(api!.fixture.state).toMatchObject({ view: 'product', selectedFeatureId: 'feat_checkout', selectedNodeId: null, drawerOpen: true });
    await act(async () => renderer!.unmount());
  });
});
