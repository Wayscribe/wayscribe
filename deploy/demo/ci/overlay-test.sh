#!/bin/sh
# CI: the public demo overlay from images built here, behind a local Caddy on
# plain HTTP, under the docker:dind service. Proves the smoke check passes, that
# nothing but Caddy is reachable from outside the Compose network, that robots
# are told to stay out, that the rate limit bites, and that the visit notifier
# runs on Node 22.12 and drops a message when ntfy is unreachable.
#
# Generated secrets live in a temp file and are never printed.
set -eu

ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
VERSION="${WAYSCRIBE_VERSION:?set WAYSCRIBE_VERSION}"
HOST="${DEMO_TEST_HOST:-docker}"
REGISTRY=registry.gitlab.com/jojithedev/wayscribe
ENV_FILE=$(mktemp)
# On failure, the stack's state and recent logs go to the job log before the
# env file is removed. compose() is defined below; the trap only runs at exit.
trap 'rc=$?; if [ "${rc}" -ne 0 ]; then compose ps -a >&2; compose logs --no-color --tail 150 >&2; fi; rm -f "${ENV_FILE}"; exit "${rc}"' EXIT

fail() {
  echo "overlay-test: $1" >&2
  exit 1
}

for name in api web demo; do
  docker build --quiet -f "${ROOT}/apps/${name}/Dockerfile" -t "${REGISTRY}/${name}:${VERSION}" "${ROOT}" >/dev/null
done

umask 077
cat >"${ENV_FILE}" <<EOF
WAYSCRIBE_VERSION=${VERSION}
ENCRYPTION_KEY=$(openssl rand -hex 32)
ADMIN_TOKEN=$(openssl rand -hex 32)
READ_TOKEN=$(openssl rand -hex 32)
DEMO_API_KEY=wsk_$(openssl rand -hex 16)
DEMO_SITE_ADDRESS=:80
DEMO_DATA_DIR=/tmp/wayscribe-demo-data
NTFY_URL=http://127.0.0.1:9
NTFY_VISIT_TOPIC=ci-never-sent
EOF
umask 022

compose() {
  docker compose --env-file "${ENV_FILE}" \
    -f "${ROOT}/infrastructure/compose.published.yaml" \
    -f "${ROOT}/infrastructure/compose.bundled.yaml" \
    -f "${ROOT}/infrastructure/compose.demo.yaml" \
    -f "${ROOT}/deploy/demo/compose.yaml" "$@"
}

compose config --quiet
# The resolved configuration publishes Caddy's ports and nobody else's. The
# probe below cannot see this alone: a port the base files bind to 127.0.0.1
# would sit on the dind daemon's loopback, unreachable from this job either way.
published=$(compose config --format json | node -e '
  let text = "";
  process.stdin.on("data", (chunk) => (text += chunk));
  process.stdin.on("end", () => {
    const services = JSON.parse(text).services ?? {};
    const names = Object.keys(services).filter((name) => (services[name].ports ?? []).length > 0);
    console.log(names.sort().join(" "));
  });
') || fail "could not read the resolved Compose configuration"
[ "${published}" = caddy ] || fail "services publishing host ports: ${published}"

compose up --detach
sh "${ROOT}/deploy/demo/wait-for-smoke.sh" "http://${HOST}" 600

# 1. Nothing but Caddy answers from outside the Compose network...
for port in 3000 3100 3200 3300 5432 8080 9324; do
  # Only "could not connect" (7) or a timeout (28) counts as unreachable; any
  # other curl outcome, an answer included, means something is listening.
  rc=0
  curl --silent --max-time 5 --output /dev/null "http://${HOST}:${port}/" || rc=$?
  [ "${rc}" = 7 ] || [ "${rc}" = 28 ] || fail "port ${port} is reachable from outside the Compose network (curl exit ${rc})"
done
# ...while the API is up inside it, so the refusals above are the network's.
inside=$(compose exec -T caddy wget -qO- http://api:8080/health) || fail "the API does not answer inside the network"
case "${inside}" in
  *'"ok"'*) ;;
  *) fail "the API's /health inside the network said: ${inside}" ;;
esac

# 2. Robots stay out.
headers=$(curl --silent --show-error --head --user-agent wayscribe-smoke/1 "http://${HOST}/")
case "${headers}" in
  *[Xx]-[Rr]obots-[Tt]ag:*noindex*) ;;
  *) fail "no X-Robots-Tag: noindex on the home page" ;;
esac
robots=$(curl --silent --show-error --user-agent wayscribe-smoke/1 "http://${HOST}/robots.txt")
case "${robots}" in
  *"Disallow: /"*) ;;
  *) fail "robots.txt does not disallow everything" ;;
esac

# 3. A browser visit reaches the notifier, which runs on Node 22.12 and, with
#    ntfy unreachable, logs and drops the message.
curl --silent --output /dev/null \
  --user-agent "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15" \
  "http://${HOST}/"
dropped=no
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  logs=$(compose logs visit-notifier 2>&1)
  case "${logs}" in
    *"message dropped"*) dropped=yes; break ;;
  esac
  sleep 2
done
[ "${dropped}" = yes ] || fail "the visit notifier never reported a dropped message: ${logs}"
case "${logs}" in
  *"visit-notifier: watching"*) ;;
  *) fail "the visit notifier did not start" ;;
esac

# 4. The rate limit bites within one minute's allowance.
limited=no
i=0
while [ "${i}" -lt 400 ]; do
  code=$(curl --silent --output /dev/null --write-out '%{http_code}' --user-agent wayscribe-smoke/1 "http://${HOST}/health")
  if [ "${code}" = 429 ]; then
    limited=yes
    break
  fi
  i=$((i + 1))
done
[ "${limited}" = yes ] || fail "400 requests in a burst never met a 429"

echo "overlay-test: ok"
