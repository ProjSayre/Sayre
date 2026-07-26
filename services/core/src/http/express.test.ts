import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { asyncHandler, errorHandler, NotImplementedError } from './express';
import { ViewportParseError } from './viewport';
import { LoginCallbackBadRequestError } from '../services/loginService';
import {
  GithubOAuthApiError,
  GithubOAuthCodeError,
  NoVerifiedEmailError,
} from '../github/oauthClient';

function makeRes(): Response {
  const res = {} as Response;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe('asyncHandler', () => {
  it('forwards a resolved value without calling next', async () => {
    const handler = asyncHandler(async (_req, res) => {
      res.json({ ok: true });
    });
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    await handler({} as Request, res, next);

    expect(res.json).toHaveBeenCalledWith({ ok: true });
    expect(next).not.toHaveBeenCalled();
  });

  it('catches a rejected promise from an async handler and forwards it to next', async () => {
    const boom = new Error('boom');
    const handler = asyncHandler(async () => {
      throw boom;
    });
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    handler({} as Request, res, next);
    // allow the microtask queue to flush the rejection -> .catch(next)
    await new Promise((resolve) => setImmediate(resolve));

    expect(next).toHaveBeenCalledWith(boom);
  });
});

describe('errorHandler', () => {
  it('maps ViewportParseError to 400 with the parse-error message', () => {
    const res = makeRes();
    const err = new ViewportParseError('viewport.width must be > 0');

    errorHandler(err, {} as Request, res, (() => {}) as NextFunction);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'viewport.width must be > 0' });
  });

  it('maps NotImplementedError to 501', () => {
    const res = makeRes();
    const err = new NotImplementedError('not implemented yet');

    errorHandler(err, {} as Request, res, (() => {}) as NextFunction);

    expect(res.status).toHaveBeenCalledWith(501);
    expect(res.json).toHaveBeenCalledWith({ error: 'Not implemented' });
  });

  it('maps an unknown error to 500 with a fixed safe body — never the stack or raw message', () => {
    const res = makeRes();
    const err = new Error('some sensitive internal detail: connection string leaked');

    errorHandler(err, {} as Request, res, (() => {}) as NextFunction);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' });
    const jsonArg = (res.json as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
    const serialized = JSON.stringify(jsonArg);
    expect(serialized).not.toContain('sensitive internal detail');
    expect(serialized).not.toContain('connection string');
  });

  it('maps a non-Error thrown value to 500 without leaking it', () => {
    const res = makeRes();

    errorHandler('a raw string throw', {} as Request, res, (() => {}) as NextFunction);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' });
  });

  // AUTH-01 ("Sign in with GitHub"): spec.md's errorHandler mapping table for
  // the four new error types had no direct test anywhere — loginService.test.ts
  // only asserts the SERVICE throws the right error class, never that
  // errorHandler.ts actually maps it to the documented status code/body. Added
  // here, mirroring this file's existing per-error-type unit style.
  describe('AUTH-01 error mappings', () => {
    it('maps LoginCallbackBadRequestError to 400 with a generic body (no message leakage)', () => {
      const res = makeRes();
      const err = new LoginCallbackBadRequestError('Invalid or expired state: nonce mismatch xyz');

      errorHandler(err, {} as Request, res, (() => {}) as NextFunction);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'bad request' });
    });

    it('maps GithubOAuthCodeError to 400 with a generic body', () => {
      const res = makeRes();
      const err = new GithubOAuthCodeError();

      errorHandler(err, {} as Request, res, (() => {}) as NextFunction);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'bad request' });
    });

    it('maps NoVerifiedEmailError to 422 with its documented body', () => {
      const res = makeRes();
      const err = new NoVerifiedEmailError();

      errorHandler(err, {} as Request, res, (() => {}) as NextFunction);

      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.json).toHaveBeenCalledWith({
        error: 'no usable verified email on the GitHub account',
      });
    });

    it('maps GithubOAuthApiError to 502 with a generic body (never the transport detail)', () => {
      const res = makeRes();
      const err = new GithubOAuthApiError('ECONNREFUSED talking to 10.0.0.5:443 (internal)');

      errorHandler(err, {} as Request, res, (() => {}) as NextFunction);

      expect(res.status).toHaveBeenCalledWith(502);
      expect(res.json).toHaveBeenCalledWith({ error: 'GitHub authentication request failed' });
      const jsonArg = (res.json as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
      expect(JSON.stringify(jsonArg)).not.toContain('10.0.0.5');
    });
  });
});
