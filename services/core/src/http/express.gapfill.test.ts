// Red-stage (W1-02 gapfill) unit coverage for the two errorHandler obligations this
// ticket adds: AC-3's InstallationResolutionInputError -> 400 mapping (so a malformed
// installation id can never reach the generic 500 fallback from ANY route, not just the
// webhook one) and AC-6's fixed-string warning on the entity.too.large branch.
//
// Mirrors the per-error-type unit style already in http/express.test.ts.

import { describe, expect, it, vi, afterEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { errorHandler } from './express';
import { InstallationResolutionInputError } from '../db/installations';

function makeRes(): Response {
  const res = {} as Response;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

function jsonArg(res: Response): unknown {
  return (res.json as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('errorHandler — InstallationResolutionInputError (AC-3 / GAP-6)', () => {
  // @spec AC-3 EC-12
  it('maps InstallationResolutionInputError to 400 { error: "bad request" }, never 500', () => {
    const res = makeRes();

    errorHandler(new InstallationResolutionInputError(), {} as Request, res, (() => {}) as NextFunction);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'bad request' });
  });

  // @spec EC-12
  it('never leaks the error message beyond the fixed body', () => {
    const res = makeRes();
    const err = new InstallationResolutionInputError();

    errorHandler(err, {} as Request, res, (() => {}) as NextFunction);

    const serialized = JSON.stringify(jsonArg(res));
    expect(serialized).toBe(JSON.stringify({ error: 'bad request' }));
    expect(serialized).not.toContain(err.message);
    expect(serialized).not.toContain('Installation id');
  });
});

describe('errorHandler — oversized-body warning (AC-6 / GAP-9)', () => {
  // @spec AC-6 EC-21
  it('still answers entity.too.large with 413 { error: "payload too large" }', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = makeRes();

    errorHandler({ type: 'entity.too.large' }, {} as Request, res, (() => {}) as NextFunction);

    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json).toHaveBeenCalledWith({ error: 'payload too large' });
  });

  // @spec AC-6 EC-21
  it('emits exactly one warning on the entity.too.large branch', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = makeRes();

    errorHandler({ type: 'entity.too.large' }, {} as Request, res, (() => {}) as NextFunction);

    expect(warn).toHaveBeenCalledTimes(1);
  });

  // "Fixed string" is testable structurally: two entity.too.large errors carrying wildly
  // different attacker-controlled fields must produce byte-identical log output. An
  // implementation that interpolated any part of the error (message, body, headers)
  // would fail this.
  // @spec AC-6 EC-21
  it('logs a fixed string — identical output for two errors with different attacker-controlled fields', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    errorHandler(
      {
        type: 'entity.too.large',
        message: 'request entity too large',
        limit: 5242880,
        length: 9999999,
        body: 'SECRET-BODY-MARKER',
        headers: { 'x-hub-signature-256': 'sha256=deadbeef' },
      },
      {} as Request,
      makeRes(),
      (() => {}) as NextFunction,
    );
    errorHandler(
      {
        type: 'entity.too.large',
        message: 'totally different message',
        body: 'OTHER-BODY-MARKER',
      },
      {} as Request,
      makeRes(),
      (() => {}) as NextFunction,
    );

    expect(warn).toHaveBeenCalledTimes(2);
    const first = warn.mock.calls[0].map(String).join(' ');
    const second = warn.mock.calls[1].map(String).join(' ');
    expect(first).toBe(second);
    expect(first).not.toContain('SECRET-BODY-MARKER');
    expect(first).not.toContain('sha256=deadbeef');
    expect(first).not.toContain('totally different message');
  });

  // Regression guard: the new warning must not start firing for unrelated errors.
  // @spec AC-6
  it('does not warn for an ordinary unmapped error', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = makeRes();

    errorHandler(new Error('something else'), {} as Request, res, (() => {}) as NextFunction);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(warn).not.toHaveBeenCalled();
  });
});
