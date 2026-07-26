import { type NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const SESSION_COOKIE = 'sayre_session';
const BEARER_RE = /^Bearer ([^\s]{1,8192})$/u;

function sessionToken(request: NextRequest): string | null {
  return request.headers.get('authorization')?.match(BEARER_RE)?.[1] ?? null;
}

/**
 * Mirrors the fragment-delivered session into an HttpOnly, same-site session
 * cookie. The browser still keeps the token for first-frame WebSocket auth;
 * the cookie lets full-page navigations (notably GitHub App installation)
 * authenticate through the browser-for-frontend without putting a token in a
 * URL.
 */
export function POST(request: NextRequest): NextResponse {
  const token = sessionToken(request);
  if (token === null) {
    return NextResponse.json({ error: 'Unauthenticated.' }, { status: 401 });
  }

  const response = new NextResponse(null, { status: 204 });
  response.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  });
  return response;
}

export function DELETE(): NextResponse {
  const response = new NextResponse(null, { status: 204 });
  response.cookies.set({
    name: SESSION_COOKIE,
    value: '',
    expires: new Date(0),
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  });
  return response;
}
