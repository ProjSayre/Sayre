import { getConfig } from '@sayre/config';
import { NextResponse, type NextRequest } from 'next/server';

const MAX_REQUEST_BYTES = 16_384;
const MAX_RESPONSE_BYTES = 262_144;
const MAX_BODY_CHUNKS = 256;
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

async function boundedRequestBody(
  request: NextRequest,
): Promise<{ body: string } | { response: NextResponse }> {
  const contentLength = request.headers.get('content-length');
  if (
    contentLength !== null &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > MAX_REQUEST_BYTES
  ) {
    await request.body?.cancel();
    return {
      response: NextResponse.json({ error: 'Request too large.' }, { status: 413 }),
    };
  }
  const reader = request.body?.getReader();
  if (!reader) return { body: '' };
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (chunks.length <= MAX_BODY_CHUNKS) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > MAX_REQUEST_BYTES || chunks.length === MAX_BODY_CHUNKS) {
      await reader.cancel();
      return {
        response: NextResponse.json(
          { error: 'Request too large.' },
          { status: 413 },
        ),
      };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { body: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return {
      response: NextResponse.json({ error: 'Invalid request.' }, { status: 400 }),
    };
  }
}

async function boundedResponse(response: Response): Promise<NextResponse> {
  const contentLength = response.headers.get('content-length');
  if (
    contentLength !== null &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > MAX_RESPONSE_BYTES
  ) {
    await response.body?.cancel();
    return NextResponse.json({ error: 'Provider settings service unavailable.' }, { status: 502 });
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
  while (chunks.length <= MAX_BODY_CHUNKS) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > MAX_RESPONSE_BYTES || chunks.length === MAX_BODY_CHUNKS) {
      await reader.cancel();
      return NextResponse.json(
        { error: 'Provider settings service unavailable.' },
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
  return new NextResponse(byteLength === 0 ? null : bytes, {
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
    try {
      const bounded = await boundedRequestBody(request);
      if ('response' in bounded) return bounded.response;
      body = bounded.body;
    } catch {
      return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
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
