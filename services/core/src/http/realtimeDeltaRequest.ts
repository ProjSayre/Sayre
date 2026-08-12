// Request adaptation only — no domain logic (see .claude/rules/service-layer.md).
// Parses/validates the body of the internal `POST /internal/realtime/graph-delta`
// request (mirrors ./viewport.ts). Deliberately never reads an `org_id`/`orgId`
// field from the body even if one is present — tenancy is resolved server-side
// from the forwarded session token (see ../auth/context.ts, ../routes/realtimeInternal.ts).

export class RealtimeDeltaParseError extends Error {}

export interface ParsedRealtimeDeltaRequest {
  repoId: string;
  changedPaths: string[];
  fullRebuild: boolean;
  graphVersion: number;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function parseRealtimeDeltaRequest(body: unknown): ParsedRealtimeDeltaRequest {
  if (typeof body !== 'object' || body === null) {
    throw new RealtimeDeltaParseError('Request body must be a JSON object.');
  }
  const candidate = body as Record<string, unknown>;

  if (typeof candidate.repoId !== 'string' || candidate.repoId.trim().length === 0) {
    throw new RealtimeDeltaParseError('Invalid or missing field: repoId');
  }

  if (!isStringArray(candidate.changedPaths)) {
    throw new RealtimeDeltaParseError('Invalid or missing field: changedPaths (must be an array of strings)');
  }

  if (typeof candidate.fullRebuild !== 'boolean') {
    throw new RealtimeDeltaParseError('Invalid or missing field: fullRebuild (must be a boolean)');
  }

  if (
    typeof candidate.graphVersion !== 'number' ||
    !Number.isInteger(candidate.graphVersion) ||
    candidate.graphVersion < 0
  ) {
    throw new RealtimeDeltaParseError('Invalid or missing field: graphVersion (must be a nonnegative integer)');
  }

  return {
    repoId: candidate.repoId,
    changedPaths: candidate.changedPaths,
    fullRebuild: candidate.fullRebuild,
    graphVersion: candidate.graphVersion,
  };
}

// ---------------------------------------------------------------------------
// CH-05 — the internal chat-authorization request body. Deliberately never
// reads org_id/orgId/userId from the body even if present — tenancy/identity
// are resolved server-side from the forwarded session token.
// ---------------------------------------------------------------------------

export const CHAT_AUTHORIZATION_MAX_NODE_IDS = 64;

export interface ParsedRealtimeChatAuthorizationRequest {
  conversationId: string;
  nodeIds: string[];
}

function isNonBlankStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && item.trim().length > 0)
  );
}

/** Reuses RealtimeDeltaParseError (already -> HTTP 400 in http/express.ts).
 *  Deliberately never reads org_id/orgId/userId from the body even if present. */
export function parseRealtimeChatAuthorizationRequest(
  body: unknown,
): ParsedRealtimeChatAuthorizationRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new RealtimeDeltaParseError('Request body must be a JSON object.');
  }
  const candidate = body as Record<string, unknown>;

  if (typeof candidate.conversationId !== 'string' || candidate.conversationId.trim().length === 0) {
    throw new RealtimeDeltaParseError('Invalid or missing field: conversationId');
  }

  if (!isNonBlankStringArray(candidate.nodeIds)) {
    throw new RealtimeDeltaParseError('Invalid or missing field: nodeIds (must be an array of non-blank strings)');
  }

  if (candidate.nodeIds.length > CHAT_AUTHORIZATION_MAX_NODE_IDS) {
    throw new RealtimeDeltaParseError(
      `Invalid field: nodeIds (must contain at most ${CHAT_AUTHORIZATION_MAX_NODE_IDS} entries)`,
    );
  }

  return {
    conversationId: candidate.conversationId,
    nodeIds: candidate.nodeIds,
  };
}
