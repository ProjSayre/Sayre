import { Router } from 'express';
import { handleGithubLoginCallback, startGithubLogin } from '../services/loginService';
import { asyncHandler } from '../http/express';

// Thin wrapper only — no business logic here (service-layer rule). Browser-
// facing routes: mounted after express.json() in app.ts. Neither route runs
// authenticate()/authorize() — the login-start route IS the unauthenticated
// entry point, and the callback route's trust anchor is the signed `state`
// JWT (auth/loginState.ts), exactly like the GitHub App install callback
// (routes/githubInstall.ts) — there is no session yet on either request.
//
// Only `code`, `state`, and an optional `redirect_to` are ever read from the
// request — NEVER `org_id`, and never any other query/body/header value that
// could influence tenancy (.claude/rules/security-multitenancy.md).
export const loginRouter = Router();

loginRouter.get(
  '/auth/github/login',
  asyncHandler(async (req, res) => {
    const result = await startGithubLogin({
      redirectTo: req.query.redirect_to as string | undefined,
    });
    res.redirect(302, result.redirectTo);
  }),
);

loginRouter.get(
  '/auth/github/callback',
  asyncHandler(async (req, res) => {
    const result = await handleGithubLoginCallback({
      code: req.query.code as string | undefined,
      state: req.query.state as string | undefined,
    });
    res.redirect(302, result.redirectTo);
  }),
);
