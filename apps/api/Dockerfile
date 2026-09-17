# Build context is the repository root: this is a pnpm workspace and the API
# depends on several packages by workspace protocol.
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
# The `...` suffix builds the package together with its workspace dependencies.
RUN pnpm --filter @wayscribe/api... build
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
 && CI=true pnpm --filter @wayscribe/api... install --prod --ignore-scripts

# Everything the runtime never executes. The image was carrying 61 test files
# and 167 TypeScript sources for an application that runs `dist`, plus the whole
# demo — which has its own image — and the web application.
#
# Source is unreachable in production regardless: the workspace `exports` maps
# name `./src/index.ts` only under the `development` condition, which requires an
# explicit `--conditions=development` that nothing here passes.
#
# The documented CLI paths are `dist` paths, so provisioning still works.
#
# The conformance fixtures go too. They are not test files by name, and the
# runtime never reads them: they are a contract artefact for somebody writing a
# client, run by the test suites and by a conformance job. They also hold
# credential-shaped strings on purpose, which is exactly what ADR-043 exists to
# keep out of a published image, since a scanner reading one cannot tell a
# fixture from a leak. The generated JSON Schema stays: it is small, it holds no
# values, and the package exports it.
#
# `packages/sdk-node` goes with them. The API does not import it, at runtime or
# at all: it became a development dependency so that one integration test could
# drive the real recorder and send what it produced to the dry run, and the
# `...` filter above then built it into the image. A recorder meant for other
# people's applications has no business inside a server image.
RUN rm -rf apps/demo apps/web packages/protocol/conformance packages/sdk-node \
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
LABEL org.opencontainers.image.title="Wayscribe API"
LABEL org.opencontainers.image.description="Ingestion, query, and replay API for record-level debugging of distributed workflows."
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.source="https://gitlab.com/jojithedev/wayscribe"
LABEL org.opencontainers.image.documentation="https://gitlab.com/jojithedev/wayscribe#readme"

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app /app
# Apache-2.0 asks a redistributor to pass on the LICENSE and NOTICE, and a
# published image is a redistribution. /licenses is where both images keep
# them, so an operator finds them at the same path in either one;
# scripts/verify-image-contents.sh checks they are there.
COPY --from=build /app/LICENSE /app/NOTICE /licenses/

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
