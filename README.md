# sayre_ — marketing site + staged demo

Static marketing site with a fully client-side interactive demo of Sayre, an AI-powered
codebase visualization platform. Everything the demo shows runs on a hand-authored,
fictional dataset (`acme/monorepo`) baked into the bundle — no backend, no auth, no live AI.

Spec: `Documents/Spec/SAYRE_FRONTEND_SPEC.md` · Design system: `Design System/SAYRE_DESIGN_SYSTEM.md`

## Stack

Vite + React 18 + TypeScript · react-router-dom · d3-hierarchy (layout math only) ·
hand-rolled SVG canvas · vanilla CSS custom properties. Runtime dependency budget is
capped at `react`, `react-dom`, `react-router-dom`, `d3-hierarchy`.

## Develop

```sh
npm install
npm run dev        # http://localhost:5173  (routes: /  and  /demo)
npm run build      # tsc --noEmit + vite build → dist/
npm run preview    # serve the production build
npm run og         # regenerate public/og.png (dev-only script; commit the output)
```

## Configuration (`src/config.ts`)

| const | notes |
|---|---|
| `WAITLIST_ENDPOINT` | Google Form URL **or** Formspree-style JSON endpoint. **Must be set before any email campaign.** While empty: dev builds log the payload and fake success; production builds show a mailto fallback and never fake success. |
| `GOOGLE_FORM_ENTRIES` | only for Google Form mode: the form's `entry.NNN` ids for email / company / source. |
| `CONTACT_EMAIL` | mailto target for `contact` / fallbacks. |
| `SITE_URL` | absolute base for OG tags (also hardcoded in `index.html` — keep in sync). |
| `PLAUSIBLE_DOMAIN` | optional; empty = no analytics script injected. |

### Waitlist: Google Form mode (accepted tradeoff)

Google Forms sends no CORS headers, so the **browser cannot read Google's
response** — the site shows success whenever the request completes, even if
Google silently rejected it (deleted form, closed responses, changed entry
ids). This is a deliberate tradeoff (team decision 2026-07-11) in exchange for
a free, unlimited endpoint with responses in a familiar Sheet.

Mitigation: run **`npm run test:waitlist`** periodically — Node *can* read the
response, so the script submits a real test row and fails loudly if the form
is gone or the entry ids stopped matching. Run it at minimum before and during
any email campaign, then delete the test rows from the Responses sheet.

## Deploy

Any static host. The SPA needs a fallback rewrite so `/demo` deep links resolve:

- **Vercel** — `vercel.json` is committed: `{ "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }`
- **Netlify** — add a `_redirects` file: `/* /index.html 200`

`public/og.png` is a committed static file (1200×630), not produced by `npm run build`.
Regenerate with `npm run og` after visual changes and commit the result.
