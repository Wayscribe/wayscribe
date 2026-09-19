# Round 3 completion and release rehearsal

Date: 2026-09-18. Reviewed by Codex against Wayscribe `3cd2c20..c072807`.
This records local verification, not a public release or a remote CI result.

## Work completed

The existing `r3-fixes` branch contained five commits after `3cd2c20`:

- F-042: an event's detail shows the aliases it stated, preserves masking,
  and distinguishes no aliases from older events whose aliases were not
  recorded.
- F-043: timeline rows show recorded deployment versions and commits.
- F-050: the SDK documents how to interpret dropped-event causes alongside
  transport errors.
- F-051: the version footer does not claim two builds differ when one lacks
  a build identity.
- F-052: `doctor` identifies its own environment as the source of its
  statement-timeout setting.

An independent code-review agent reviewed all five commits. It found that
the F-050 wording incorrectly treated zero fault counters as proof of a
responding collector. The existing early-shutdown test demonstrated the
counterexample. Commit `bc4eb55` corrects the SDK TSDoc, README,
troubleshooting guide and changelog: zero counters are inconclusive, and
`after_shutdown` drops say nothing about the collector.

Commit `c072807` makes the `demo` and `release-verify` jobs copy
`.env.example` to `.env` before booting the stack, matching the README, and
wait for web health as well as the API and demo source. The CI overlay
publishes the web port to the separate Docker-in-Docker job container.
The actual merged Compose configuration was checked for one reachable
mapping each on ports 8080, 3000 and 3100.

Current release-status wording now distinguishes the deprecated
`@wayscribe/node@0.0.1-placeholder.0` name reservation from a usable SDK
release. `npm view @wayscribe/node versions --json` returned only that
placeholder during this session. No public release was made.

## Verification

| Check | Local result |
| --- | --- |
| Unit and component suite | 3,280 tests passed across 184 files |
| PostgreSQL 17 integration suite | 969 tests passed across 55 files |
| Type checking, lint and formatting | Passed |
| Targeted documentation, Compose and supported-version checks | 79 tests passed |
| SDK and CLI on Node 22.12.0 | 769 tests passed; packed SDK installed, imported and required in fresh projects |
| SDK and CLI on Node 24.19.0 | 769 tests passed; packed SDK installed, imported and required in fresh projects |
| Browser suite against built Docker images | 64 tests passed, including JavaScript-disabled flows and narrow-screen layouts |
| Demo acceptance suite | 7 tests passed on rerun |
| API and web image contents | Passed: entry points and legal files present; test/source/fixture exclusions checked |
| SDK publication rehearsal | `DRY_RUN=1 scripts/publish-sdk.sh v0.1.0` passed; no publication |
| Dependency audit at the repository's high-severity gate | Passed; one moderate development-only advisory remains |
| Multi-architecture image publication rehearsal | API build and both SBOMs passed; web build blocked by exhausted disk space |
| Website build | Content sync passed; rendering blocked by exhausted disk space |
| Install from Compose files alone | Not completed: Docker storage failed before this check |

The initial demo run had one failure: PostgreSQL cancelled an event-detail
read at its statement timeout while cross-architecture image builds were
running. The same read then returned 200 in 111 ms. After limiting the build
container's CPU use, the complete demo suite passed in 12 seconds. No
application timeout or assertion was relaxed.

The final unit run initially caught `tests/site.test.ts` still expecting the
old README sentence about npm publication. The README and landing page now
both distinguish the placeholder from a usable release, and their existing
consistency checks were updated. The full rerun passed all 3,280 tests.

The moderate advisory is `GHSA-w5hq-g745-h8pq`, `uuid <11.1.1`, reached only
through `@testcontainers/postgresql > testcontainers > dockerode > uuid` in
the API and database development dependencies. This is not a clean audit
claim and does not change the repository's high/critical blocking policy.

## Image rehearsal and storage blocker

The publish script ran with `DRY_RUN=1` against a loopback-only throwaway
registry, `127.0.0.1:15055`, using tag `v0.1.0-rehearsal` and build commit
`c072807`. It built both `linux/amd64` and `linux/arm64` API images, pushed
them by digest, and generated a CycloneDX 1.6 SBOM for each: 322 and 321
components respectively. The API index was
`sha256:1e895d5dd30ab7b813c7d52fd8660ee1255adf775249bce4111127aad3243f88`.
No cosign operation ran.

The web-image build failed with disk I/O errors. The host then reported
only about 130 MiB available, and the website build independently failed
with `No space left on device`. The publish script did not reach its
tagging phase, so neither rehearsal image received a release tag.

The completed demo stack and its volume were removed. Attempts to remove
the rehearsal builder and registry failed because Docker's own metadata
store reported I/O errors. Restarting Docker affects the existing Leadline
containers, so approval was requested before doing that. No unrelated
images, volumes, caches or user files were deleted. The site dependencies
installed in this session were removed to recover available host space.

To resume after storage is healthy:

1. Remove the session's remaining Docker resources:
   `buildx_buildkit_wayscribe-codex-release0`,
   `buildx_buildkit_wayscribe-codex-release0_state`, and
   `wayscribe-codex-registry`. The first two are the builder container and
   its cache volume; remove the volume only after its container is gone.
2. Reinstall the website dependencies with its frozen lockfile and run its
   build. Run the image rehearsal in `OPERATIONS.md` section 11 with enough
   free disk space for both architectures.
3. Complete the install from Compose files alone before marking release
   preparation complete. A local test driver is prepared at
   `/tmp/wayscribe-published-install.mjs`; it provisions a project and key,
   checks `doctor`, installs the packed SDK in an empty consumer project,
   records and searches a journey, checks masking and diff data, replays to
   a local development target, and checks the signed-in UI at desktop and
   mobile widths. This script has not yet run and is not verification
   evidence.

## Remaining release decisions and external checks

- The existing owner checklist leaves the release placement of the remaining
  per-record timing work undecided. Showing deployment on each timeline row
  is now built; timeline gaps, stuck journeys, retry presentation, standard
  metadata and duration filters are separate work.
- The owner must choose and create the protected `v0.1.0` tag and run the
  manual publish jobs. Trusted-publisher configuration and real Sigstore
  signatures are not proven by a local dry run.
- After publication, verify `npm install @wayscribe/node@0.1.0`, package
  provenance, image signatures, and installation from the public files and
  registry. A local rehearsal cannot prove those public delivery paths.
- The cold-machine timing test, an unfamiliar developer's README walkthrough,
  outside pilot feedback, and support/contribution-policy decisions remain
  the owner checklist's human checks.

The separate `demo-video` worktree and existing Leadline installations were
not changed by this verification.
