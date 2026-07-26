import { getConfig } from '@sayre/config';
import { NextResponse, type NextRequest } from 'next/server';

const MAX_REQUEST_BYTES = 32_768;
const MAX_RESPONSE_BYTES = 262_144;
const REQUEST_TIMEOUT_MS = 5_000;
const SESSION_COOKIE = 'sayre_session';
const BEARER_RE = /^Bearer\s+\S+$/iu;

function upstreamUrl(path: readonly string[]): string | null {
  const base = getConfig('CORE_INTERNAL_BASE_URL').replace(/\/+$/, '');
  if (path.length === 0) return `${base}/settings/mcp`;
  if (path.length === 1 && path[0] === 'keys') {
    return `${base}/settings/mcp/keys`;
  }
  if (path.length === 1 && path[0] === 'rate-limit') {
    return `${base}/settings/mcp/rate-limit`;
  }
  if (
    path.length === 2 &&
    path[0] === 'keys' &&
    /^[0-9a-f-]{36}$/i.test(path[1] ?? '')
  ) {
    return `${base}/settings/mcp/keys/${encodeURIComponent(path[1] ?? '')}`;
  }
  return null;
}

function forwardedHeaders(request: NextRequest, hasBody: boolean): Headers {
  const headers = new Headers({ accept: 'application/json' });
  const explicit = request.headers.get('authorization');
  const session = request.cookies.get(SESSION_COOKIE)?.value;
  if (explicit !== null && BEARER_RE.test(explicit)) {
    headers.set('authorization', explicit);
  } else if (session && !/\s/u.test(session)) {
    headers.set('authorization', `Bearer ${session}`);
  }
  if (hasBody) headers.set('content-type', 'application/json');
  return headers;
}

async function boundedBody(
  body: ReadableStream<Uint8Array> | null,
  maximum: number,
): Promise<Uint8Array | null> {
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximum || chunks.length >= 256) {
      await reader.cancel();
      throw new RangeError('body too large');
    }
    chunks.push(value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function proxy(
  request: NextRequest,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: readonly string[],
): Promise<NextResponse> {
  const url = upstreamUrl(path);
  if (!url) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }
  let body: Uint8Array | null = null;
  try {
    const contentLength = request.headers.get('content-length');
    if (
      contentLength &&
      /^\d+$/.test(contentLength) &&
      Number(contentLength) > MAX_REQUEST_BYTES
    ) {
      await request.body?.cancel();
      return NextResponse.json({ error: 'Request too large.' }, { status: 413 });
    }
    if (method === 'POST' || method === 'PUT') {
      body = await boundedBody(request.body, MAX_REQUEST_BYTES);
    }
  } catch {
    return NextResponse.json({ error: 'Request too large.' }, { status: 413 });
  }

  try {
    const response = await fetch(url, {
      method,
      headers: forwardedHeaders(request, body !== null),
      body,
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const responseBody = await boundedBody(response.body, MAX_RESPONSE_BYTES);
    return new NextResponse(responseBody, {
      status: response.status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  } catch {
    return NextResponse.json(
      { error: 'MCP settings service unavailable.' },
      { status: 502 },
    );
  }
}

function routePath(context: { params: { path?: string[] } }): string[] {
  return context.params.path ?? [];
}

export function GET(
  request: NextRequest,
  context: { params: { path?: string[] } },
) {
  const path = routePath(context);
  return path.length === 0
    ? proxy(request, 'GET', path)
    : NextResponse.json({ error: 'Not found.' }, { status: 404 });
}

export function POST(
  request: NextRequest,
  context: { params: { path?: string[] } },
) {
  const path = routePath(context);
  return path.length === 1 && path[0] === 'keys'
    ? proxy(request, 'POST', path)
    : NextResponse.json({ error: 'Not found.' }, { status: 404 });
}

export function PUT(
  request: NextRequest,
  context: { params: { path?: string[] } },
) {
  const path = routePath(context);
  return path.length === 1 && path[0] === 'rate-limit'
    ? proxy(request, 'PUT', path)
    : NextResponse.json({ error: 'Not found.' }, { status: 404 });
}

export function DELETE(
  request: NextRequest,
  context: { params: { path?: string[] } },
) {
  const path = routePath(context);
  return path.length === 2 && path[0] === 'keys'
    ? proxy(request, 'DELETE', path)
    : NextResponse.json({ error: 'Not found.' }, { status: 404 });
}
