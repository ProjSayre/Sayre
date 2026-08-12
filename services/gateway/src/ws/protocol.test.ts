import { describe, expect, it } from 'vitest';
import type { ClientToGatewayMessage } from '@sayre/shared-types';
import {
  decodeClientMessage,
  encodeServerMessage,
  isChatChannelMessage,
  ProtocolError,
} from './protocol';

const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';

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

// ---------------------------------------------------------------------------
// CH-05 — the `channel: 'chat'` subscribe/unsubscribe variants. Authored by
// `red` from .pipeline/spec.md before any implementation exists. Every case
// above this line is CH-01..W2-03's and must keep passing untouched (AC-10).
// ---------------------------------------------------------------------------

describe('decodeClientMessage — CH-05 chat channel frames', () => {
  // @spec AC-10
  it('AC-10: a subscribe/unsubscribe frame WITHOUT a channel still decodes byte-identically to the repo variant', () => {
    expect(decodeClientMessage(JSON.stringify({ type: 'subscribe', repoId: 'repo-1' }))).toEqual({
      type: 'subscribe',
      repoId: 'repo-1',
    });
    expect(decodeClientMessage(JSON.stringify({ type: 'unsubscribe', repoId: 'repo-1' }))).toEqual({
      type: 'unsubscribe',
      repoId: 'repo-1',
    });
  });

  // @spec AC-8
  it('AC-8: a chat subscribe frame decodes to exactly { type, channel, conversationId } — an org field in the frame is never carried through', () => {
    const message = decodeClientMessage(
      JSON.stringify({
        type: 'subscribe',
        channel: 'chat',
        conversationId: CONVERSATION_ID,
        orgId: 'attacker-org',
        org_id: 'attacker-org',
      }),
    );

    expect(message).toEqual({ type: 'subscribe', channel: 'chat', conversationId: CONVERSATION_ID });
    expect(Object.keys(message).sort()).toEqual(['channel', 'conversationId', 'type']);
    expect(JSON.stringify(message)).not.toContain('attacker-org');
  });

  // @spec AC-5
  it('AC-5: a chat unsubscribe frame decodes to exactly { type, channel, conversationId }', () => {
    expect(
      decodeClientMessage(
        JSON.stringify({ type: 'unsubscribe', channel: 'chat', conversationId: CONVERSATION_ID }),
      ),
    ).toEqual({ type: 'unsubscribe', channel: 'chat', conversationId: CONVERSATION_ID });
  });

  // @spec EC-26
  it('EC-26: a chat frame with a missing, blank or non-string conversationId is a ProtocolError', () => {
    expect(() => decodeClientMessage(JSON.stringify({ type: 'subscribe', channel: 'chat' }))).toThrow(
      ProtocolError,
    );
    expect(() =>
      decodeClientMessage(JSON.stringify({ type: 'subscribe', channel: 'chat', conversationId: '' })),
    ).toThrow(ProtocolError);
    expect(() =>
      decodeClientMessage(JSON.stringify({ type: 'subscribe', channel: 'chat', conversationId: 42 })),
    ).toThrow(ProtocolError);
    expect(() =>
      decodeClientMessage(
        JSON.stringify({ type: 'unsubscribe', channel: 'chat', conversationId: null }),
      ),
    ).toThrow(ProtocolError);
  });

  // @spec EC-26
  it('EC-26: an unknown channel value is a ProtocolError, never a silently accepted frame', () => {
    expect(() =>
      decodeClientMessage(
        JSON.stringify({ type: 'subscribe', channel: 'graph', conversationId: CONVERSATION_ID }),
      ),
    ).toThrow(ProtocolError);
    expect(() =>
      decodeClientMessage(JSON.stringify({ type: 'subscribe', channel: '', repoId: 'repo-1' })),
    ).toThrow(ProtocolError);
    expect(() =>
      decodeClientMessage(JSON.stringify({ type: 'unsubscribe', channel: 7, repoId: 'repo-1' })),
    ).toThrow(ProtocolError);
  });
});

describe('isChatChannelMessage', () => {
  // @spec AC-10
  it('AC-10: true only for the chat-channel variants — never for the repo or auth frames', () => {
    const chatSubscribe = {
      type: 'subscribe',
      channel: 'chat',
      conversationId: CONVERSATION_ID,
    } as unknown as ClientToGatewayMessage;
    const chatUnsubscribe = {
      type: 'unsubscribe',
      channel: 'chat',
      conversationId: CONVERSATION_ID,
    } as unknown as ClientToGatewayMessage;

    expect(isChatChannelMessage(chatSubscribe)).toBe(true);
    expect(isChatChannelMessage(chatUnsubscribe)).toBe(true);
    expect(isChatChannelMessage({ type: 'subscribe', repoId: 'repo-1' })).toBe(false);
    expect(isChatChannelMessage({ type: 'unsubscribe', repoId: 'repo-1' })).toBe(false);
    expect(isChatChannelMessage({ type: 'auth', token: 'tok-1' })).toBe(false);
  });
});

describe('encodeServerMessage — CH-05 frames', () => {
  // @spec AC-6
  it('AC-6: the chat subscribed reply round-trips with exactly { type, channel, conversationId }', () => {
    const encoded = encodeServerMessage({
      type: 'subscribed',
      channel: 'chat',
      conversationId: CONVERSATION_ID,
    } as never);

    expect(JSON.parse(encoded)).toEqual({
      type: 'subscribed',
      channel: 'chat',
      conversationId: CONVERSATION_ID,
    });
  });
});
