// Leading-red test (W7-01, AC-16) for the new ImportingRepositoriesState component. Mirrors
// PrerequisiteNode.test.tsx's renderToStaticMarkup convention (this package's vitest config runs
// with environment: 'node', not jsdom). The component/module does not exist yet, so this fails
// today at import (RED-CORRECT).

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RepositoryImportSync } from '../types';

(globalThis as unknown as { React: typeof React }).React = React;

function sync(overrides: Partial<RepositoryImportSync> = {}): RepositoryImportSync {
  return {
    status: 'importing',
    updatedAt: '2026-08-12T18:00:00.000Z',
    discoveredRepositories: 120,
    registeredRepositories: 47,
    ...overrides,
  } as RepositoryImportSync;
}

describe('ImportingRepositoriesState — AC-16 (canvas state + chip variants)', () => {
  // @spec AC-16
  it('renders a canvas-state variant with data-canvas-state="importing-repositories" when no repository is selectable yet', async () => {
    const { ImportingRepositoriesState } = await import('./CanvasStates');
    const markup = renderToStaticMarkup(
      React.createElement(ImportingRepositoriesState, { sync: sync(), variant: 'canvas' }),
    );
    expect(markup).toContain('data-canvas-state="importing-repositories"');
  });

  // @spec AC-16
  it('renders a chip variant carrying data-repository-import=<status> alongside the canvas once repositories are listed', async () => {
    const { ImportingRepositoriesState } = await import('./CanvasStates');
    const markup = renderToStaticMarkup(
      React.createElement(ImportingRepositoriesState, { sync: sync({ status: 'stalled' }), variant: 'chip' }),
    );
    expect(markup).toContain('data-repository-import="stalled"');
  });
});
