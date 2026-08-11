import { describe, expect, it } from 'vitest';
import {
  parseRealtimeChatAuthorizationRequest,
  parseRealtimeDeltaRequest,
  RealtimeDeltaParseError,
} from './realtimeDeltaRequest';

const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';

describe('parseRealtimeDeltaRequest', () => {
  it('parses a fully specified body', () => {
    const parsed = parseRealtimeDeltaRequest({
      repoId: 'repo-1',
      changedPaths: ['/src/index.ts'],
      fullRebuild: false,
      graphVersion: 4,
    });
    expect(parsed).toEqual({
      repoId: 'repo-1',
      changedPaths: ['/src/index.ts'],
      fullRebuild: false,
      graphVersion: 4,
    });
  });

  it('accepts an empty changedPaths array', () => {
    const parsed = parseRealtimeDeltaRequest({
      repoId: 'repo-1',
      changedPaths: [],
      fullRebuild: true,
      graphVersion: 0,
    });
    expect(parsed.changedPaths).toEqual([]);
  });

  it('throws when repoId is missing', () => {
    expect(() =>
      parseRealtimeDeltaRequest({ changedPaths: [], fullRebuild: false, graphVersion: 0 }),
    ).toThrow(RealtimeDeltaParseError);
  });

  it('throws when repoId is blank', () => {
    expect(() =>
      parseRealtimeDeltaRequest({ repoId: '  ', changedPaths: [], fullRebuild: false, graphVersion: 0 }),
    ).toThrow(RealtimeDeltaParseError);
  });

  it('throws when changedPaths is not an array of strings', () => {
    expect(() =>
      parseRealtimeDeltaRequest({
        repoId: 'repo-1',
        changedPaths: ['ok', 5],
        fullRebuild: false,
        graphVersion: 0,
      }),
    ).toThrow(RealtimeDeltaParseError);
  });

  it('throws when fullRebuild is not a boolean', () => {
    expect(() =>
      parseRealtimeDeltaRequest({
        repoId: 'repo-1',
        changedPaths: [],
        fullRebuild: 'yes',
        graphVersion: 0,
      }),
    ).toThrow(RealtimeDeltaParseError);
  });

  it('throws when graphVersion is negative', () => {
    expect(() =>
      parseRealtimeDeltaRequest({
        repoId: 'repo-1',
        changedPaths: [],
        fullRebuild: false,
        graphVersion: -1,
      }),
    ).toThrow(RealtimeDeltaParseError);
  });

  it('throws when graphVersion is not an integer', () => {
    expect(() =>
      parseRealtimeDeltaRequest({
        repoId: 'repo-1',
        changedPaths: [],
        fullRebuild: false,
        graphVersion: 1.5,
      }),
    ).toThrow(RealtimeDeltaParseError);
  });

  it('throws when the body is not an object', () => {
    expect(() => parseRealtimeDeltaRequest(null)).toThrow(RealtimeDeltaParseError);
    expect(() => parseRealtimeDeltaRequest('nope')).toThrow(RealtimeDeltaParseError);
  });

  it('isolation regression: a client-supplied org_id in the body has no effect on the parsed result', () => {
    const parsed = parseRealtimeDeltaRequest({
      repoId: 'repo-1',
      changedPaths: [],
      fullRebuild: false,
      graphVersion: 0,
      org_id: 'attacker-org',
      orgId: 'attacker-org',
    });
    expect(Object.keys(parsed)).not.toContain('org_id');
    expect(Object.keys(parsed)).not.toContain('orgId');
  });
});

// ---------------------------------------------------------------------------
// CH-05 — the internal chat-authorization request body. Authored by `red` from
// .pipeline/spec.md before any implementation exists. Every case above this
// line predates CH-05 and must keep passing untouched (AC-10).
// ---------------------------------------------------------------------------

describe('parseRealtimeChatAuthorizationRequest', () => {
  // @spec AC-11
  it('AC-11: parses a fully specified body to exactly { conversationId, nodeIds }', () => {
    const parsed = parseRealtimeChatAuthorizationRequest({
      conversationId: CONVERSATION_ID,
      nodeIds: ['file-login', 'canvas-login'],
    });

    expect(parsed).toEqual({
      conversationId: CONVERSATION_ID,
      nodeIds: ['file-login', 'canvas-login'],
    });
    expect(Object.keys(parsed).sort()).toEqual(['conversationId', 'nodeIds']);
  });

  // @spec EC-28
  it('EC-28: accepts an empty nodeIds array (every progress/error push and every subscribe-time check)', () => {
    expect(
      parseRealtimeChatAuthorizationRequest({ conversationId: CONVERSATION_ID, nodeIds: [] }),
    ).toEqual({ conversationId: CONVERSATION_ID, nodeIds: [] });
  });

  // @spec AC-11
  it('AC-11: rejects a non-object body', () => {
    expect(() => parseRealtimeChatAuthorizationRequest(null)).toThrow(RealtimeDeltaParseError);
    expect(() => parseRealtimeChatAuthorizationRequest('nope')).toThrow(RealtimeDeltaParseError);
    expect(() => parseRealtimeChatAuthorizationRequest([])).toThrow(RealtimeDeltaParseError);
  });

  // @spec AC-11
  it('AC-11: rejects a missing or blank conversationId', () => {
    expect(() => parseRealtimeChatAuthorizationRequest({ nodeIds: [] })).toThrow(
      RealtimeDeltaParseError,
    );
    expect(() =>
      parseRealtimeChatAuthorizationRequest({ conversationId: '   ', nodeIds: [] }),
    ).toThrow(RealtimeDeltaParseError);
    expect(() => parseRealtimeChatAuthorizationRequest({ conversationId: 42, nodeIds: [] })).toThrow(
      RealtimeDeltaParseError,
    );
  });

  // @spec AC-11
  it('AC-11: rejects nodeIds that is missing, not an array, or not all non-blank strings', () => {
    expect(() => parseRealtimeChatAuthorizationRequest({ conversationId: CONVERSATION_ID })).toThrow(
      RealtimeDeltaParseError,
    );
    expect(() =>
      parseRealtimeChatAuthorizationRequest({ conversationId: CONVERSATION_ID, nodeIds: 'n1' }),
    ).toThrow(RealtimeDeltaParseError);
    expect(() =>
      parseRealtimeChatAuthorizationRequest({ conversationId: CONVERSATION_ID, nodeIds: ['ok', 5] }),
    ).toThrow(RealtimeDeltaParseError);
    expect(() =>
      parseRealtimeChatAuthorizationRequest({ conversationId: CONVERSATION_ID, nodeIds: ['ok', ' '] }),
    ).toThrow(RealtimeDeltaParseError);
  });

  // @spec AC-11
  it('AC-11: rejects more than 64 nodeIds and accepts exactly 64', () => {
    const ids = (count: number) => Array.from({ length: count }, (_unused, index) => `n-${index}`);

    expect(
      parseRealtimeChatAuthorizationRequest({ conversationId: CONVERSATION_ID, nodeIds: ids(64) })
        .nodeIds,
    ).toHaveLength(64);
    expect(() =>
      parseRealtimeChatAuthorizationRequest({ conversationId: CONVERSATION_ID, nodeIds: ids(65) }),
    ).toThrow(RealtimeDeltaParseError);
  });

  // @spec AC-8 AC-11
  it('AC-8/AC-11: a client-supplied org_id / orgId / userId in the body is never read into the parsed result', () => {
    const parsed = parseRealtimeChatAuthorizationRequest({
      conversationId: CONVERSATION_ID,
      nodeIds: ['n1'],
      org_id: 'attacker-org',
      orgId: 'attacker-org',
      userId: 'attacker-user',
    });

    expect(Object.keys(parsed).sort()).toEqual(['conversationId', 'nodeIds']);
    expect(JSON.stringify(parsed)).not.toContain('attacker');
  });
});
