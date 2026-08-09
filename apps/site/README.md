# sayre_ — marketing site

Static marketing site for Sayre, an engineering memory graph for developers and AI agents.
The previously staged interactive prototype remains in source for possible future use, but
it is not linked or shipped as a production route.

Spec: `docs/product/SAYRE_FRONTEND_SPEC.md` · Design system: `docs/design-system/SAYRE_DESIGN_SYSTEM.md`

## Stack

Vite + React 18 + TypeScript · react-router-dom · d3-hierarchy (layout math only) ·
hand-rolled SVG canvas · vanilla CSS custom properties. Runtime dependency budget is
capped at `react`, `react-dom`, `react-router-dom`, `d3-hierarchy`.

## Develop

Run these from `apps/site/` (or prefix each with `--workspace @sayre/site` from the repo root):

```sh
npm install
npm run dev        # http://localhost:5173  (routes: / and /privacy; /demo redirects home)
npm run build      # tsc --noEmit + vite build → repo-root dist/ (see Deploy below)
npm run preview    # serve the production build
npm run og         # regenerate public/og.png (dev-only script; commit the output)
npm run hero:render # regenerate the prerecorded Anime hero media (requires Chromium + FFmpeg)
```

The Anime handoff is archived under `apps/site/design/handoffs/anime-hero-animation/`.
The renderer captures it deterministically into one-shot MP4/WebM files and
responsive WebP stills; its prototype React/Babel runtime is never shipped.
If no compatible browser is installed, install Puppeteer's headless shell with
`npm exec puppeteer -- browsers install chrome-headless-shell@stable`.

## Configuration (`apps/site/src/config.ts`)

| const | notes |
|---|---|
| `WAITLIST_ENDPOINT` | Google Form URL **or** Formspree-style JSON endpoint. **Must be set before any email campaign.** While empty: dev builds log the payload and fake success; production builds show a mailto fallback and never fake success. |
| `GOOGLE_FORM_ENTRIES` | only for Google Form mode: the form's `entry.NNN` ids for email / company / source. |
| `CONTACT_EMAIL` | mailto target for `contact` / fallbacks. |
| `SITE_URL` | absolute base for OG tags (also hardcoded in `index.html` — keep in sync). |
| `PLAUSIBLE_DOMAIN` | optional; empty = no analytics script injected. |

### Waitlist: Google Form mode (accepted tradeoff)

The site's two-step waitlist form mirrors the team's Google Form and posts
into it. Name and email are required on step one; company, website, team size,
tools, interest, referral source, and notes are optional on step two. Both
Google Form questions that support *Other* expose a matching free-text field.
The site's internal `source` tag is also reported through the form's
"How did you hear about us?" *Other* slot as `site: <source>`; a
visitor-supplied Other answer is combined with that tag.

Google Forms sends no CORS headers, so the **browser cannot read Google's
response** — the site shows success whenever the request completes, even if
Google silently rejected it (deleted form, closed responses, changed entry
ids or option strings, a question flipped to required). This is a deliberate
tradeoff (team decision 2026-07-11) for a free endpoint with responses in a
Sheet.

Mitigation: run **`npm run test:waitlist`** periodically — Node *can* read the
response, so the script submits a complete test row exactly as the site does
and fails loudly on any of the above. Run it after ANY edit to the Google Form
and before/during email campaigns, then delete the test rows from Responses.
If the form's questions change, update `GOOGLE_FORM` in `src/config.ts`
(option strings must match verbatim).

## Deploy

Cloudflare Pages builds from the **repo root**, not from `apps/site/` — the root
`npm run build` delegates to this workspace's own `tsc --noEmit && vite build`, and
`apps/site/vite.config.ts` emits to repo-root `dist/` rather than the default
`apps/site/dist/`. This keeps the external Cloudflare Pages contract byte-identical to
before this workspace existed. See `docs/repo-structure.md` (deferred item D2) for why the
shim exists and what would be needed to remove it.

The SPA needs a fallback rewrite so `/privacy` resolves, plus a temporary redirect from `/demo` to `/`:

- **Vercel** — `vercel.json` (repo root) contains both the temporary demo redirect and SPA rewrite.
- **Cloudflare Pages / Netlify** — `public/_redirects` contains the same redirect and fallback.

`public/og.png` is a committed static file (1200×630), not produced by `npm run build`.
Regenerate with `npm run og` after visual changes and commit the result.
