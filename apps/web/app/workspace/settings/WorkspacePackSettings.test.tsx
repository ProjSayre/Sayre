import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { defaultWorkspacePack } from '../packs/builtins';
import { WorkspacePackProvider } from '../packs/WorkspacePackProvider';
import { WorkspacePackSettings } from './WorkspacePackSettings';

(globalThis as unknown as { React: typeof React }).React = React;

function renderedText(renderer: TestRenderer.ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

async function renderSettings() {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    renderer = TestRenderer.create(<WorkspacePackProvider><WorkspacePackSettings /></WorkspacePackProvider>);
    await Promise.resolve();
  });
  return renderer!;
}

describe('Workspace Pack settings product surface', () => {
  // @spec AC-15 AC-20 AC-21 EC-21 EC-26
  it('renders readable design-system cards, active/source status, grouped actions, and canonical editable colors', async () => {
    const renderer = await renderSettings();
    const list = renderer.root.findByProps({ 'aria-label': 'Installed Workspace Packs' });
    const cards = list.findAll((node) => node.props.className?.split(' ').includes('workspace-pack-card'));
    expect(cards.length).toBeGreaterThanOrEqual(2);
    expect(renderedText(renderer)).toMatch(/Built-in/i);
    expect(renderedText(renderer)).toMatch(/Active/i);
    const defaultCard = cards.find((card) => JSON.stringify(card.props.children).includes(defaultWorkspacePack.pack.metadata.name));
    expect(defaultCard).toBeDefined();
    expect(defaultCard!.findAll((node) => node.type === 'button' && /uninstall/i.test(JSON.stringify(node.props.children)))).toHaveLength(0);

    for (const color of Object.values(defaultWorkspacePack.pack.theme.colors)) {
      expect(color).toMatch(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/);
    }
    await act(async () => renderer.unmount());
  });

  // @spec AC-15 AC-20 EC-17 EC-21
  it('keeps malformed imports and invalid/cancelled forks atomic while showing legible feedback', async () => {
    const renderer = await renderSettings();
    const before = renderer.root.findAll((node) => node.props.className?.split(' ').includes('workspace-pack-card')).length;
    const input = renderer.root.findByProps({ type: 'file' });
    const currentTarget = { files: [{ text: async () => '{not-json' }], value: 'chosen.json' };
    await act(async () => input.props.onChange({ currentTarget }));
    expect(currentTarget.value).toBe('');
    expect(String(renderer.root.findByProps({ role: 'status' }).props.className ?? '')).toMatch(/workspace-pack-feedback/);
    expect(renderedText(renderer)).toMatch(/invalid|json|parse|could not/i);
    expect(renderer.root.findAll((node) => node.props.className?.split(' ').includes('workspace-pack-card'))).toHaveLength(before);

    const fork = renderer.root.findAll((node) => node.type === 'button' && /Fork with new identity/i.test(JSON.stringify(node.props.children)))[0]!;
    await act(async () => fork.props.onClick());
    expect(renderer.root.findByProps({ 'aria-label': 'Workspace Pack fork form' })).toBeDefined();
    const cancel = renderer.root.findAll((node) => node.type === 'button' && /Cancel fork/i.test(JSON.stringify(node.props.children)))[0]!;
    await act(async () => cancel.props.onClick());
    expect(renderer.root.findAllByProps({ 'aria-label': 'Workspace Pack fork form' })).toHaveLength(0);
    await act(async () => renderer.unmount());
  });
});
