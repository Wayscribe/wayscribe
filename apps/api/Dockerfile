# Build context is the repository root: this is a pnpm workspace and the API
# depends on several packages by workspace protocol.
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
# The `...` suffix builds the package together with its workspace dependencies.
RUN pnpm --filter @flight-recorder/api... build
# Drop development dependencies in place. The runtime previously carried the
# whole toolchain — vitest, playwright, typescript, eslint, testcontainers —
# around 500 MB of node_modules for an application that needs 26 MB of it.
#
# Pruned in place rather than with `pnpm deploy`: deploy's --legacy mode
# symlinks workspace packages back into a directory tree the runtime stage does
# not have, which produces an image that builds cleanly and then cannot resolve
# its own imports at startup. Keeping the whole tree also keeps the paths the
# documentation uses, including the database CLI for provisioning.
# The tree is removed first, then reinstalled production-only and filtered to
# this application. Two things had to be explicit here:
#
#   `pnpm install --prod` over an existing install leaves the development
#   packages already in .pnpm where they are, so the image sat at 500 MB of
#   node_modules until this became a wipe and reinstall.
#
#   Without the filter, the workspace root installs every project's production
#   dependencies — Next and React for the web app, the AWS SDK for the demo —
#   none of which the API imports.
#
# CI=true because pnpm will not remove a modules directory without a TTY.
RUN find . -name node_modules -type d -prune -exec rm -rf {} + \
 && CI=true pnpm --filter @flight-recorder/api... install --prod --ignore-scripts

# Everything the runtime never executes. The image was carrying 61 test files
# and 167 TypeScript sources for an application that runs `dist`, plus the whole
# demo — which has its own image — and the web application.
#
# Source is unreachable in production regardless: the workspace `exports` maps
# name `./src/index.ts` only under the `development` condition, which requires an
# explicit `--conditions=development` that nothing here passes.
#
# The documented CLI paths are `dist` paths, so provisioning still works.
RUN rm -rf apps/demo apps/web \
 && find . -path ./node_modules -prune -o -type d -name src -print0 \
      | xargs -0 -r rm -rf \
 && find . -path ./node_modules -prune -o -type f \
      \( -name '*.test.ts' -o -name '*.spec.ts' -o -name 'tsconfig*.json' \) -print0 \
      | xargs -0 -r rm -f

FROM node:24-alpine AS runtime
# The base image lags Alpine's own security releases by days to weeks. Upgrading
# its packages here means a fix Alpine has already published (libcrypto3 3.5.8
# for CVE-2026-14456, when this was added) reaches the image on the next build
# rather than when the upstream tag is rebuilt.
RUN apk upgrade --no-cache
LABEL org.opencontainers.image.title="Flight Recorder API"
LABEL org.opencontainers.image.description="Ingestion, query, and replay API for record-level debugging of distributed workflows."
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.source="https://gitlab.com/jojithedev/flight-recorder"
LABEL org.opencontainers.image.documentation="https://gitlab.com/jojithedev/flight-recorder#readme"

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

# Never root. A process that serves HTTP and talks to PostgreSQL has no reason
# to be able to write to its own image.
USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  # 127.0.0.1, not localhost: localhost resolves to ::1 first here and the
  # server binds 0.0.0.0, so the check is refused and the container reports
  # unhealthy while serving traffic perfectly.
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

CMD ["node", "apps/api/dist/server.js"]
