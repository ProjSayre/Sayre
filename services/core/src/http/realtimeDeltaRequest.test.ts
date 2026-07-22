import { describe, expect, it } from 'vitest';
import { parseRealtimeDeltaRequest, RealtimeDeltaParseError } from './realtimeDeltaRequest';

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
