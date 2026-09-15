# Design: an upgrade test and signed images

Date: 2026-09-15. Status: approved for planning (autonomous v1 work).

## Why

Two v1 promises have nothing behind them yet.

1. **An upgrade keeps your data.** Flight Recorder runs on each team's own
   PostgreSQL, so an upgrade is a new image pointed at an old database. The
   v1 work changed stored formats (the `fr1.` envelope with key ids, migration
   012), added indexes built concurrently (013), and added deletion over rows
   written by older builds. No test runs an old build, stops it, and brings the
   new one up against what it wrote.
2. **An operator can tell the image they pulled is the one this project
   built.** `publish-images` pushes to the GitLab registry and nothing more:
   no signature, no bill of materials.

## Item 1: the upgrade test

### Shape

`scripts/upgrade-test.mjs`, plain Node 24 with built-ins only, driving `git`,
`docker build`, and `docker compose`. JavaScript rather than shell because the
heart of it is comparing JSON responses field by field and saying precisely
which field differed. No `pnpm install` is needed to run it.

It runs its own Compose file, `scripts/upgrade-test.compose.yaml`, rather
than `infrastructure/compose.yaml` from each ref. The two refs' Compose files
read keys differently (the baseline interpolated them from the shell; main
reads `defaults.env` then `.env`), so reusing them would test Compose plumbing
differences instead of the data. The dedicated file runs exactly what a
published-image installation runs: one API image, a `migrate` via the image's
database CLI, and PostgreSQL with a named volume. It has three services:

- `postgres`, `postgres:17-alpine`, volume `upgrade-data`, **no published
  port**: the script reaches it with `docker compose exec postgres psql`, so
  it cannot collide with a developer's 5432.
- `api`, image from `UPGRADE_API_IMAGE`, keys from the script's environment,
  published on `${UPGRADE_BIND_ADDRESS}:${UPGRADE_API_PORT}` (defaults
  `127.0.0.1:18080`; CI binds `0.0.0.0` and reaches it at the `docker` host,
  as the demo job does).
- `replay-echo`, `node:24-alpine` running a twenty-line server that answers
  every request with the method, path, headers and body it received. It is the
  replay destination, and the only way to prove that a destination's encrypted
  headers still decrypt is to see them arrive somewhere.

Only the API image is built. The web image holds no state and reads nothing
the API does not hand it, so building it would add minutes without testing
anything about data.

### Baseline

In order:

1. `UPGRADE_BASELINE_REF` when set.
2. The highest `v*` tag by version order that is an ancestor of `HEAD` and does
   not point at `HEAD` (on a tag pipeline the newest tag *is* the build under
   test).
3. `f4a85f0ccb1f25b73be3401f0e9eb81377596df8`, "docs: implementation plan for
   key rotation", which is `d1bae55^1`: main immediately before the key
   rotation merge.

Why that commit: it predates migration 012 and the `fr1.` envelope (every
encrypted value it writes is legacy, and API key verifiers have no key id), it
predates 013's recent-journeys indexes, and it predates deletion and error
text masking. Everything v1 changed about stored data is therefore crossed in
one step. It is also late enough to have `project:create` and `key:create` in
its CLI (ADR-037), which the flow uses. The phase tags and `usable-v0` are
older and would cross more history without testing more formats.

What the test expects depends on the baseline. If the baseline tree lacks
`packages/database/migrations/012_key_rotation.js`, it expects legacy rows
before re-encryption and none after. If a later release tag already has it, it
expects no legacy rows at all. Either way everything else is asserted.

### Flow

1. `git worktree add --detach` the baseline into a temporary directory outside
   the repository (the API Dockerfile copies its whole build context, so a
   worktree inside the repository would ride along into the current image).
2. Build `<project>-api:baseline` from it. Generate a random 64-hex
   `ENCRYPTION_KEY` and `ADMIN_TOKEN` for the run: never the published defaults.
3. Baseline: `migrate`, `project:create`, `key:create` with the baseline CLI;
   start the API; wait for `/ready`.
4. Ingest through the baseline API, as one batch per journey:
   - **J1**, a customer with two aliases: `received`, a `transformed` event
     whose output drops a phone number (a structural diff), and a `failed`
     event with an error. Carries a trace id and a correlation id.
   - **J2**, an order with one alias, `received` then `completed`.
   - **J3**, a customer that will be erased after the upgrade.
   Create a replay destination on `replay-echo` with a marker header, and run a
   replay of J1's transformed event.
5. Record: search by each entity id, each alias value, the journey id, the
   trace id and the correlation id; journey detail and event list for each
   journey; event detail for every event; the destination list; the replay run.
   Assert the baseline itself answered correctly (entity ids decrypt to what was
   sent, the diff is non-empty, the echo saw the marker header), so a broken
   baseline fails as a baseline problem rather than as an upgrade mismatch.
6. `docker compose rm --stop` the API. The volume stays.
7. Build `<project>-api:current` from the working tree; run its `migrate`
   and assert 012 and 013 were in the batch it applied (when the baseline
   lacked them).
8. `rotate:status` before any key is presented: legacy rows in `journeys`,
   `entity_aliases` and `replay_destinations`, and the API key listed as having
   no recorded key id.
9. Start the current API and wait for `/ready`. Then:
   - every recorded response must be contained in the current one: every field
     the baseline returned is present and equal, and arrays match element by
     element. New fields (such as the journey detail's `environment`) are
     allowed; changed or missing ones fail with the path that differed.
   - the old API key ingests a new journey (J4) and the `api_keys` row now has
     a `key_hash_key_id`;
   - `GET /v1/journeys` (new in v1, and the reason for 013) lists J1 as failed;
   - a new replay through the baseline's destination reaches `replay-echo` with
     the marker header, proving legacy-format headers decrypt;
   - `POST /v1/erasures` on J3's entity id, with a dry run first, deletes it;
     J3's search is then empty and its detail 404.
10. `rotate:reencrypt` with no previous key: first line says `Upgrading`, exit
    0. `rotate:status` then exits 0 with no legacy rows.
11. Repeat the comparison of every recorded response (J3's excepted, since it
    was erased) and the replay, now against `fr1.` values.
12. `doctor`, if the current CLI has it. The CLI answers `Unknown command` when
    it does not, and the test then prints that the check was skipped. When it
    exists it must exit 0.
13. A key issued by the current CLI ingests an event.

Any failure prints what was expected, what came back, and the API log tail,
and exits 1. Cleanup always runs: `docker compose down -v`, the two image tags,
and `git worktree remove --force`. `UPGRADE_KEEP=1` leaves everything up for
debugging.

### CI

A job `upgrade-test` in the `demo` stage, `node:24-alpine` plus
`git docker-cli docker-cli-compose` under `docker:dind`, the demo job's pattern.
`GIT_DEPTH: 0`, because the baseline commit and earlier tags must exist in the
clone, and the script fetches tags before choosing when `UPGRADE_FETCH_TAGS=1`.
Rules: automatic and blocking on tags and schedules, manual and allowed to fail
otherwise. `publish-images` needs it.

## Item 2: SBOMs and signed images

### Tools and pins

- Syft `anchore/syft:v1.51.1`, pinned by digest too, run as a container.
  CycloneDX JSON, because `cosign attest --type cyclonedx` and most scanners
  consume it directly.
- Cosign `ghcr.io/sigstore/cosign/cosign:v3.1.3`, pinned by digest. The job
  copies the static binary out of the image with `docker create` and
  `docker cp` rather than running it as a container: under docker-in-docker a
  bind mount names the dind service's filesystem, not the job's, so a container
  could not read the SBOM file or the job's registry login. Syft writes its SBOM
  to stdout for the same reason.

### `scripts/sbom.sh <source> <output> [platform]`

One command both jobs use, so the path the release takes is the path CI runs on
every default-branch pipeline. `source` is Syft's source syntax
(`docker:scan/api:sha` for a local image, `registry:…@sha256:…` for a pushed
one). It mounts the Docker socket, passes registry credentials from
`CI_REGISTRY*` when set, writes CycloneDX JSON to the output file, and prints a
one-line summary (component count and the image digest the SBOM describes).

### `scripts/attest-and-sign.sh <repository> <tag>`

Run by `publish-images` after each push:

1. Resolve the index digest and each platform manifest digest with
   `docker buildx imagetools inspect`.
2. For each platform (`linux/amd64`, `linux/arm64`): `scripts/sbom.sh` against
   the platform digest, then `cosign attest --type cyclonedx` on that platform
   digest. An SBOM describes one platform's files, so it is attached to that
   platform's manifest rather than to the index.
3. `cosign sign --recursive` on the index digest, which signs the index and
   every platform manifest. Always by digest: signing a tag signs whatever the
   tag points at when cosign resolves it.
4. `cosign verify` the index with the identity an operator will use, so a
   signature that verifies only in theory fails the job.

`DRY_RUN=1` does steps 1 and 2 against any multi-platform image and prints the
cosign commands instead of running them. That is how the digest resolution and
registry SBOM path are exercised locally without publishing.

Keyless signing uses GitLab's OIDC token: `id_tokens: SIGSTORE_ID_TOKEN` with
`aud: sigstore`, which cosign reads from the environment. The certificate
identity is `https://gitlab.com/jojithedev/flight-recorder//.gitlab-ci.yml@refs/tags/<tag>`
with issuer `https://gitlab.com`. Signing records the project path and tag in
the public Rekor log, which is fine for a public project.

### The non-publishing job

`sbom`, in the `security` stage with `container-scan`'s rules (default branch,
tags, schedules). It builds both images for the runner's platform and runs
`scripts/sbom.sh` on each, keeping the SBOMs as artifacts for 30 days. Signing
cannot be exercised here: a signature is pushed to the registry beside the
image, and keyless signing writes to the public transparency log. Both are
publishing.

### Documentation

`docs/OPERATIONS.md` gains a section on verifying a pulled image: `cosign
verify` with the exact identity regexp, and `cosign verify-attestation --type
cyclonedx` against a platform digest, extracting the SBOM with `jq`.
`SECURITY.md` says images are signed, how to check, and that an unsigned image
claiming to be ours should be reported.

## Not in scope

- Publishing anything, creating tags, or configuring the registry.
- npm provenance for the SDK (separate item).
- Signing the SBOM job's local images.

## Risks

- Cosign 3 stores signatures and attestations in the new bundle format,
  through the OCI referrers API where the registry supports it and a tag-based
  fallback where it does not. Neither can be tried against the GitLab registry
  without pushing. The job's closing `cosign verify` is what catches a registry
  that accepts the push and cannot serve it back.
- `v*` tags should be protected, so that only maintainers can produce a ref the
  documented identity regexp accepts. That is a GitLab setting for the owner.
