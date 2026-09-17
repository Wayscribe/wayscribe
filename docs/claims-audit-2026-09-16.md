# Claims audit, 2026-09-16

Every number and every absolute statement (never, always, every, only, cannot, all, no) in the public documentation, and how each was checked. Line numbers are in the documents as corrected by this audit. A claim that recurs in the same document is listed once, at its first or most specific place.

Documents in scope: `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, and in `docs/`: `OPERATIONS.md`, `SECURITY.md`, `SECURITY_REVIEW.md`, `RELEASE_NOTES_DRAFT.md`, `FAQ.md`, `TROUBLESHOOTING.md`, `INGESTION_CONTRACT.md`, `API_SPEC.md`, `ROADMAP.md`, `LOCAL_DEVELOPMENT.md`, `ALTERNATIVES.md` (internal references only) and `recipes/`; `packages/sdk-node/README.md`; `deploy/helm/README.md`. `docs/DECISIONS.md` is historical and was read only for statements of current fact that are now false.

## Summary

- Claims checked: 306.
- True as written: 227, of which 30 gained the date of the measurement they rest on.
- Corrected: 70.
- Removed: 2.
- Not verifiable from this repository: 7, each saying why.

Results:

- **true**: checked against the code, a test, a measurement in the repository, or a command run on the date shown.
- **true, dated**: true, and the number now carries the date of the measurement it comes from.
- **corrected**: the document was wrong or out of date, and now says what is true.
- **removed**: the claim had no support and was taken out.
- **not verifiable here**: it depends on something outside this repository; the row says what.

## Decisions this audit made

- **API key audit rows.** `docs/SECURITY.md` section 13 said that creating and revoking an API key, changing a capture policy and changing retention were audited, and none of them wrote a row. Key creation and revocation now do: `key:create` and `key:revoke` write `api_key.created` and `api_key.revoked` in the same transaction as the key, naming it by prefix, with the actor `cli` (`packages/database/src/repositories/key-admin.ts`, tested in `key-admin.integration.test.ts`, including that a failed audit insert rolls the key back). Capture mode, redaction paths, allowlist and retention have no code path that changes them; they are changed with SQL, so section 13 now says they are not audited rather than adding rows for writes that never happen.
- **The gitleaks image.** The `secrets` job ran `zricethezav/gitleaks:latest`. It is now `zricethezav/gitleaks:v8.30.1` pinned by digest (`sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f`), the version `latest` pointed at on 2026-09-16, like Trivy, Syft and cosign already were.
- **No `latest` in `compose.published.yaml`.** The images fell back to `latest` when `FLIGHT_RECORDER_VERSION` was unset, while OPERATIONS section 11 says to pin a version in anything you deploy. The file now requires the variable and refuses to start without it, naming it. The quick start costs one more `export`, next to `COMPOSE_FILE`, which the reader already sets. Against that, the `migrate` service applies whatever schema the pulled image carries, so an unpinned `docker compose pull` could move a team's own database across a minor release, which before 1.0 may change the API, with no way back. Nothing is published yet, so no existing installation relies on the fallback.

## The most important corrections

- SECURITY section 13 claimed audit rows that nothing wrote (above).
- The SDK's measured cost was stale. Re-measured on the same Apple M3 Pro on 2026-09-16, a `transform` of 1 KiB adds 112 µs at p50 where the documents said 30, and 64 KiB payloads cost about half as much again as documented. The 2026-09-15 run predates the check for secret-looking names (commit `7cce070`), which is the likely cause; that was not isolated. The README of the SDK, the FAQ and the release notes now carry the new figures, and the SDK README keeps the old ones for comparison. With the endpoint refusing connections the added time was higher than against a working one, which the documents had said it was not.
- `docs/API_SPEC.md` section 12 documented a replay request with `payload` and `headers` and a response with `replayId`. The route reads neither field and answers the stored run.
- The FAQ said CI ran PostgreSQL 17 alone and that `doctor` warned on anything older. CI runs 15, 17 and 18, and `doctor` warns on a release newer than 18.
- The SDK README described a name-value redaction object as needing exactly two keys, which the code stopped requiring when a third key was found to defeat the rule.
- The README and the SDK README said the SDK prints one or two things unasked. It prints four kinds of warning; ADR-052 carried the same statement and has an amendment.
- A 403 on ingestion: the batch route the SDK uses answers 202 with `httpStatus: 403` in the event's result (OPERATIONS section 14, LOCAL_DEVELOPMENT section 7).
- `docs/SECURITY.md` sections 4, 5, 8 to 12, 14 and 16 were written as requirements. They now say what is built, and where it is tested. Two requirements were not built: projects cannot add blocked replay headers, and the SDK does not propagate trace context.
- The image verification commands used `v1.0.0`; releases will be 0.x, so they use `vX.Y.Z`.
- The ingestion contract sent readers to a section 10 it does not have.
- ROADMAP's test counts, its DebtWatch sentence and its audit count were stale.
- The timeline's clock marker was described, in the interface and in two code comments, as catching a service clock that runs ahead. It fires only when an event arrives more than 120 seconds after its own timestamp.

## Checks added

- `tests/docs-links.test.ts`: every relative link and anchor in the audited documents resolves, and every numbered section they cite (`OPERATIONS §9`, `SECURITY section 4` and the like) exists.
- `tests/docs-audit-actions.test.ts`: SECURITY section 13's table equals the audit actions the code writes, no code path updates an environment's settings, and ROADMAP's count matches.
- `tests/docs-claims.test.ts`: the SDK's defaults, transport bounds, error and label bounds and unasked warnings; both diagnostic tables against `diagnostics.ts`; replay bounds, blocked headers and destination types; page sizes, `q` and `entityType` bounds and clock tolerance; deletion batch sizes; throttle size; HKDF subkeys and key id length; doctor's sample; metric names and buckets; migration lock timeouts and the Helm Job's retries; which migrations build concurrently; the pending migration count; loopback ports and the local URL list; the required release version; CI image pins; placeholder release tags; the tarball name; the README's layout; LOCAL_DEVELOPMENT's commands; dated counts and measurements; the conformance loader's size; PostgreSQL versions everywhere; no em or en dashes; the troubleshooting links; and two retired wordings.
- `tests/docs-helpers.ts` holds the helpers `tests/docs-truth.test.ts` had inline, and `docs-truth.test.ts` now imports them.

## Not verifiable from this repository

- `README.md` line 399: 30 claims raised, 28 survived, three affected correctness, twelve smaller findings. The 2026-08-09 audit report, held outside this repository; M1 to M8 and S1 to S7 (15 fixes) match three plus twelve (commit `42f2037`).
- `SECURITY.md` line 15: Acknowledgement within a week. A policy commitment, not a measurement.
- `docs/RELEASE_NOTES_DRAFT.md` line 148: The chart was used on kind, never on a managed cluster. ADR-042; `deploy/helm/README.md`. The kind run was by hand and is not repeatable here.
- `docs/recipes/express-bullmq-hubspot.md` line 5: Leadline is being built as this stack. A project outside this repository; now says so.
- `docs/recipes/fastify-sqs-salesforce.md` line 151: SQS returns no attributes unless named. AWS SQS `ReceiveMessage` behaviour; not re-checked against AWS here.
- `docs/recipes/nextjs-stripe.md` line 100: `after` is stable since Next.js 15.1. Next.js 15.1 release notes (December 2024); not re-checked here.
- `deploy/helm/README.md` line 4: Used on kind, never on a managed cluster. ADR-042; a manual run, not repeated here.

## The claims

### `README.md`

| Line | Claim | How verified | Result | Checked |
| --- | --- | --- | --- | --- |
| 11 | Nothing captured leaves your machine | Outbound calls: `apps/api/src/replay/send.ts` (replays to configured hosts) and `apps/api/src/metrics/listener.ts` (a server); the API may run on another host, so "your machine" was wrong | corrected | 2026-09-16 |
| 18 | `pnpm screenshots` regenerates the images | `package.json` scripts; `scripts/screenshots.mjs` | true | 2026-09-16 |
| 21 | GitHub is a read-only mirror | `.gitlab-ci.yml` `mirror-to-github` force-pushes; `docs/MIRRORING.md` | true | 2026-09-16 |
| 32 | "five defects" live in `main` | `docs/WHAT_RUNNING_IT_FOUND.md` now records more than five; the count was removed | removed | 2026-09-16 |
| 69 | The demo journey is the ten steps shown, three with a 422 | `apps/demo/src/demo.e2e.test.ts` ("records every step, in order", "records the target's rejection on every delivery attempt") | true | 2026-09-16 |
| 86 | The transformation maps `Phone__c` and loses `Phone` | `apps/demo/src/transform.ts`; `demo.e2e.test.ts` ("shows the phone leaving with a value and arriving null") | true | 2026-09-16 |
| 117 | Only Docker with Compose is needed to try it | The images build inside Docker (`apps/*/Dockerfile`); `pnpm demo:trigger` is optional | true | 2026-09-16 |
| 131 | Build 38 s, boot 12 s | Measured on a laptop from a fresh clone; commit `42f2037` (2026-09-14) records it. Not re-measured: a cold Docker cache is destructive to reproduce here | true, dated | 2026-09-16 |
| 137 | The trigger is on port 3100 | `infrastructure/compose.demo.yaml` publishes `127.0.0.1:3100:3100`; `tests/docs-claims.test.ts` ("lists the local URLs the Compose files publish") | true | 2026-09-16 |
| 143 | The journey dead-letters about ten seconds after the trigger | `infrastructure/elasticmq.conf`: 3 s visibility, `maxReceiveCount = 3`; the reason is now stated | true | 2026-09-16 |
| 149 | The default admin token | `infrastructure/defaults.env` | true | 2026-09-16 |
| 153 | Loopback ports 8080 and 3000, movable with `API_PORT` and `WEB_PORT` | `infrastructure/compose.yaml`; `tests/docs-claims.test.ts` ("binds every published port to 127.0.0.1") | true | 2026-09-16 |
| 170 | A warning at every boot on the published defaults | `apps/api/src/server.ts` logs each `findInsecureDefaults` finding; `packages/config/src/insecure-defaults.test.ts` | true | 2026-09-16 |
| 181 | Supported versions table (Node, PostgreSQL, Compose, platforms) | `tests/supported-versions.test.ts`, which reads `.gitlab-ci.yml` and every `engines` field | true | 2026-09-16 |
| 187 | doctor fails below 15 and warns above the newest tested | `packages/database/src/doctor.ts` `MINIMUM_POSTGRES`, `NEWEST_TESTED_POSTGRES = 18`; `tests/supported-versions.test.ts` | true | 2026-09-16 |
| 196 | The SDK is not on npm | `npm view @flight-recorder/node` answered 404 on 2026-09-16 | true, dated | 2026-09-16 |
| 203 | The packed tarball is `flight-recorder-node-0.1.0.tgz` | `packages/sdk-node/package.json` version 0.1.0; `tests/docs-claims.test.ts` ("names the tarball the SDK's version packs") | true | 2026-09-16 |
| 254 | The example does it "in about thirty lines" | `examples/instrument-a-service/index.mjs` is 110 lines; its recorder calls are about thirty. Reworded to say so | corrected | 2026-09-16 |
| 261 | No runtime dependencies | `packages/sdk-node/src/package.test.ts` ("has no dependencies at all") | true | 2026-09-16 |
| 262 | Every entry point is wrapped; a failure never reaches your code | `packages/sdk-node/src/entry-points.test.ts`, `safely.test.ts`, `isolation.test.ts` | true | 2026-09-16 |
| 264 | Wrappers rethrow the exact error | `packages/sdk-node/src/wrappers.test.ts` ("rethrows a synchronous callback's exact error synchronously") | true | 2026-09-16 |
| 266 | Bounded queue, drops oldest | `packages/sdk-node/src/queue.ts`; `queue.test.ts` | true | 2026-09-16 |
| 270 | shutdown never hangs | `recorder.ts` `raceTimeout(drain, timeoutMs)`; `accounting.test.ts` | true | 2026-09-16 |
| 271 | Only one unasked console line per process | Four unasked warnings exist: `recorder.ts` (three `printed once per process` notes) and `secret-names.ts`; `tests/docs-claims.test.ts` ("prints unasked only the four warnings the README lists") | corrected | 2026-09-16 |
| 309 | Reads OTel trace and span ids; never writes `traceparent` | `packages/sdk-node/src/trace.ts`; no `traceparent` write in `propagation.ts`; `trace.test.ts` | true | 2026-09-16 |
| 316 | No open-source tool does all four, as of September 2026 | `tests/docs-truth.test.ts` ("dates the no-open-source-alternative claim"); sources dated in `docs/ALTERNATIVES.md` | true, dated | 2026-09-16 |
| 355 | PostgreSQL is the only required backing service | ADR-004, ADR-012; `infrastructure/compose.published.yaml` has no other service | true | 2026-09-16 |
| 363 | Identifiers and aliases encrypted, payloads not | `packages/payload-security/src/encryption.ts`; `tests/docs-truth.test.ts`, which forbids the old wording about payload encryption in every document | true | 2026-09-16 |
| 371 | Every encrypted value names its key; rotation has a grace period | `fr1.<keyId>.` format in `encryption.ts`; `rotation.integration.test.ts` | true | 2026-09-16 |
| 374 | Cross-project isolation is structural | Composite keys in migrations 003, 004, 006; `schema.integration.test.ts` | true | 2026-09-16 |
| 377 | Replay connects to the resolved address | `apps/api/src/replay/address-policy.ts`, `send.ts`; ADR-033 | true | 2026-09-16 |
| 379 | Retention sweeps in the API process | `apps/api/src/retention-job.ts` (hourly `setInterval`) | true | 2026-09-16 |
| 382 | 56 ADRs (twice) | `tests/docs-truth.test.ts` counts `## ADR-` headings | true | 2026-09-16 |
| 389 | Nothing is published | No image tag or npm version exists (npm 404 on 2026-09-16); `docs/ROADMAP.md` | true, dated | 2026-09-16 |
| 399 | 30 claims raised, 28 survived, three affected correctness, twelve smaller findings | The 2026-08-09 audit report, held outside this repository; M1 to M8 and S1 to S7 (15 fixes) match three plus twelve (commit `42f2037`) | not verifiable here | 2026-09-16 |
| 430 | PostgreSQL 15 or later | `tests/supported-versions.test.ts` | true | 2026-09-16 |
| 437 | The published install pulls images with no version named | `compose.published.yaml` now requires `FLIGHT_RECORDER_VERSION`; `tests/docs-claims.test.ts` ("requires a release version") | corrected | 2026-09-16 |
| 486 | doctor prints one line per check and exits 1 on a failure | `packages/database/src/doctor.ts`; `doctor.integration.test.ts` | true | 2026-09-16 |
| 508 | Changed and rejected are demonstrated end to end | `apps/demo/src/demo.e2e.test.ts` | true | 2026-09-16 |
| 541 | No telemetry; Next.js telemetry off in the image and scripts | `tests/next-telemetry.test.ts`; the outbound calls listed above | true | 2026-09-16 |
| 602 | The layout lists every app and package | `packages/cli` was missing; `tests/docs-claims.test.ts` ("lists every app and package in its layout") | corrected | 2026-09-16 |
| 598 | The demo image has five entry points | `infrastructure/compose.demo.yaml` runs bootstrap, target, integration, worker and source from one image | true | 2026-09-16 |
| 591 | Built with Node 24 and PostgreSQL 17 | `.nvmrc`; `postgres:17-alpine` in `infrastructure/compose.yaml` | true | 2026-09-16 |
| 7 | Em dashes in the README | Replaced throughout (21); `tests/docs-claims.test.ts` ("uses no em or en dashes") | corrected | 2026-09-16 |

### `SECURITY.md`

| Line | Claim | How verified | Result | Checked |
| --- | --- | --- | --- | --- |
| 15 | Acknowledgement within a week | A policy commitment, not a measurement | not verifiable here | 2026-09-16 |
| 27 | "the published package" and "the published container images" are in scope | Nothing is published; now says "once published" | corrected | 2026-09-16 |
| 34 | Development defaults are committed, and the API warns at boot | `infrastructure/defaults.env`, `.env.example`; `apps/api/src/server.ts` | true | 2026-09-16 |
| 39 | The admin token grants "project-wide" read | It reads every project it names (`x-flight-project-id`); ADR-029. Reworded | corrected | 2026-09-16 |
| 41 | Propagated context is not authenticated; extraction checks shape only | `packages/sdk-node/src/propagation.ts`; `propagation.test.ts` | true | 2026-09-16 |
| 51 | Released images are signed (present tense) | Nothing is released; signing is in `scripts/attest-and-sign.sh`, cosign `v3.1.3` | corrected | 2026-09-16 |
| 60 | The verify command used `v1.0.0` | Releases will be 0.x; now `vX.Y.Z`; `tests/docs-claims.test.ts` ("shows a placeholder, never a real release") | corrected | 2026-09-16 |
| 75 | Release jobs run only for `vMAJOR.MINOR.PATCH` tags | `.gitlab-ci.yml` `.release-rules`: `/^v\d+\.\d+\.\d+$/` | true | 2026-09-16 |
| 81 | "Nothing captured is sent anywhere" | Replays send captured input to configured destinations; now says so | corrected | 2026-09-16 |
| 86 | Next.js build telemetry is off in the image and scripts | `tests/next-telemetry.test.ts` | true | 2026-09-16 |
| 94 | Redaction in the process and again on the server, by name at any depth | `packages/payload-security/src/redact.ts`; `redact.test.ts`; ADR-035 | true | 2026-09-16 |
| 98 | Em dashes in the root security policy | Replaced (5) | corrected | 2026-09-16 |

### `CONTRIBUTING.md`

| Line | Claim | How verified | Result | Checked |
| --- | --- | --- | --- | --- |
| 5 | The mirror is force-pushed "on every green pipeline" | `.gitlab-ci.yml` `mirror-to-github` runs on `main` and tags only, and only once `GITHUB_TOKEN` exists | corrected | 2026-09-16 |
| 36 | ADR-042 covers the Helm chart | `docs/DECISIONS.md` ADR-042 | true | 2026-09-16 |
| 42 | A first journey in about 15 minutes | A target from `docs/PRODUCT_PRINCIPLES.md`, not a measurement; now labelled a target, beside the 2026-09-14 measurement | corrected | 2026-09-16 |

### `docs/OPERATIONS.md`

| Line | Claim | How verified | Result | Checked |
| --- | --- | --- | --- | --- |
| 8 | Everything is in PostgreSQL | ADR-012; compose and chart run no other store | true | 2026-09-16 |
| 22 | The published stack needs only `DATABASE_URL` | It also needs `FLIGHT_RECORDER_VERSION` now; `tests/docs-claims.test.ts` | corrected | 2026-09-16 |
| 38 | No extensions installed | `packages/database/migrations/001_projects.js` comment; `gen_random_uuid()` is built in from PostgreSQL 13 | true | 2026-09-16 |
| 42 | CI runs PostgreSQL 15, 17 and 18 | `tests/supported-versions.test.ts` ("is restated the same way in OPERATIONS.md") | true | 2026-09-16 |
| 66 | `migrate` is the only thing that writes schema | `compose.published.yaml`; the API never calls `migrate.latest` | true | 2026-09-16 |
| 76 | `/ready` 503 until migrated | `apps/api/src/routes/health.ts`; `ready.test.ts` | true | 2026-09-16 |
| 89 | The bundled database is user and database `flight` | `infrastructure/compose.bundled.yaml` | true | 2026-09-16 |
| 148 | Releases are gated on the upgrade test | `.gitlab-ci.yml` `upgrade-test`; `scripts/upgrade-test.mjs`; `tests/upgrade-test-lib.test.ts` | true | 2026-09-16 |
| 180 | 017 and 018 set a five second lock timeout | `017_alias_displayable.js`, `018_journey_browse.js`; `tests/docs-claims.test.ts` ("states the lock timeouts") | true | 2026-09-16 |
| 198 | 018 adds six nullable columns | `packages/database/migrations/018_journey_browse.js` | true | 2026-09-16 |
| 236 | 019 waits up to 10 minutes; the Job retries 30 times; the deadline is 30 minutes | `019_journey_browse_indexes.js` `LOCK_TIMEOUT = "10min"`; `templates/migrate-job.yaml`; `values.yaml` `activeDeadlineSeconds: 1800`; `tests/docs-claims.test.ts` | true | 2026-09-16 |
| 276 | 015 took about 2 s for 100,000 runs; updates waited about 2.3 s | Commit `8e948a4` (2026-09-15); the machine was not recorded | true, dated | 2026-09-16 |
| 346 | Key creation and revocation are audited (new sentence) | `packages/database/src/repositories/key-admin.ts`; `key-admin.integration.test.ts` ("the audit trail") | true | 2026-09-16 |
| 356 | Four subkeys derive from `ENCRYPTION_KEY` | `packages/payload-security/src/keys.ts` `deriveSubkeys`; `tests/docs-claims.test.ts` ("names the four subkeys") | true | 2026-09-16 |
| 380 | Keys are trimmed; the same key twice stops the API | `packages/config/src/schema.ts` `z.string().trim()`; `keyring.test.ts` | true | 2026-09-16 |
| 502 | rotate:reencrypt works in batches of 500 | `rotation.ts` `DEFAULT_BATCH_SIZE = 500`; `tests/docs-claims.test.ts` | true | 2026-09-16 |
| 516 | rotate:reencrypt exits 1 on a held lock; the sweep exits 0 | `packages/database/src/cli.ts`; `rotation.integration.test.ts` | true | 2026-09-16 |
| 591 | Hourly sweep behind an advisory lock | `retention-job.ts` `DEFAULT_INTERVAL_MS`; `retention.ts`; `tests/docs-claims.test.ts` | true | 2026-09-16 |
| 612 | Nothing changes an environment's settings except SQL (new sentence) | `tests/docs-audit-actions.test.ts` ("says plainly that environment settings are changed without an audit row") | true | 2026-09-16 |
| 625 | Deletions are hard and audited in the same transaction | `packages/database/src/repositories/deletion.ts`; `deletion.integration.test.ts` | true | 2026-09-16 |
| 663 | The four deletion commands and their arguments | `packages/database/src/deletion-cli.ts`; `deletion-cli.integration.test.ts` | true | 2026-09-16 |
| 704 | delete:range shares the retention lock | `deletion.ts` `withTransactionLock(db, RETENTION_LOCK_KEY, ...)` | true | 2026-09-16 |
| 715 | The admin API deletes three kinds; range is CLI only | `apps/api/src/routes/deletions.ts` | true | 2026-09-16 |
| 733 | What each deletion's audit row holds | `deletion.ts` metadata builders; `deletions.integration.test.ts` | true | 2026-09-16 |
| 773 | Every published port binds to loopback | `tests/docs-claims.test.ts` ("binds every published port to 127.0.0.1, except the CI overlay's") | true | 2026-09-16 |
| 780 | The web app sets CSP with a nonce and three other headers | `apps/web/src/lib/security-headers.ts`, `apps/web/middleware.ts`; `security-headers.test.ts` | true | 2026-09-16 |
| 786 | Cross-origin form posts are refused | `apps/web/src/lib/same-origin.ts`; `same-origin.test.ts` | true | 2026-09-16 |
| 826 | Replay allowlist defaults | `compose.published.yaml`, `deploy/helm/flight-recorder/values.yaml` (`localhost`); `.env.example` and `compose.yaml` add the demo hosts | true | 2026-09-16 |
| 845 | Five failures a minute lock an address for five minutes | `address-throttle.ts` and `login-limiter.ts` (`maxFailures: 5`, `windowMs: 60_000`, `cooldownMs: 300_000`); `tests/security-review.test.ts` | true | 2026-09-16 |
| 862 | Admin token at least 32 characters; API key 192 bits | `schema.ts` `ADMIN_TOKEN: z.string().min(32)`; `api-key.ts` `KEY_BYTES = 24`; `tests/docs-claims.test.ts` | true | 2026-09-16 |
| 875 | At most 50,000 addresses remembered | `MAX_TRACKED_ADDRESSES = 50_000` in both throttles; `tests/docs-claims.test.ts` | true | 2026-09-16 |
| 869 | IPv6 by /64; mapped IPv4 as IPv4 | `tests/throttle-key-parity.test.ts` | true | 2026-09-16 |
| 900 | Disk per event table (1,049 to 1,496 B at a million events) | `scripts/measure-storage.mjs`, commit `5388756` (2026-09-15), on the machine named; date added | true, dated | 2026-09-16 |
| 921 | Indexes 39 to 56 percent; capture costs about four times the JSON size | Same measurement; 445 B over 120 B of JSON | true, dated | 2026-09-16 |
| 953 | The worked example is 67 GB, 63 GiB | Arithmetic: 67.23 GB, 62.6 GiB | true | 2026-09-16 |
| 974 | Search: 0.1 ms at a million journeys; 13 ms and 64 ms for broad values | Commits `5ffc08e` and `33f8f1e` (2026-09-15), PostgreSQL 17; the machine is not recorded and no script repeats it; date and that gap now stated | true, dated | 2026-09-16 |
| 990 | 014 took 3 s over 3 million events | `014_search_indexes.js` comment; commit `5ffc08e` | true, dated | 2026-09-16 |
| 987 | Four migrations build concurrently | `tests/docs-claims.test.ts` ("builds concurrently the indexes OPERATIONS says it does") | true | 2026-09-16 |
| 1070 | Journey list latency table | `scripts/measure-journey-list.mjs`, commit `b02b381` (2026-09-16); date added | true, dated | 2026-09-16 |
| 1161 | Ingestion cost of the new indexes | Same measurement, commit `8745774` (2026-09-16) | true, dated | 2026-09-16 |
| 1200 | Three blocking scanners | `.gitlab-ci.yml`: `audit`, `secrets`, `container-scan` have `allow_failure: false` | true | 2026-09-16 |
| 1214 | Scanner images are pinned (new sentence) | gitleaks was `latest`; now `v8.30.1` by digest; `tests/docs-claims.test.ts` ("pins every CI image to a tag, and the scanners to a digest") | corrected | 2026-09-16 |
| 1242 | The first container scan found seven CVEs | Commit `e05392d` (2026-08-10); date added | true, dated | 2026-09-16 |
| 1255 | npm stopped classic tokens in November 2025; granular tokens last 90 days at most | npm's announcements (creation stopped 2025-11-05), checked 2026-08-10 when the publish job was designed; not re-checked | true, dated | 2026-09-16 |
| 1279 | Publishing needs npm 11.5.1 or later, checked by the script | `scripts/publish-sdk.sh` | true | 2026-09-16 |
| 1309 | Image verification used `v1.0.0` (four places) | Replaced with `vX.Y.Z`, with a note that releases are 0.x; `tests/docs-claims.test.ts` | corrected | 2026-09-16 |
| 1323 | cosign 3.x signs | `scripts/attest-and-sign.sh` pins `cosign:v3.1.3` | true | 2026-09-16 |
| 1380 | The SBOM is CycloneDX 1.6 | `scripts/sbom.sh` (Syft `cyclonedx-json`, whose current output is 1.6) | true | 2026-09-16 |
| 1436 | doctor's check table | `packages/database/src/doctor.ts`; `doctor.integration.test.ts`; `tests/supported-versions.test.ts` | true | 2026-09-16 |
| 1440 | doctor warns on the demo key `fr_demo00000` | `doctor.ts`; `doctor.integration.test.ts` | true | 2026-09-16 |
| 1506 | At most ten names, 64 characters each; a 2,000 event sample; 5 per journey of 100; 5 s | `secret-names.ts` `SAMPLE_BOUNDS`, `MAX_NAMES_SHOWN`, `MAX_NAME_SHOWN`; `tests/docs-claims.test.ts` | true | 2026-09-16 |
| 1532 | The sample cost 155 ms warm over 600,000 events | Commit `190564b` (2026-09-16); the machine is not recorded; date added | true, dated | 2026-09-16 |
| 1568 | Metrics only on `METRICS_PORT` | `apps/api/src/metrics/listener.ts`; `metrics.integration.test.ts` | true | 2026-09-16 |
| 1572 | "Neither Compose file" publishes the port | There are six Compose files; none publishes it. Reworded | corrected | 2026-09-16 |
| 1592 | The metric names | `apps/api/src/metrics/api-metrics.ts`; `tests/docs-claims.test.ts` ("names the metrics the API exposes, and their buckets") | true | 2026-09-16 |
| 1621 | Duration buckets | `api-metrics.ts`; `tests/docs-claims.test.ts` | true | 2026-09-16 |
| 1607 | Seven methods | `KNOWN_METHODS` in `api-metrics.ts`; `tests/docs-claims.test.ts` | true | 2026-09-16 |
| 1667 | The first sweep runs an hour after start | `retention-job.ts` uses `setInterval` only | true | 2026-09-16 |
| 1675 | Statement timeout 15000 ms | `schema.ts`; `tests/docs-truth.test.ts` ("states the limits the constants actually enforce") | true | 2026-09-16 |
| 1686 | A retention batch took 2.4 s with the index and 9.5 s without | Commit `4c7ab65` (2026-09-15); the machine is not recorded; date added | true, dated | 2026-09-16 |
| 1727 | The logger censors authorization, cookie, x-api-key, x-flight-api-key, set-cookie | `apps/api/src/app.ts` `LOG_REDACT_PATHS` | true | 2026-09-16 |
| 1721 | Parameter names over 64 characters are replaced | `apps/api/src/log-url.ts` `PARAMETER_NAME`; `log-url.test.ts` | true | 2026-09-16 |
| 1766 | "SDK sends nothing" did not link the troubleshooting page | Linked; `tests/docs-claims.test.ts` ("points a reader whose SDK sends nothing") | corrected | 2026-09-16 |
| 1767 | The row said ingestion returns 403 | The batch route answers 202 with `httpStatus: 403` in the result; only `POST /v1/events` answers 403 (`apps/api/src/routes/events.ts`, `journey-environment.integration.test.ts`) | corrected | 2026-09-16 |
| 1775 | Strings are cut to 65,536 characters | `packages/payload-security/src/truncate.ts` `MAX_STRING_LENGTH` | true | 2026-09-16 |
| 3 | Em dashes in OPERATIONS | Replaced (15) | corrected | 2026-09-16 |

### `docs/SECURITY.md`

| Line | Claim | How verified | Result | Checked |
| --- | --- | --- | --- | --- |
| 63 | Throttle, and the token's 32 character floor | As OPERATIONS §9 above | true | 2026-09-16 |
| 75 | The CSP string and headers; the browser suite fails on a violation | `security-headers.ts`; `apps/web/e2e/security-headers.spec.ts` ("the search, journey, journeys, replay, and delete pages work with no CSP violation") | true | 2026-09-16 |
| 126 | Full payload never skips secret detection | `default-secrets.ts` applies in every payload mode; `capture.test.ts` | true | 2026-09-16 |
| 130 | Redaction "should occur" at five points | Written as a requirement. Now what is built: the replay response gets only the echo scrub, and there is no AI request | corrected | 2026-09-16 |
| 163 | A name-value object with any other keys still has `value` replaced | `redact.ts` `namedValueKey`; `header-shapes.test.ts` | true | 2026-09-16 |
| 174 | Interleaved header lists and CRLF header blocks | `packages/payload-security/src/header-shapes.test.ts` | true | 2026-09-16 |
| 240 | The SDK warns once per process and name, cut to 128 characters | `packages/sdk-node/src/secret-names.ts`; `secret-name-warning.test.ts` | true | 2026-09-16 |
| 257 | Names that are not reported | `packages/payload-security/src/secret-name.ts`; `secret-name.test.ts` | true | 2026-09-16 |
| 261 | Eight webhook signature headers are built in | `default-secrets.ts`; `tests/security-review.test.ts` | true | 2026-09-16 |
| 296 | What the error text masker replaces | `packages/payload-security/src/mask-text.ts`; `mask-text.test.ts` | true | 2026-09-16 |
| 349 | SDK cuts messages to 4096 and stacks to 16384 | `recorder.ts` constants; `tests/docs-claims.test.ts` | true | 2026-09-16 |
| 357 | The content hash is an HMAC stored as `h1.` | `packages/payload-security/src/content-hash.ts`; `content-hash.integration.test.ts` | true | 2026-09-16 |
| 367 | API key requirements ("Generate high-entropy keys" and seven more) | Written as requirements. Now what is built, each point read in `api-key.ts`, `key-admin.ts`, `api-keys.ts` and `app.ts` | corrected | 2026-09-16 |
| 400 | A masked alias has no plain-text copy | Check constraint `entity_aliases_display_value_only_when_displayable` and trigger (migration 018); `journey-browse.integration.test.ts` | true | 2026-09-16 |
| 435 | A NUL value gets no copy | Conformance case `wire/displayable-alias-nul` | true | 2026-09-16 |
| 495 | The key id is 12 characters | `keys.ts` `FINGERPRINT_LENGTH = 6` bytes as hex; `tests/docs-claims.test.ts` | true | 2026-09-16 |
| 531 | Echoed destination header values of 8 characters or more are replaced | `apps/api/src/replay/echo-scrub.ts` `MIN_SCRUBBED_LENGTH = 8`; `echo-scrub.test.ts` | true | 2026-09-16 |
| 548 | Isolation tests "must" cover six reads | Written as a requirement. Now names the tests that exist; audit events have no read route | corrected | 2026-09-16 |
| 566 | Replay rules listed as requirements, including "audit every attempt" | Now what is built. Refusals before a run is created are not audited (`apps/api/src/routes/replays.ts`) | corrected | 2026-09-16 |
| 577 | Replay timeout 10 s, response 256 KiB | `send.ts` constants; `tests/docs-claims.test.ts` ("states the replay bounds send.ts applies") | true | 2026-09-16 |
| 599 | "Projects may add more" blocked headers | No setting extends `BLOCKED` in `header-policy.ts`; removed, and the list is tested ("lists the replay header policy's blocked names exactly") | removed | 2026-09-16 |
| 592 | Allowlist defaults | As OPERATIONS §9 above | true | 2026-09-16 |
| 615 | Default propagation includes "standard trace context" | The SDK never writes trace context (`propagation.ts`, ADR-010); now what is built | corrected | 2026-09-16 |
| 633 | Input limits listed as requirements | Now the built values; `tests/docs-truth.test.ts` holds INGESTION_CONTRACT §3 | corrected | 2026-09-16 |
| 644 | SDK safety list, including "configurable stack capture" | No setting configures stacks: the wrappers send none (`recorder.ts`). Now what is built | corrected | 2026-09-16 |
| 660 | Key creation and revocation, capture-policy and retention changes, and destination updates are audited | Keys now audited (`key-admin.ts`); settings have no code path and are stated as unaudited; there is no destination update. `tests/docs-audit-actions.test.ts` | corrected | 2026-09-16 |
| 704 | Retention listed as requirements | Now the built behaviour: `DEFAULT_RETENTION_DAYS` 7, 1,000 per transaction, cascade | corrected | 2026-09-16 |
| 722 | An API key cannot delete | `apps/api/src/routes/deletions.ts` (admin guard); `deletions.integration.test.ts` | true | 2026-09-16 |
| 757 | Pre-release checklist with open boxes | Every item is built; each now names where it is checked | corrected | 2026-09-16 |

### `docs/SECURITY_REVIEW.md`

| Line | Claim | How verified | Result | Checked |
| --- | --- | --- | --- | --- |
| 4 | Every statement links its source; links resolve | `tests/security-review.test.ts`, `tests/docs-links.test.ts` | true | 2026-09-16 |
| 17 | Replays are the API's only outbound requests | `send.ts` is the only client call in `apps/api/src` | true | 2026-09-16 |
| 24 | Default capture mode | `tests/security-review.test.ts` | true | 2026-09-16 |
| 60 | 32 characters, 192 bits, 12 hours, five a minute, eight headers | `tests/security-review.test.ts` ("repeats the numbers the code enforces") | true | 2026-09-16 |
| 74 | Session cookie flags | `apps/web/app/api/login/route.ts`; `NODE_ENV=production` in `apps/web/Dockerfile` | true | 2026-09-16 |
| 102 | Placeholder tag | `tests/security-review.test.ts` | true | 2026-09-16 |
| 109 | Ports and loopback | `tests/docs-claims.test.ts` | true | 2026-09-16 |
| 126 | The review found no Critical, High or Medium issues | `docs/reviews/2026-09-16-security-review.md`; `tests/security-review.test.ts` | true, dated | 2026-09-16 |

### `docs/RELEASE_NOTES_DRAFT.md`

| Line | Claim | How verified | Result | Checked |
| --- | --- | --- | --- | --- |
| 3 | Nothing published | As the README | true, dated | 2026-09-16 |
| 40 | At most one line per kind a minute; four unasked warnings | `diagnostics.ts` `LOG_WINDOW_MS = 60_000`; `tests/docs-claims.test.ts` | true | 2026-09-16 |
| 45 | SDK cost: 30 µs and 513 µs for `transform` at 1 KiB, 219 MiB resident | Re-measured 2026-09-16 with the current SDK: 112 µs and 1,462 µs, 220 MiB. The 2026-09-15 figures predate the secret-name check | corrected | 2026-09-16 |
| 70 | 1,049 and 1,494 bytes per event; 63 GiB | OPERATIONS §10; date and machine added | true, dated | 2026-09-16 |
| 82 | Search 0.1 ms and 64 ms | OPERATIONS §10; date added | true, dated | 2026-09-16 |
| 87 | Journey list under 12 ms at 24 hours; 262 and 316 ms worst case | OPERATIONS §10, *Listing journeys*; date added | true, dated | 2026-09-16 |
| 73 | Compose install | Now names the required version variable | corrected | 2026-09-16 |
| 114 | Key audit rows (new) | `key-admin.integration.test.ts` | true | 2026-09-16 |
| 142 | Node 22.12; PostgreSQL 15, CI on 15, 17 and 18; doctor warns above 18 | `tests/supported-versions.test.ts` | true | 2026-09-16 |
| 148 | The chart was used on kind, never on a managed cluster | ADR-042; `deploy/helm/README.md`. The kind run was by hand and is not repeatable here | not verifiable here | 2026-09-16 |
| 175 | The experimental parts | `@experimental` tags in `packages/sdk-node/src/types.ts` and `config.ts`; SDK README, Stability | true | 2026-09-16 |

### `docs/FAQ.md`

| Line | Claim | How verified | Result | Checked |
| --- | --- | --- | --- | --- |
| 4 | Every number names its source and machine | The search figures had no machine; the sentence now allows for that, and every table is dated. `tests/docs-claims.test.ts` ("dates the counts and measurements it states") | corrected | 2026-09-16 |
| 48 | OTLP is not built | No `/v1/logs` route in `apps/api/src/routes` | true | 2026-09-16 |
| 83 | The storage table | As SECURITY §6 and §7 | true | 2026-09-16 |
| 103 | SDK cost tables (30 / 513, 75 / 1,146, 1,420 / 19,555, 1,079 / 10,337 µs; 219 MiB) | Re-measured twice on 2026-09-16 on the same M3 Pro with the current SDK: 112 / 1,462, 93 / 1,504, 2,172 / 12,526, 1,717 / 10,917; 220 MiB | corrected | 2026-09-16 |
| 135 | Disk per event table | OPERATIONS §10; date added | true, dated | 2026-09-16 |
| 162 | Search table | OPERATIONS §10; date added, machine unrecorded | true, dated | 2026-09-16 |
| 174 | Journey list table | OPERATIONS §10; date added | true, dated | 2026-09-16 |
| 193 | Ingestion 230.6 and 248.3 ms per batch | OPERATIONS §10, *What they cost ingestion* (2026-09-16) | true, dated | 2026-09-16 |
| 202 | Unreachable endpoint added 20 to 116 µs, within the working range | On 2026-09-16 it added 96 to 161 µs, above the working endpoint's, in both runs; corrected with the reason | corrected | 2026-09-16 |
| 208 | Queue 1,000; breaker five failures, 30 s; shutdown 2,000 ms | `resolveConfig`, `recorder.ts`; `tests/docs-claims.test.ts` ("states the transport's bounds") | true | 2026-09-16 |
| 232 | Deletion routes | `apps/api/src/routes/deletions.ts` | true | 2026-09-16 |
| 260 | The SDK reads no environment variables | No `process.env` read in `packages/sdk-node/src` outside comments | true | 2026-09-16 |
| 265 | CI was said to test only PostgreSQL 17, and doctor to warn under 17 | CI runs 15, 17 and 18, and doctor warns above 18 (`doctor.ts`); `tests/docs-claims.test.ts` ("states the PostgreSQL versions CI runs") | corrected | 2026-09-16 |
| 274 | Apache-2.0 with NOTICE | `LICENSE`, `NOTICE`; `license` in the root, SDK and CLI manifests | true | 2026-09-16 |

### `docs/TROUBLESHOOTING.md`

| Line | Claim | How verified | Result | Checked |
| --- | --- | --- | --- | --- |
| 11 | Outputs are from a local stack | Dated in the document; the SDK lines were reproduced with the built SDK on 2026-09-16 | true, dated | 2026-09-16 |
| 39 | A fresh database reports 19 pending migrations | 19 files in `packages/database/migrations`; `tests/docs-claims.test.ts` ("shows the pending migration count") | true | 2026-09-16 |
| 33 | `/health` does not touch the database | `apps/api/src/routes/health.ts`; `health.test.ts` | true | 2026-09-16 |
| 112 | The printed lines | With `logDiagnostics` off, the configuration lines end with a note; now said (`recorder.ts` `printDiagnostic`) | corrected | 2026-09-16 |
| 126 | An empty required setting is reported as missing | `packages/sdk-node/src/config.ts` `text()`; `config.test.ts` | true | 2026-09-16 |
| 145 | One line per kind a minute | `diagnostics.ts` `LOG_WINDOW_MS` | true | 2026-09-16 |
| 167 | Breaker five and 30 s | `tests/docs-claims.test.ts` | true | 2026-09-16 |
| 202 | Every kind and code | `tests/docs-claims.test.ts` ("lists every kind and code, and no other, in TROUBLESHOOTING's table") | true | 2026-09-16 |
| 231 | `required_setting_unusable` is "missing or not a string" | Empty and blank count too (`config.ts`) | corrected | 2026-09-16 |
| 210 | Payload depth 30; width 1,000; strings 65,536; labels 200; aliases 128 and 512 | `limits.ts` (`PAYLOAD_DEPTH = 2` below 32), `recorder.ts` constants | true | 2026-09-16 |
| 254 | Key prefix is 12 characters | `api-key.ts` `API_KEY_PREFIX_LENGTH = 12`; `key-admin.integration.test.ts` | true | 2026-09-16 |
| 271 | Batch answers 202 with the refusal inside | `journey-environment.integration.test.ts` | true | 2026-09-16 |
| 314 | Refusal codes and limits | `tests/docs-truth.test.ts` (the contract tables) | true | 2026-09-16 |
| 361 | 60 s of clock tolerance | `journey-list-query.ts` `SINCE_CLOCK_TOLERANCE_MS`; `tests/docs-claims.test.ts` | true | 2026-09-16 |
| 369 | The clock marker fires after 120 s; a clock ahead is never marked | `apps/web/src/lib/time.ts` `SKEW_THRESHOLD_SECONDS = 120`. The interface tooltip and two code comments said otherwise and were fixed | true | 2026-09-16 |
| 412 | The secret-name line | Both forms printed by the built SDK on 2026-09-16; the note appears only with logging off | corrected | 2026-09-16 |

### `docs/INGESTION_CONTRACT.md`

| Line | Claim | How verified | Result | Checked |
| --- | --- | --- | --- | --- |
| 17 | "section 10 says how to run them" | The contract has nine sections; `tests/docs-links.test.ts` | corrected | 2026-09-16 |
| 14 | Generated schemas are checked byte for byte | `packages/protocol/src/json-schema.test.ts` | true | 2026-09-16 |
| 44 | At most 100 events; 202 with results | `MAX_BATCH_EVENTS`; `events.integration.test.ts` | true | 2026-09-16 |
| 129 | The limits table | `tests/docs-truth.test.ts` ("states the limits the constants actually enforce") | true | 2026-09-16 |
| 131 | Body limit about 25 MiB | `app.ts`: 100 × 262,144 + 65,536 bytes = 25.06 MiB | true | 2026-09-16 |
| 171 | The refusal table | `tests/docs-truth.test.ts` ("lists exactly the refusals the code can send") | true | 2026-09-16 |
| 189 | A refused event leaves no trace | `refusal-leaves-no-trace.integration.test.ts` | true | 2026-09-16 |
| 204 | 30 s or 10 sends | `recorder.ts`; `tests/docs-claims.test.ts` | true | 2026-09-16 |
| 159 | A payload has 30 levels of its own | `limits.ts` `PAYLOAD_DEPTH = 2` | true | 2026-09-16 |
| 367 | Integers beyond 2^53 lose precision | JSON parsing in Node | true | 2026-09-16 |
| 343 | Labels are 1 to 200 code points | `MAX_JOURNEY_LABEL_LENGTH = 200` | true | 2026-09-16 |
| 393 | Dry run parameter rules | `dry-run.integration.test.ts` | true | 2026-09-16 |
| 450 | `otlp` is reserved and unused | `conformance.ts` enum; only `wire` and `sdk` directories exist | true | 2026-09-16 |
| 553 | The loader is "around five hundred lines" | It is 570; now "under six hundred", held by `tests/docs-claims.test.ts` | corrected | 2026-09-16 |

### `docs/API_SPEC.md`

| Line | Claim | How verified | Result | Checked |
| --- | --- | --- | --- | --- |
| 38 | The project header may be omitted with one project | `principal.integration.test.ts` ("requires a project when more than one exists and none is named") | true | 2026-09-16 |
| 88 | 503 `query_timeout` after 15 s | `statement-timeout.integration.test.ts` | true | 2026-09-16 |
| 96 | 429 after five refusals | `auth-throttle.integration.test.ts` | true | 2026-09-16 |
| 129 | 414 for long path parameters | `app.ts` `MAX_PARAM_LENGTH`; `tests/docs-claims.test.ts` | true | 2026-09-16 |
| 147 | At most a hundred envelopes | `MAX_BATCH_EVENTS` | true | 2026-09-16 |
| 239 | Page size 25 and 100; `q` 2 to 200; `entityType` 128; 60 s clock tolerance | `queries.ts`, `journey-list-query.ts`; `tests/docs-claims.test.ts` ("states the list endpoints' page sizes") | true | 2026-09-16 |
| 232 | The journey list parameters | `tests/docs-truth.test.ts` ("documents exactly the query parameters the route reads") | true | 2026-09-16 |
| 399 | Event detail "may include" permissions and replay eligibility | No permission model or eligibility field exists; now the stored event's actual fields (`stored-event.schema.json`) | corrected | 2026-09-16 |
| 431 | "The server must validate the destination against configured host policy" | The host is checked at send, not at creation (`replays.ts`); headers are encrypted; there is no environment-backed option | corrected | 2026-09-16 |
| 445 | "Secrets are never returned" | `listDestinations` selects no header column (`replay.ts`) | true | 2026-09-16 |
| 464 | The replay request takes `payload` and `headers`, and answers `replayId` | `parseReplayRequest` reads `eventId`, `destinationId`, `method` and `path` only, and the answer is the stored run (`replays.ts` `present`). Request and response rewritten | corrected | 2026-09-16 |
| 502 | Refusals before a run are not audited | `replays.ts` | true | 2026-09-16 |
| 518 | The run includes "audit metadata" | `present` returns no audit data; rewritten | corrected | 2026-09-16 |
| 547 | "Exact defaults belong in configuration documentation once implementation measurements exist" | They exist; now points at INGESTION_CONTRACT §3 and states the replay bounds | corrected | 2026-09-16 |
| 575 | 1,152 is nine times 128 | `app.ts`; `tests/docs-claims.test.ts` | true | 2026-09-16 |
| 602 | Dry run lists 1,000; batches of 500; values up to 512 | `deletions.ts`, `deletion.ts`; `tests/docs-claims.test.ts` | true | 2026-09-16 |

### `docs/ROADMAP.md`

| Line | Claim | How verified | Result | Checked |
| --- | --- | --- | --- | --- |
| 18 | 1930 unit, 713 integration, 29 browser, 7 acceptance tests | Counted on 2026-09-16: `pnpm test`, `pnpm test:integration`, `playwright test --list` (29), `vitest list` on the demo config (7); the first two were stale | corrected | 2026-09-16 |
| 33 | `docs/images` holds three screenshots | It holds four (`journeys.png`) | corrected | 2026-09-16 |
| 40 | The CLI commands | `packages/cli/src/cli.ts` | true | 2026-09-16 |
| 46 | A literal run found the port defect | `tests/compose-config.test.ts` records the defect | true, dated | 2026-09-16 |
| 95 | "Each of these now carries a DebtWatch declaration" | The repository has three declarations, none for these two (`grep debtwatch:start`) | corrected | 2026-09-16 |
| 100 | `audit_events` "holds four call sites" | Ten actions now; `tests/docs-audit-actions.test.ts` ("is what ROADMAP counts") | corrected | 2026-09-16 |
| 103 | The limiter is per process | `login-limiter.ts` holds state in module memory | true | 2026-09-16 |
| 115 | "pinned off `:latest`" as future work | The Compose file now requires a version | corrected | 2026-09-16 |
| 170 | Search figures "(measurements on `searchJourneys`)" | No such named measurement exists; now points at OPERATIONS §10 with the date | corrected | 2026-09-16 |
| 186 | Four planning documents are marked | `tests/docs-truth.test.ts` ("keeps the pre-implementation documents marked as such") | true | 2026-09-16 |

### `docs/LOCAL_DEVELOPMENT.md`

| Line | Claim | How verified | Result | Checked |
| --- | --- | --- | --- | --- |
| 9 | Node 24, pnpm 11 | `.nvmrc`; `packageManager` in `package.json` | true | 2026-09-16 |
| 89 | The browser suite reads four variables | `playwright.config.ts` and `apps/web/e2e/session.ts` read `ADMIN_TOKEN`, `FLIGHT_API_KEY`, `API_URL`, `WEB_URL` | true | 2026-09-16 |
| 107 | The demo key | `infrastructure/compose.demo.yaml` | true | 2026-09-16 |
| 121 | The local URLs | `tests/docs-claims.test.ts` ("lists the local URLs the Compose files publish") | true | 2026-09-16 |
| 146 | Both at least 32 characters | `schema.ts` | true | 2026-09-16 |
| 176 | `?? ""` pattern (new explanation) | `config.ts`; the change that made empty count as missing | true | 2026-09-16 |
| 191 | `pnpm format` is a verify gate | The gate is `format:check` (`.gitlab-ci.yml`); `pnpm format` rewrites | corrected | 2026-09-16 |
| 198 | Every command in the table exists | `tests/docs-claims.test.ts` ("names only package scripts that exist") | true | 2026-09-16 |
| 211 | db:seed creates `local`/`development` and prints one key | `packages/database/src/seed-local.ts`; `seed-local.integration.test.ts` | true | 2026-09-16 |
| 222 | An environment mismatch was said to answer 403 | The batch route answers 202 with the refusal inside; corrected | corrected | 2026-09-16 |
| 271 | SDK emits no events: check "debug logs" and "circuit breaker state" | Now the actual tools, `logDiagnostics` and `counters().breakerOpened`, and a link | corrected | 2026-09-16 |
| 321 | Time to first journey "is measured in Epic 12" | It was measured; now states the result | corrected | 2026-09-16 |
| 84 | Em dashes | Replaced (3) | corrected | 2026-09-16 |

### `docs/ALTERNATIVES.md`

| Line | Claim | How verified | Result | Checked |
| --- | --- | --- | --- | --- |
| 3 | Internal references resolve and the dates agree with the README | `tests/docs-truth.test.ts` ("dates the no-open-source-alternative claim"); `tests/docs-links.test.ts`. External claims were not re-checked, as instructed | true | 2026-09-16 |

### `packages/sdk-node/README.md`

| Line | Claim | How verified | Result | Checked |
| --- | --- | --- | --- | --- |
| 11 | No runtime dependencies | `package.test.ts` | true | 2026-09-16 |
| 31 | Tarball name | `tests/docs-claims.test.ts` | true | 2026-09-16 |
| 118 | An alias is displayable only while every statement lists it | ADR-053; `displayable.test.ts` | true | 2026-09-16 |
| 163 | Labels are cut at 200 code points | `label.ts`; `journey-label.test.ts` | true | 2026-09-16 |
| 256 | Eleven operations | `packages/sdk-node/src/operations.ts`; `operations.test.ts` | true | 2026-09-16 |
| 273 | The secret is at least 32 bytes | `journey-id.ts`; `tests/docs-claims.test.ts` | true | 2026-09-16 |
| 303 | The secret warning and the required-setting warning are "the only things the SDK prints unasked" | There are four; `tests/docs-claims.test.ts` | corrected | 2026-09-16 |
| 419 | Propagation levels; aliases never propagate | `propagation.ts`; `propagation.test.ts` | true | 2026-09-16 |
| 449 | Required-setting warning for "missing or not a string" | Empty and blank count too | corrected | 2026-09-16 |
| 526 | One line per kind a minute; reasons cut to 512 | `diagnostics.ts`; `tests/docs-claims.test.ts` | true | 2026-09-16 |
| 593 | Every kind and code | `tests/docs-claims.test.ts` ("lists every kind with its codes, in order, in the SDK README's table") | true | 2026-09-16 |
| 608 | The insecure endpoint rule | `insecure-endpoint.test.ts` | true | 2026-09-16 |
| 641 | Three tries, 0 to 100 then 0 to 200 ms; 30 s or 10 sends | `recorder.ts` transport options; `transient.test.ts`; `tests/docs-claims.test.ts` | true | 2026-09-16 |
| 736 | A name-value object needs "exactly the keys" `name` and `value` | `redact.ts` `namedValueKey` replaces `value` whatever else is there; `tests/docs-claims.test.ts` forbids the old wording | corrected | 2026-09-16 |
| 773 | The sample warning line ends with a note | True with `logDiagnostics` off only; both forms printed on 2026-09-16 and now shown | corrected | 2026-09-16 |
| 860 | 4096 and 16384 | `tests/docs-claims.test.ts` | true | 2026-09-16 |
| 902 | What happens to values | `packages/payload-security/src/exotic.test.ts` and `truncate.test.ts` | true | 2026-09-16 |
| 949 | 256 characters | `recorder.ts` `MAX_ERROR_FIELD_LENGTH`; `error-limits.test.ts` | true | 2026-09-16 |
| 966 | Cost measured on the M3 Pro, undated | Machine stated; dated now | true, dated | 2026-09-16 |
| 985 | Added time: 30 / 513, 75 / 1,146, 1,420 / 19,555, 1,079 / 10,337 µs | Re-measured on 2026-09-16 (two runs): the SDK now costs more, most for `transform` at 1 KiB; the old run is kept for comparison | corrected | 2026-09-16 |
| 1003 | Unreachable and slow endpoints stayed in the stub's range, 20 to 116 µs | On 2026-09-16 the unreachable endpoint was consistently higher; corrected, with the cause | corrected | 2026-09-16 |
| 1022 | Sustained load table | Re-measured 2026-09-16; within noise of the old figures | corrected | 2026-09-16 |
| 1028 | 124,000 stored | 2,000 a second for 62 s; the 2026-09-16 run stored 124,000 again | true | 2026-09-16 |
| 1031 | "The heap after collection does not grow" | It grew 0.2 MiB wrapped and 1.0 MiB unwrapped; stated | corrected | 2026-09-16 |
| 1038 | Send concurrency table | Commits `2434357` and `ab90096` (2026-09-15); not re-run; dated | true, dated | 2026-09-16 |
| 1051 | Fleet model table | Commit `d1729e7` (2026-09-15); not re-run; dated | true, dated | 2026-09-16 |
| 1089 | The API's pool is 10 | `packages/database/src/knex-config.ts` `max: 10` | true | 2026-09-16 |
| 1101 | Clamped to 1-16 | `config.ts` `MAX_CONCURRENT_SENDS_LIMIT = 16` | true | 2026-09-16 |
| 1114 | The configuration table | `tests/docs-claims.test.ts` ("lists the defaults resolveConfig applies") | true | 2026-09-16 |
| 1111 | SDK capture modes | `config.ts` `CAPTURE_MODES` | true | 2026-09-16 |
| 1146 | Node 22.12; CI checks 22.12.0 and 24 | `tests/supported-versions.test.ts` | true | 2026-09-16 |

### `docs/recipes/README.md`

| Line | Claim | How verified | Result | Checked |
| --- | --- | --- | --- | --- |
| 18 | The recipe code is type-checked and copied verbatim | `tests/recipes-typecheck.test.ts` | true | 2026-09-16 |

### `docs/recipes/express-bullmq-hubspot.md`

| Line | Claim | How verified | Result | Checked |
| --- | --- | --- | --- | --- |
| 5 | Leadline is being built as this stack | A project outside this repository; now says so | not verifiable here | 2026-09-16 |
| 53 | An empty key is reported and printed once | `config.ts`; reproduced with the built SDK on 2026-09-16 | true | 2026-09-16 |
| 207 | The `isFailure` error text and code | `recorder.ts` (`reported a failed result.`, code `result_failed`) | true | 2026-09-16 |

### `docs/recipes/fastify-sqs-salesforce.md`

| Line | Claim | How verified | Result | Checked |
| --- | --- | --- | --- | --- |
| 151 | SQS returns no attributes unless named | AWS SQS `ReceiveMessage` behaviour; not re-checked against AWS here | not verifiable here | 2026-09-16 |

### `docs/recipes/nextjs-stripe.md`

| Line | Claim | How verified | Result | Checked |
| --- | --- | --- | --- | --- |
| 100 | `after` is stable since Next.js 15.1 | Next.js 15.1 release notes (December 2024); not re-checked here | not verifiable here | 2026-09-16 |
| 98 | The SDK sends about once a second | `flushIntervalMs` default 1000 | true | 2026-09-16 |
| 134 | The stored input was taken from a local stack | Commit `dfcd399` (2026-09-16); dated | true, dated | 2026-09-16 |
| 122 | `stripe-signature` and the others are built in | `default-secrets.ts` | true | 2026-09-16 |

### `deploy/helm/README.md`

| Line | Claim | How verified | Result | Checked |
| --- | --- | --- | --- | --- |
| 4 | Used on kind, never on a managed cluster | ADR-042; a manual run, not repeated here | not verifiable here | 2026-09-16 |
| 52 | The chart refuses to render without a database | `templates/secret.yaml` `fail`; `helm template` without `databaseUrl` failed with that message on 2026-09-16 | true | 2026-09-16 |
| 66 | Readiness paths | `templates/api.yaml` (`/ready`), `templates/web.yaml` (`/login`) | true | 2026-09-16 |
| 86 | uid 1000 and 70, read-only root, all capabilities dropped | `values.yaml` security contexts | true | 2026-09-16 |
| 114 | Network policy ports | `templates/networkpolicy.yaml` | true | 2026-09-16 |
| 146 | The Job "retries the migration itself for a minute" | It retries a connection failure 30 times, 2 s apart, and anything else once; deadline 1800 s. `tests/docs-claims.test.ts` | corrected | 2026-09-16 |
| 3 | Em dashes | Replaced (5) | corrected | 2026-09-16 |

### `docs/DECISIONS.md`

| Line | Claim | How verified | Result | Checked |
| --- | --- | --- | --- | --- |
| 2191 | ADR-052: an unusable secret is "the one exception to SDK-40" | There are four unasked warnings now; amendment added, decision unchanged. Its code comment in `recorder.ts` was fixed too | corrected | 2026-09-16 |
| 225 | Em dashes in the log | Replaced (61), punctuation only | corrected | 2026-09-16 |
