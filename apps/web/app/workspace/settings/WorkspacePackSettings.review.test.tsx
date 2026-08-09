import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultWorkspacePack } from '../packs/builtins';
import { WorkspacePackProvider } from '../packs/WorkspacePackProvider';
import { WorkspacePackSettings } from './WorkspacePackSettings';

(globalThis as unknown as { React: typeof React }).React = React;

class FailableStorage implements Storage {
  private readonly values = new Map<string, string>();
  failNextWrite = false;
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('quota exceeded');
    }
    this.values.set(key, value);
  }
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

function installWindow(storage: Storage): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      addEventListener: () => undefined,
      innerWidth: 320,
      localStorage: storage,
      removeEventListener: () => undefined,
    },
  });
}

function restoreWindow(): void {
  if (originalWindow === undefined) delete (globalThis as { window?: Window }).window;
  else Object.defineProperty(globalThis, 'window', originalWindow);
}

afterEach(restoreWindow);

async function renderSettings(storage = new FailableStorage()) {
  installWindow(storage);
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    renderer = TestRenderer.create(<WorkspacePackProvider><WorkspacePackSettings /></WorkspacePackProvider>);
    await Promise.resolve();
  });
  return { renderer: renderer!, storage };
}

function cards(renderer: TestRenderer.ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAll((node) => typeof node.props['data-pack-name'] === 'string');
}

function feedback(renderer: TestRenderer.ReactTestRenderer): string {
  return JSON.stringify(renderer.root.findByProps({ role: 'status' }).props.children);
}

async function importJson(renderer: TestRenderer.ReactTestRenderer, raw: string): Promise<void> {
  const input = renderer.root.findByProps({ type: 'file' });
  const currentTarget = { files: [{ text: async () => raw }], value: 'review.workspace.json' };
  await act(async () => input.props.onChange({ currentTarget }));
  expect(currentTarget.value).toBe('');
}

describe('Workspace Pack settings review remediation', () => {
  // @spec AC-15 AC-20 EC-17
  it('renders atomic feedback for duplicate, incompatible, and oversized imports', async () => {
    const { renderer } = await renderSettings();
    const originalCount = cards(renderer).length;

    await importJson(renderer, JSON.stringify(defaultWorkspacePack.pack));
    expect(feedback(renderer)).toMatch(/built-in packs cannot be shadowed/i);
    expect(cards(renderer)).toHaveLength(originalCount);

    const incompatible = structuredClone(defaultWorkspacePack.pack);
    incompatible.metadata = { ...incompatible.metadata, id: 'sayre.incompatible-review', name: 'Incompatible review' };
    incompatible.compatibility = { ...incompatible.compatibility, minimumRuntimeContractVersion: 999 };
    await importJson(renderer, JSON.stringify(incompatible));
    expect(feedback(renderer)).toMatch(/runtime contract|runtime.*outside/i);
    expect(cards(renderer)).toHaveLength(originalCount);

    const oversized = structuredClone(defaultWorkspacePack.pack);
    oversized.metadata = { ...oversized.metadata, id: 'sayre.oversized-review' };
    const oversizedJson = JSON.stringify({ ...oversized, padding: 'x'.repeat(270_000) });
    await importJson(renderer, oversizedJson);
    expect(feedback(renderer)).toMatch(/exceeds 256 KiB/i);
    expect(cards(renderer)).toHaveLength(originalCount);

    const first = structuredClone(defaultWorkspacePack.pack);
    first.metadata = { ...first.metadata, id: 'sayre.duplicate-review', name: 'Duplicate review' };
    await importJson(renderer, JSON.stringify(first));
    expect(cards(renderer)).toHaveLength(originalCount + 1);
    const conflicting = structuredClone(first);
    conflicting.metadata.description = 'Different content under the same exact identity.';
    await importJson(renderer, JSON.stringify(conflicting));
    expect(feedback(renderer)).toMatch(/same ID\/version has different content/i);
    expect(cards(renderer)).toHaveLength(originalCount + 1);
    await act(async () => renderer.unmount());
  });

  // @spec AC-15 AC-20 EC-17 EC-21
  it('keeps invalid and storage-failed fork materialization rendered, legible, and atomic', async () => {
    const storage = new FailableStorage();
    const { renderer } = await renderSettings(storage);
    const originalCount = cards(renderer).length;
    const fork = renderer.root.findAll((node) => node.type === 'button' && /Fork with new identity/i.test(String(node.props.children)))[0]!;
    await act(async () => fork.props.onClick());
    const form = renderer.root.findByProps({ 'aria-label': 'Workspace Pack fork form' });
    const inputs = form.findAllByType('input');
    await act(async () => inputs[0]!.props.onChange({ currentTarget: { value: 'INVALID ID' } }));
    const create = form.find((node) => node.type === 'button' && /Create fork/i.test(String(node.props.children)));
    await act(async () => create.props.onClick());
    expect(feedback(renderer)).toMatch(/identifier|pack.*id|invalid/i);
    expect(cards(renderer)).toHaveLength(originalCount);
    expect(renderer.root.findByProps({ 'aria-label': 'Workspace Pack fork form' })).toBeDefined();

    const values = ['sayre.review-fork', 'A reusable review fork', '1.0.0', 'Review member'];
    for (const [index, value] of values.entries()) {
      await act(async () => inputs[index]!.props.onChange({ currentTarget: { value } }));
    }
    storage.failNextWrite = true;
    await act(async () => create.props.onClick());
    expect(feedback(renderer)).toMatch(/quota exceeded/i);
    expect(cards(renderer)).toHaveLength(originalCount);
    expect(renderer.root.findByProps({ 'aria-label': 'Workspace Pack fork form' })).toBeDefined();
    await act(async () => renderer.unmount());
  });
});
