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
LABEL org.opencontainers.image.title="Flight Recorder demo services"
LABEL org.opencontainers.image.description="The four demo services that prove the reference journey."
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.source="https://gitlab.com/jojithedev/flight-recorder"

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
# No CMD: Compose runs this one image five times with five different commands.
