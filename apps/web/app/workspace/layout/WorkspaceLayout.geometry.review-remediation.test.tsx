import { readFileSync } from 'node:fs';
import React from 'react';
import postcss, { type Root } from 'postcss';
import TestRenderer, { type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import type { ResolvedWorkspaceLayout } from '../../../../../packages/workspace-packs/src/runtime';
import { WorkspaceLayout } from './WorkspaceLayout';

(globalThis as unknown as { React: typeof React }).React = React;

type Slot = 'top' | 'bottom' | 'navigation' | 'explorer' | 'primary' | 'inspector' | 'overlay';
type Axis = 'horizontal' | 'vertical' | 'none';
type Edge = 'inline-start' | 'inline-end' | 'block-start' | 'block-end';

interface RegionInput {
  id: string;
  slot: Slot;
  order?: number;
  resize?: Axis;
  size?: number;
}

interface FlowRectangle {
  id: string;
  start: number;
  end: number;
}

const css = postcss.parse(readFileSync(new URL('./workspace-layout.css', import.meta.url), 'utf8'));

function declarations(root: Root, selector: string): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  root.walkRules((rule) => {
    if (!rule.selectors.includes(selector)) return;
    rule.walkDecls((declaration) => {
      result.set(declaration.prop, declaration.value);
    });
  });
  return result;
}

function pixels(value: unknown): number {
  expect(typeof value).toBe('string');
  const parsed = Number.parseFloat(value as string);
  expect(Number.isFinite(parsed)).toBe(true);
  return parsed;
}

function resolvedLayout(inputs: readonly RegionInput[]): ResolvedWorkspaceLayout {
  return {
    id: 'layout.review-remediation.geometry',
    regions: inputs.map((input) => ({
      id: input.id,
      slot: input.slot,
      order: input.order ?? 0,
      component: {
        id: input.slot === 'primary' ? 'sayre.primary-surface' : 'sayre.geometry-fixture',
        version: 1,
        props: {},
      },
      defaultSize: input.size ?? 96,
      minimumSize: 44,
      maximumSize: 500,
      size: input.size ?? 96,
      resize: input.resize ?? 'none',
      collapsible: false,
      collapsed: false,
      hidden: false,
      compactBehavior: 'overlay',
      visibleInViews: null,
    })),
  } as unknown as ResolvedWorkspaceLayout;
}

function render(inputs: readonly RegionInput[]) {
  return TestRenderer.create(
    <WorkspaceLayout
      layout={resolvedLayout(inputs)}
      viewId="technical"
      renderRegion={(id) => <span>{id}</span>}
    />,
  );
}

function docksIn(renderer: TestRenderer.ReactTestRenderer, slot: Slot): ReactTestInstance[] {
  return renderer.root
    .findByProps({ 'data-workspace-slot-group': slot })
    .findAll((node) => typeof node.props['data-workspace-dock'] === 'string');
}

function rectanglesFromRenderedDocks(
  docks: readonly ReactTestInstance[],
  dimension: 'blockSize' | 'inlineSize',
  origin = 0,
): FlowRectangle[] {
  let cursor = origin;
  return docks.map((dock) => {
    const size = pixels(dock.props.style[dimension]);
    const rectangle = {
      id: dock.props['data-workspace-dock'] as string,
      start: cursor,
      end: cursor + size,
    };
    cursor = rectangle.end;
    return rectangle;
  });
}

function expectNoOverlap(rectangles: readonly FlowRectangle[]): void {
  for (let index = 1; index < rectangles.length; index += 1) {
    expect(rectangles[index]!.start).toBe(rectangles[index - 1]!.end);
    expect(rectangles[index]!.start).toBeGreaterThanOrEqual(rectangles[index - 1]!.end);
  }
}

function expectCenteredTarget(rectangle: FlowRectangle, edge: Edge): void {
  const axis = edge.startsWith('block') ? 'vertical' : 'horizontal';
  const targetRule = declarations(css, `.workspace-resize-handle--${axis}`);
  const edgeRule = declarations(css, `.workspace-resize-handle--${edge}`);
  const targetSize = pixels(targetRule.get(axis === 'vertical' ? 'block-size' : 'inline-size'));
  const offset = pixels(edgeRule.get(`inset-${edge}`));
  const seam = edge.endsWith('start') ? rectangle.start : rectangle.end;
  const targetStart = edge.endsWith('start')
    ? seam + offset
    : seam - offset - targetSize;

  expect(targetSize).toBeGreaterThanOrEqual(44);
  expect(targetStart).toBe(seam - 22);
  expect(targetStart + targetSize / 2).toBe(seam);
}

describe('WorkspaceLayout review-remediation geometry', () => {
  // @spec AC-6 AC-7 AC-8 EC-4 EC-5
  it('lays out repeated normal-slot rectangles on stable seams with complete centered targets', () => {
    const inputs: RegionInput[] = [
      { id: 'top.b', slot: 'top', order: 0, resize: 'vertical', size: 64 },
      { id: 'top.a', slot: 'top', order: 0, resize: 'vertical', size: 56 },
      { id: 'navigation.b', slot: 'navigation', order: 0, resize: 'horizontal', size: 72 },
      { id: 'navigation.a', slot: 'navigation', order: 0, resize: 'horizontal', size: 60 },
      { id: 'explorer.b', slot: 'explorer', order: 0, resize: 'horizontal', size: 84 },
      { id: 'explorer.a', slot: 'explorer', order: 0, resize: 'horizontal', size: 76 },
      { id: 'primary', slot: 'primary' },
      { id: 'inspector.b', slot: 'inspector', order: 0, resize: 'horizontal', size: 88 },
      { id: 'inspector.a', slot: 'inspector', order: 0, resize: 'horizontal', size: 80 },
      { id: 'bottom.b', slot: 'bottom', order: 0, resize: 'vertical', size: 68 },
      { id: 'bottom.a', slot: 'bottom', order: 0, resize: 'vertical', size: 52 },
    ];
    const renderer = render(inputs);
    const cases: readonly [Slot, 'blockSize' | 'inlineSize', Edge][] = [
      ['top', 'blockSize', 'block-end'],
      ['navigation', 'inlineSize', 'inline-end'],
      ['explorer', 'inlineSize', 'inline-end'],
      ['inspector', 'inlineSize', 'inline-start'],
      ['bottom', 'blockSize', 'block-start'],
    ];

    for (const [slot, dimension, edge] of cases) {
      const docks = docksIn(renderer, slot);
      expect(docks.map((dock) => dock.props['data-workspace-dock'])).toEqual([`${slot}.a`, `${slot}.b`]);
      const rectangles = rectanglesFromRenderedDocks(docks, dimension);
      expectNoOverlap(rectangles);

      docks.forEach((dock, index) => {
        const handle = dock.findByProps({ role: 'separator' });
        expect(handle.props['data-resize-edge']).toBe(edge);
        expectCenteredTarget(rectangles[index]!, edge);
      });
    }

    const topBottomRule = declarations(css, '.workspace-layout__slot-group--top');
    expect(topBottomRule.get('overflow')).toBe('visible');
    expect(declarations(css, '.workspace-layout').get('overflow')).toBe('hidden');
    renderer.unmount();
  });

  // @spec AC-6 AC-7 AC-8 EC-4 EC-5
  it('renders the declared dimension, orientation, and edge for every slot/axis pair', () => {
    const slots: readonly Exclude<Slot, 'primary'>[] = [
      'top',
      'bottom',
      'navigation',
      'explorer',
      'inspector',
      'overlay',
    ];
    const inputs: RegionInput[] = [{ id: 'primary', slot: 'primary' }];
    for (const slot of slots) {
      inputs.push({ id: `${slot}.horizontal`, slot, resize: 'horizontal', size: 101 });
      inputs.push({ id: `${slot}.vertical`, slot, resize: 'vertical', size: 103 });
    }
    const renderer = render(inputs);

    for (const slot of slots) {
      for (const axis of ['horizontal', 'vertical'] as const) {
        const id = `${slot}.${axis}`;
        const dock = renderer.root.findByProps({ 'data-workspace-dock': id });
        const handle = dock.findByProps({ role: 'separator' });
        const expectedEdge: Edge = axis === 'horizontal'
          ? slot === 'inspector' ? 'inline-start' : 'inline-end'
          : slot === 'bottom' ? 'block-start' : 'block-end';
        const dimension = axis === 'horizontal' ? 'inlineSize' : 'blockSize';

        expect(dock.props['data-resize-axis']).toBe(axis);
        expect(dock.props.style).toEqual({ [dimension]: axis === 'horizontal' ? '101px' : '103px' });
        expect(handle.props['aria-orientation']).toBe(axis === 'horizontal' ? 'vertical' : 'horizontal');
        expect(handle.props['data-resize-edge']).toBe(expectedEdge);
      }
    }

    const horizontalTarget = declarations(css, '.workspace-resize-handle--horizontal');
    const verticalTarget = declarations(css, '.workspace-resize-handle--vertical');
    expect(horizontalTarget.get('inline-size')).toBe('44px');
    expect(horizontalTarget.get('block-size')).toBe('max(44px, 100%)');
    expect(verticalTarget.get('block-size')).toBe('44px');
    expect(verticalTarget.get('inline-size')).toBe('max(44px, 100%)');
    renderer.unmount();
  });
});
