import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from 'vitest';
import { MockProvider, useWorkspaceFixture, type MockState } from '../state';
import { WorkspaceShell } from './WorkspaceShell';

(globalThis as unknown as { React: typeof React }).React = React;

interface ControlMock {
  readonly label: string;
  readonly dataset: Record<string, string>;
  readonly ownerDocument: InteractionDocument;
  focus: Mock;
  setPointerCapture: Mock;
  releasePointerCapture: Mock;
  hasPointerCapture: Mock;
  closest(selector: string): ControlMock | null;
  contains(node: unknown): boolean;
  querySelector(): ControlMock | null;
  querySelectorAll(): ControlMock[];
  getBoundingClientRect(): { width: number; height: number; left: number; top: number; right: number; bottom: number };
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

class InteractionDocument extends EventTarget {
  activeElement: ControlMock | null = null;
  controls: Map<string, ControlMock> | null = null;
  elementFromPoint(): ControlMock | null { return null; }
  querySelector(selector: string): ControlMock | null {
    return selector === '[aria-label="Workspace controls"]'
      ? this.controls?.get('Workspace controls') ?? null
      : null;
  }
}

class InteractionWindow extends EventTarget {
  readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  readonly innerWidth = 1280;
  readonly localStorage: Storage;
  readonly sessionStorage: Storage;
  readonly location = { search: '' };

  constructor(storage: Storage) {
    super();
    this.localStorage = storage;
    this.sessionStorage = new MemoryStorage();
  }

  setTimeout = setTimeout;
  clearTimeout = clearTimeout;
  requestAnimationFrame = (callback: FrameRequestCallback): number => { callback(0); return 1; };
  cancelAnimationFrame = (): void => undefined;
  matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true,
  });

  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (listener !== null) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }
    super.addEventListener(type, listener);
  }

  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (listener !== null) this.listeners.get(type)?.delete(listener);
    super.removeEventListener(type, listener);
  }

  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

type BlockCase = {
  readonly label: string;
  readonly patch: Partial<MockState>;
  readonly marker: { readonly name: string; readonly value: string };
  readonly input: 'pointer' | 'keyboard';
  readonly announcement: RegExp;
};

const BLOCK_CASES: readonly BlockCase[] = [
  { label: 'signed out', patch: { session: 'signed-out' }, marker: { name: 'data-global-state', value: 'signed-out' }, input: 'pointer', announcement: /session changed/i },
  { label: 'expired session', patch: { session: 'session-expired' }, marker: { name: 'data-global-state', value: 'session-expired' }, input: 'keyboard', announcement: /session changed/i },
  { label: 'backend unavailable', patch: { backend: 'unavailable' }, marker: { name: 'data-global-state', value: 'backend-unavailable' }, input: 'pointer', announcement: /service became unavailable/i },
  { label: 'organization forbidden', patch: { access: 'forbidden' }, marker: { name: 'data-global-state', value: 'organization-forbidden' }, input: 'keyboard', announcement: /organization access changed/i },
  { label: 'repository forbidden', patch: { access: 'repository-restricted' }, marker: { name: 'data-canvas-state', value: 'repository-forbidden' }, input: 'pointer', announcement: /repository access changed/i },
];

describe('Workspace system interruption review remediation', () => {
  let originalWindow: PropertyDescriptor | undefined;
  let originalDocument: PropertyDescriptor | undefined;
  let interactionWindow: InteractionWindow;
  let interactionDocument: InteractionDocument;
  let storage: MemoryStorage;
  let storageWrite: MockInstance<(key: string, value: string) => void>;
  let controls: Map<string, ControlMock>;
  let fixture: NonNullable<ReturnType<typeof useWorkspaceFixture>> | null;
  let renderer: TestRenderer.ReactTestRenderer | null;

  function FixtureProbe() {
    fixture = useWorkspaceFixture();
    return null;
  }

  const createNodeMock = (element: React.ReactElement): ControlMock => {
    const label = String(element.props['aria-label'] ?? element.props.children ?? element.type);
    const dataset: Record<string, string> = {};
    if (element.props['data-workspace-drop-slot'] !== undefined) dataset.workspaceDropSlot = String(element.props['data-workspace-drop-slot']);
    if (element.props['data-workspace-drop-order'] !== undefined) dataset.workspaceDropOrder = String(element.props['data-workspace-drop-order']);
    const control: ControlMock = {
      label,
      dataset,
      ownerDocument: interactionDocument,
      focus: vi.fn(() => { interactionDocument.activeElement = control; }),
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
      closest: vi.fn((selector: string) => selector.includes('data-workspace-drop-slot') && dataset.workspaceDropSlot !== undefined ? control : null),
      contains: vi.fn((node: unknown) => node === control),
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn(() => []),
      getBoundingClientRect: vi.fn(() => ({ width: 880, height: 600, left: 0, top: 0, right: 880, bottom: 600 })),
    };
    if (element.type === 'button') controls.set(label, control);
    return control;
  };

  async function openEditor(): Promise<void> {
    const trigger = renderer!.root.findByProps({ 'data-workspace-recovery-trigger': 'true' });
    await act(async () => trigger.props.onClick());
    const open = renderer!.root.findByProps({ 'data-workspace-recovery-action': 'open-editor' });
    await act(async () => open.props.onClick());
    expect(renderer!.root.findByProps({ 'aria-label': 'Layout Edit Mode' })).toBeDefined();
  }

  beforeEach(async () => {
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    storage = new MemoryStorage();
    storageWrite = vi.spyOn(storage, 'setItem');
    interactionWindow = new InteractionWindow(storage);
    interactionDocument = new InteractionDocument();
    controls = new Map();
    interactionDocument.controls = controls;
    fixture = null;
    renderer = null;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: interactionWindow });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: interactionDocument });
    await act(async () => {
      renderer = TestRenderer.create(
        <MockProvider>
          <WorkspaceShell />
          <FixtureProbe />
        </MockProvider>,
        { createNodeMock },
      );
      await Promise.resolve();
      fixture!.patch({ canvasData: 'loading' });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  });

  afterEach(async () => {
    if (renderer !== null) await act(async () => renderer!.unmount());
    if (originalWindow === undefined) delete (globalThis as { window?: Window }).window;
    else Object.defineProperty(globalThis, 'window', originalWindow);
    if (originalDocument === undefined) delete (globalThis as { document?: Document }).document;
    else Object.defineProperty(globalThis, 'document', originalDocument);
    vi.restoreAllMocks();
  });

  // @spec AC-18 EC-23
  it.each(BLOCK_CASES)('synchronously cancels a rendered $input edit interaction when $label', async ({ patch, marker, input, announcement }) => {
    await openEditor();
    const range = renderer!.root.findAll((node) => node.type === 'input' && node.props.type === 'range')[0]!;
    await act(async () => range.props.onChange({ currentTarget: { value: String(Number(range.props.value) + 8) } }));
    const handle = renderer!.root.findByProps({ 'aria-label': 'Move region.explorer' });
    const sourceControl = controls.get('Move region.explorer')!;
    await act(async () => {
      if (input === 'pointer') handle.props.onPointerDown({ pointerId: 73, pointerType: 'mouse', currentTarget: sourceControl });
      else handle.props.onKeyDown({ key: ' ', preventDefault: vi.fn() });
    });
    expect(renderer!.root.findAll((node) => node.props['data-workspace-drop-slot'] !== undefined).length).toBeGreaterThan(0);
    expect(interactionWindow.count('keydown')).toBe(1);
    expect(interactionWindow.count('blur')).toBe(1);
    if (input === 'pointer') expect(interactionWindow.count('pointermove')).toBe(1);
    storageWrite.mockClear();

    await act(async () => fixture!.patch(patch));

    expect(renderer!.root.findByProps({ [marker.name]: marker.value })).toBeDefined();
    expect(renderer!.root.findAllByProps({ 'aria-label': 'Layout Edit Mode' })).toHaveLength(0);
    expect(renderer!.root.findAll((node) => node.props['data-workspace-drop-slot'] !== undefined)).toHaveLength(0);
    expect(renderer!.root.findAll((node) => node.props['data-workspace-dock'] !== undefined)).toHaveLength(0);
    expect(renderer!.root.findAll((node) => typeof node.props.className === 'string' && node.props.className.includes('react-flow__node'))).toHaveLength(0);
    expect(renderer!.root.findByProps({ 'data-workspace-interruption-status': 'true' }).props.children).toMatch(announcement);
    expect(interactionWindow.count('pointermove')).toBe(0);
    expect(interactionWindow.count('pointerup')).toBe(0);
    expect(interactionWindow.count('keydown')).toBe(0);
    expect(interactionWindow.count('blur')).toBe(0);
    if (input === 'pointer') expect(sourceControl.releasePointerCapture).toHaveBeenCalledWith(73);
    expect(storageWrite).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer!.toJSON())).not.toMatch(/Moved region\.explorer/i);

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1)); });
    expect(interactionDocument.activeElement?.label).toBe('Workspace controls');
    const recoveryTrigger = renderer!.root.findByProps({ 'data-workspace-recovery-trigger': 'true' });
    await act(async () => recoveryTrigger.props.onClick());
    expect(renderer!.root.findAllByProps({ 'data-workspace-recovery-action': 'open-editor' })).toHaveLength(0);
    await act(async () => recoveryTrigger.props.onClick());

    await act(async () => fixture!.patch({ session: 'authenticated', backend: 'available', access: 'authorized' }));
    await openEditor();
    const undo = renderer!.root.findAll((node) => node.type === 'button' && node.props.children === 'Undo')[0]!;
    expect(undo.props.disabled).toBe(true);
  });
});
