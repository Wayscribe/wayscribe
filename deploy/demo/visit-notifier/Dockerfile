# Node 22.12, the oldest Node this repository supports, running the TypeScript
# sources directly with Node's type stripping. No build step and no packages.
FROM node:22.12.0-alpine@sha256:51eff88af6dff26f59316b6e356188ffa2c422bd3c3b76f2556a2e7e89d080bd
WORKDIR /app
COPY notifier.ts main.ts ./
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
USER node
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "main.ts"]
