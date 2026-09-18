# Build context is the repository root: this is a pnpm workspace.
FROM node:24-alpine AS base
# Next sends anonymous usage data to Vercel from `next build` unless this is
# set, and the README's quick start builds this image on the reader's machine.
# Set here so the build stage inherits it, and again in the runtime stage, which
# starts from a fresh base image.
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @wayscribe/web build

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
# The base image lags Alpine's own security releases by days to weeks. Upgrading
# its packages here means a fix Alpine has already published (libcrypto3 3.5.8
# for CVE-2026-14456, when this was added) reaches the image on the next build
# rather than when the upstream tag is rebuilt.
RUN apk upgrade --no-cache
LABEL org.opencontainers.image.title="Wayscribe web"
LABEL org.opencontainers.image.description="Developer interface for searching journeys, reading their timelines, and seeing where a value changed."
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.source="https://gitlab.com/jojithedev/wayscribe"
LABEL org.opencontainers.image.documentation="https://gitlab.com/jojithedev/wayscribe#readme"
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
WORKDIR /app

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

# The standalone bundle already contains the traced subset of node_modules.
COPY --from=build /app/apps/web/.next/standalone ./
# Static assets are deliberately excluded from the trace and must be copied.
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
# Apache-2.0 asks a redistributor to pass on the LICENSE and NOTICE, and a
# published image is a redistribution. Same path as in the API image;
# scripts/verify-image-contents.sh checks they are there.
COPY --from=build /app/LICENSE /app/NOTICE /licenses/

USER node
EXPOSE 3000

# Without this the container has no health check at all, so `docker compose up
# -d --wait` reported it `Healthy` on nothing more than the process having
# started, while the same word next to the API rested on a served request
# (F-022). /login is the one page that renders without a session, so a passing
# probe means Next is answering and rendering, not merely listening.
#
# 127.0.0.1 rather than localhost, for the reason the API image gives: the
# server binds 0.0.0.0 and localhost resolves to ::1 first here. The body goes
# to /dev/null because Docker keeps the last probes' output in the container's
# state and a rendered page is not worth storing there.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --start-interval=2s --retries=3 \
  CMD wget -qO /dev/null http://127.0.0.1:3000/login || exit 1

CMD ["node", "apps/web/server.js"]
