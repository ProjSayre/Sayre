# Build context is the REPO ROOT, not services/core — this is an npm
# workspace (root package.json's "workspaces": ["apps/web", "services/core",
# "services/gateway", "packages/*"]), so `npm ci` needs the root lockfile
# and every workspace member's package.json to resolve correctly. See
# .github/workflows/deploy.yml, which sets context: . and
# file: services/core/Dockerfile for this build.
#
# Build with (from repo root):
#   docker build -f services/core/Dockerfile -t sayre-core .

# ---- deps + build ---------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /repo

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY services/core/package.json services/core/package.json
COPY services/gateway/package.json services/gateway/package.json
# Full directories, not just package.json: packages/config's "prepare"
# script (npm run build) fires during `npm ci` itself (npm's lifecycle for
# local/workspace deps), so its tsconfig.json + src must already be present.
# packages/shared-types has no prepare script but is copied in full too, for
# the same reason and consistency.
COPY packages/config packages/config
COPY packages/shared-types packages/shared-types
RUN npm ci

COPY . .

# turbo's dependency graph (build depends on ^build) builds @sayre/config
# and @sayre/shared-types first, matching the ci.yml build order.
RUN npx turbo run build --filter=@sayre/core

# Strip devDependencies from node_modules now that dist/ output already
# exists — @sayre/core's own node_modules is workspace-hoisted to the repo
# root, so this prunes across the whole tree in one pass.
RUN npm prune --omit=dev

# ---- runtime ----------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# node-postgres (pg) treats connection-string sslmode=require as an alias for
# verify-full as of the pg-connection-string version this project pins --
# meaning it validates DATABASE_RUNTIME_URL's server certificate against
# Node's trusted CA store. Amazon RDS's CA isn't in that default store, so
# without this the container fails to connect with SELF_SIGNED_CERT_IN_CHAIN
# (confirmed the hard way running the equivalent migration locally against a
# real RDS instance). NODE_EXTRA_CA_CERTS adds AWS's own published bundle to
# Node's trust store rather than disabling verification.
RUN wget -qO /etc/ssl/certs/rds-ca-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-ca-bundle.pem

COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/package.json ./package.json
# @sayre/config and @sayre/shared-types are npm-workspace symlinks
# (node_modules/@sayre/config -> ../../packages/config), so the actual
# built package directories must be present too, not just the symlink.
COPY --from=builder /repo/packages/config packages/config
COPY --from=builder /repo/packages/shared-types packages/shared-types
COPY --from=builder /repo/services/core/dist services/core/dist
COPY --from=builder /repo/services/core/package.json services/core/package.json
COPY --from=builder /repo/services/core/drizzle services/core/drizzle
# npm doesn't hoist every dependency to the root node_modules when a
# version conflict elsewhere in the workspace blocks it (same pattern
# W0-00's dependency audit found with zod) — drizzle-orm, typescript, and
# zod all install nested here instead. Verified by actually building and
# running this image; a MODULE_NOT_FOUND for drizzle-orm is what happens
# without this line.
COPY --from=builder /repo/services/core/node_modules services/core/node_modules

EXPOSE 4000
WORKDIR /app/services/core
CMD ["node", "dist/index.js"]
