import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { WorkspaceEditorProvider, useWorkspaceEditor } from '../editor/WorkspaceEditorProvider';
import { WorkspacePackProvider } from '../packs/WorkspacePackProvider';
import { MockProvider } from '../state';
import { WorkspaceCatalogErrorBoundary } from './WorkspaceShell';
import { SystemRecoveryMenu } from './SystemRecoveryMenu';

(globalThis as unknown as { React: typeof React }).React = React;

function ThrowingCatalogComponent(): React.ReactElement {
  throw new Error('trusted review fixture failed');
}

describe('System recovery review remediation', () => {
  // @spec AC-14 EC-15
  it('renders truthful dirty-draft recovery actions without silently switching or resetting', async () => {
    let editor: ReturnType<typeof useWorkspaceEditor> | null = null;
    function Probe() {
      editor = useWorkspaceEditor();
      return null;
    }
    let renderer: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      renderer = TestRenderer.create(
        <MockProvider>
          <WorkspacePackProvider>
            <WorkspaceEditorProvider>
              <SystemRecoveryMenu />
              <Probe />
            </WorkspaceEditorProvider>
          </WorkspacePackProvider>
        </MockProvider>,
      );
      await Promise.resolve();
    });
    await act(async () => editor!.begin());
    await act(async () => {
      expect(editor!.apply({ type: 'set-theme-color', token: 'canvas', value: '#010203' })).toBe(true);
    });
    expect(editor!.dirty).toBe(true);
    await act(async () => renderer!.root.findByProps({ 'data-workspace-recovery-trigger': 'true' }).props.onClick());
    expect(renderer!.root.findByProps({ 'data-workspace-recovery-action': 'switch-default' }).props.disabled).toBe(true);
    expect(renderer!.root.findByProps({ 'data-workspace-recovery-action': 'reset-layout' }).props.disabled).toBe(true);
    expect(JSON.stringify(renderer!.toJSON())).toMatch(/Finish or discard the open layout draft/i);
    expect(JSON.stringify(renderer!.toJSON())).toMatch(/Discard draft and exit layout editor/i);
    await act(async () => renderer!.unmount());
  });

  // @spec AC-14 EC-16
  it('keeps rendered recovery controls outside a throwing trusted catalog boundary', async () => {
    let renderer: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      renderer = TestRenderer.create(
        <MockProvider>
          <WorkspacePackProvider>
            <WorkspaceEditorProvider>
              <SystemRecoveryMenu />
              <WorkspaceCatalogErrorBoundary>
                <ThrowingCatalogComponent />
              </WorkspaceCatalogErrorBoundary>
            </WorkspaceEditorProvider>
          </WorkspacePackProvider>
        </MockProvider>,
      );
      await Promise.resolve();
    });
    expect(renderer!.root.findByProps({ role: 'alert' }).props.children).toMatch(/workspace component failed/i);
    const trigger = renderer!.root.findByProps({ 'data-workspace-recovery-trigger': 'true' });
    await act(async () => trigger.props.onClick());
    expect(renderer!.root.findByProps({ 'data-workspace-recovery-menu': 'true' })).toBeDefined();
    await act(async () => renderer!.unmount());
  });
});
