# Round 3 completion and release rehearsal

Date: 2026-09-18. Reviewed by Codex against Wayscribe `3cd2c20..c072807`;
the completed release rehearsal used `c442d0b`, including the documentation follow-up.
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
| Multi-architecture image publication rehearsal | Passed after Docker recovery: API and web built for AMD64/ARM64, four SBOMs generated, local tags verified by digest; no signing or public publication |
| Website build | Passed on retry: 32 pages, search index and all internal links validated |
| Install from Compose files alone | Passed end to end using a loopback registry, copied Compose files and an SDK packed into a fresh consumer |
| AMD64 release-image contents | API exclusions/imports and API/web legal files/entry points passed using `DOCKER_DEFAULT_PLATFORM=linux/amd64` |

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

## Image rehearsal and storage recovery

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

Later, after available host space rose to about 1.2 GiB, the website's frozen
dependency install and build passed. The build generated 32 pages, its search
index and sitemap, and validated every internal link. This was a local build,
not a website deployment.

Initial cleanup attempts failed because Docker's metadata store reported
I/O errors. After the owner approved a restart, Docker Desktop was restarted
and the session's failed builder/cache, registry and source-demo images were
removed. All seven Leadline service containers returned healthy; the separate
test PostgreSQL container was also restored. No unrelated images, volumes,
caches or user files were deleted.

The complete image script was then rerun at `c442d0b`, using the same
loopback registry and `v0.1.0-rehearsal` tag. The builder ran one step at a
time with four CPUs, 4 GiB memory and limited cache retention. A host-space
guard would stop the rehearsal below 1 GiB free; it did not trigger.
The script exited successfully, generated all four CycloneDX 1.6 SBOMs,
and checked both local version tags and `latest` against the built digests.

| Image | AMD64 SBOM components | ARM64 SBOM components | Multi-platform index |
| --- | --- | --- | --- |
| API | 322 | 321 | `sha256:c024c71a577ad7dd826012d17f9e4c46db1f5a712b93b53a0f4433817ceb68a3` |
| Web | 368 | 367 | `sha256:09ea9531a5f12777367be0c1c349a109a1e26d347f0aaca820c9f87351380bac` |

`DRY_RUN=1` generated SBOM files and printed the cosign commands; it did not
sign images or attach real cosign attestations. Every image push and tag in
this rehearsal went to the local registry, not a public registry.

## Installation from Compose files alone

The installation directory contained copied `compose.published.yaml` and
`compose.bundled.yaml`, with an override for the local image registry, test
ports and a development replay target. The merged configuration contained
no build directives or source bind mounts. Random admin/encryption secrets
were held in the test process, and the generated API key was not printed.

The ARM64 installation passed:

- Image pull, automatic migrations, API readiness and web health.
- API build identity equal to `v0.1.0-rehearsal` and the full `c442d0b` commit.
- Project/key provisioning and all 12 `doctor` checks.
- SDK packed from source, installed into a fresh consumer, and imported
  through the public `@wayscribe/node` package entry point.
- Four recorded events, all four sent, zero rejected or dropped; alias search,
  a nonempty masked email alias, payload redaction, field diff, failed-step
  identity, application deployment and SDK metadata read back correctly.
- Development replay of the stored redacted input and comparison against the
  original output.
- Signed-in UI at 1440 px and 400 px, including stated aliases and deployment
  rows, explicit matching Web/API release version and commit in the footer,
  and no horizontal overflow at 400 px. Screenshots were visually inspected.

Review of the temporary test driver caught an inherited healthcheck aimed at
the wrong port, a direct import that bypassed package exports, a weak masked
alias assertion and an incomplete footer assertion. All four were corrected
before the driver ran. No application-code change was needed.

The install stack and its volume were removed after success. The retry's
builder/cache, registry/volume and pulled rehearsal images were also removed.
Leadline remained healthy after cleanup. Logs, SBOMs, screenshots, the test
driver and its machine-readable result are retained locally under
`~/workspace/wayscribe-release-evidence/2026-09-18/`.

This verifies installation from local images using the distributed Compose
files. It does not prove public registry availability, a registry-installed
SDK, real signatures/provenance, or a timed installation on a clean machine.

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

The separate `demo-video` worktree and Leadline source/configuration were
unchanged. Leadline containers were restarted as part of the approved Docker recovery.

The follow-up launch-documentation review is recorded in
[the claims follow-up](../claims-audit-2026-09-18.md). Its 250 documentation
checks passed after the historical-name wording in the new audit note was
corrected to comply with the existing rename guard. Code review also caught
the release draft omitting personal data in error messages from warnings that
print without opt-in; the draft now includes all three public-value fields.

## Per-record timing addendum

Wayscribe commit `3fb2b4a` corrected the final broker-redelivery contradiction
before Leadline adoption. An explicitly reported delivery count above 1 now
rules out an initial-enqueue queue wait in both `queueMetadata` and protocol
normalization. ADR-064 and the event, general SDK and Node SDK contracts carry
the same rule. No protocol version changed.

Leadline commit `275d8ba` pins that exact SDK and replaces its local timing
logic with `queueMetadata` and `httpMetadata`. It supplies BullMQ's real
`attemptsStarted` as delivery count, keeps `attemptsMade + 1` as application
attempt, and groups retries explicitly. Missing, invalid and negative clock
evidence stays absent; measured zero stays zero. HubSpot's normalized retry
delay remains Leadline policy, while recording receives only the genuine raw
`Retry-After` header and the instant the response was observed.

The fresh Wayscribe gate passed formatting, lint, type checking and 3,415 tests
in 188 files. The API dependency closure built successfully. Independently
packed ESM and CommonJS consumers passed 796 SDK tests in 47 files on each of
Node 22.12.0 and 24.19.0. Leadline passed formatting, lint, type checking and
866 unit tests in 51 files. Its integration run discovered 53 tests: 50 passed
and the three tests in the existing image-backed database-CLI suite skipped
because a `local-3fb2b4a` API image was not built. The skipped suite runs with
no network and does not cover the timing service path.

The final PostgreSQL 17 integration run passed 978 tests in 55 files. A
production standalone web build passed, followed by all 71 browser tests in
31.4 seconds, including JavaScript-disabled navigation and the production CSP.

Independent live Leadline run `dogfood-a4d2cc02` then passed all six scenarios
plus the real paused-worker browser check. The harness used actual intake and
worker processes, dedicated Redis, the Wayscribe API, a controlled CRM fixture
and an independent broker/HTTP oracle. Its backlog wait was 3,369 ms in both
the broker source and recorded event. A corrupt broker timestamp completed
with queue wait absent. A raw request for a 2,000 ms retry delay remained
distinct from the 525 ms observed inter-attempt gap. A real stalled job
recovered with `attemptsStarted: 2` and `attemptsMade: 1`, recording broker
delivery 2, application attempt 1 and no initial-enqueue wait. The browser
assertions held the fixed active-idle cutoff and preserved the detail page's
return context. Filtered-neighbor behavior has separate Task 3 browser
coverage; it was not asserted by this live Leadline harness.

That completed-event browser matrix also found the Payloads grid wider than
the viewport with realistic JSON: 484 px at a 400 px phone width and 1,555 px
at a 1,440 px desktop width. Commit `5537d4c` gives both grid layouts an
explicit zero minimum so each preformatted payload keeps its own horizontal
scroller. The regression requires full input/output text, local block overflow
and zero document overflow at 400 px without JavaScript and at 1,280 px. The
real completed-event rerun then reported zero overflow at 400 and 1,440 px.

The final Task 4 review remains open. This addendum does not claim a human
walkthrough, remote CI, clean-machine verification, publication or a public
release.
