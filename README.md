# Sayre

Sayre is an AI-powered codebase ontology and visualization platform. It parses a repository into
a graph (Neo4j, moving to Amazon Neptune at scale) and renders Technical, Product, and Onboarding
tree views for different stakeholders — engineers, architects, PMs, and new hires.

This repository is a monorepo: the product platform (frontend, core API, realtime gateway, async
worker fleet, shared packages) and the marketing site each live in their own workspace member
under a shared root.

## Repo layout

| Path | What it is |
|---|---|
| `apps/site` | Vite/React marketing site (sayre.pages.dev) |
| `apps/web` | Next.js product visualization client (Technical/Product/Onboarding tree canvas) |
| `services/core` | Node.js/TypeScript core API + service layer + Graph Query Service + BullMQ integration jobs |
| `services/gateway` | WebSocket gateway for realtime fan-out (Redis pub/sub) |
| `services/workers` | Python/FastAPI async worker fleet (ingestion, semantic enrichment, retrieval/RAG) |
| `packages/` | Shared TypeScript packages (graph schema, config, shared types, workspace packs) |
| `infra/` | docker-compose and pinned service images for local development |
| `docs/` | Architecture reference, product spec, design system, and migration-trigger detail |
| `scripts/` | The SDD pipeline control plane, secret-scanning gates, and one product QA script |
| `.sdd/` | The runtime-neutral definition of the planner → red → dev → tester → review → security pipeline, plus its durable ledger |
| `security-attacker-agents/` | The registered attacker briefs the security-checker stage runs against a change |

See `docs/repo-structure.md` for the full directory map, why the marketing site keeps deploying
from the repo root, and the follow-ups this restructure deliberately deferred.

## Run it

```sh
npm install
npm run dev             # marketing site dev server (http://localhost:5173)
npm run dev:workspaces  # the product platform (web + core + gateway) via turbo
npm run build           # marketing site production build → repo-root dist/
npm run test:workspaces # test every workspace package via turbo
```

`npm run dev` / `npm run build` / `npm run preview` at the repo root are thin delegating aliases
to the marketing site's own scripts (`apps/site/package.json`) — their names and behavior are
unchanged from before this repository had a monorepo root, because they are load-bearing for the
Cloudflare Pages deploy and for muscle memory. See `apps/site/README.md` for everything specific
to the marketing site, and `CLAUDE.md` for the product platform's stack, structure, and
verification order.

## Where to read next

- `docs/repo-structure.md` — the directory map and the deploy-compatibility shims this restructure
  relies on.
- `CLAUDE.md` — product architecture, stack, structure, and the non-negotiable architecture rules.
- `AGENTS.md` — the entry point for any coding agent working in this repository, including the
  pipeline commands and the branch policy for autonomous ticket work.
