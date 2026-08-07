# Build context is the repository root: this is a pnpm workspace.
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @flight-recorder/web build

# The runtime carries Next's standalone bundle and nothing else.
#
# It runs `node`, not `pnpm`. The previous version started the app with
# `pnpm --filter ... start` from a stage that had only run `corepack enable`,
# and corepack downloads the pnpm tarball on first use — so every fresh
# container reached out to registry.npmjs.org before it could serve a request,
# and an air-gapped host could not start the image at all.
#
# `next start` also does not support `output: standalone` and said so in the
# logs on every boot. `server.js` is what that output is meant to be run with.
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
WORKDIR /app

# The standalone bundle already contains the traced subset of node_modules.
COPY --from=build /app/apps/web/.next/standalone ./
# Static assets are deliberately excluded from the trace and must be copied.
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static

USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
