import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { WorkspacePackDocument } from '../../../../../packages/workspace-packs/src/runtime';
import { defaultWorkspacePack } from '../packs/builtins';
import { workspaceComponentCatalog } from '../packs/runtimeCatalog';
import { ComponentPalette } from './ComponentPalette';
import { LayoutEditMode } from './LayoutEditMode';

const hookState = vi.hoisted(() => ({
  editor: null as unknown,
  pack: null as unknown,
  navigation: null as unknown,
  selection: null as unknown,
}));

vi.mock('./WorkspaceEditorProvider', () => ({
  useWorkspaceEditor: () => hookState.editor,
}));

vi.mock('../packs/WorkspacePackProvider', () => ({
  useWorkspacePack: () => hookState.pack,
}));

vi.mock('../state', () => ({
  useWorkspaceNavigation: () => hookState.navigation,
  useWorkspaceSelection: () => hookState.selection,
}));

(globalThis as unknown as { React: typeof React }).React = React;

interface ControlMock {
  readonly label: string;
  readonly dataset: Record<string, string>;
  focus: Mock;
  setPointerCapture: Mock;
  releasePointerCapture: Mock;
  hasPointerCapture: Mock;
  closest(selector: string): ControlMock | null;
}

class InteractionWindow extends EventTarget {
  readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

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

function interactionEvent(type: string, values: Record<string, unknown>): Event {
  const event = new Event(type, { bubbles: true });
  Object.entries(values).forEach(([key, value]) => Object.defineProperty(event, key, { configurable: true, value }));
  return event;
}

function clonePack(): WorkspacePackDocument {
  return structuredClone(defaultWorkspacePack.pack);
}

function editorValue(pack: WorkspacePackDocument) {
  const apply = vi.fn(() => true);
  return {
    editing: true,
    previewPack: pack,
    draft: { basePack: clonePack() },
    violations: [],
    canUndo: false,
    canRedo: false,
    dirty: false,
    apply,
    undo: vi.fn(),
    redo: vi.fn(),
    savePersonal: vi.fn(),
    discard: vi.fn(),
    materializeFork: vi.fn(),
    interruptionAnnouncement: '',
    registerInteractionCancellation: vi.fn(() => () => undefined),
    interruptForSystemState: vi.fn(),
  };
}

function packValue() {
  return {
    activePackRef: structuredClone(defaultWorkspacePack.ref),
    viewportClass: 'wide',
    role: 'member',
    availableCapabilities: workspaceComponentCatalog.capabilities.map((capability) => capability.id),
  };
}

describe('Layout Edit Mode review remediation', () => {
  let interactionWindow: InteractionWindow;
  let pointTarget: ControlMock | null;
  let activeFocus: string | null;
  let controls: Map<string, ControlMock>;
  let renderer: TestRenderer.ReactTestRenderer;
  let originalWindow: typeof globalThis.window | undefined;
  let originalDocument: typeof globalThis.document | undefined;

  const renderEditor = () => <LayoutEditMode><div>Live workspace preview</div></LayoutEditMode>;

  const createNodeMock = (element: React.ReactElement): ControlMock | null => {
    if (element.type !== 'button') return null;
    const label = String(element.props['aria-label'] ?? element.props.children ?? 'button');
    const dataset: Record<string, string> = {};
    if (element.props['data-workspace-drop-slot'] !== undefined) dataset.workspaceDropSlot = String(element.props['data-workspace-drop-slot']);
    if (element.props['data-workspace-drop-order'] !== undefined) dataset.workspaceDropOrder = String(element.props['data-workspace-drop-order']);
    const control: ControlMock = {
      label,
      dataset,
      focus: vi.fn(() => { activeFocus = label; }),
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
      closest: vi.fn((selector: string) => selector.includes('data-workspace-drop-slot') && dataset.workspaceDropSlot !== undefined ? control : null),
    };
    controls.set(label, control);
    return control;
  };

  const mount = async () => {
    const pack = clonePack();
    hookState.editor = editorValue(pack);
    hookState.pack = packValue();
    hookState.navigation = { viewId: 'technical' };
    hookState.selection = { closeInspector: vi.fn() };
    await act(async () => {
      renderer = TestRenderer.create(renderEditor(), { createNodeMock });
    });
  };

  const moveHandle = () => renderer.root.findByProps({ 'aria-label': 'Move region.explorer' });

  const pickUp = async (pointerId = 17, pointerType = 'mouse') => {
    const handle = moveHandle();
    const control = controls.get('Move region.explorer')!;
    await act(async () => {
      handle.props.onPointerDown({ pointerId, pointerType, currentTarget: control });
    });
    return { handle, control };
  };

  const waitForFocus = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    });
  };

  const expectCancelled = (reason: RegExp) => {
    expect(JSON.stringify(renderer.toJSON())).toMatch(reason);
    expect(renderer.root.findAll((node) => node.type === 'button' && node.props['data-workspace-drop-slot'] !== undefined)).toHaveLength(0);
    expect((hookState.editor as ReturnType<typeof editorValue>).apply).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    interactionWindow = new InteractionWindow();
    pointTarget = null;
    activeFocus = null;
    controls = new Map();
    Object.defineProperty(globalThis, 'window', { configurable: true, value: interactionWindow });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        elementFromPoint: () => pointTarget,
        querySelector: () => null,
      },
    });
  });

  afterEach(async () => {
    if (renderer !== undefined) await act(async () => renderer.unmount());
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
    vi.restoreAllMocks();
  });

  // @spec AC-18 EC-18
  it.each(['mouse', 'touch'])('commits a rendered %s pointer drag through the semantic operation path', async (pointerType) => {
    await mount();
    const { control } = await pickUp(19, pointerType);
    const target = renderer.root.findAll((node) => node.type === 'button' && node.props['data-workspace-drop-slot'] === 'navigation')[0]!;
    pointTarget = target.instance as ControlMock;
    expect(pointTarget.dataset).toMatchObject({ workspaceDropSlot: 'navigation', workspaceDropOrder: '0' });
    await act(async () => {
      interactionWindow.dispatchEvent(interactionEvent('pointermove', { pointerId: 19, pointerType, clientX: 40, clientY: 40 }));
      interactionWindow.dispatchEvent(interactionEvent('pointerup', { pointerId: 19, pointerType, clientX: 40, clientY: 40 }));
    });
    expect((hookState.editor as ReturnType<typeof editorValue>).apply).toHaveBeenCalledWith(expect.objectContaining({
      type: 'move-region', regionId: 'region.explorer', slot: 'navigation', order: 0,
    }));
    expect(JSON.stringify(renderer.toJSON())).toMatch(/Moved region\.explorer to navigation position 1/i);
    expect(control.releasePointerCapture).toHaveBeenCalledWith(19);
    await waitForFocus();
    expect(activeFocus).toBe('Move region.explorer');
  });

  // @spec AC-18 EC-19
  it.each([
    ['pointer cancellation', 'pointercancel', /pointer capture was lost/i],
    ['outside touch release', 'outside', /released outside a compatible target/i],
    ['Escape', 'escape', /cancelled with Escape/i],
    ['lost capture', 'lostcapture', /pointer capture was lost/i],
  ])('cancels a rendered %s, releases capture, removes listeners/targets, and restores focus', async (_label, action, reason) => {
    await mount();
    const { handle, control } = await pickUp(23, action === 'outside' ? 'touch' : 'mouse');
    expect(interactionWindow.count('pointermove')).toBe(1);
    await act(async () => {
      if (action === 'pointercancel') interactionWindow.dispatchEvent(interactionEvent('pointercancel', { pointerId: 23 }));
      else if (action === 'outside') interactionWindow.dispatchEvent(interactionEvent('pointerup', { pointerId: 23, pointerType: 'touch', clientX: -1, clientY: -1 }));
      else if (action === 'escape') interactionWindow.dispatchEvent(interactionEvent('keydown', { key: 'Escape' }));
      else handle.props.onLostPointerCapture({ pointerId: 23 });
    });
    expectCancelled(reason);
    expect(control.releasePointerCapture).toHaveBeenCalledWith(23);
    expect(interactionWindow.count('pointermove')).toBe(0);
    expect(interactionWindow.count('pointerup')).toBe(0);
    await waitForFocus();
    expect(activeFocus).toBe('Move region.explorer');
  });

  // @spec AC-18 EC-19
  it('reconciles a rendered source unmount without mutation and focuses its surviving restore control', async () => {
    await mount();
    await pickUp();
    const next = structuredClone((hookState.editor as ReturnType<typeof editorValue>).previewPack);
    next.layouts[0]!.regions.find((region) => region.id === 'region.explorer')!.hidden = true;
    (hookState.editor as ReturnType<typeof editorValue>).previewPack = next;
    await act(async () => renderer.update(renderEditor()));
    expectCancelled(/source region is no longer available/i);
    await waitForFocus();
    expect(activeFocus).toMatch(/Restore.*region\.explorer/);
  });

  // @spec AC-18 EC-19
  it('reconciles a source removed from the rendered layout and focuses the stable Discard fallback', async () => {
    await mount();
    await pickUp();
    const next = structuredClone((hookState.editor as ReturnType<typeof editorValue>).previewPack);
    next.layouts[0]!.regions = next.layouts[0]!.regions.filter((region) => region.id !== 'region.explorer');
    (hookState.editor as ReturnType<typeof editorValue>).previewPack = next;
    await act(async () => renderer.update(renderEditor()));
    expectCancelled(/source region is no longer available/i);
    await waitForFocus();
    expect(activeFocus).toBe('Discard');
  });

  // @spec AC-18 EC-19
  it.each([
    ['current view', 'view', /active workspace view changed/i],
    ['default view', 'defaultView', /active workspace view changed/i],
    ['viewport', 'viewport', /workspace viewport changed/i],
    ['pack', 'pack', /active workspace pack changed/i],
    ['layout', 'layout', /active workspace layout changed/i],
    ['role', 'role', /workspace role changed/i],
    ['capabilities', 'capabilities', /workspace capabilities changed/i],
  ])('cancels without mutation and restores focus when the rendered %s scope changes', async (_label, change, reason) => {
    await mount();
    await pickUp();
    if (change === 'view') (hookState.navigation as { viewId: string }).viewId = 'product';
    if (change === 'viewport') (hookState.pack as ReturnType<typeof packValue>).viewportClass = 'compact';
    if (change === 'pack') (hookState.pack as ReturnType<typeof packValue>).activePackRef = { id: 'sayre.pitch', version: '1.0.0' };
    if (change === 'role') (hookState.pack as ReturnType<typeof packValue>).role = 'admin';
    if (change === 'capabilities') (hookState.pack as ReturnType<typeof packValue>).availableCapabilities = ['sayre.technical'];
    if (change === 'defaultView') {
      const next = structuredClone((hookState.editor as ReturnType<typeof editorValue>).previewPack);
      next.defaultViewId = 'product';
      (hookState.editor as ReturnType<typeof editorValue>).previewPack = next;
    }
    if (change === 'layout') {
      const current = structuredClone((hookState.editor as ReturnType<typeof editorValue>).previewPack);
      const next: WorkspacePackDocument = {
        ...current,
        layouts: [...current.layouts, { ...structuredClone(current.layouts[0]!), id: 'layout.alternate' }],
      };
      next.defaultLayoutId = 'layout.alternate';
      (hookState.editor as ReturnType<typeof editorValue>).previewPack = next;
    }
    await act(async () => renderer.update(renderEditor()));
    expectCancelled(reason);
    await waitForFocus();
    expect(activeFocus).toBe('Move region.explorer');
  });

  // @spec AC-18 EC-19
  it('cancels when the rendered active target becomes incompatible and leaves no operation behind', async () => {
    await mount();
    await pickUp();
    const target = renderer.root.findAll((node) => node.type === 'button' && node.props['data-workspace-drop-slot'] === 'navigation')[0]!;
    await act(async () => target.props.onFocus());
    const next = structuredClone((hookState.editor as ReturnType<typeof editorValue>).previewPack);
    next.layouts[0]!.regions.find((region) => region.id === 'region.explorer')!.component = { id: 'sayre.inspector', version: 1 };
    (hookState.editor as ReturnType<typeof editorValue>).previewPack = next;
    await act(async () => renderer.update(renderEditor()));
    expectCancelled(/selected drop target is no longer compatible/i);
    await waitForFocus();
    expect(activeFocus).toBe('Move region.explorer');
  });

  // @spec AC-17 EC-18
  it('filters rendered replacement choices by slot, role, capabilities, current component, and search', async () => {
    const catalog = {
      runtimeContractVersion: 1 as const,
      capabilities: [{ id: 'cap.extra', version: 1 }],
      components: [
        { id: 'component.current', version: 1, allowedSlots: ['inspector'] as const, requiredCapabilities: [], minimumRole: 'member' as const },
        { id: 'component.member', version: 1, allowedSlots: ['inspector'] as const, requiredCapabilities: [], minimumRole: 'member' as const },
        { id: 'component.admin', version: 1, allowedSlots: ['inspector'] as const, requiredCapabilities: [], minimumRole: 'admin' as const },
        { id: 'component.capability', version: 1, allowedSlots: ['inspector'] as const, requiredCapabilities: ['cap.extra'], minimumRole: 'member' as const },
        { id: 'component.wrong-slot', version: 1, allowedSlots: ['explorer'] as const, requiredCapabilities: [], minimumRole: 'member' as const },
      ],
    };
    let palette: TestRenderer.ReactTestRenderer;
    await act(async () => {
      palette = TestRenderer.create(
        <ComponentPalette
          catalog={catalog}
          slot="inspector"
          role="member"
          capabilities={[]}
          current={{ id: 'component.current', version: 1 }}
          onChoose={vi.fn()}
        />,
      );
    });
    expect(JSON.stringify(palette!.toJSON())).toContain('component.member');
    expect(JSON.stringify(palette!.toJSON())).not.toMatch(/component\.(current|admin|capability|wrong-slot)/);
    await act(async () => palette!.update(
      <ComponentPalette
        catalog={catalog}
        slot="inspector"
        role="admin"
        capabilities={['cap.extra']}
        current={{ id: 'component.current', version: 1 }}
        onChoose={vi.fn()}
      />,
    ));
    expect(JSON.stringify(palette!.toJSON())).toMatch(/component\.member.*component\.admin.*component\.capability/);
    const search = palette!.root.findByType('input');
    await act(async () => search.props.onChange({ currentTarget: { value: 'no-match' } }));
    expect(JSON.stringify(palette!.toJSON())).toMatch(/No compatible alternatives match this search/i);
    await act(async () => palette!.unmount());
  });
});
