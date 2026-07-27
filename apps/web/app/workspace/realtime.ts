import type { GatewayToClientMessage } from '@sayre/shared-types';

interface BrowserLocation {
  protocol: string;
  hostname: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(
  value: Record<string, unknown>,
  field: string,
): string | null {
  return typeof value[field] === 'string' && value[field].length > 0
    ? (value[field] as string)
    : null;
}

/** Runtime guard for the small subset of server messages the workspace uses. */
export function parseGatewayMessage(raw: string): GatewayToClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.type !== 'string') return null;

  if (value.type === 'ready') return { type: 'ready' };
  if (value.type === 'subscribed') {
    const repoId = stringField(value, 'repoId');
    return repoId === null ? null : { type: 'subscribed', repoId };
  }
  if (value.type === 'graph.resync') {
    const repoId = stringField(value, 'repoId');
    return repoId === null || !Number.isSafeInteger(value.graphVersion)
      ? null
      : {
          type: 'graph.resync',
          repoId,
          graphVersion: value.graphVersion as number,
        };
  }
  if (value.type === 'graph.delta') {
    const repoId = stringField(value, 'repoId');
    if (
      repoId === null ||
      !Number.isSafeInteger(value.graphVersion) ||
      !Array.isArray(value.upserts) ||
      !Array.isArray(value.removals)
    ) {
      return null;
    }
    // Core re-filters every event. The client deliberately does not attempt to
    // reconstruct edges from a node-only delta; it re-fetches the authorized
    // view after a valid notification.
    return {
      type: 'graph.delta',
      repoId,
      graphVersion: value.graphVersion as number,
      upserts: [],
      removals: [],
    };
  }
  if (value.type === 'error') {
    const code = stringField(value, 'code');
    const message = stringField(value, 'message');
    return code === null || message === null
      ? null
      : { type: 'error', code, message };
  }
  return null;
}

/**
 * Public URLs are treated as routing configuration, never credentials. Query
 * strings, fragments, embedded credentials, and non-WebSocket schemes fail
 * closed because those are common token-leak paths.
 */
export function normalizeRealtimeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'ws:' && url.protocol !== 'wss:') ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function browserRealtimeUrl(
  location: BrowserLocation,
  configured: string | undefined,
  development: boolean,
): string | null {
  if (configured !== undefined) return normalizeRealtimeUrl(configured);
  if (!development) return null;
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return normalizeRealtimeUrl(`${scheme}//${location.hostname}:4100`);
}
