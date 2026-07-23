import { getConfig } from '@sayre/config';
import { NextResponse, type NextRequest } from 'next/server';

const MAX_REQUEST_BYTES = 16_384;
const MAX_RESPONSE_BYTES = 262_144;
const REQUEST_TIMEOUT_MS = 5_000;

function upstreamUrl(purpose?: string): string {
  const base = getConfig('CORE_INTERNAL_BASE_URL').replace(/\/+$/, '');
  return `${base}/settings/model-providers${purpose ? `/${encodeURIComponent(purpose)}` : ''}`;
}

function forwardedHeaders(request: NextRequest, hasBody: boolean): Headers {
  const headers = new Headers({ accept: 'application/json' });
  const authorization = request.headers.get('authorization');
  if (authorization) headers.set('authorization', authorization);
  if (hasBody) headers.set('content-type', 'application/json');
  return headers;
}

async function boundedResponse(response: Response): Promise<NextResponse> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    return NextResponse.json({ error: 'Provider settings service unavailable.' }, { status: 502 });
  }
  return new NextResponse(bytes, {
    status: response.status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function proxy(
  request: NextRequest,
  method: 'GET' | 'PUT',
  purpose?: string,
): Promise<NextResponse> {
  let body: string | undefined;
  if (method === 'PUT') {
    body = await request.text();
    if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
      return NextResponse.json({ error: 'Request too large.' }, { status: 413 });
    }
  }
  try {
    const response = await fetch(upstreamUrl(purpose), {
      method,
      headers: forwardedHeaders(request, body !== undefined),
      body,
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return boundedResponse(response);
  } catch {
    return NextResponse.json(
      { error: 'Provider settings service unavailable.' },
      { status: 502 },
    );
  }
}

export async function GET(
  request: NextRequest,
  context: { params: { purpose?: string[] } },
) {
  if (context.params.purpose?.length) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }
  return proxy(request, 'GET');
}

export async function PUT(
  request: NextRequest,
  context: { params: { purpose?: string[] } },
) {
  const purpose = context.params.purpose;
  if (!purpose || purpose.length !== 1) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }
  return proxy(request, 'PUT', purpose[0]);
}
