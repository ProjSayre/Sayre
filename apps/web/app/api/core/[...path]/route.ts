import { getConfig } from '@sayre/config';
import { type NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const SESSION_COOKIE = 'sayre_session';
const BEARER_RE = /^Bearer\s+\S+$/i;

interface CoreRoute {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  query: ReadonlySet<string>;
  redirect?: boolean;
}

const NO_QUERY = new Set<string>();

function coreRoute(
  method: 'GET' | 'POST' | 'PUT',
  segments: readonly string[],
): CoreRoute | null {
  if (segments.length === 1 && segments[0] === 'repositories' && method === 'GET') {
    return { method, path: '/repositories', query: NO_QUERY };
  }
  if (
    segments.length === 2 &&
    segments[0] === 'settings' &&
    segments[1] === 'model-providers' &&
    method === 'GET'
  ) {
    return {
      method,
      path: '/settings/model-providers',
      query: NO_QUERY,
    };
  }
  if (
    segments.length === 3 &&
    segments[0] === 'auth' &&
    segments[1] === 'github' &&
    segments[2] === 'login' &&
    method === 'GET'
  ) {
    return {
      method,
      path: '/auth/github/login',
      query: new Set(['redirect_to']),
      redirect: true,
    };
  }
  if (
    segments.length === 3 &&
    segments[0] === 'settings' &&
    segments[1] === 'model-providers' &&
    (segments[2] === 'generation' || segments[2] === 'embedding') &&
    method === 'PUT'
  ) {
    return {
      method,
      path: `/settings/model-providers/${segments[2]}`,
      query: NO_QUERY,
    };
  }
  if (
    segments.length === 3 &&
    segments[0] === 'repos' &&
    segments[2] === 'onboarding-tree' &&
    method === 'GET'
  ) {
    return {
      method,
      path: `/repos/${encodeURIComponent(segments[1])}/onboarding-tree`,
      query: new Set(['ref']),
    };
  }
  if (
    segments.length === 5 &&
    segments[0] === 'repos' &&
    segments[2] === 'onboarding-steps' &&
    segments[4] === 'execute' &&
    method === 'POST'
  ) {
    return {
      method,
      path:
        `/repos/${encodeURIComponent(segments[1])}` +
        `/onboarding-steps/${encodeURIComponent(segments[3])}/execute`,
      query: new Set(['ref']),
    };
  }
  if (
    segments.length === 3 &&
    segments[0] === 'repos' &&
    segments[2] === 'technical-tree' &&
    method === 'GET'
  ) {
    return {
      method,
      path: `/repos/${encodeURIComponent(segments[1])}/technical-tree`,
      query: new Set(['x', 'y', 'width', 'height', 'zoom', 'refName']),
    };
  }
  if (
    segments.length === 3 &&
    segments[0] === 'repos' &&
    segments[2] === 'product-tree' &&
    method === 'GET'
  ) {
    return {
      method,
      path: `/repos/${encodeURIComponent(segments[1])}/product-tree`,
      query: new Set(['ref']),
    };
  }
  if (
    segments.length === 3 &&
    segments[0] === 'repos' &&
    segments[2] === 'provider-state' &&
    method === 'GET'
  ) {
    return {
      method,
      path: `/repos/${encodeURIComponent(segments[1])}/provider-state`,
      query: new Set(['refName', 'surface']),
    };
  }
  if (
    segments.length === 3 &&
    segments[0] === 'nodes' &&
    segments[2] === 'overlay' &&
    method === 'GET'
  ) {
    return {
      method,
      path: `/nodes/${encodeURIComponent(segments[1])}/overlay`,
      query: NO_QUERY,
    };
  }
  if (
    segments.length === 3 &&
    segments[0] === 'nodes' &&
    segments[2] === 'agent-skill-md' &&
    method === 'PUT'
  ) {
    return {
      method,
      path: `/nodes/${encodeURIComponent(segments[1])}/agent-skill-md`,
      query: NO_QUERY,
    };
  }
  if (
    segments.length === 4 &&
    segments[0] === 'nodes' &&
    segments[2] === 'agent-skill-md' &&
    segments[3] === 'history' &&
    method === 'GET'
  ) {
    return {
      method,
      path: `/nodes/${encodeURIComponent(segments[1])}/agent-skill-md/history`,
      query: new Set(['limit']),
    };
  }
  if (
    segments.length === 3 &&
    segments[0] === 'integrations' &&
    segments[1] === 'github' &&
    segments[2] === 'status' &&
    method === 'GET'
  ) {
    return {
      method,
      path: '/integrations/github/status',
      query: NO_QUERY,
    };
  }
  if (
    segments.length === 3 &&
    segments[0] === 'integrations' &&
    segments[1] === 'github' &&
    segments[2] === 'install' &&
    method === 'GET'
  ) {
    return {
      method,
      path: '/integrations/github/install',
      query: NO_QUERY,
      redirect: true,
    };
  }
  if (
    segments.length === 3 &&
    segments[0] === 'integrations' &&
    segments[1] === 'jira' &&
    segments[2] === 'connect' &&
    method === 'GET'
  ) {
    return {
      method,
      path: '/integrations/jira/connect',
      query: NO_QUERY,
      redirect: true,
    };
  }
  if (
    segments.length === 3 &&
    segments[0] === 'integrations' &&
    segments[1] === 'jira' &&
    segments[2] === 'status' &&
    method === 'GET'
  ) {
    return {
      method,
      path: '/integrations/jira/status',
      query: NO_QUERY,
    };
  }
  if (
    segments.length === 3 &&
    segments[0] === 'integrations' &&
    segments[1] === 'jira' &&
    segments[2] === 'disconnect' &&
    method === 'POST'
  ) {
    return {
      method,
      path: '/integrations/jira/disconnect',
      query: NO_QUERY,
    };
  }
  return null;
}

function authorizationFor(request: NextRequest): string | null {
  const explicit = request.headers.get('authorization');
  if (explicit !== null && BEARER_RE.test(explicit)) return explicit;

  const session = request.cookies.get(SESSION_COOKIE)?.value;
  return session && !/\s/u.test(session) ? `Bearer ${session}` : null;
}

function targetUrl(request: NextRequest, route: CoreRoute): URL {
  const base = getConfig('CORE_INTERNAL_BASE_URL').replace(/\/+$/u, '');
  const target = new URL(`${base}${route.path}`);
  for (const key of route.query) {
    for (const value of request.nextUrl.searchParams.getAll(key)) {
      target.searchParams.append(key, value);
    }
  }
  return target;
}

async function boundedRequestBody(
  request: NextRequest,
): Promise<string | NextResponse> {
  const length = request.headers.get('content-length');
  if (length !== null && /^\d+$/u.test(length) && Number(length) > MAX_REQUEST_BYTES) {
    await request.body?.cancel();
    return NextResponse.json({ error: 'Request too large.' }, { status: 413 });
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: 'Request too large.' }, { status: 413 });
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }
}

async function boundedResponse(response: Response): Promise<NextResponse> {
  const length = response.headers.get('content-length');
  if (length !== null && /^\d+$/u.test(length) && Number(length) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    return NextResponse.json({ error: 'Core service response too large.' }, { status: 502 });
  }

  const reader = response.body?.getReader();
  if (!reader) {
    return new NextResponse(null, {
      status: response.status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return NextResponse.json(
        { error: 'Core service response too large.' },
        { status: 502 },
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new NextResponse(bytes.byteLength === 0 ? null : bytes, {
    status: response.status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function proxy(
  request: NextRequest,
  method: 'GET' | 'POST' | 'PUT',
  segments: readonly string[],
): Promise<NextResponse> {
  const route = coreRoute(method, segments);
  if (route === null) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  const authorization = authorizationFor(request);
  const headers = new Headers({ accept: 'application/json' });
  if (authorization !== null) headers.set('authorization', authorization);

  let body: string | undefined;
  if (method === 'PUT') {
    const parsed = await boundedRequestBody(request);
    if (parsed instanceof NextResponse) return parsed;
    body = parsed;
    headers.set('content-type', 'application/json');
  }

  try {
    const response = await fetch(targetUrl(request, route), {
      method,
      headers,
      body,
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (route.redirect && response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location === null) {
        return NextResponse.json({ error: 'GitHub install unavailable.' }, { status: 502 });
      }
      return NextResponse.redirect(location, response.status);
    }
    return boundedResponse(response);
  } catch {
    return NextResponse.json({ error: 'Core service unavailable.' }, { status: 502 });
  }
}

export async function GET(
  request: NextRequest,
  context: { params: { path: string[] } },
): Promise<NextResponse> {
  return proxy(request, 'GET', context.params.path);
}

export async function PUT(
  request: NextRequest,
  context: { params: { path: string[] } },
): Promise<NextResponse> {
  return proxy(request, 'PUT', context.params.path);
}

export async function POST(
  request: NextRequest,
  context: { params: { path: string[] } },
): Promise<NextResponse> {
  return proxy(request, 'POST', context.params.path);
}
