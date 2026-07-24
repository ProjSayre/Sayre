import { getConfig } from '@sayre/config';
import { type NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF_RE = /^refs\/[^\s]{1,500}$/;
const SURFACES = new Set(['product', 'onboarding', 'chatbot']);

export async function GET(
  request: NextRequest,
  context: { params: { repoId: string } },
): Promise<NextResponse> {
  const refName = request.nextUrl.searchParams.get('refName');
  const surface = request.nextUrl.searchParams.get('surface');
  if (
    !UUID_RE.test(context.params.repoId) ||
    refName === null ||
    !REF_RE.test(refName) ||
    surface === null ||
    !SURFACES.has(surface)
  ) {
    return NextResponse.json({ error: 'invalid provider state request' }, { status: 400 });
  }

  const target = new URL(
    `/repos/${encodeURIComponent(context.params.repoId)}/provider-state`,
    getConfig('CORE_INTERNAL_BASE_URL'),
  );
  target.searchParams.set('refName', refName);
  target.searchParams.set('surface', surface);
  const authorization = request.headers.get('authorization');

  try {
    const response = await fetch(target, {
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        ...(authorization === null ? {} : { authorization }),
      },
      signal: request.signal,
    });
    const payload: unknown = await response.json();
    return NextResponse.json(payload, { status: response.status });
  } catch {
    return NextResponse.json({ error: 'provider state unavailable' }, { status: 502 });
  }
}
