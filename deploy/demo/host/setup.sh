#!/bin/sh
# One-time setup of the demo VM: a fresh Ubuntu 24.04 Hetzner CX22, as root.
#
#   sh setup.sh "<deploy public key>" <release tag>
#
# Generates the secrets here, into a root-only file, and never prints them.
# Rerun it after a release changes deploy.sh or the systemd units; it keeps an
# existing env file.
set -eu
DEPLOY_KEY="${1:?usage: setup.sh \"<deploy public key>\" <release tag>}"
TAG="${2:?usage: setup.sh \"<deploy public key>\" <release tag>}"
if ! expr "${TAG}" : 'v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*$' >/dev/null; then
  echo "the second argument must be a release tag such as v0.3.0" >&2
  exit 2
fi
# One ed25519 key on one line: a newline here would add a second, unrestricted
# line to authorized_keys.
case "${DEPLOY_KEY}" in
  *'
'*)
    echo "the deploy public key must be a single line" >&2
    exit 2
    ;;
  'ssh-ed25519 '*) ;;
  *)
    echo "the first argument must be an ssh-ed25519 public key" >&2
    exit 2
    ;;
esac

apt-get update -qq
apt-get install -y -qq --no-install-recommends docker.io docker-compose-v2 docker-buildx git curl openssl ufw
systemctl enable --now docker

# The overlay needs Compose 2.24 or newer: `!reset` in deploy/demo/compose.yaml
# and `pull --ignore-buildable` in reset.sh. --short prints 2.27.0, maybe with
# a leading v or a suffix such as +ds1.
compose_version=$(docker compose version --short) || {
  echo "docker compose is not installed" >&2
  exit 1
}
version="${compose_version#v}"
major="${version%%.*}"
rest="${version#*.}"
minor="${rest%%[!0-9]*}"
case "${major}" in '' | *[!0-9]*) major=x ;; esac
case "${minor}" in '' | *[!0-9]*) minor=x ;; esac
if [ "${major}" = x ] || [ "${minor}" = x ]; then
  echo "cannot read the Docker Compose version: ${compose_version}" >&2
  exit 1
fi
if [ "${major}" -lt 2 ] || { [ "${major}" -eq 2 ] && [ "${minor}" -lt 24 ]; }; then
  echo "Docker Compose ${compose_version} is too old: the demo needs 2.24 or newer" >&2
  exit 1
fi

# Keys only. Docker-published ports bypass ufw; only Caddy publishes, on 80/443.
cat >/etc/ssh/sshd_config.d/10-wayscribe-demo.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
# A config sshd rejects must not reach a reload that could lock us out.
sshd -t
systemctl reload ssh
ufw default deny incoming
ufw allow 22/tcp
# The web is IPv4 only (deploy/demo/compose.yaml, caddy ports): no AAAA
# record, and nothing on IPv6 80/443.
ufw allow proto tcp from 0.0.0.0/0 to any port 80,443
ufw allow proto udp from 0.0.0.0/0 to any port 443
ufw --force enable

CHECKOUT=/opt/wayscribe
# Held from here to the end: a rerun must not move the checkout or the env
# file under a nightly reset or a deploy. The final reset runs under it.
exec 9>/run/wayscribe-demo.lock
flock -w 900 9 || {
  echo "a reset or deploy is running" >&2
  exit 1
}
if [ ! -d "${CHECKOUT}/.git" ]; then
  git clone --quiet --depth 1 --branch "${TAG}" https://gitlab.com/jojithedev/wayscribe.git "${CHECKOUT}"
else
  # A rerun installs deploy.sh and the units from this tag, as deploy.sh would.
  git -C "${CHECKOUT}" fetch --quiet --depth 1 origin "refs/tags/${TAG}:refs/tags/${TAG}"
  git -C "${CHECKOUT}" -c advice.detachedHead=false checkout --quiet "refs/tags/${TAG}"
fi

install -d -m 0700 /etc/wayscribe-demo /var/lib/wayscribe-demo
install -d -m 0700 /var/lib/wayscribe-demo/caddy-data /var/lib/wayscribe-demo/caddy-config
install -d -m 0755 /var/lib/wayscribe-demo/caddy-logs

ENV_FILE=/etc/wayscribe-demo/env
# secret <hex bytes>: a random hex string, checked for length. An assignment
# from a command substitution fails under set -e; one inside a heredoc does not.
secret() {
  value=$(openssl rand -hex "$1")
  if [ "${#value}" -ne $(($1 * 2)) ]; then
    echo "openssl rand gave a short secret" >&2
    exit 1
  fi
  printf '%s' "${value}"
}
if [ ! -f "${ENV_FILE}" ]; then
  encryption_key=$(secret 32)
  admin_token=$(secret 32)
  read_token=$(secret 32)
  demo_api_key=$(secret 16)
  visit_suffix=$(secret 8)
  alert_suffix=$(secret 8)
  umask 077
  cat >"${ENV_FILE}.tmp" <<EOF
WAYSCRIBE_VERSION=${TAG}
ENCRYPTION_KEY=${encryption_key}
ADMIN_TOKEN=${admin_token}
READ_TOKEN=${read_token}
DEMO_API_KEY=wsk_${demo_api_key}
DEMO_SITE_ADDRESS=demo.wayscribe.dev
DEMO_DATA_DIR=/var/lib/wayscribe-demo
NTFY_URL=https://ntfy.sh
NTFY_VISIT_TOPIC=wayscribe-demo-visits-${visit_suffix}
NTFY_ALERT_TOPIC=wayscribe-demo-alerts-${alert_suffix}
EOF
  umask 022
  mv "${ENV_FILE}.tmp" "${ENV_FILE}"
  unset encryption_key admin_token read_token demo_api_key visit_suffix alert_suffix
else
  sed -i "s/^WAYSCRIBE_VERSION=.*/WAYSCRIBE_VERSION=${TAG}/" "${ENV_FILE}"
fi
recorded=$(sed -n 's/^WAYSCRIBE_VERSION=//p' "${ENV_FILE}")
if [ "${recorded}" != "${TAG}" ]; then
  echo "${ENV_FILE} does not record WAYSCRIBE_VERSION=${TAG}" >&2
  exit 1
fi

id wayscribe-deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/sh wayscribe-deploy
install -d -m 0700 -o wayscribe-deploy -g wayscribe-deploy /home/wayscribe-deploy/.ssh
cat >/home/wayscribe-deploy/.ssh/authorized_keys <<EOF
command="sudo -n /usr/local/sbin/wayscribe-demo-deploy \"\$SSH_ORIGINAL_COMMAND\"",restrict ${DEPLOY_KEY}
EOF
chown wayscribe-deploy:wayscribe-deploy /home/wayscribe-deploy/.ssh/authorized_keys
chmod 0600 /home/wayscribe-deploy/.ssh/authorized_keys
install -m 0755 "${CHECKOUT}/deploy/demo/host/deploy.sh" /usr/local/sbin/wayscribe-demo-deploy
# Validated before it goes live: sudo skips files whose names contain a dot, and
# a broken file in /etc/sudoers.d would break sudo for every user. The argument
# is held to a release tag by sudo's own regex match (sudo 1.9.10 or newer);
# `[.]`, not `\.`, because sudoers reads a backslash as its own escape.
SUDOERS_TMP=/etc/sudoers.d/wayscribe-demo-deploy.tmp
echo 'wayscribe-deploy ALL=(root) NOPASSWD: /usr/local/sbin/wayscribe-demo-deploy ^v[0-9]+[.][0-9]+[.][0-9]+$' >"${SUDOERS_TMP}"
chmod 0440 "${SUDOERS_TMP}"
visudo -cf "${SUDOERS_TMP}"
mv "${SUDOERS_TMP}" /etc/sudoers.d/wayscribe-demo-deploy

install -m 0644 "${CHECKOUT}"/deploy/demo/host/systemd/* /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now wayscribe-demo-reset.timer wayscribe-demo-uptime.timer wayscribe-demo-prune.timer

WAYSCRIBE_DEMO_LOCKED=1 DEMO_ACTION=setup sh "${CHECKOUT}/deploy/demo/host/reset.sh"
echo "Demo is up. Subscribe to the two ntfy topics named NTFY_VISIT_TOPIC and NTFY_ALERT_TOPIC in /etc/wayscribe-demo/env."
