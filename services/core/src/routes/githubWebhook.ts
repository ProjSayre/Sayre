import { Router } from 'express';
import { handleGithubWebhook } from '../services/githubWebhookService';
import { asyncHandler } from '../http/express';

// Thin wrapper only — no business logic here (service-layer rule). This route reads
// the RAW request body (see app.ts wiring: mounted before express.json()) so
// signature validation runs over the exact bytes GitHub signed. Unauthenticated by
// design (GitHub is the caller) — auth is the HMAC signature only, never
// authenticate()/authorize() (W1-03) or a session.
export const githubWebhookRouter = Router();

// Mounted at the '/webhooks/github' prefix in app.ts (so express.raw() is scoped to
// this path only) — the route itself is relative to that mount point.
githubWebhookRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const outcome = await handleGithubWebhook({
      rawBody: req.body as Buffer,
      signature: req.header('x-hub-signature-256'),
      githubEvent: req.header('x-github-event'),
      deliveryId: req.header('x-github-delivery'),
    });
    const status = outcome.status === 'published' ? 202 : 200;
    const body =
      outcome.status === 'ignored' ? { ok: true, ignored: outcome.reason } : { ok: true };
    res.status(status).json(body);
  }),
);
