import { describe, expect, it, vi } from 'vitest';
import {
  NodeOverlayRequestError,
  NodeOverlayResponseError,
  fetchAgentSkillMdHistory,
  fetchNodeOverlay,
  parseNodeOverlayResponse,
  saveAgentSkillMd,
} from './nodeOverlay';
import { OVERLAY_FIXTURE } from './nodeOverlay.fixture';

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('node overlay response boundary', () => {
  it('accepts the six server-filtered layers', () => {
    expect(parseNodeOverlayResponse(OVERLAY_FIXTURE)).toEqual(OVERLAY_FIXTURE);
  });

  it.each([
    { ...OVERLAY_FIXTURE, authorization: 'client-filtered' },
    {
      ...OVERLAY_FIXTURE,
      node: { ...OVERLAY_FIXTURE.node, label: 'Function' },
    },
    {
      ...OVERLAY_FIXTURE,
      dependencies: [{
        ...OVERLAY_FIXTURE.dependencies[0],
        relationship: 'CALLS',
      }],
    },
  ])('rejects a response outside the presentation contract', (value) => {
    expect(() => parseNodeOverlayResponse(value)).toThrow(
      NodeOverlayResponseError,
    );
  });

  it('fetches a node without sending tenant identity and hides error bodies', async () => {
    const fetchImpl = vi.fn(async () => response(OVERLAY_FIXTURE));

    await expect(
      fetchNodeOverlay(' file/one ', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toEqual(OVERLAY_FIXTURE);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/core/nodes/file%2Fone/overlay');
    expect(url).not.toMatch(/org/i);
    expect(init.credentials).toBe('same-origin');

    const forbidden = vi.fn(async () =>
      response({ secret: 'do not echo' }, 403),
    ) as unknown as typeof fetch;
    const error = await fetchNodeOverlay('file-1', { fetchImpl: forbidden })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(NodeOverlayRequestError);
    expect(String(error)).not.toContain('do not echo');
  });
});

describe('Agent/Skill MD save boundary', () => {
  it('sends only content and optimistic version and returns the new version', async () => {
    const fetchImpl = vi.fn(async () =>
      response({ document: { ...OVERLAY_FIXTURE.agentSkillMd, version: 2 } }),
    );

    const saved = await saveAgentSkillMd(
      'file-1',
      OVERLAY_FIXTURE.agentSkillMd!.content,
      1,
      fetchImpl as unknown as typeof fetch,
    );

    expect(saved.version).toBe(2);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      content: OVERLAY_FIXTURE.agentSkillMd!.content,
      expectedVersion: 1,
    });
  });

  it('surfaces a safe optimistic conflict with the current version', async () => {
    const fetchImpl = vi.fn(
      async () => response({ currentVersion: 4 }, 409),
    ) as unknown as typeof fetch;

    await expect(
      saveAgentSkillMd('file-1', 'content', 3, fetchImpl),
    ).rejects.toMatchObject({
      status: 409,
      currentVersion: 4,
    });
  });

  it('loads immutable history through the node-scoped endpoint', async () => {
    const versions = [
      OVERLAY_FIXTURE.agentSkillMd!,
      { ...OVERLAY_FIXTURE.agentSkillMd!, version: 2 },
    ];
    const fetchImpl = vi.fn(async () => response({ versions }));

    await expect(
      fetchAgentSkillMdHistory(
        'file-1',
        fetchImpl as unknown as typeof fetch,
      ),
    ).resolves.toEqual(versions);
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/core/nodes/file-1/agent-skill-md/history',
      expect.objectContaining({ method: 'GET', credentials: 'same-origin' }),
    );
  });
});
