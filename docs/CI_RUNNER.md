# The self-hosted CI runner

CI runs on GitLab.com. Jobs can run on GitLab's hosted runners, which use the
namespace's compute minutes, or on one project runner that we host ourselves: a
Hetzner VM with GitLab Runner's Docker executor. The minutes ran out during the
0.2.5 release (2026-10-10), which is why the project runner exists.

## Which job runs where

- **Every job that holds a credential stays on GitLab's hosted runners:**
  `publish-images`, `publish-sdk`, `publish-python`, `publish-python-testpypi`,
  `deploy-demo`, `mirror-to-github` and `github-release`. They set
  `tags: [saas-linux-small-amd64]` in `.gitlab-ci.yml`. They are short, so they
  cost few minutes.
- **Every other job goes where `RUNNER_TAG` says.** The `default:` block sets
  `tags: ["$RUNNER_TAG"]`, and `.gitlab-ci.yml` sets `RUNNER_TAG` to
  `saas-linux-small-amd64`. A project variable `RUNNER_TAG=self-hosted`
  (Settings → CI/CD → Variables, not protected, not masked) overrides it and
  sends them to the project runner.

The split exists because the project runner is privileged. Nine jobs run
Docker-in-Docker and two mount the Docker socket, so any job there is root on
the VM. A job on any branch could leave something behind on the VM that a
later release build would pick up. Release builds and the OIDC identities
GitLab mints for them (Sigstore, npm, PyPI) never touch that VM.

The split does not narrow which jobs see the protected variables
(`GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `DEMO_DEPLOY_SSH_KEY_B64`,
`DEMO_SSH_KNOWN_HOSTS`). Every job in a `main` or tag pipeline sees them,
wherever it runs. That was already true on GitLab's runners. Scoping them to
environments would narrow it; that has not been done yet.

## Setting it up

Run the wizard from the repository root. It walks through creating the VM and
its firewall in the Hetzner console, runs [`deploy/ci-runner/setup.sh`](../deploy/ci-runner/setup.sh)
on it, and registers the runner with a token from the project's CI/CD
settings:

```sh
deploy/ci-runner/wizard.sh
```

The VM is Ubuntu 24.04, x86, 4 vCPU and 8 GB or larger. The setup script:

- installs Docker, GitLab Runner from GitLab's apt repository (pinned to its
  signing key), and `qemu-user-static` for the arm64 half of `publish-images`'
  multi-platform build;
- allows SSH keys only and lets nothing in but port 22;
- turns on unattended security upgrades;
- prunes Docker daily at 04:30.

It registers the runner with privileged Docker, a 256 MB `/dev/shm` for
Playwright, and two concurrent jobs. The runner carries the tag `self-hosted`
and does not take untagged jobs.

Its last stage offers to set the project variable `RUNNER_TAG=self-hosted`
once the runner is online. Jobs land on the project runner from the next
pipeline.

## When the runner is down

Delete the `RUNNER_TAG` project variable. Jobs go back to GitLab's runners from
the next pipeline. Jobs already pending for the project runner stay pending;
cancel and retry them.

To rebuild the VM, delete the runner in Settings → CI/CD → Runners, create a
new VM, and run the wizard again. It reuses the SSH key and the saved address
(`~/.config/wayscribe/ci-runner.env`), so update the address when asked.
