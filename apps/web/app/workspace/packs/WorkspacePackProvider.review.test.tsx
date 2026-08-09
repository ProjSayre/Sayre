import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultWorkspacePack } from './builtins';
import { WorkspacePackProvider, useWorkspacePack } from './WorkspacePackProvider';

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
      innerWidth: 1280,
      localStorage: storage,
      removeEventListener: () => undefined,
      requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1; },
      setTimeout,
    },
  });
}

function restoreWindow(): void {
  if (originalWindow === undefined) delete (globalThis as { window?: Window }).window;
  else Object.defineProperty(globalThis, 'window', originalWindow);
}

afterEach(restoreWindow);

async function renderRuntime(storage: Storage) {
  installWindow(storage);
  let runtime: ReturnType<typeof useWorkspacePack> | null = null;
  function Probe() {
    runtime = useWorkspacePack();
    return <output>{runtime.error ?? runtime.experience.layout.id}</output>;
  }
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    renderer = TestRenderer.create(<WorkspacePackProvider><Probe /></WorkspacePackProvider>);
    await Promise.resolve();
  });
  return { renderer: renderer!, runtime: () => runtime! };
}

describe('WorkspacePackProvider review remediation', () => {
  // @spec AC-9 AC-10 EC-10
  it('reports quota failure, keeps a valid in-memory size, and retains the last committed size through collapse/restore', async () => {
    const storage = new FailableStorage();
    const { renderer, runtime } = await renderRuntime(storage);
    const region = runtime().experience.layout.regions.find((item) => item.id === 'region.explorer')!;
    const originalSize = region.size;

    storage.failNextWrite = true;
    await act(async () => runtime().setRegionSize(region.id, originalSize + 24));
    expect(runtime().error).toMatch(/quota exceeded/i);
    expect(runtime().experience.layout.regions.find((item) => item.id === region.id)?.size).toBe(originalSize);
    expect(runtime().store.preferences(runtime().activePackRef, `${runtime().experience.layout.id}:wide`)).toBeNull();

    await act(async () => runtime().setRegionSize(region.id, originalSize + 24));
    expect(runtime().experience.layout.regions.find((item) => item.id === region.id)?.size).toBe(originalSize + 24);
    await act(async () => runtime().setRegionCollapsed(region.id, true));
    expect(runtime().experience.layout.regions.find((item) => item.id === region.id)).toMatchObject({ collapsed: true, size: originalSize + 24 });
    await act(async () => runtime().setRegionCollapsed(region.id, false));
    expect(runtime().experience.layout.regions.find((item) => item.id === region.id)).toMatchObject({ collapsed: false, size: originalSize + 24 });
    await act(async () => renderer.unmount());
  });

  // @spec AC-10 EC-11
  it('ignores a rendered provider collapse request for a non-primary collapsible=false region', async () => {
    const storage = new FailableStorage();
    const setItem = vi.spyOn(storage, 'setItem');
    const { renderer, runtime } = await renderRuntime(storage);
    const fixedPack = structuredClone(defaultWorkspacePack.pack);
    fixedPack.metadata = { ...fixedPack.metadata, id: 'sayre.fixed-review', name: 'Fixed review pack', version: '1.0.0' };
    fixedPack.layouts[0]!.regions = fixedPack.layouts[0]!.regions.map((region) => region.id === 'region.explorer'
      ? { ...region, collapsible: false, defaultCollapsed: false }
      : region);
    expect(runtime().store.install(JSON.stringify(fixedPack)).ok).toBe(true);
    await act(async () => runtime().activatePack({ id: fixedPack.metadata.id, version: fixedPack.metadata.version }));
    const fixed = runtime().experience.layout.regions.find((item) => item.id === 'region.explorer')!;
    expect(fixed).toMatchObject({ slot: 'explorer', collapsible: false, collapsed: false });
    setItem.mockClear();
    await act(async () => runtime().setRegionCollapsed(fixed.id, true));
    expect(setItem).not.toHaveBeenCalled();
    expect(runtime().experience.layout.regions.find((item) => item.id === fixed.id)?.collapsed).toBe(false);
    await act(async () => renderer.unmount());
  });
});
