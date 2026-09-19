# Launch claims follow-up, 2026-09-18

Source baseline: `afa0e6e`, after the Round 3 changes were merged locally.
This is a focused follow-up to the [2026-09-16 audit](claims-audit-2026-09-16.md),
not a repeat of all 306 claims. Updated 2026-09-19 with the primary-source
comparison audit, current SDK, storage and journey-list measurements, npm setup
correction and delivered runtime CI result.
The [verification record](reviews/2026-09-18-round-3-and-release-readiness.md)
contains the commands, results and release-rehearsal limits.

## Corrections

| Claim | Correction and evidence |
| --- | --- |
| The npm package is not published | No usable SDK release is published. `npm view @wayscribe/node versions --json` returned only `0.0.1-placeholder.0`; that deprecated package reserves the name. README, operations, release draft, roadmap, security packet and landing page distinguish it from a working SDK. |
| The launch name is still undecided | Wayscribe is the adopted name, recorded by ADR-057 and implemented in package names, registry paths and the protocol. The new owner fact sheet uses Wayscribe; the old sheet is explicitly historical. |
| Deployment on each event is future work | F-043 is built in timeline rows. F-042's event aliases are built in detail. Both have component and browser coverage in the passing Round 3 suites. |
| The source quick start still needs a copied `.env` CI check | `demo` and `release-verify` now copy `.env.example`, wait for web health as well as the API and demo source, and run acceptance tests. This states what the jobs do, not that a new remote pipeline has passed. |
| The roadmap's test counts describe the current suite | Updated the dated snapshot to the locally passing 3,280 unit, 969 PostgreSQL integration, 64 browser and 7 demo tests. |
| Only the original four warning categories print without opt-in | The release draft now includes unusable optional settings and personal data in public labels, displayable aliases and error messages, matching the six categories in the SDK README and `tests/docs-claims.test.ts`. |
| Fitting an oversized payload means its event arrives | Fitting handles capture limits before sending. Transport failures and ingestion refusals still prevent storage; the release draft no longer promises delivery. |
| Zero transport errors and zero `no_verdict` drops prove a healthy collector | They are inconclusive, including when shutdown occurs before retries are exhausted. The SDK docs, TSDoc, troubleshooting guide and release draft say so. Existing fault tests exercise this case. |
| Released images are already signed and the SDK already has provenance | The draft now describes implemented release jobs and the absence of a completed real release. SDK dry-run and the local AMD64/ARM64 API/web image rehearsal passed after Docker recovery, including four SBOMs, local tags and installation from Compose files alone. Real signing and public package provenance remain unverified. |
| Honeycomb is hosted only and all data lives in its vendor cloud | Honeycomb Private Cloud documents Honeycomb-managed and self-managed deployments in a customer's AWS account. README and Alternatives now describe it as a commercial platform without conflating commercial status with deployment or licence classification. |
| Traces cannot carry record values | Spans can carry arbitrary attributes, including business identifiers and record values an application adds. The narrower documented comparison is Wayscribe's first-class paired step input/output, field diff, aliases across services and journey-linked development replay. |
| Current competitor prices and community access match the 2026-09-16 prose | Nodinite figures are identified as Tier 1 maximums; Turbo360's generic indicative starting price is not called a BAM price; Particular's limited Community production tier and n8n registered Community capabilities are stated; Convoy now cites its primary README. Capability-absence wording is scoped to the inspected documentation. |
| The 2026-09-17 SDK table is current | The 2026-09-19 UTC normal and awake runs replace the launch summary. They name source heads, identical SDK/protocol trees, Node 24.19.0, the shared host and the scheduler/power-state limitation. The 1 KiB local-stub added latency was 76.3 / 1,208.6 µs p50/p99 for `transform` and 28.5 / 452.3 for `persist`; the awake experiment measured 37.0 / 575.0 and 21.8 / 400.6. Slow and unreachable collector cases retain their bounded-buffer drops. |
| The million-event storage figures were freshly repeated | The current run at `9da8b37` completed 100,000 events per capture mode, one tenth of the historical run. It measured 1,217, 1,476, 1,655 and 1,669 bytes per event as ingested, with 944, 1,190, 1,377 and 1,377 after compaction. It used PostgreSQL 17.11 in a 2 CPU, 3 GiB aarch64 container with tmpfs on a shared host, so it is not physical-disk or production-capacity evidence. The 2026-09-15 million-event values remain explicitly historical. |
| The 2026-09-16 journey-list timings are current, or the 120,000-journey refresh covered the new timing predicates | The current run at `9da8b37` completed 120,000 journeys, 360,000 events and 360,000 aliases with 40 samples per browse, text, admin, API-key and second-page case. The default admin 24-hour list measured 6.7 / 14.1 ms p50 / p95; an admin text query matching nothing over 30 days measured 483.3 / 594.2 ms. It used a warm cache and in-process API injection on the same shared-host tmpfs environment as the storage run, so network and physical storage I/O are excluded. The timing predicates retain their separate 2026-09-18 `EXPLAIN` evidence at 20,000 journeys and 60,000 events. |
| The first real SDK version must be published manually to create the npm package | The deprecated placeholder already created and reserved `@wayscribe/node`. The owner should configure its GitLab trusted publisher without a manual SDK publish. New trusted-publisher configurations default to staging; the current release script calls direct `npm publish`, so that allowed action must be enabled. `npm trust list @wayscribe/node --json` returned E401, so the account configuration remains unverified. |
| Runtime delivery is still unverified | Pipeline `2863343305` at `9da8b37` passed all 20 normal jobs. PostgreSQL 15, 17 and 18 each passed 979/979 integration tests and the GitHub mirror reached the same commit. The manual e2e, demo and upgrade jobs intentionally wait for the final docs/assets commit; publication is still unperformed. |

## Facts retained with their limits

- PostgreSQL is the only required backing service. The demo's queue belongs to
  the observed example workflow, not to Wayscribe's storage architecture.
- Payloads are plain `jsonb` after redaction. Entity identifiers and aliases
  are encrypted; displayable alias copies and journey labels are plain text.
  Redaction by field name and error masking by shape are not universal secret
  detection. The current security packet and passing documentation checks
  preserve those distinctions.
- Replay targets configured development destinations. One shared admin token
  can access all projects; there are no individual user accounts or per-user
  audit identities. Neither claim was broadened.
- Supported versions remain Node 22.12+ for SDK/CLI, Node 24 for repository
  work, PostgreSQL 15+, and Compose 2.24+. CI is configured for PostgreSQL
  15/17/18; the current local integration run used 17 only.
- Performance and storage numbers state their dates, revisions, scale and
  environments. Current SDK measurements and the 100,000-event storage run are
  separate from the historical million-event storage and million-journey
  search results.
- The dependency audit passed the high-severity gate with one moderate
  development-only `uuid` advisory. It is not a claim of zero advisories.

The multi-architecture image rehearsal and installation from Compose files
alone passed after Docker recovery, as recorded in the verification record.
The website build also passed: 32 pages and all internal links validated.

## Still needed before launch

- Verify actual package/image publication, provenance and signatures after
  the owner runs the protected release jobs. Do not turn future install
  instructions into current instructions before that verification.
- Time installation on a clean machine and obtain an unfamiliar developer's
  README walkthrough. The 15-minute first-journey target is not a measured
  guarantee.
- Treat the 2026-09-19 competitor audit as a dated primary-source check, not a
  universal claim that undocumented capabilities or extensions are impossible.

The updated owner fact sheet is `~/workspace/wayscribe-launch-facts.md`.
