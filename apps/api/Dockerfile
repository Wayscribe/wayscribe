# Build context is the repository root: this is a pnpm workspace and the API
# depends on packages/config and packages/database by workspace protocol.
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
# The `...` suffix builds the package together with its workspace dependencies,
# so packages/config and packages/database are compiled first.
RUN pnpm --filter @flight-recorder/api... build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 8080
CMD ["node", "apps/api/dist/server.js"]
