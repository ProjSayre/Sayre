// W3-04 gapfill (GAP-3). Leading-red coverage for the extracted, shared bounded JSON
// reader. spec.md's Interfaces section pins the signature:
//   readBoundedJson<T>(response, context, makeError): Promise<T>
// mechanically lifted from github/appClient.ts's private helper, with the error type
// injected so appClient keeps throwing GithubAppApiError while the git adapter throws
// GithubGitSyncError (Approach step 2).
//
// Broker-free: exercises the Response/ReadableStream Web APIs only.

import { describe, expect, it } from 'vitest';

class FakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FakeError';
  }
}

function makeError(message: string): Error {
  return new FakeError(message);
}

describe('readBoundedJson (GAP-3)', () => {
  // @spec AC-6
  it('parses a small JSON response body using the injected error constructor', async () => {
    const { readBoundedJson } = await import('./boundedJson');
    const response = new Response(JSON.stringify({ hello: 'world' }), { status: 200 });

    await expect(readBoundedJson(response, 'test context', makeError)).resolves.toEqual({
      hello: 'world',
    });
  });

  // @spec AC-6 EC-11
  it('rejects a response whose declared Content-Length exceeds MAX_JSON_RESPONSE_BYTES before buffering', async () => {
    const boundedJson = await import('./boundedJson');
    const oversized = boundedJson.MAX_JSON_RESPONSE_BYTES + 1;
    const response = new Response('{}', {
      status: 200,
      headers: { 'content-length': String(oversized) },
    });

    await expect(
      boundedJson.readBoundedJson(response, 'oversized context', makeError),
    ).rejects.toBeInstanceOf(FakeError);
  });

  // @spec AC-6 EC-11
  it('rejects a response that streams more than MAX_JSON_RESPONSE_BYTES with no declared Content-Length', async () => {
    const boundedJson = await import('./boundedJson');
    const oversized = boundedJson.MAX_JSON_RESPONSE_BYTES + 1024;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(oversized).fill(48)); // ASCII '0'
        controller.close();
      },
    });
    const response = new Response(stream, { status: 200 });

    await expect(
      boundedJson.readBoundedJson(response, 'streamed-oversized context', makeError),
    ).rejects.toBeInstanceOf(FakeError);
  });

  // @spec AC-6
  it('wraps invalid JSON using the injected error constructor rather than throwing a raw SyntaxError', async () => {
    const { readBoundedJson } = await import('./boundedJson');
    const response = new Response('not json', { status: 200 });

    await expect(readBoundedJson(response, 'invalid-json context', makeError)).rejects.toBeInstanceOf(
      FakeError,
    );
  });
});
