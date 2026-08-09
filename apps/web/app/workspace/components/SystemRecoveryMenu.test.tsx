import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { WorkspaceEditorProvider } from '../editor/WorkspaceEditorProvider';
import { WorkspacePackProvider } from '../packs/WorkspacePackProvider';
import { MockProvider } from '../state';
import { SystemRecoveryMenu } from './SystemRecoveryMenu';

(globalThis as unknown as { React: typeof React }).React = React;

function text(renderer: TestRenderer.ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

async function renderRecovery(props: Omit<React.ComponentProps<typeof WorkspacePackProvider>, 'children'> = {}) {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    renderer = TestRenderer.create(
      <MockProvider>
        <WorkspacePackProvider {...props}>
          <WorkspaceEditorProvider><SystemRecoveryMenu /></WorkspaceEditorProvider>
        </WorkspacePackProvider>
      </MockProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer!;
}

describe('System recovery utility', () => {
  // @spec AC-13 AC-14 EC-15 EC-21 EC-22
  it('keeps recovery actions behind one friendly, focus-managed menu trigger', async () => {
    const renderer = await renderRecovery();
    const nav = renderer.root.findByProps({ 'aria-label': 'Workspace recovery' });
    const trigger = nav.findByProps({ 'aria-haspopup': 'menu' });

    expect(trigger.props['aria-expanded']).toBe(false);
    expect(text(renderer)).not.toMatch(/sayre\.default@1\.0\.0/i);
    expect(text(renderer)).not.toMatch(/Switch to default|Reset layout|Workspace Pack settings/i);

    await act(async () => trigger.props.onClick());
    expect(text(renderer)).toMatch(/Switch to default/i);
    expect(text(renderer)).toMatch(/Reset layout/i);
    expect(text(renderer)).toMatch(/Layout editor/i);
    expect(text(renderer)).toMatch(/Workspace Pack settings/i);

    const menu = renderer.root.findByProps({ role: 'menu' });
    await act(async () => menu.props.onKeyDown({ key: 'Escape', stopPropagation: () => undefined }));
    expect(nav.findByProps({ 'aria-haspopup': 'menu' }).props['aria-expanded']).toBe(false);
    expect(nav.findByProps({ 'aria-haspopup': 'menu' }).props['data-focus-returned']).toBe(true);
    await act(async () => renderer.unmount());
  });

  // @spec AC-13 AC-14 EC-16 EC-23
  it('retains the compact recovery trigger during incompatible-pack fallback and blocked global states', async () => {
    const fallback = await renderRecovery({
      initialPackRef: { id: 'missing.pack', version: '1.0.0' },
      initialPackRequest: 'missing.pack@1.0.0',
    });
    expect(fallback.root.findAll((node) => node.props['aria-haspopup'] === 'menu')).toHaveLength(1);
    expect(text(fallback)).toMatch(/default|safety/i);
    expect(text(fallback)).not.toMatch(/missing\.pack@1\.0\.0.*Switch to default/i);
    await act(async () => fallback.unmount());
  });
});
