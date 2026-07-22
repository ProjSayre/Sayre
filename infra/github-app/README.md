# Sayre GitHub App — creation & per-environment recreation

W1-06 registers Sayre as a GitHub App. The App itself is **not** something
Sayre creates at runtime — it is a one-time (per environment) manual step
using GitHub's "Create GitHub App from manifest" flow, driven by
[`manifest.json`](./manifest.json) in this directory. This doc is the
recreation runbook: how to (re)create the App for `development`, `staging`,
and `production`, and which resulting values populate `infra/.env`
(see `infra/.env.example`).

No raw App credential (private key, client secret, webhook secret, or any
minted installation token) is ever committed to this repo, logged, or stored
anywhere but the per-environment secret store (MVP: gitignored `infra/.env`,
seeded from the committed placeholder-only `infra/.env.example` — see
`.claude/rules/security-multitenancy.md` and `SECRETS.md`).

## Why a manifest

The manifest ([`manifest.json`](./manifest.json)) is the portable, checked-in
source of truth for the App's shape (permissions, subscribed webhook events,
webhook/callback URLs). Recreating the App from this file for a new
environment (or after deleting a dev App) reproduces the exact same
configuration — no manual clicking through GitHub's App-settings UI to
re-derive permissions/events by hand.

The manifest uses the placeholder host `__SAYRE_HOST__` in `url`,
`hook_attributes.url`, `redirect_url`, and `setup_url` — replace this with the
real per-environment host before starting the creation flow (see steps below).
`hook_attributes.url` always resolves to `<host>/webhooks/github` (the
existing W1-02 webhook receiver); `redirect_url` and `setup_url` both resolve
to `<host>/integrations/github/callback` (this ticket's callback route).

## Per-environment recreation steps

1. **Pick the host** for this environment (e.g. `http://localhost:4000` for
   local dev via a tunnel such as `smee.io`/`ngrok` since GitHub cannot reach
   `localhost` directly for webhook delivery; the real `staging`/`production`
   domain otherwise). Replace every `__SAYRE_HOST__` in a LOCAL COPY of
   `manifest.json` (do not commit the substituted file — the checked-in copy
   keeps the placeholder).
2. Go to GitHub → your org/user Settings → **Developer settings** → **GitHub
   Apps** → **New GitHub App** → use the **"create a GitHub App from a
   manifest"** flow (POST the manifest JSON as the `manifest` form field per
   [GitHub's manifest flow docs](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)),
   or paste the manifest into the UI's manifest-import screen if offered for
   your account type.
3. GitHub creates the App and redirects to `redirect_url` with a one-time
   `code` query param. Exchange it (`POST
   https://api.github.com/app-manifests/{code}/conversions`, no auth
   required) to receive the App's `id`, `slug`, `client_id`, `client_secret`,
   `pem` (private key), and `webhook_secret`. This exchange is a manual,
   one-time step per environment — Sayre has no runtime code for it (out of
   scope for W1-06; see spec.md "Out").
4. Populate `infra/.env` (never commit the populated file — `infra/.env` is
   gitignored; `infra/.env.example` holds placeholders only):
   - `GITHUB_APP_SLUG` = the App's `slug`
   - `GITHUB_APP_ID` = the App's numeric `id`
   - `GITHUB_APP_CLIENT_ID` = the App's `client_id`
   - `GITHUB_APP_PRIVATE_KEY` = the App's `pem` (the full private key,
     including the `-----BEGIN/END-----` lines)
   - `GITHUB_APP_CLIENT_SECRET` = the App's `client_secret` (provisioned but
     currently unused at runtime — W1-06 skips the OAuth `code` exchange at
     MVP; org binding comes from the signed `state` token, not GitHub
     identity — see spec.md O-3)
   - `GITHUB_WEBHOOK_SECRET` = the App's `webhook_secret`
5. Restart core (`services/core`) so the new `infra/.env` values are picked
   up by `@sayre/config` / the W0-07 secret loader.
6. From the App's settings page, click **Install App** on your test
   org/account to exercise `GET /integrations/github/install` →
   `GET /integrations/github/callback` end to end.

## Recreating after deleting a dev App

Deleting and recreating a GitHub App issues a NEW `id`/`slug`/keys — repeat
steps 2–5 above and update `infra/.env` again. Any `github_app_installations`
rows tied to the old App's installations become orphaned (their
`installation_id` values no longer correspond to any real GitHub
installation); this is expected for local dev churn and requires no cleanup
beyond re-installing the new App.

## Local dev: `DEV_ORG_ID` must be a real org UUID

`GET /integrations/github/callback` performs real tenant-scoped Postgres
writes via `withOrgContext`, which requires a UUID `org_id` matching an
existing `organizations.id` row (see `infra/.env.example` for the full
explanation and the fixed dev-seed org UUID + seed command). The default
`DEV_ORG_ID=org_dev_local` is **not** a UUID and will fail `withOrgContext`'s
UUID check the moment the callback tries to write — override `DEV_ORG_ID`
locally (after seeding the org row) before exercising step 6 above.
