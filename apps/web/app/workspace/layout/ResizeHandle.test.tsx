import React, { type ComponentType } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResizeHandle } from './ResizeHandle';

(globalThis as unknown as { React: typeof React }).React = React;

const SpecResizeHandle = ResizeHandle as unknown as ComponentType<Record<string, unknown>>;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
let eventWindow: EventTarget;

function event(type: string, values: Record<string, number>): Event {
  const result = new Event(type);
  for (const [key, value] of Object.entries(values)) Object.defineProperty(result, key, { value });
  return result;
}

beforeEach(() => {
  eventWindow = new EventTarget();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: eventWindow,
  });
});

afterEach(() => {
  if (originalWindow === undefined) delete (globalThis as { window?: Window }).window;
  else Object.defineProperty(globalThis, 'window', originalWindow);
});

function renderHandle(overrides: Record<string, unknown> = {}) {
  const onPreview = vi.fn();
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  const onCollapse = vi.fn();
  const onExpand = vi.fn();
  const renderer = TestRenderer.create(
    <SpecResizeHandle
      regionId="region.explorer"
      axis="horizontal"
      edge="inline-end"
      value={200}
      minimum={160}
      maximum={240}
      collapsible
      collapsed={false}
      onPreview={onPreview}
      onCommit={onCommit}
      onCancel={onCancel}
      onCollapse={onCollapse}
      onExpand={onExpand}
      /* Compatibility input lets the pre-contract implementation expose its preview calls. */
      onChange={onPreview}
      {...overrides}
    />,
  );
  return { renderer, separator: renderer.root.findByProps({ role: 'separator' }), onPreview, onCommit, onCancel, onCollapse, onExpand };
}

describe('ResizeHandle transaction and edge contract', () => {
  // @spec AC-8 AC-9 EC-8 EC-9
  it('previews clamped pointer movement and commits the final value exactly once', async () => {
    const handle = renderHandle();
    await act(async () => handle.separator.props.onPointerDown({
      clientX: 100,
      clientY: 0,
      pointerId: 7,
      currentTarget: { setPointerCapture: vi.fn() },
    }));
    await act(async () => { eventWindow.dispatchEvent(event('pointermove', { clientX: 300, clientY: 0, pointerId: 7 })); });
    await act(async () => { eventWindow.dispatchEvent(event('pointermove', { clientX: 132, clientY: 0, pointerId: 7 })); });
    await act(async () => { eventWindow.dispatchEvent(event('pointerup', { clientX: 132, clientY: 0, pointerId: 7 })); });

    expect(handle.onPreview.mock.calls.map(([value]) => value)).toEqual([240, 232]);
    expect(handle.onCommit).toHaveBeenCalledTimes(1);
    expect(handle.onCommit).toHaveBeenCalledWith(232);
    expect(handle.onCancel).not.toHaveBeenCalled();
    handle.renderer.unmount();
  });

  // @spec AC-8 EC-8
  it('uses the inverse signed delta for an inspector inline-start edge', async () => {
    const handle = renderHandle({ edge: 'inline-start', regionId: 'region.inspector', value: 200, minimum: 100, maximum: 400 });
    await act(async () => handle.separator.props.onPointerDown({
      clientX: 300,
      clientY: 0,
      pointerId: 2,
      currentTarget: { setPointerCapture: vi.fn() },
    }));
    await act(async () => { eventWindow.dispatchEvent(event('pointermove', { clientX: 260, clientY: 0, pointerId: 2 })); });
    expect(handle.onPreview).toHaveBeenLastCalledWith(240);
    handle.renderer.unmount();
  });

  // @spec AC-9 EC-9
  it.each(['pointercancel', 'lost-capture', 'blur', 'escape', 'unmount'])('cancels a %s preview without committing', async (reason) => {
    const handle = renderHandle();
    await act(async () => handle.separator.props.onPointerDown({
      clientX: 10,
      clientY: 0,
      pointerId: 4,
      currentTarget: { setPointerCapture: vi.fn() },
    }));
    await act(async () => { eventWindow.dispatchEvent(event('pointermove', { clientX: 35, clientY: 0, pointerId: 4 })); });
    if (reason === 'pointercancel') await act(async () => { eventWindow.dispatchEvent(event('pointercancel', { clientX: 35, clientY: 0, pointerId: 4 })); });
    if (reason === 'lost-capture') await act(async () => handle.separator.props.onLostPointerCapture());
    if (reason === 'blur') await act(async () => { eventWindow.dispatchEvent(new Event('blur')); });
    if (reason === 'escape') await act(async () => handle.separator.props.onKeyDown({ key: 'Escape', preventDefault: vi.fn() }));
    if (reason === 'unmount') await act(async () => handle.renderer.unmount());

    expect(handle.onCommit).not.toHaveBeenCalled();
    expect(handle.onCancel).toHaveBeenCalledTimes(1);
    if (reason !== 'unmount') handle.renderer.unmount();
  });

  // @spec AC-9 AC-10 EC-11
  it('commits keyboard values and gates Enter collapse by collapsibility', async () => {
    const fixed = renderHandle({ collapsible: false });
    await act(async () => fixed.separator.props.onKeyDown({ key: 'End', preventDefault: vi.fn(), shiftKey: false }));
    await act(async () => fixed.separator.props.onKeyDown({ key: 'Enter', preventDefault: vi.fn(), shiftKey: false }));
    expect(fixed.onPreview).toHaveBeenCalledWith(240);
    expect(fixed.onCommit).toHaveBeenCalledWith(240);
    expect(fixed.onCollapse).not.toHaveBeenCalled();
    fixed.renderer.unmount();
  });
});
