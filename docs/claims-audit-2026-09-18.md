# Launch claims follow-up, 2026-09-18

Source baseline: `afa0e6e`, after the Round 3 changes were merged locally.
This is a focused follow-up to the [2026-09-16 audit](claims-audit-2026-09-16.md),
not a repeat of all 306 claims or a new performance benchmark.
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
- Performance and storage numbers retain the dates and machines of their
  original measurements. The SDK timing table predates the latest dogfood
  changes and is not a new measurement of this commit.
- The dependency audit passed the high-severity gate with one moderate
  development-only `uuid` advisory. It is not a claim of zero advisories.

The multi-architecture image rehearsal and installation from Compose files
alone passed after Docker recovery, as recorded in the verification record.
The website build also passed: 32 pages and all internal links validated.

## Still needed before launch

- Verify actual package/image publication, provenance and signatures after
  the owner runs the protected release jobs. Do not turn future install
  instructions into current instructions before that verification.
- Remeasure any performance figure that will be promoted as current. Time
  installation on a clean machine and obtain an unfamiliar developer's README
  walkthrough. The 15-minute first-journey target is not a measured guarantee.
- Recheck external competitor capabilities, licenses and prices if the owner
  plans to quote them. This follow-up deliberately makes no fresh comparative
  market claim; the old alternatives research retains its own dates.

The updated owner fact sheet is `~/workspace/wayscribe-launch-facts.md`.
