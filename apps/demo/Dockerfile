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

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
# No CMD: Compose runs this one image five times with five different commands.
