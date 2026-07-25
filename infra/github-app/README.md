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
`hook_attributes.url`, `redirect_url`, and `callback_urls` — replace this with
the real per-environment host before starting the creation flow (see steps
below). `hook_attributes.url` always resolves to `<host>/webhooks/github` (the
existing W1-02 webhook receiver). The OAuth callback URL resolves to
`<host>/integrations/github/callback`.

`request_oauth_on_install` is intentionally enabled. GitHub therefore sends a
one-time user OAuth `code` with the installation callback. Sayre exchanges
that code in memory, verifies that the GitHub user owns the personal
installation account or is an active admin of the installation organization,
and only then binds the installation to the Sayre organization carried in the
signed `state`. The App requests read-only `members` permission solely for
that organization-admin check. The manifest also sets `public: true`; a
private App can only be installed on the account that owns it, so it cannot
serve target-customer organizations.

## Updating an existing App safely

The manifest creates an App; it does not patch an App that already exists.
For an existing staging or production registration, take an App-settings
snapshot and use this rollout order:

1. Temporarily gate the Sayre **Install GitHub App** action so no installation
   callback can arrive while GitHub settings and the deployed callback code
   disagree.
2. Provision `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET`, run the
   current database migrations, and stage the hardened Core build without
   sending callback traffic to it yet.
3. In GitHub App settings, set the user-authorization callback URL to
   `<host>/integrations/github/callback`. Remove the old setup URL if GitHub
   requires it; GitHub does not allow a setup URL while OAuth-on-install is
   enabled.
4. Enable **Request user authorization (OAuth) during installation**, add
   read-only **Members** organization permission, and make the App public.
   Adding `members: read` makes GitHub ask each existing installation owner to
   approve the new permission. Until that approval is accepted, do not claim
   that the affected installation has completed this hardened onboarding
   flow.
5. Route traffic to the hardened Core build, perform a fresh owner/admin
   install from a separate target-customer test organization, and verify the
   callback, installation row, repository rows, and initial-parse messages.
6. Re-enable the Sayre install action only after that test passes. Track
   permission reapproval for every pre-existing installation.

Do not roll back only the GitHub settings or only the callback code. Prefer a
roll-forward fix. For an emergency rollback, first gate all new installs,
restore the full settings snapshot (callback/setup URL, OAuth-on-install,
Members permission, and visibility) and the matching prior Core build while
the gate remains closed, then test before reopening. Callbacks that arrive
during a mismatch fail closed and their users must restart the install flow;
installation tokens and OAuth codes are never retained for replay.

GitHub documents the [OAuth-on-install and permission-change
behavior](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration)
and the distinction between [public and private GitHub
Apps](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app#making-a-github-app-public-or-private).

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
   `pem` (private key), and `webhook_secret`. This **manifest-conversion code**
   is distinct from the per-install OAuth code used by the runtime callback.
   The manifest conversion remains a manual, one-time step per environment.
4. Populate `infra/.env` (never commit the populated file — `infra/.env` is
   gitignored; `infra/.env.example` holds placeholders only):
   - `GITHUB_APP_SLUG` = the App's `slug`
   - `GITHUB_APP_ID` = the App's numeric `id`
   - `GITHUB_APP_CLIENT_ID` = the App's `client_id`
   - `GITHUB_APP_PRIVATE_KEY` = the App's `pem` (the full private key,
     including the `-----BEGIN/END-----` lines)
   - `GITHUB_APP_CLIENT_SECRET` = the App's `client_secret` (used only
     server-side to exchange the one-time install OAuth code; never sent to
     the browser, persisted, or logged)
   - `GITHUB_WEBHOOK_SECRET` = the App's `webhook_secret`
5. Restart core (`services/core`) so the new `infra/.env` values are picked
   up by `@sayre/config` / the W0-07 secret loader.
6. From the App's settings page, click **Install App** on your test
   org/account to exercise `GET /integrations/github/install` →
   GitHub install + user authorization →
   `GET /integrations/github/callback` end to end. The authorizing GitHub user
   must own a personal installation account or be an active admin of the
   organization account.

## Known install/reconciliation limits

- The callback intentionally processes at most 25 repositories. Repositories
  after GitHub's first 25 results are neither registered nor queued for an
  initial parse. There is currently no background pagination, warning in the
  product UI, or reconciliation job, and the subscribed
  `installation_repositories` event is not yet applied. An installation with
  more than 25 selected repositories therefore must **not** be described as
  fully synchronized.
- An organization member who cannot install the App can send an owner-approval
  request. The `setup_action=request` callback has no installation to bind, so
  Sayre safely writes and queues nothing. A later signed
  `installation.created` webhook identifies the new GitHub installation but
  carries no authenticated Sayre tenant binding; the lifecycle handler
  therefore cannot adopt it and intentionally ignores unknown `created`
  events.
- The secure MVP recovery for an approved request is for an organization owner
  to restart the install from Sayre while authenticated to the intended Sayre
  organization. That produces a fresh signed `state`, OAuth code, and
  installation ID that can be checked together.

Automatic approval reconciliation needs a separate ticket and schema: a
short-lived, single-use pending-install intent bound to the Sayre org and an
authoritative GitHub target account ID, plus a compare-and-consume path that
binds a later installation exactly once. The request callback does not expose
enough authoritative identity today to implement that safely from its
`state` alone. Required tests include request/approval by different users,
lost or replayed state, duplicate approvals, expiry, wrong-org conflicts, and
out-of-order `installation.created` webhook/callback delivery. GitHub
documents that unauthorized members can [request owner
approval](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party)
and that `installation.created` means an App was actually
installed in the [installation webhook
contract](https://docs.github.com/en/webhooks/webhook-events-and-payloads#installation).

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
