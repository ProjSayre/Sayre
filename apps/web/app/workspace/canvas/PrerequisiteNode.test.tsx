import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { NodeProps } from '@xyflow/react';

// Handle subscribes to the React Flow store, which only exists inside a
// provider. The node's own rendering is what this file covers.
vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Left: 'left', Right: 'right' },
}));

(globalThis as unknown as { React: typeof React }).React = React;

import { PrerequisiteNodeView, type PrerequisiteNodeData } from './PrerequisiteNode';

function render(overrides: Partial<PrerequisiteNodeData> = {}): string {
  const data: PrerequisiteNodeData = {
    name: 'money.ts',
    path: 'packages/shared/money.ts',
    layer: 0,
    progress: 'current',
    selected: false,
    matched: false,
    dimmed: false,
    groupSize: 1,
    ...overrides,
  };
  return renderToStaticMarkup(
    <PrerequisiteNodeView {...({ data } as unknown as NodeProps)} />,
  );
}

describe('PrerequisiteNodeView', () => {
  it('shows the file name and its position in the reading order', () => {
    const markup = render({ layer: 2 });
    expect(markup).toContain('money.ts');
    // Layers are zero-indexed internally but read as human step numbers.
    expect(markup).toContain('step 3');
    expect(markup).toContain('packages/shared/money.ts');
  });

  it('distinguishes done, current, and locked', () => {
    expect(render({ progress: 'done' })).toContain('is-done');
    expect(render({ progress: 'current' })).toContain('is-current');
    expect(render({ progress: 'locked' })).toContain('is-locked');
  });

  it('carries a text label for each state, not colour alone', () => {
    expect(render({ progress: 'done' })).toContain('Read');
    expect(render({ progress: 'current' })).toContain('Ready to read');
    expect(render({ progress: 'locked' })).toContain(
      'Prerequisites outstanding',
    );
  });

  it('names the cycle it belongs to rather than only styling it', () => {
    const markup = render({ groupSize: 3 });
    expect(markup).toContain('is-entangled');
    expect(markup).toContain('3-file cycle');
  });

  it('omits cycle wording for an ordinary file', () => {
    const markup = render({ groupSize: 1 });
    expect(markup).not.toContain('cycle');
    expect(markup).not.toContain('is-entangled');
  });

  it('reflects selection and search state', () => {
    expect(render({ selected: true })).toContain('is-selected');
    expect(render({ matched: true })).toContain('is-match');
    expect(render({ dimmed: true })).toContain('is-dimmed');
  });
});
