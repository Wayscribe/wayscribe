# Build context is the repository root: this is a pnpm workspace and the demo
# depends on packages/database and packages/sdk-node by workspace protocol.
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
# The `...` suffix builds the package together with its workspace dependencies.
RUN pnpm --filter @flight-recorder/demo... build
# See apps/api/Dockerfile for why this is a wipe-and-reinstall rather than a
# plain `--prod` install, and why it is filtered.
RUN find . -name node_modules -type d -prune -exec rm -rf {} + \
 && CI=true pnpm --filter @flight-recorder/demo... install --prod --ignore-scripts

FROM node:24-alpine AS runtime
# The base image lags Alpine's own security releases by days to weeks. Upgrading
# its packages here means a fix Alpine has already published (libcrypto3 3.5.8
# for CVE-2026-14456, when this was added) reaches the image on the next build
# rather than when the upstream tag is rebuilt.
RUN apk upgrade --no-cache
LABEL org.opencontainers.image.title="Flight Recorder demo services"
LABEL org.opencontainers.image.description="The four demo services that prove the reference journey."
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.source="https://gitlab.com/jojithedev/flight-recorder"

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app /app

# The base image ships npm and corepack, and neither is used at runtime — the
# container runs `node` directly. Container scanning reported seven CVEs against
# their bundled dependencies (tar, brace-expansion, ip-address, an old undici),
# none of them ours and none of them reachable. Removing the package managers is
# both the honest fix and a smaller attack surface than an ignore file.
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm \
           /usr/local/bin/npx \
           /usr/local/bin/corepack

USER node
# No CMD: Compose runs this one image five times with five different commands.
