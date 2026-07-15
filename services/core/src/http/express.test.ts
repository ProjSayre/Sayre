import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { asyncHandler, errorHandler, NotImplementedError } from './express';
import { ViewportParseError } from './viewport';

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
});
