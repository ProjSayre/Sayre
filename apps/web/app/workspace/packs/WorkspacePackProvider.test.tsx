import React from 'react';
import { renderToString } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspacePackProvider, useWorkspacePack } from './WorkspacePackProvider';

(globalThis as unknown as { React: typeof React }).React = React;

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
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
    },
  });
}

function removeWindow(): void {
  if (originalWindow === undefined) delete (globalThis as { window?: Window }).window;
  else Object.defineProperty(globalThis, 'window', originalWindow);
}

function Probe() {
  const pack = useWorkspacePack();
  return <output>{pack.error ?? `ready:${pack.activePackRef.id}`}</output>;
}

afterEach(removeWindow);

describe('WorkspacePackProvider hydration', () => {
  // @spec AC-20 EC-16
  it('renders the same server and first-client recovery state before storage hydration', () => {
    removeWindow();
    const server = renderToString(<WorkspacePackProvider><Probe /></WorkspacePackProvider>);
    installWindow(new MemoryStorage());
    const firstClient = renderToString(<WorkspacePackProvider><Probe /></WorkspacePackProvider>);
    expect(firstClient).toBe(server);
    expect(server).toContain('ready:sayre.default');
  });

  // @spec AC-9 AC-10 EC-10 EC-11
  it('persists a committed size once and rejects primary/non-collapsible collapse requests', async () => {
    const storage = new MemoryStorage();
    const setItem = vi.spyOn(storage, 'setItem');
    installWindow(storage);
    let runtime: ReturnType<typeof useWorkspacePack> | null = null;
    function RuntimeProbe() {
      runtime = useWorkspacePack();
      return <output>{runtime.error ?? runtime.experience.layout.id}</output>;
    }
    let renderer: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      renderer = TestRenderer.create(<WorkspacePackProvider><RuntimeProbe /></WorkspacePackProvider>);
      await Promise.resolve();
    });
    setItem.mockClear();
    const primary = runtime!.experience.layout.regions.find((region) => region.slot === 'primary')!;
    await act(async () => runtime!.setRegionCollapsed(primary.id, true));
    expect(setItem).not.toHaveBeenCalled();
    expect(runtime!.experience.layout.regions.find((region) => region.id === primary.id)?.collapsed).toBe(false);

    const resizable = runtime!.experience.layout.regions.find((region) => region.resize !== 'none' && region.slot !== 'primary')!;
    await act(async () => runtime!.setRegionSize(resizable.id, resizable.minimumSize + 12));
    expect(setItem).toHaveBeenCalledTimes(1);
    await act(async () => renderer!.unmount());
  });
});
