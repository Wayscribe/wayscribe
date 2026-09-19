# Final whole-branch timing review

Date: 2026-09-19

**Verdict: Ready for local integration.** No Critical or Important findings. One Minor documentation correction should be included in the controller's documentation follow-up; it is not a missing-feature requirement or a runtime integration blocker.

> This record preserves the review issued against Wayscribe `68f5039..6327198b70ce530921a371d0d646e828a98c5013` and Leadline `6b2c210..f65d3e05d9db199713633b63cb79c2f2ecfac881`. M1 was subsequently corrected in the documentation-only follow-up commit that added this record; no retry-state list filter was added and no runtime source changed.

## Scope and method

Reviewed Wayscribe `68f5039..6327198b70ce530921a371d0d646e828a98c5013` and Leadline `6b2c210..f65d3e05d9db199713633b63cb79c2f2ecfac881`. Both checkout heads matched the supplied commits and both tracked working trees were clean at inspection. This review changed only this report.

Read the final-review brief, supplied code-reviewer instructions, timing design and plan, progress ledger including the redelivery ruling and deferred-warning triage, task reports and fix evidence, and Task 4 controller evidence. Inspected the supplied final diff packages in bounded sections, tracing the production changes across SDK/protocol, API/database, web presentation and Leadline adoption/comparison. Reviewed the corresponding regression coverage and documentation where they establish these boundaries. Prior task approvals were evidence, not a substitute for tracing those boundaries.

No broad suite was rerun. One concrete doubt received a focused, read-only check: could a valid 256-code-point astral queue/host value survive the protocol parser but fail the public stored-event Zod schema? A Node 24.19.0 probe of the built protocol parser and `storedEventSchema.pick({ timingContext: true, recordedHost: true })` returned `projectedCodePoints: 256, valid: true`. The concern is resolved; no finding.

## Strengths and requirements compliance

- **Measurement semantics agree across boundaries.** `packages/sdk-node/src/timing-metadata.ts:95` and `packages/protocol/src/timing-context.ts:37` independently omit invalid measurements and retain zero. The web normalizer repeats the same bounded interpretation for mixed-version/malformed reads. Queue wait requires its basis and an appropriate attempt; explicit delivery count above one suppresses initial-enqueue wait even for application attempt one. Retry-ready evidence is never derived from original enqueue age. This matches the accepted ruling and its deliberately conservative omission tradeoff.
- **Host code remains isolated from helper failures.** SDK property/header access is guarded field by field; inherited broker getters remain supported. The helper does not adopt a broker/client dependency. Queue identities use an unambiguous serialized pair and are omitted rather than truncated. HTTP metadata strips destination credentials/path/query and distinguishes actual raw Retry-After evidence from local scheduling policy. The wrapper's attempt/status ownership remains unchanged, with complete usage covered by recorder tests and packed exports.
- **Reads remain scoped and bounded.** `packages/database/src/repositories/event-reads.ts:201` projects only the timing vocabulary and stored runtime hostname; `apps/api/src/routes/present.ts:167` removes internal projection fields and presents normalized evidence. Full detail retains existing redacted raw metadata. There is no alternate unredacted source, payload expansion on timeline rows, ingestion-acceptance change, mutation path, new migration or protocol version. Existing authentication and scoped read flows remain intact.
- **Filters use the correct quantities.** `packages/database/src/repositories/journey-list.ts:90` compares recorded event-start span and stored step duration strictly above the threshold. The event predicate correlates project and journey, avoiding cross-project matches for reused journey IDs; service remains an independent journey predicate. Inactivity applies active status and a strict cutoff within the existing required activity window. API bounds, invalid/repeated parameters and contradictory statuses are covered. Existing keyset order/page bounds remain in use. The query-plan evidence supports retaining existing indexes and correctly avoids a production-latency promise.
- **UI uncertainty is preserved.** `apps/web/app/components/JourneyTimeline.tsx:135` derives gaps before display filtering. `apps/web/src/lib/timing-presentation.ts:69` groups only explicit service/name/retry identities, and `:125` keeps unknown/duplicate/missing attempt evidence, bounded sparse ranges, incomplete-page warnings and pair-specific clock qualifications. Failed operations count as failed even without an error object. Observed retry delay and requested Retry-After stay separate; no successful attempt is promoted to a journey-completion claim. Journey span is correctly first-to-last event start, not summed duration.
- **Navigation and presentation integrate with existing behavior.** Inactivity is calculated once and carried through pagination and list return context (`apps/web/src/lib/journey-filters.ts:77`, `:252`); retry links retain the server query and ordinary selection stays in place. Existing selection, keyboard, load-more and no-JavaScript paths have covering browser evidence. The responsive payload fix changes grid minimum sizing while preserving complete locally scrollable JSON. Older APIs yield absent timing context without breaking detail or timeline rendering.
- **Leadline is an actual consumer of the packed SDK.** `services/hubspot-sync/src/sync-lead.ts:103` passes BullMQ `attemptsStarted` independently of completed application attempts. Push instrumentation passes the helper attempt explicitly and shares the queue retry identity, while raw HTTP response evidence uses its response observation clock. The SDK pin and vendored artifact are updated together. No queue scheduling/retry policy was replaced by recorded metadata.
- **The independent comparator now compares like evidence.** Leadline `tools/scenarios/src/recorded-run.ts:213` opens each returned take-job delivery within the existing bounded reader. `tools/scenarios/src/recording-checks.ts:416` evaluates deliveries separately and uses completed broker clocks only when they can describe that same delivery. It preserves an earlier delivery's recorded wait after later broker timestamps overwrite the source clock, and rejects an invented later-delivery wait. `tools/scenarios/src/timing-evidence.ts:1` validates clocks independently of the SDK and preserves real zero. Reader-backed and invalid-clock regressions cover the Task 4 review corrections.

## Findings

### Critical

None.

### Important

None.

### Minor — M1: Roadmap claims a retry-state list filter that was not implemented

- **Location:** Wayscribe `docs/ROADMAP.md:115` (sentence continues at line 116).
- **Issue:** The duration-filter closure says the Journeys page filters by “active inactivity and retry state.” The implemented API/form adds recorded-span, step-duration and active-inactivity predicates. Retry identities and attempts are presented on journey detail; there is no retry-state list predicate.
- **Impact:** The completion statement overstates the delivered UI, although all specified timing filters are present. This does not justify adding a new filter or expanding timing scope.
- **Correction:** Remove “and retry state” from that sentence, preserving the separate retry-detail completion item. Documentation-only inspection/formatting is sufficient; no runtime suite rerun is warranted.
- **Follow-up:** Corrected after review in the documentation-only commit that added this record. No feature was added.

## Verification evidence and limits

The supplied reports distinguish source commits, failures, corrections and final successful runs. The relevant final local evidence is:

- Wayscribe: 3,415 unit tests; 978 PostgreSQL integration tests; formatting, lint and type checking.
- SDK: 796 SDK/CLI tests on each of Node 22.12.0 and 24.19.0, including packed ESM and CommonJS consumers after the final SDK/protocol redelivery correction.
- Web: production standalone build and 71/71 browser checks, covering CSP, keyboard, no-JavaScript navigation, pagination, timing and realistic payload overflow.
- Leadline final comparator/adoption head: 883 unit tests and all 53 integration tests, including the exact SDK-pinned API-image CLI checks. The older controller note's 50 passed/3 skipped status is superseded explicitly by the later report and ledger; it is not an outstanding skip.
- Independent real-process Leadline run: six scenarios cover ordinary flow, rate-limit retry, slow step, paused-worker backlog/active inactivity, missing broker timestamp and actual stalled redelivery. Broker backlog wait matched recorded evidence; requested 2,000 ms and observed 525 ms remained distinct; delivery two/application attempt one omitted unsupported wait. Later comparator fixes have separate reader-backed verification.
- Documentation closure: 124 relevant truth/claims/site tests plus formatting, on the final documentation changes.

These are reviewed recorded results, not newly rerun suites in this review. No unresolved cross-cutting timing requirement was identified. The code and evidence support local integration; they do not establish remote CI, public delivery/publication, human walkthroughs, an outside pilot or clean-machine installation. Post-timing storage/query remeasurement, claims updates and demo assets remain separate work. The pre-existing migration 019 custom-search-path failure is outside this diff and remains separately queued; timing introduces no migration.

## Deferred-minor triage

- **Next tracing-root warning:** Accepted as a local nested-worktree artifact already present before timing. Both outer and inner lockfiles are visible; production build/standalone/browser checks succeeded. Avoid an unrelated Next configuration change in this branch. The planned flat-checkout/image delivery verification remains appropriate.
- **Node 22 experimental require-ESM warning:** Accepted as the tested runtime's native warning. Packed ESM/CommonJS consumers passed; do not describe the output as warning-free or treat it as an unresolved functional failure.
- **Color-variable conflict:** Closed by removing the conflicting environment from final Leadline runs; no application change or further action required.
- **M1 roadmap wording:** Corrected after review in the documentation-only commit that added this record. No other new Minor finding.

## Assessment

**Ready for local integration: Yes.** Cross-component timing semantics, scope, failure isolation and delivery-aware evidence agree with the design and accepted clarification, with substantial focused and end-to-end evidence. M1 was corrected during the documentation follow-up, the disclosed warning/release limits remain in place, and the work can proceed to the already authorized integration and subsequent delivery steps. No additional timing verification is recommended absent a source change or a new concrete failure.
