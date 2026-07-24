import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OVERLAY_FIXTURE } from '../lib/nodeOverlay.fixture';
import { NodeOverlayPanel } from './NodeOverlayPanel';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('NodeOverlayPanel', () => {
  it('fetches once per selected node and never refetches when any layer toggles', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(OVERLAY_FIXTURE));
    vi.stubGlobal('fetch', fetchSpy);
    let renderer: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<NodeOverlayPanel nodeId="file-1" />);
      await settle();
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const layerNames = [
      'Dependencies',
      'Recent Changes',
      'Specific Features',
      'Agent/Skill MD',
      'Description',
      'Specific Tickets',
    ];
    for (const name of layerNames) {
      const button = renderer!.root.findAllByType('button').find(
        (candidate) => candidate.props.children === name,
      );
      expect(button).toBeDefined();
      await act(async () => {
        button!.props.onClick();
        await Promise.resolve();
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    }

    await act(async () => {
      renderer!.update(<NodeOverlayPanel nodeId="file-2" />);
      await settle();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    act(() => renderer!.unmount());
  });

  it('updates the Agent/Skill layer from the save response without a graph refetch', async () => {
    const saved = {
      ...OVERLAY_FIXTURE.agentSkillMd!,
      version: 2,
      editorLabel: 'Grace',
    };
    const fetchSpy = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      init?.method === 'PUT'
        ? jsonResponse({ document: saved })
        : jsonResponse(OVERLAY_FIXTURE),
    );
    vi.stubGlobal('fetch', fetchSpy);
    let renderer: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<NodeOverlayPanel nodeId="file-1" />);
      await settle();
    });
    const saveButton = renderer!.root.findAllByType('button').find(
      (candidate) => candidate.props.children === 'Save new version',
    );
    await act(async () => {
      saveButton!.props.onClick();
      await settle();
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/overlay');
    expect(String(fetchSpy.mock.calls[1]?.[0])).toContain('/agent-skill-md');
    expect(JSON.stringify(renderer!.toJSON())).toContain('v2 · Grace');
    act(() => renderer!.unmount());
  });
});
