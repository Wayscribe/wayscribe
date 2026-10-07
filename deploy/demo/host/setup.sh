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
apt-get install -y -qq --no-install-recommends docker.io docker-compose-v2 git curl openssl ufw
systemctl enable --now docker

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
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

CHECKOUT=/opt/wayscribe
if [ ! -d "${CHECKOUT}/.git" ]; then
  git clone --quiet --depth 1 --branch "${TAG}" https://gitlab.com/jojithedev/wayscribe.git "${CHECKOUT}"
fi

install -d -m 0700 /etc/wayscribe-demo /var/lib/wayscribe-demo
install -d -m 0700 /var/lib/wayscribe-demo/caddy-data /var/lib/wayscribe-demo/caddy-config
install -d -m 0755 /var/lib/wayscribe-demo/caddy-logs

if [ ! -f /etc/wayscribe-demo/env ]; then
  umask 077
  cat >/etc/wayscribe-demo/env <<EOF
WAYSCRIBE_VERSION=${TAG}
ENCRYPTION_KEY=$(openssl rand -hex 32)
ADMIN_TOKEN=$(openssl rand -hex 32)
READ_TOKEN=$(openssl rand -hex 32)
DEMO_API_KEY=wsk_$(openssl rand -hex 16)
DEMO_SITE_ADDRESS=demo.wayscribe.dev
DEMO_DATA_DIR=/var/lib/wayscribe-demo
NTFY_URL=https://ntfy.sh
NTFY_VISIT_TOPIC=wayscribe-demo-visits-$(openssl rand -hex 8)
NTFY_ALERT_TOPIC=wayscribe-demo-alerts-$(openssl rand -hex 8)
EOF
  umask 022
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
# a broken file in /etc/sudoers.d would break sudo for every user.
SUDOERS_TMP=/etc/sudoers.d/wayscribe-demo-deploy.tmp
echo 'wayscribe-deploy ALL=(root) NOPASSWD: /usr/local/sbin/wayscribe-demo-deploy' >"${SUDOERS_TMP}"
chmod 0440 "${SUDOERS_TMP}"
visudo -cf "${SUDOERS_TMP}"
mv "${SUDOERS_TMP}" /etc/sudoers.d/wayscribe-demo-deploy

install -m 0644 "${CHECKOUT}"/deploy/demo/host/systemd/* /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now wayscribe-demo-reset.timer wayscribe-demo-uptime.timer wayscribe-demo-prune.timer

sh "${CHECKOUT}/deploy/demo/host/reset.sh"
echo "Demo is up. Subscribe to the two ntfy topics named NTFY_VISIT_TOPIC and NTFY_ALERT_TOPIC in /etc/wayscribe-demo/env."
