# Shared by the demo host scripts. POSIX sh, sourced. Every parameter that a
# colon follows is braced ("${var}:x"): these lines get pasted into zsh, which
# reads "$var:x" as a modifier.
DEMO_ENV_FILE="${DEMO_ENV_FILE:-/etc/wayscribe-demo/env}"
DEMO_CHECKOUT="${DEMO_CHECKOUT:-/opt/wayscribe}"
DEMO_LOCK="${DEMO_LOCK:-/run/wayscribe-demo.lock}"
# The cosign the release pipeline signs with (scripts/attest-and-sign.sh).
COSIGN_IMAGE="ghcr.io/sigstore/cosign/cosign:v3.1.3@sha256:9e5c2f2edc34351160407ca3416c61855bdf9403c3c5936e0f0be7fc261611b8"
REGISTRY="registry.gitlab.com/jojithedev/wayscribe"

load_env() {
  set -a
  # shellcheck disable=SC1090
  . "${DEMO_ENV_FILE}"
  set +a
}

demo_compose() {
  docker compose --env-file "${DEMO_ENV_FILE}" \
    -f "${DEMO_CHECKOUT}/infrastructure/compose.published.yaml" \
    -f "${DEMO_CHECKOUT}/infrastructure/compose.bundled.yaml" \
    -f "${DEMO_CHECKOUT}/infrastructure/compose.demo.yaml" \
    -f "${DEMO_CHECKOUT}/deploy/demo/compose.yaml" "$@"
}

# notify <title> <body>: an alert through ntfy. Logs and drops on failure.
# The topic is the only secret in an ntfy alert, so the URL reaches curl on
# stdin (--config -), never in its argv where ps would show it.
notify() {
  [ -n "${NTFY_ALERT_TOPIC:-}" ] || return 0
  printf 'url = "%s/%s"\n' "${NTFY_URL:-https://ntfy.sh}" "${NTFY_ALERT_TOPIC}" |
    curl --config - --silent --show-error --max-time 10 --output /dev/null \
      -H "Title: $1" -H "Tags: warning" --data "$2" ||
    echo "ntfy unreachable; alert dropped: $1" >&2
}

# verify_images <tag>: each pulled image's digest is signed by that tag's
# release pipeline. Verified by digest, so what runs is what was verified.
verify_images() {
  for name in api web demo; do
    ref=$(docker image inspect --format '{{index .RepoDigests 0}}' "${REGISTRY}/${name}:$1") ||
      return 1
    if ! docker run --rm "${COSIGN_IMAGE}" verify "${ref}" \
      --certificate-identity "https://gitlab.com/jojithedev/wayscribe//.gitlab-ci.yml@refs/tags/$1" \
      --certificate-oidc-issuer https://gitlab.com >/dev/null; then
      echo "cosign: ${ref} is not signed by the $1 release pipeline" >&2
      return 1
    fi
  done
}

site_url() {
  printf 'https://%s' "${DEMO_SITE_ADDRESS}"
}
