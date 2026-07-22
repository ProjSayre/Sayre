import { describe, expect, it } from 'vitest';
import { decodeClientMessage, encodeServerMessage, ProtocolError } from './protocol';

describe('decodeClientMessage', () => {
  it('decodes a valid auth frame from a string', () => {
    const msg = decodeClientMessage(JSON.stringify({ type: 'auth', token: 'tok-1' }));
    expect(msg).toEqual({ type: 'auth', token: 'tok-1' });
  });

  it('decodes a valid subscribe frame from a Buffer', () => {
    const raw = Buffer.from(JSON.stringify({ type: 'subscribe', repoId: 'repo-1' }));
    const msg = decodeClientMessage(raw);
    expect(msg).toEqual({ type: 'subscribe', repoId: 'repo-1' });
  });

  it('decodes a valid unsubscribe frame', () => {
    const msg = decodeClientMessage(JSON.stringify({ type: 'unsubscribe', repoId: 'repo-1' }));
    expect(msg).toEqual({ type: 'unsubscribe', repoId: 'repo-1' });
  });

  it('throws ProtocolError for non-JSON input, never crashes', () => {
    expect(() => decodeClientMessage('not json')).toThrow(ProtocolError);
  });

  it('throws ProtocolError for a JSON array (not an object)', () => {
    expect(() => decodeClientMessage(JSON.stringify([1, 2, 3]))).toThrow(ProtocolError);
  });

  it('throws ProtocolError for an unknown frame type', () => {
    expect(() => decodeClientMessage(JSON.stringify({ type: 'nope' }))).toThrow(ProtocolError);
  });

  it('throws ProtocolError when auth frame is missing a token', () => {
    expect(() => decodeClientMessage(JSON.stringify({ type: 'auth' }))).toThrow(ProtocolError);
    expect(() => decodeClientMessage(JSON.stringify({ type: 'auth', token: '' }))).toThrow(ProtocolError);
  });

  it('throws ProtocolError when subscribe/unsubscribe frames are missing repoId', () => {
    expect(() => decodeClientMessage(JSON.stringify({ type: 'subscribe' }))).toThrow(ProtocolError);
    expect(() => decodeClientMessage(JSON.stringify({ type: 'unsubscribe', repoId: 123 }))).toThrow(
      ProtocolError,
    );
  });

  it('never accepts a token from a shape resembling a query string (only the declared "token" field matters)', () => {
    const msg = decodeClientMessage(
      JSON.stringify({ type: 'auth', token: 'real-token', query: '?token=evil' }),
    );
    expect(msg).toEqual({ type: 'auth', token: 'real-token' });
  });
});

describe('encodeServerMessage', () => {
  it('round-trips through JSON', () => {
    const encoded = encodeServerMessage({ type: 'subscribed', repoId: 'repo-1' });
    expect(JSON.parse(encoded)).toEqual({ type: 'subscribed', repoId: 'repo-1' });
  });
});
