import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { fixtureWorkspaceDataSource } from '../dataSource';
import { WorkspaceProvider } from '../state';
import { NoRepositoryState } from '../components/CanvasStates';
import { SettingsPanel } from './SettingsPanel';

(globalThis as unknown as { React: typeof React }).React = React;

function renderedText(renderer: TestRenderer.ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

describe('GitHub repository onboarding UI', () => {
  it('renders a first-class admin connection action in the empty workspace', async () => {
    let renderer: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      renderer = TestRenderer.create(
        <WorkspaceProvider source={fixtureWorkspaceDataSource}>
          <NoRepositoryState reason="none" />
        </WorkspaceProvider>,
      );
    });

    expect(renderedText(renderer!)).toContain('Connect a GitHub repository');

    await act(async () => renderer?.unmount());
  });

  it('shows the connected account and per-repository import lifecycle', async () => {
    let renderer: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      renderer = TestRenderer.create(
        <WorkspaceProvider
          source={fixtureWorkspaceDataSource}
          initialSettingsSection="github"
        >
          <SettingsPanel />
        </WorkspaceProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const text = renderedText(renderer!);
    expect(text).toContain('GitHub App installed');
    expect(text).toContain('Connected account');
    expect(text).toContain('acme');
    expect(text).toContain('Installation health and per-repository sync');
    expect(text).toContain('Sayre is building the repository graph.');
    expect(text).not.toContain('no browser-facing installation-status API');

    await act(async () => renderer?.unmount());
  });
});
