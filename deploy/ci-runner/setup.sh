#!/bin/sh
# One-time setup of the CI runner VM: a fresh Ubuntu 24.04 Hetzner x86 server,
# 4 vCPU / 8 GB or larger, as root. docs/CI_RUNNER.md says why it exists.
#
#   sh setup.sh
#
# Installs Docker, GitLab Runner and arm64 emulation, keeps SSH to keys only,
# closes every inbound port but 22, and prunes Docker daily. It registers
# nothing: registration takes the runner token, which `register` below reads
# from standard input so it never appears in an argument list or a file here.
#
#   printf '%s\n' "$TOKEN" | sh setup.sh register
#
# Safe to rerun.
set -eu

OS_RELEASE="${WAYSCRIBE_OS_RELEASE:-/etc/os-release}"
os_id=$(sed -n 's/^ID=//p' "${OS_RELEASE}" 2>/dev/null | tr -d '"' | head -n 1) || os_id=
os_version=$(sed -n 's/^VERSION_ID=//p' "${OS_RELEASE}" 2>/dev/null | tr -d '"' | head -n 1) || os_version=
if [ "${os_id}" != ubuntu ] || [ "${os_version}" != 24.04 ]; then
  echo "this host is ${os_id:-unknown} ${os_version:-unknown}: setup needs Ubuntu 24.04" >&2
  exit 1
fi
if [ "$(dpkg --print-architecture)" != amd64 ]; then
  echo "this host is $(dpkg --print-architecture): the runner must be amd64, as GitLab's are" >&2
  exit 1
fi

if [ "${1:-}" = register ]; then
  # A runner authentication token (glrt-), created in the project's CI/CD
  # settings with the tag `self-hosted` and "Run untagged jobs" off. Tags and
  # the untagged setting live on GitLab with such a token, not here.
  IFS= read -r CI_SERVER_TOKEN || true
  case "${CI_SERVER_TOKEN}" in
    glrt-*) ;;
    *)
      echo "expected a runner authentication token starting glrt- on standard input" >&2
      exit 2
      ;;
  esac
  export CI_SERVER_TOKEN
  if grep -q '^\[\[runners\]\]' /etc/gitlab-runner/config.toml 2>/dev/null; then
    echo "a runner is already registered here; run 'gitlab-runner unregister --all-runners' first" >&2
    exit 1
  fi
  # Privileged: nine jobs run Docker-in-Docker (.gitlab-ci.yml). 256 MB of
  # /dev/shm: Chromium under Playwright crashes in Docker's default 64 MB.
  gitlab-runner register --non-interactive \
    --url https://gitlab.com \
    --executor docker \
    --docker-image alpine:3.22 \
    --docker-privileged \
    --docker-volumes /cache \
    --docker-shm-size 268435456 \
    --description "wayscribe-runner-$(hostname)"
  unset CI_SERVER_TOKEN
  # Two jobs at a time on 4 vCPU / 8 GB: a Docker-in-Docker build and a test
  # job side by side, without either swapping.
  sed -i 's/^concurrent = .*/concurrent = 2/' /etc/gitlab-runner/config.toml
  systemctl restart gitlab-runner
  gitlab-runner verify
  exit 0
fi

apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl gnupg docker.io qemu-user-static ufw unattended-upgrades
systemctl enable --now docker

# publish-images builds linux/arm64 under emulation. qemu-user-static registers
# its interpreters with the fix-binary flag, so the registration holds inside
# the Docker-in-Docker containers that run the build, and across reboots.
if [ ! -e /proc/sys/fs/binfmt_misc/qemu-aarch64 ]; then
  systemctl restart systemd-binfmt
fi
grep -q '^flags: .*F' /proc/sys/fs/binfmt_misc/qemu-aarch64 || {
  echo "arm64 emulation is not registered with the fix-binary flag" >&2
  exit 1
}

# GitLab's own apt repository, pinned to its signing key rather than piping
# their install script into a root shell.
KEYRING=/usr/share/keyrings/gitlab-runner.gpg
curl -fsSL https://packages.gitlab.com/runner/gitlab-runner/gpgkey | gpg --dearmor --yes -o "${KEYRING}"
echo "deb [signed-by=${KEYRING}] https://packages.gitlab.com/runner/gitlab-runner/ubuntu/ noble main" \
  >/etc/apt/sources.list.d/gitlab-runner.list
apt-get update -qq
apt-get install -y -qq gitlab-runner
systemctl enable --now gitlab-runner

# Keys only, as on the demo VM.
cat >/etc/ssh/sshd_config.d/10-wayscribe-runner.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
sshd -t
systemctl reload ssh
# The runner only connects out, to gitlab.com. Nothing here publishes a port:
# Docker-published ports would bypass ufw, and no job publishes one on the host.
ufw default deny incoming
ufw allow 22/tcp
ufw --force enable

# Security updates install themselves; the runner restarts on its own release.
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

# Every Docker-in-Docker job leaves its daemon's layers in an anonymous volume,
# and pulled images pile up. Daily: images and stopped containers older than
# two days, and anonymous volumes. The runner's named cache volumes stay.
cat >/etc/systemd/system/wayscribe-runner-prune.service <<'EOF'
[Unit]
Description=Prune Docker on the Wayscribe CI runner

[Service]
Type=oneshot
ExecStart=/usr/bin/docker system prune --all --force --filter until=48h
ExecStart=/usr/bin/docker volume prune --force
EOF
cat >/etc/systemd/system/wayscribe-runner-prune.timer <<'EOF'
[Unit]
Description=Daily Docker prune on the Wayscribe CI runner

[Timer]
OnCalendar=*-*-* 04:30:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now wayscribe-runner-prune.timer

echo "setup done: gitlab-runner $(gitlab-runner --version | sed -n 's/^Version: *//p'), docker $(docker version --format '{{.Server.Version}}')"
