# Project ingestion controls implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give self-hosted operators optional per-project ingestion capacity controls without another service or database.

**Architecture:** Parse an explicit policy map once at startup and create one synchronous token-bucket/in-flight admission controller per API app. Native and enabled OTLP handlers share it after authentication and request-shape/count checks. Refusal is retryable HTTP 503, preserving released SDK behavior.

**Tech Stack:** Existing TypeScript, Zod, Fastify, bounded in-memory maps, Vitest and isolated PostgreSQL integration tests.

**Spec:** `docs/superpowers/specs/2026-09-20-ingestion-controls-design.md`.

## Global Constraints

- Implement after native Python, Go and optional OTLP; work locally with no GitLab execution, push, publication, deployment or account changes.
- Default behavior stays unlimited. No additional service or database is needed.
- `INGESTION_LIMITS_JSON`, absent/blank, means disabled. `default` and `projects` are optional; project policies are complete overrides.
- At most 1000 configured UUID project keys. Positive integers: `eventsPerMinute` 1..60,000,000; `burst` 100..1,000,000; `maxConcurrent` 1..1000. Refuse malformed JSON, unknown keys, invalid types and extra fields without echoing the setting value.
- Share one project budget across `/v1/events`, `/v1/events/batch` including dry runs, and enabled `/v1/logs`. Invalid credentials never allocate a bucket.
- Costs are one for a single event and record count for a shape/count-valid batch/export, including duplicates and individually invalid records. Empty batches still reserve concurrency.
- Reserve capacity and concurrency synchronously, with no await between checking and reserving. Do not subtract tokens when refusing concurrency. Release each successful reservation exactly once.
- Track at most 10,000 project buckets. Reclaim only fully refilled idle buckets with zero in-flight work, incrementally; never evict an active/depleted bucket to admit another.
- Temporary refusals use HTTP 503, `Retry-After` whole seconds of at least one, and native code `ingestion_rate_limited`. OTLP uses its matching Status encoding. No event from a refused request is stored.
- Limits apply separately per API process/replica and reset on restart. No installation-wide quota claim. Refusal metrics have only `rate`, `concurrency`, `capacity` labels, never project IDs.

## File and interface map

Create `packages/config/src/ingestion-limits.ts` and its tests for bounded strict parsing. Extend schema/load/export tests without making this a secret-file setting. Create `apps/api/src/ingestion/admission.ts` and its unit tests. Extend `app.ts`, `server.ts`, native event routes and the OTLP route built earlier in this program. Extend `metrics/api-metrics.ts`, deployment settings and their existing checks. No database migration is necessary.

### Task 1: Strict policies and bounded atomic admission

**Files:**
- Create `packages/config/src/{ingestion-limits,ingestion-limits.test}.ts`.
- Modify `packages/config/src/{schema,index}.ts` and relevant loading tests.
- Create `apps/api/src/ingestion/{admission,admission.test}.ts`.

**Interfaces:**
```ts
export interface IngestionPolicy {
  eventsPerMinute: number;
  burst: number;
  maxConcurrent: number;
}
export interface IngestionLimits {
  default?: IngestionPolicy;
  projects?: Readonly<Record<string, IngestionPolicy>>;
}
export type Admission =
  | { admitted: true; release(): void }
  | { admitted: false; reason: "rate" | "concurrency" | "capacity"; retryAfterSeconds: number };
// undefined disables controls; now defaults to performance.now.
export function createIngestionAdmission(
  limits: IngestionLimits | undefined,
  options?: { now?: () => number }
): { reserve(projectId: string, events: number): Admission };
```

- [ ] **Step 1: Write configuration tests and observe RED.** Through `loadServerEnv`, prove blank/missing means disabled, default-only/project-only policies work, overrides do not merge missing fields, 1000 project entries pass and 1001 fail, and every integer boundary is enforced. Reject strings/bools in numeric fields, arrays/null/unknown fields and invalid project IDs. Use a distinctive sentinel in malformed input and assert ConfigError names `INGESTION_LIMITS_JSON` without the sentinel. Export the parsed type for API use; keep arbitrary setting content out of errors.

- [ ] **Step 2: Write literal admission examples and observe RED.** Use injected monotonic time, not wall-clock sleeps. Cover exact rate refill, burst clipping, independent projects, default/override selection, unconfigured unlimited projects, empty-batch concurrency, simultaneous synchronous reservations and idempotent release. A refused concurrency reservation must leave the token budget unchanged.

```ts
let now = 0;
const admission = createIngestionAdmission(
  { default: { eventsPerMinute: 60, burst: 100, maxConcurrent: 1 } },
  { now: () => now }
);
const first = admission.reserve("project-a", 100);
expect(first.admitted).toBe(true);
expect(admission.reserve("project-a", 1)).toMatchObject({ admitted: false, reason: "concurrency" });
if (first.admitted) { first.release(); first.release(); }
expect(admission.reserve("project-a", 1)).toMatchObject({ admitted: false, reason: "rate", retryAfterSeconds: 1 });
now = 1000;
expect(admission.reserve("project-a", 1).admitted).toBe(true);
expect(admission.reserve("project-b", 100).admitted).toBe(true);
```

- [ ] **Step 3: Implement bounded state and test adversarial churn.** Validate internal event costs as integers 0..100. Refill at `eventsPerMinute / 60000` per elapsed millisecond and cap at burst. A release closure can decrement only its own reservation and only once. Walk a fixed small number of map entries per new-project admission with a persistent cursor, removing only idle fully refilled entries; no interval or per-request timer. Fill all 10,000 slots with depleted or active entries, refuse a new project with `capacity`, advance time/release and prove incremental reclamation eventually admits new projects without resetting depleted budgets. Exercise long elapsed times, the exact refill boundary, repeated release and map churn. An unlimited project creates no state.

- [ ] **Step 4: Validate and commit the pure deliverable.** Run focused config/admission tests, package/API typechecks and changed-file lint/format. Keep RED/GREEN commands/output in the report. No route behavior changes yet. Commit `feat(api): add bounded project ingestion admission`.

### Task 2: Shared native/OTLP admission and operator controls

**Files:**
- Modify `apps/api/src/{app,server}.ts`, `routes/events.ts`, the implemented OTLP route/options and `metrics/api-metrics.ts` with its tests.
- Create `apps/api/src/routes/ingestion-admission.integration.test.ts` and focused lifecycle tests.
- Modify `packages/config` deployment compatibility checks if needed, `.env.example`, relevant `infrastructure/compose*.yaml`, Helm values/templates, `docs/{DECISIONS,INGESTION_CONTRACT,API_SPEC,OPERATIONS}.md` and the OTLP guide.

**Interfaces:**
- `BuildAppOptions.ingestionLimits?: IngestionLimits` creates one admission instance; both native and OTLP route registration consume that instance. Server passes the parsed config. No module-global state shared across apps/tests.
- Add `ApiMetrics.countIngestionRefusal(reason)` with the fixed reason union from Task 1. Existing event counters remain for events reaching ingestion, so refusal does not double-count rejected events.
- Native refusal body uses the existing error-body format and fixed safe text; OTLP refusal uses its earlier Status codec. Both expose the same Retry-After.

- [ ] **Step 1: Add database-backed refusal tests and observe RED.** Authenticate two projects with separate environment keys. Exhaust one project using mixed single and batch calls, then assert a request is refused before any ingest write while the other project succeeds. Include dry run and enabled OTLP in the same project budget. Verify malformed/oversized request errors occur before admission; individually invalid records and duplicates cost tokens; invalid credentials create no state and cannot consume another project's budget. Snapshot journey/event/alias rows around refusal. API-key usage bookkeeping remains separate from event persistence.

- [ ] **Step 2: Wire shared reservation and once-only release.** Reserve only after key authentication and envelope-level shape/count validation and before the first ingest/dry-run transaction. Wrap asynchronous handling in try/finally. Handle response, thrown storage error and disconnected clients without leaking or prematurely releasing capacity. A disconnect must not free a slot while already-started database work is still running: stop any remaining batch work, settle/cancel the current operation through existing statement-timeout behavior, then release once. Test this with a controlled blocked ingest boundary and a real socket abort; do not rely only on an onResponse hook. Temporary refusals must never appear as per-event permanent failures.

- [ ] **Step 3: Prove retry compatibility and observability.** Use the public Node SDK and a real loopback API with a short controlled reservation to make the first attempt get 503 and a later attempt succeed; assert stable event IDs and one stored event. No SDK runtime change is needed. Assert Retry-After is an integer at least one on all three refusal reasons and both protocols. Render metrics after many project IDs and confirm only the bounded reason labels exist. Exercise Fastify error paths and app close without dangling timers or reserved slots.

- [ ] **Step 4: Document and wire deployment settings.** Add an ADR explaining per-process scope and why 503 preserves SDK-31's permanent-4xx contract. Pass optional JSON through source/published Compose and Helm without templating it into JavaScript or accidentally converting blank into enabled controls. Document complete overrides, the 100-event burst floor, restart reset, replicas multiplying capacity, finding project IDs, and earlier SDKs not necessarily honoring Retry-After. Add configuration/help examples. Do not deploy or run GitLab.

- [ ] **Step 5: Verify and commit.** Run focused route integration plus native/OTLP auth and ingestion regression suites, config/metrics/docs unit checks, changed-file typecheck/lint/format and local Helm/Compose rendering checks already used by this repository. Include exact commands and outcomes; report unavailable tools explicitly. Commit `feat(api): enforce optional ingestion limits across protocols`.

## Plan self-review

Task 1 owns strict configuration and bounded atomic state; Task 2 owns all protocol integration, counters, lifecycle and operator documentation. Their shared interface is the admission result/release closure, not a database or timer. Slot release follows actual work completion after an abort, preserving the purpose of maxConcurrent. The OTLP route's exact path/signature must be copied into the Task 2 brief from its completed implementation report before dispatch. No default-on limits or SDK behavior changes are introduced.
