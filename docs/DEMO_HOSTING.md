# Hosting the public demo

demo.wayscribe.dev is a live, read-only Wayscribe holding generated data only (ADR-069).
This page describes how it is built, run, reset, deployed and rebuilt from nothing. Nothing
here is needed to run Wayscribe yourself.

## What runs

One Hetzner CX22 VM (2 vCPU, 4 GB, Ubuntu 24.04) runs, with Docker Compose:

- the published `api` and `web` images of one release, and the published `demo` image for
  the demo services, all verified with cosign before they start;
- PostgreSQL and ElasticMQ, with no host ports;
- Caddy, the only service that publishes ports (80 and 443, IPv4 only), with a certificate it
  obtains itself, a rate limit of 300 requests a minute per client address (hashed static
  assets excepted), `X-Robots-Tag: noindex`, a `robots.txt` that disallows everything, and a
  JSON access log kept 7 days;
- `demo-history`, which once per reset writes the pinned failed journey for `+1 555 0100`
  and about 300 journeys over the past five days;
- `demo-source` in loop mode, one new customer a minute, about a fifth of them failing;
- `visit-notifier`, which reads Caddy's log and posts one ntfy message per new visitor.

The web app runs with `WEB_ANONYMOUS_READ_ONLY=true` and holds only `READ_TOKEN`, so every
visitor is a reader (ADR-070). The Compose files are `infrastructure/compose.published.yaml`,
`compose.bundled.yaml`, `compose.demo.yaml` and `deploy/demo/compose.yaml`, in that order.

## IPv4 only

The demo publishes an A record and no AAAA record. Caddy's ports are bound to `0.0.0.0`, and
`setup.sh` opens ports 80 and 443 in `ufw` for IPv4 only. Docker's userland proxy would
present every IPv6 visitor to Caddy as the bridge gateway, which would merge all of them
into one client in the rate limiter and in the visit notifier. Adding IPv6 later needs
`enable_ipv6` on the Compose network and `"userland-proxy": false` in Docker's daemon
configuration, and then a firewall rule and an AAAA record.

## Secrets

Generated on the VM by `deploy/demo/host/setup.sh` into `/etc/wayscribe-demo/env`
(root-only, mode 0600) and never committed or printed: `ENCRYPTION_KEY`, `ADMIN_TOKEN` (for
the CLI and `doctor` on the box; the web app does not hold it), `READ_TOKEN`,
`DEMO_API_KEY`, and the two ntfy topic names. They are separate from the GitLab CI
variables, which hold only the deploy key and the VM's host key:

| Variable | Type | Notes |
| --- | --- | --- |
| `DEMO_DEPLOY_SSH_KEY_B64` | Variable, protected, masked | The private deploy key as single-line base64 (a multi-line key cannot be masked). |
| `DEMO_SSH_KNOWN_HOSTS` | Variable, protected, not masked | The VM's host key line, verified out of band. |

A protected variable reaches a tag pipeline only when the tag is protected, so `v*` must
remain a protected tag or `deploy-demo` fails at its first line.

## The deploy key is restricted

The deploy user `wayscribe-deploy` has one authorized key, written with `restrict` and a
forced command, `sudo -n /usr/local/sbin/wayscribe-demo-deploy`, which receives the requested
tag as its argument. Sudoers lets that user run only that program, and only with an argument
matching `^v[0-9]+[.][0-9]+[.][0-9]+$`. The script checks the same pattern again. A stolen
key can therefore redeploy a release tag and do nothing else.

## Reset

`wayscribe-demo-reset.timer` runs `deploy/demo/host/reset.sh` at 04:00 UTC. It takes the demo
lock (`/run/wayscribe-demo.lock`), pulls, verifies signatures, rebuilds Caddy and the
notifier, runs `down --volumes`, `up`, and then waits up to ten minutes for the smoke check.
`setup.sh` and `deploy.sh` take the same lock, so a rerun of setup, a deploy and a reset never
overlap. A failure alerts through ntfy, including a hung reset that systemd stops at its
30-minute timeout (the script turns the termination into a failure and alerts). systemd then
retries every 30 minutes, up to three times, alerting each time. A reset that fails every
retry leaves the demo empty until fixed by hand; that is an accepted risk for a demo.
Caddy's certificate, configuration and access log are host directories under
`/var/lib/wayscribe-demo`, so a reset keeps them and Let's Encrypt's duplicate-certificate
limit is not touched. `wayscribe-demo-prune.timer` prunes unused images weekly.

## Uptime

`wayscribe-demo-uptime.timer` runs the smoke check (`deploy/demo/smoke-check.sh`) every 5
minutes and alerts when the demo goes down and when it recovers, not on every failed check.
The smoke check loads the home page and looks for the banner, searches `+1 555 0100`, and
opens the pinned journey's transform step, checking for the diff. It sends
`User-Agent: wayscribe-smoke/1`, which the visit notifier ignores. It skips while a reset or
deploy holds the lock. It cannot notice the VM itself going away; an external HTTP monitor
does that (optional step J6).

## Deploy and rollback

On a `vX.Y.Z` tag the `demo-overlay` CI job runs the overlay test, `publish-images` publishes
and signs `api`, `web` and `demo`, and `deploy-demo` appears as a manual job. It needs both
`publish-images` and `demo-overlay`, and runs in the `demo` resource group, so two deploys
never overlap. Play it after `publish-images` finishes. It connects as `wayscribe-deploy`,
which runs `/usr/local/sbin/wayscribe-demo-deploy <tag>`; that checks out the tag, records
`WAYSCRIBE_VERSION`, and runs the reset. The job then runs the smoke check from outside and
fails if it fails.

`demo-overlay` also runs on branch pipelines that change `deploy/demo/**`, `apps/demo/**`,
`apps/web/**`, `apps/api/src/**` or `infrastructure/compose.*.yaml`, and is otherwise manual.

**Rollback** is the same job played on the previous tag's pipeline. Every deploy is a reset,
so a database a newer release migrated never meets an older one. Play `deploy-demo` on every
release, so the path stays exercised. If a release changes `deploy/demo/host/deploy.sh` or
the systemd units, rerun `setup.sh` on the VM afterwards (it keeps the existing env file).

## Visit notifications

One ntfy message per visit, carrying only:

- the time, in New York;
- a route shape: `/`, `/journeys`, `/journeys/:id`, `/recent`, `/projects`, `/login`, or
  "other page", so no identifier or query string is sent;
- the referrer's host, bounded in length, or "direct", or "other site" if the referrer is not
  a valid host;
- the browser and operating system family.

A visit is a successful (2xx) page request: assets, API calls, health checks and error
responses do not count. Bots and scripted clients are skipped, among them crawlers, preview
fetchers, headless browsers, `curl`, `wget` and `python-requests`, as is the smoke check. The
same client is announced at most once in 6 hours (a sliding window). The client key is a hash
of address and user agent under a salt held only in memory and replaced daily, so no address
is stored. Search terms are never sent. At most 10 messages an hour, then one "muted until"
notice and, when the hour ends, a summary. If ntfy is unreachable the message is logged and
dropped; Caddy is never slowed.

## Rebuild from nothing

1. Jorge: steps J1 and J2 below.
2. Jorge: tag `vX.Y.Z`, a release that contains this work, play `publish-images` on its
   pipeline, and wait for it to finish. `setup.sh` pulls and verifies that tag's images, so
   the tag must exist first. On a first deploy there is no earlier tag to use.
3. Jorge: step J3 (generate the deploy key, then run `setup.sh` with that tag). On the VM as
   root: `git clone --depth 1 --branch <tag> https://gitlab.com/jojithedev/wayscribe.git /opt/wayscribe`
   then `sh /opt/wayscribe/deploy/demo/host/setup.sh "<deploy public key>" <tag>`. It
   installs Docker, configures `ufw` and SSH, generates the secrets, installs the deploy
   script, sudoers rule and timers, and runs the first reset. It refuses to start on anything
   but Ubuntu 24.04, because the sudoers rule needs regexes that Ubuntu 26.04's sudo-rs lacks.
4. Jorge: step J4 (CI variables and the protected `v*` tag), then step J5.
5. Check that `https://demo.wayscribe.dev` loads and shows the banner, and run
   `sh /opt/wayscribe/deploy/demo/smoke-check.sh https://demo.wayscribe.dev`.

## Jorge's manual steps

These need Jorge's accounts. Nothing automated performs them.

- **J1. VM.** Create the Hetzner account and a CX22 VM with Ubuntu 24.04, with your personal
  SSH public key. In the Hetzner Cloud Firewall allow inbound TCP 22, 80 and 443, and UDP
  443, for IPv4. Note the VM's IPv4 address.
- **J2. DNS.** In Cloudflare, add `demo.wayscribe.dev` as an **A record only, with no AAAA
  record**, pointing to the VM, **DNS only (grey cloud), not proxied**, so Caddy obtains and
  serves its own certificate.
- **J3. Deploy key and setup.** On your machine: `ssh-keygen -t ed25519 -N "" -C wayscribe-demo-deploy -f demo-deploy`.
  On the VM, run the `setup.sh` command in step 2 of "Rebuild from nothing" with the
  contents of `demo-deploy.pub` and the release tag. `setup.sh` pulls that tag's images,
  verifies their signatures and waits for the smoke check, so the tag must be a `vX.Y.Z`
  tag whose `publish-images` job has finished and which includes the `demo` image (the
  first release made after this work).
- **J4. CI variables.** In GitLab (Settings, CI/CD, Variables), add
  `DEMO_DEPLOY_SSH_KEY_B64` = the output of `base64 < demo-deploy | tr -d '\n'` (type
  Variable, **protected and masked**), and `DEMO_SSH_KNOWN_HOSTS` = the output of
  `ssh-keyscan -t ed25519 demo.wayscribe.dev` (protected, not masked), after checking its
  fingerprint against the VM's (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`, read on
  the VM's console or over your own SSH session). Confirm the `v*` tag is protected. Then
  delete the local private key file if you do not want a second copy.
- **J5. ntfy.** On the VM, `sudo sed -n 's/^NTFY_\(VISIT\|ALERT\)_TOPIC=//p' /etc/wayscribe-demo/env`
  prints the two topic names; subscribe to both in the ntfy app on your phone.
- **J6 (optional). External monitor.** Point a free HTTP keyword monitor at
  `https://demo.wayscribe.dev/`, looking for "Public demo. Read-only, sample data.", with
  user agent `wayscribe-smoke/1`, to hear about the VM itself going down.
