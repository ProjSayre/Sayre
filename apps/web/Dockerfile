# Build context is the REPO ROOT, not apps/web — this is an npm workspace
# (root package.json's "workspaces": ["apps/web", "services/core",
# "services/gateway", "packages/*"]), so `npm ci` needs the root lockfile
# and every workspace member's package.json to resolve correctly. See
# .github/workflows/deploy.yml, which sets context: . and
# file: apps/web/Dockerfile for this build.
#
# Build with (from repo root):
#   docker build -f apps/web/Dockerfile -t sayre-web .

# ---- deps + build ---------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /repo

# Copy only manifests first so this layer is cache-friendly across source
# changes that don't touch dependencies.
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY services/core/package.json services/core/package.json
COPY services/gateway/package.json services/gateway/package.json
# Full directories, not just package.json, for packages/config specifically:
# its "prepare" script (npm run build) fires during `npm ci` itself (npm's
# lifecycle for local/workspace deps), so its tsconfig.json + src must
# already be present at that point. packages/shared-types has no prepare
# script but is copied in full too, for the same reason and consistency.
COPY packages/config packages/config
COPY packages/shared-types packages/shared-types
RUN npm ci

COPY . .

# next.config.mjs sets output: 'standalone'. turbo's dependency graph
# (typecheck/test/build depend on ^build) builds @sayre/config and
# @sayre/shared-types first, matching the ci.yml build order.
RUN npx turbo run build --filter=@sayre/web

# ---- runtime ----------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Standalone output already contains a minimal node_modules tree (traced
# from actual runtime requires, including the @sayre/config workspace
# dependency) — copy it as-is rather than reinstalling anything.
COPY --from=builder /repo/apps/web/.next/standalone ./
COPY --from=builder /repo/apps/web/.next/static ./apps/web/.next/static
# apps/web/public doesn't exist today (no static assets checked in yet) —
# add `COPY --from=builder /repo/apps/web/public ./apps/web/public` back
# here if one is added; Next.js's standalone server expects it at that path.

EXPOSE 3000
CMD ["node", "apps/web/server.js"]
