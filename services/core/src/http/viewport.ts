// Request adaptation only — no domain logic (see .claude/rules/service-layer.md).
// Parses/validates the client-supplied viewport window. Never reads orgId:
// tenancy is resolved server-side (see ./authenticate.ts / ../auth/context.ts), not client input.

import type { Viewport } from '../graph-query/types';

export type { Viewport } from '../graph-query/types';

export class ViewportParseError extends Error {}

function parseRequiredNumber(value: unknown, field: string): number {
  const num = Number(value);
  if (value === undefined || value === null || value === '' || !Number.isFinite(num)) {
    throw new ViewportParseError(`Invalid or missing viewport field: ${field}`);
  }
  return num;
}

export function parseViewport(query: unknown): Viewport {
  const q = (query ?? {}) as Record<string, unknown>;

  const x = parseRequiredNumber(q.x, 'x');
  const y = parseRequiredNumber(q.y, 'y');
  const width = parseRequiredNumber(q.width, 'width');
  const height = parseRequiredNumber(q.height, 'height');

  if (width <= 0) {
    throw new ViewportParseError('viewport.width must be > 0');
  }
  if (height <= 0) {
    throw new ViewportParseError('viewport.height must be > 0');
  }

  const zoom = q.zoom === undefined ? 1 : Number(q.zoom);
  if (!Number.isFinite(zoom) || zoom <= 0) {
    throw new ViewportParseError('viewport.zoom must be > 0');
  }

  return { x, y, width, height, zoom };
}
