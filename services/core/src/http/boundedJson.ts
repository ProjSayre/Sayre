// W3-04 gapfill (GAP-3). Shared bounded JSON response reader, mechanically extracted
// from github/appClient.ts's former private `readBoundedJson` so both that client and
// the git adapter (services/core/src/integrations/git/providers/github.ts) share one
// implementation instead of two copies drifting apart. The error TYPE is injected via
// `makeError` so each caller keeps throwing its own domain error
// (appClient -> GithubAppApiError, the git adapter -> GithubGitSyncError) — behavior for
// appClient is byte-for-byte unchanged by this extraction.

export const MAX_JSON_RESPONSE_BYTES: number = 256 * 1024;

/**
 * Reads `response.body`, rejecting (via `makeError`) before fully buffering a response
 * that declares (Content-Length) or streams more than `MAX_JSON_RESPONSE_BYTES`. Also
 * wraps a JSON parse failure and a null/empty body the same way, rather than letting a
 * raw `SyntaxError`/`TypeError` escape.
 */
export async function readBoundedJson<T>(
  response: Response,
  context: string,
  makeError: (message: string) => Error,
): Promise<T> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
      throw makeError(`${context} returned an invalid Content-Length.`);
    }
    if (declaredBytes > MAX_JSON_RESPONSE_BYTES) {
      throw makeError(`${context} returned an oversized response.`);
    }
  }

  if (response.body === null) {
    throw makeError(`${context} returned an empty response.`);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.byteLength;
    if (receivedBytes > MAX_JSON_RESPONSE_BYTES) {
      await reader.cancel();
      throw makeError(`${context} returned an oversized response.`);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(body)) as T;
  } catch {
    throw makeError(`${context} returned invalid JSON.`);
  }
}
