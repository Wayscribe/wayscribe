# Root-Cause Linking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A failed step whose error names the field it rejected shows "Likely cause: `phone` lost at **transform-salesforce-account**", computed by the API over the whole journey and shown in the web app, the CLI and the live demo.

**Architecture:** An optional `error.fields: string[]` joins the protocol; the Node, Python and Go SDKs read it by convention (like `code`) and sanitize it inside their failure-isolation boundaries; ingestion stores it unchanged in `journey_events.error`. `pairChanges` moves into `@wayscribe/payload-diff` so the API and the web share it. A pure `findLikelyCauses` in `apps/api/src/journeys/likely-cause.ts` walks one journey in timeline order and, for each failed event, finds the nearest earlier non-failed step whose paired diff removed or changed the field (or an ancestor of it). The journey, timeline and event reads attach `likelyCauses`; the web turns them into text on the server and renders one line under the error and under the journey's status line; the CLI prints the same; the demo target names `fields` in its 422s.

**Tech Stack:** TypeScript on Node 24 (API, web, demo, CLI) and Node 22.12 (the Node SDK and CLI floor), Zod 4, Fastify 5, Knex/PostgreSQL 17, Next 15 / React 19, Vitest 4 (node and jsdom projects), Testcontainers, Playwright 1.63, Python 3.11+ `unittest`, Go 1.22+ `go test`, GitLab CI.

**Spec:** `docs/superpowers/specs/2026-10-12-root-cause-linking-design.md` (issue #8, ADR-072)

---

## Read this first (executor rules)

1. **Credentials.** Never print, `cat`, `head`, `grep` or otherwise read `.env`, `.env.*`, `~/.npmrc`, `~/.pypirc`, `~/.zshenv` or any file a `*_FILE` setting names. Nothing in this plan needs them.
2. **Docker from an agent shell.** Integration tests start PostgreSQL with Testcontainers. Pulls from an agent shell can hang in `docker-credential-desktop`; run them with a credential-free Docker config that keeps the CLI plugins: `export DOCKER_CONFIG=$(mktemp -d) && ln -s ~/.docker/cli-plugins "$DOCKER_CONFIG/cli-plugins"`.
3. **Shell.** Never write `cmd | grep -q pattern` under `pipefail`; capture the output, then match it with `case`. Brace every parameter a colon follows (`"${var}:x"`) in anything zsh may run.
4. **Docs pin claims.** Any change under `README.md`, `docs/` or an SDK README needs the full unit suite (`pnpm test`): `tests/docs-truth.test.ts` counts the ADRs against the README, and `tests/docs-claims.test.ts` refuses an em or en dash in the audited documents, `docs/DECISIONS.md` and `CHANGELOG.md`.
5. **Commits.** One commit per task unless a task says otherwise, a Conventional Commit subject, and a body ending with a blank line then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Every commit command below uses two `-m` flags, which git joins with exactly that blank line.
6. **Test commands.** From the repository root: unit `pnpm exec vitest run <path>`; integration `pnpm exec vitest run --config vitest.integration.config.ts <path>`; Python `sh packages/sdk-python/scripts/test.sh discover -s packages/sdk-python/tests -p <file> -v`; Go `GOTOOLCHAIN=local GOWORK=off go -C packages/sdk-go test ./...`. The root `engines` is Node 24; the Node SDK and CLI also run on 22.12.0 through `scripts/sdk-node-versions.sh 22.12.0` (it downloads the official build and checks its SHA-256).
7. **No unbounded waits.** Any poll of a CI job or a service has a deadline.
8. **Formatting.** CI runs `pnpm format:check` and `pnpm lint`. Before each commit, run `pnpm exec prettier --write <the task's changed files>` and `pnpm exec eslint <the same files>`; the code blocks below are correct but not always wrapped exactly as Prettier wraps them.

## Deviations from spec

Each follows the code as it is and keeps the spec's intent. Items 1 to 4 change behavior the spec describes. Items 3 and 8 were decided by Jorge on 2026-10-12.

1. **Failed events are not candidates.** The spec's candidates are "every event before the reporter that has a stored diff". In the demo every delivery attempt records the customer as input and the 422 response as output, so each attempt's stored diff removes `phone` (the input's `phone: null`). Under the spec's rule the dead-letter's likely cause would be delivery attempt 2, not the transform. A failed step is where a field was refused, not where it changed, so `findLikelyCauses` skips failed events (an error, or the operation `failed`, the same test `deriveStatus` in `packages/database/src/repositories/journeys.ts` uses) as candidates.
2. **A change at the empty path never matches.** `diffPayloads` writes a whole-payload replacement at path `""` (`persist-customer` takes the customer and answers its id, a number). An empty path is technically an ancestor of every field; counting it would make `persist-customer` the likely cause of every field in the demo. A path must have at least one segment to match.
3. **The `schema-rejected` demo journey gets a link; case-only changes count (decided by Jorge, 2026-10-12).** The spec says the transform renames `Status__c` to `status` "with the value intact". It does not: `transformAccount` in `apps/demo/src/transform.ts` lowercases it, so "Former Customer" becomes "former customer", a `renamed-changed` change, which the spec's rule counts. Jorge kept the rule as written: case changes are a real integration bug class (case-sensitive picklists and enums), the line shows before and after so the reader judges, and excluding them starts a slippery slope (whitespace, number and date formatting). The journey links `status` to `transform-salesforce-account` (changed, was "Former Customer", now "former customer"); Task 12 asserts that link, ADR-072 records the rejected exclusion, and the negative case in the live demo is the `timeout` journey, whose errors name no field.
4. **`GET /v1/events/:eventId` also returns `likelyCauses`** for a failed event. The spec lists the journey and timeline reads only, but the web's event detail panel (`EventDetail.tsx`) and `wayscribe event <id>` both read the event endpoint, so without it neither could show the line for an event that is not on a loaded timeline page.
5. **The SDKs also read `fields` from an `isFailure` reason** (Node `isFailure`, Python `is_failure`, Go `FailureReason.Fields`) and Node from an error passed to `record()`. The demo's `phone_required` 422 is a returned result classified by `isFailure: deliveryFailure`, not a throw, so reading only thrown errors would never record it.
6. **The demo's 422 bodies are defined in `apps/demo/src/failures.ts`** (`PHONE_REQUIRED`, `invalidStatus`), which `contacts.ts` and `history.ts` both use. `fields` is added there once; `contacts.ts` does not change.
7. **The journey read needs the failing event's id.** `findJourneyDetail` exposes `failedStep` (a name). It gains `failedStepEventId` from the existing `failed_step_event_id` column (migration 021), under the same `status = 'failed'` guard. It is not presented; the route uses it to pick the causes.
8. **The web app does not import from `@wayscribe/payload-diff` (decided by Jorge, 2026-10-12).** The spec moves pairing into the package and has the web import it. Instead, `packages/payload-diff/src/pairing.ts` is the canonical copy, which the API uses, and the web keeps its copy at `apps/web/src/lib/diff-pairing.ts`; `tests/diff-pairing-parity.test.ts` fails CI if the two differ in text or behaviour. That is the repository's existing convention for code both sides need (`tests/throttle-key-parity.test.ts`). The reason: workspace packages have broken the images before (`pnpm deploy --legacy` symlinks, production-install pruning), and the web app's image stays free of that risk. The web's `package.json`, `next.config.ts` and Dockerfile do not change.
9. **Go has no "non-list" or "non-string entries".** `ErrorInfo.Fields` and `Fields()` are `[]string`; the Go tests cover empty strings, over 20 entries, over 200 runes, nothing surviving, a wrapped error, and a panicking `Fields()`.
10. **The pinned demo journey's digest changes.** `apps/demo/src/history.test.ts` pins the pinned journey's bytes with two SHA-256 digests (ADR-071). Adding `fields` changes those bytes. Task 11 keeps both digests by comparing them against the envelopes with `fields` deleted in place (every other key keeps its order), and asserts where `fields` now appears.
11. **Reporter wording.** The spec's example says "reported by the 422 on delivery attempt 3". The web names the reporting step from the loaded timeline: its name, plus "attempt N" when its timing context has an attempt above 1 ("reported by retry-customer-delivery attempt 3"), or "an earlier failed step" when it is not loaded. The CLI names it from the timeline, or by id for `wayscribe event`.
12. **OTLP.** The spec says there is no OTLP ingest; `apps/api/src/otlp` and API_SPEC's "Optional OTLP logs" exist. Nothing here changes them; an OTLP error never carries `fields`.

## Decisions taken

Jorge decided both open questions on 2026-10-12: case-only changes count as a likely cause (Deviation 3), and the web keeps its own copy of pairing held to the package's by a sync test (Deviation 8, Task 6).

## Found in the code while planning (not changed by this plan)

- **Timeline pages can repeat a row.** `listJourneyEvents` encodes `received_at` in its cursor with `toISOString()` (milliseconds), while `journey_events.received_at` defaults to `now()` (microseconds). The next page's `(event_timestamp, received_at, id) > (...)` then includes the previous page's last row whenever its arrival time has sub-millisecond digits. Seen while checking Task 8's paging test against PostgreSQL 17: page 2 repeated page 1's last event. The web app hides it (`mergeEvents` dedupes by id); `wayscribe journey` (which follows every cursor) and API callers do not. Task 8's test is written so it does not depend on page boundaries. Worth its own issue.
- **`DiffTable.test.tsx` owns every single-quoted pattern in `deploy/demo/smoke-check.sh`**: it extracts each `*'...'*)` case and expects the diff table's markup to contain it. Task 12's new smoke pattern is double-quoted for that reason.

## How this plan was checked

Every code step was applied to a scratch copy of this branch and run before the plan was committed: the Task 1 protocol suite (346 tests), the Node SDK suite (839, including the 17 new), the Python file (7) and full Python suite, the Go module (`go test ./...` and `go vet`, without `-race`) and `gofmt -l`, `findLikelyCauses` (16), the API and database integration suites on PostgreSQL 17 (1,175 tests, all passing once Task 8 Step 7 was added; `mixed-language` needs a built Python wheel and was not run), the web (736), CLI (97) and demo (40) unit suites, `pnpm typecheck`, `pnpm lint`, the full `pnpm test` (4,190), and the web build. After Jorge's decisions, Task 6 was rewritten and checked again the same way: the sync test (12, and failing when one character of the package copy's block changes), both copies' pairing tests, `findLikelyCauses` against the package copy, the web suite (760 with the sync test), the full `pnpm test`, `pnpm typecheck` (root `tsc -b` included), `pnpm lint` and `pnpm --filter @wayscribe/web build`. Not run while planning: the Docker image builds, `scripts/sdk-node-versions.sh 22.12.0`, `pnpm test:demo` and Playwright, which need the full stack.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `packages/protocol/src/event.ts` | Modify | `errorSchema.fields`: optional, 1 to 20 paths of 1 to 200 characters |
| `packages/protocol/src/event.test.ts` | Modify | Accepts valid `fields`, refuses each malformed shape |
| `packages/protocol/src/json-schema.test.ts` | Modify | The capped-string walk covers `error.fields.<items>` |
| `packages/protocol/schemas/0.1/*.schema.json` | Regenerate | Generated JSON Schema picks up `fields` |
| `apps/api/src/ingestion/ingest-event.ts` | Modify | `storedError` documents that `fields` is kept as given |
| `apps/api/src/ingestion/ingest-event.integration.test.ts` | Modify | `fields` stored; malformed refused with `invalid_event` |
| `packages/sdk-node/src/error-fields.ts` | Create | `errorFields`: the SDK's sanitizer and limits |
| `packages/sdk-node/src/error-fields.test.ts` | Create | Sanitizer unit tests and wire tests through a capture server |
| `packages/sdk-node/src/types.ts` | Modify | `ErrorInput.fields` |
| `packages/sdk-node/src/recorder.ts` | Modify | `toErrorRecord`, `failureFrom`, `maskedError` read `fields` |
| `packages/sdk-python/src/wayscribe/_errors.py` | Modify | `error_fields`, `_fields_of`; `capture_error` adds `fields` |
| `packages/sdk-python/src/wayscribe/recorder.py` | Modify | `_failure` passes an `is_failure` mapping's `fields` |
| `packages/sdk-python/tests/test_error_fields.py` | Create | Python SDK `fields` tests |
| `packages/sdk-go/types.go` | Modify | `ErrorInfo.Fields`, `FailureReason.Fields` |
| `packages/sdk-go/errors.go` | Modify | `errorFields`, `fieldsOf`; `hostError` and `captureError` |
| `packages/sdk-go/wrappers.go` | Modify | `IsFailure` reason carries `Fields` |
| `packages/sdk-go/errors_fields_test.go` | Create | Go SDK `fields` tests |
| `packages/payload-diff/src/pairing.ts` | Create (a copy of the web's) | The canonical `pairChanges`, `normalizeKey`, `PairedChange`, `DisplayKind`, which the API uses |
| `packages/payload-diff/src/pairing.test.ts` | Create (a copy of the web's) | The pairing tests, run against the package |
| `packages/payload-diff/src/index.ts` | Modify | Export the pairing API |
| `apps/web/src/lib/diff-pairing.ts` | Modify | Imports nothing; the shared code sits in a marked `pairChanges` block |
| `tests/diff-pairing-parity.test.ts` | Create | Holds the two copies to one text and one behaviour |
| `apps/web/src/lib/event-display.ts` | Modify | Causes as text; rows drop causes |
| `apps/api/src/journeys/likely-cause.ts` | Create | Pure `findLikelyCauses`, `LikelyCause`, the 1,000-event cap |
| `apps/api/src/journeys/likely-cause.test.ts` | Create | Salesforce-shaped unit tests with exact outputs |
| `packages/database/src/repositories/event-reads.ts` | Modify | `listJourneyFailureFacts`, `listJourneyPayloadDiffs` |
| `packages/database/src/repositories/journey-reads.ts` | Modify | `JourneyDetail.failedStepEventId` |
| `packages/database/src/index.ts` | Modify | Export the two new reads |
| `apps/api/src/journeys/journey-causes.ts` | Create | `journeyLikelyCauses` (database to pure function), `isFailedEvent` |
| `apps/api/src/routes/queries.ts` | Modify | Journey, timeline and event reads attach `likelyCauses` |
| `apps/api/src/routes/likely-causes.integration.test.ts` | Create | All three reads, paging, empty cases |
| `apps/web/src/lib/likely-cause-display.ts` | Create | `likelyCausesForDisplay`: API causes to bounded text |
| `apps/web/src/lib/likely-cause-display.test.ts` | Create | Its tests |
| `apps/web/app/components/LikelyCauseLines.tsx` | Create | The "Likely cause" lines with step links |
| `apps/web/app/components/LikelyCauseLines.test.tsx` | Create | Its tests |
| `apps/web/src/lib/api.ts` | Modify | `JourneyDetail.likelyCauses`, `EventDetailData.likelyCauses`, `EventsPageResponse.journeyLikelyCauses` |
| `apps/web/app/components/EventDetail.tsx` (+ test) | Modify | The line under the error block |
| `apps/web/app/components/JourneyTimeline.tsx` (+ test) | Modify | The line under the status summary, kept current by polls |
| `apps/web/app/components/AboutJourneyView.tsx` | Modify | One "Likely cause" definition |
| `apps/web/app/components/AboutJourneyView.test.tsx` | Create | Its test |
| `apps/web/app/(authenticated)/journeys/[journeyId]/page.tsx` | Modify | Passes the journey's causes to the timeline |
| `apps/web/app/api/journeys/[journeyId]/events/route.ts` (+ test) | Modify | Each poll carries `journeyLikelyCauses` |
| `packages/cli/src/client.ts`, `packages/cli/src/format.ts`, `packages/cli/src/cli.test.ts` | Modify | `journey` and `event` print the line |
| `apps/demo/src/failures.ts` | Modify | 422 bodies name `fields` |
| `apps/demo/src/delivery.ts` (+ test) | Modify | `deliveryFailure` copies the target's `fields` |
| `apps/demo/src/history.ts` (+ test) | Modify | Backfilled 422s and errors match the live ones |
| `apps/demo/src/demo.e2e.test.ts` | Modify | Dead-letter links to the transform; schema-rejected and timeout cases |
| `apps/web/e2e/likely-cause.spec.ts` | Create | Detail, header, step link, no-JS, 375 and 1440 px |
| `deploy/demo/smoke-check.sh`, `tests/demo-overlay.test.ts` | Modify | The public demo smoke check also requires the pinned journey's likely-cause line |
| `docs/EVENT_PROTOCOL.md`, `docs/API_SPEC.md` | Modify | `fields`; `likelyCauses` on three reads |
| `docs/INGESTION_CONTRACT.md`, `apps/api/src/routes/dry-run.integration.test.ts` | Modify | A dry run's `stored` has no read-time `likelyCauses` |
| `packages/sdk-node/README.md`, `packages/sdk-python/README.md`, `packages/sdk-go/README.md` | Modify | One paragraph and one example each |
| `docs/DECISIONS.md`, `README.md`, `CHANGELOG.md` | Modify | ADR-072, the ADR count (71 to 72), an Unreleased entry |

Task order: 1 protocol, 2 ingestion, 3 Node SDK, 4 Python SDK, 5 Go SDK, 6 pairing move, 7 `findLikelyCauses`, 8 API reads, 9 web, 10 CLI, 11 demo, 12 demo test and Playwright, 13 docs. Tasks 3, 4 and 5 are independent of each other; everything else runs in order.

---

### Task 1: `error.fields` in the protocol

**Files:**
- Modify: `packages/protocol/src/event.ts` (`errorSchema`, about line 34)
- Modify: `packages/protocol/src/event.test.ts` (append)
- Modify: `packages/protocol/src/json-schema.test.ts` (`finds the fields it is meant to walk`, `overlong`)
- Regenerate: `packages/protocol/schemas/0.1/*.schema.json`

- [ ] **Step 1: Write the failing protocol tests**

Append to `packages/protocol/src/event.test.ts`, after the closing `});` of `describe("journeyEventSchema", ...)`:

```ts
describe("error.fields (ADR-072)", () => {
  const withFields = (fields: unknown): unknown => ({
    ...minimalEvent,
    operation: "delivered",
    name: "deliver-customer-to-target",
    error: { message: "A phone number is required.", code: "phone_required", fields }
  });

  it("accepts the paths the failing system named, as given", () => {
    const fields = ["phone", "BillingAddress.PostalCode", "Opportunity_Lines__c[0].Unit_Price__c"];
    const result = journeyEventSchema.safeParse(withFields(fields));
    expect(result.success).toBe(true);
    expect(result.data?.error?.fields).toEqual(fields);
  });

  it("accepts twenty paths of two hundred characters", () => {
    const fields = Array.from({ length: 20 }, (_, index) => String(index).padEnd(200, "x"));
    expect(journeyEventSchema.safeParse(withFields(fields)).success).toBe(true);
  });

  it.each([
    ["an empty list", []],
    ["an empty path", ["phone", ""]],
    [
      "twenty-one paths",
      Array.from({ length: 21 }, (_, index) => `Opportunity_Lines__c[${String(index)}].Quantity__c`)
    ],
    ["a path of 201 characters", ["x".repeat(201)]],
    ["a string rather than a list", "phone"],
    ["a number in the list", ["phone", 42]]
  ])("refuses %s", (_label, fields) => {
    expect(journeyEventSchema.safeParse(withFields(fields)).success).toBe(false);
  });
});
```

In `packages/protocol/src/json-schema.test.ts`, in `it("finds the fields it is meant to walk", ...)`, replace:

```ts
      expect(names).toContain("error.message");
```

with:

```ts
      expect(names).toContain("error.message");
      expect(names).toContain("error.fields.<items>");
```

and in `function overlong`, replace the final `else` branch:

```ts
      } else {
        // An object at each level of the path, holding what is required beside
        // the field: `runtime.sdk.commit` needs `name` and `version` next to it.
        let parent: Record<string, unknown> = event;
        const prefix: string[] = [];
        for (const key of one.path.slice(0, -1)) {
          prefix.push(key);
          const nested: Record<string, unknown> = { ...REQUIRED_BESIDE[prefix.join(".")] };
          parent[key] = nested;
          parent = nested;
        }
        parent[one.path.at(-1) ?? ""] = value;
      }
```

with:

```ts
      } else {
        // An object at each level of the path, holding what is required beside
        // the field: `runtime.sdk.commit` needs `name` and `version` next to it.
        // A path ending in `<items>` is a list holding the one value:
        // `error.fields` (ADR-072).
        const listed = one.path.at(-1) === "<items>";
        const keys = listed ? one.path.slice(0, -1) : one.path;
        let parent: Record<string, unknown> = event;
        const prefix: string[] = [];
        for (const key of keys.slice(0, -1)) {
          prefix.push(key);
          const nested: Record<string, unknown> = { ...REQUIRED_BESIDE[prefix.join(".")] };
          parent[key] = nested;
          parent = nested;
        }
        parent[keys.at(-1) ?? ""] = listed ? [value] : value;
      }
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm exec vitest run packages/protocol/src/event.test.ts packages/protocol/src/json-schema.test.ts`

Expected: FAIL. `accepts the paths the failing system named` fails with `expected undefined to deeply equal [ 'phone', ... ]` (Zod strips the unknown key); every `refuses ...` case fails with `expected true to be false`; `finds the fields it is meant to walk` fails because `error.fields.<items>` is not in the list.

- [ ] **Step 3: Add `fields` to `errorSchema`**

In `packages/protocol/src/event.ts`, replace:

```ts
export const errorSchema = z.object({
  type: z.string().max(256).optional(),
  message: z.string().min(1).max(4096),
  code: z.string().max(256).optional(),
  stack: z.string().max(16_384).optional()
});
```

with:

```ts
export const errorSchema = z.object({
  type: z.string().max(256).optional(),
  message: z.string().min(1).max(4096),
  code: z.string().max(256).optional(),
  stack: z.string().max(16_384).optional(),
  /**
   * The paths the failing system named (ADR-072), in the syntax a stored diff
   * writes: object keys joined with `.`, array indexes in brackets
   * (`address.postalCode`, `lines[0].sku`). Names, not values, so they are not
   * masked. The API links a failure to the nearest earlier step that changed
   * one of them. Optional and added in 0.1, so the version does not change.
   */
  fields: z.array(z.string().min(1).max(200)).min(1).max(20).optional()
});
```

- [ ] **Step 4: Regenerate the JSON Schema files**

Run: `pnpm --filter @wayscribe/protocol run schemas`

Expected: the script rewrites `packages/protocol/schemas/0.1/`. `git diff --stat packages/protocol/schemas` lists `event.schema.json` alone (the other files refer to it), which gains an `error.properties.fields` of `type: array`, `minItems: 1`, `maxItems: 20`, items `minLength: 1`, `maxLength: 200`.

- [ ] **Step 5: Run the protocol suite and watch it pass**

Run: `pnpm exec vitest run packages/protocol`

Expected: PASS, including `error.fields.<items>, one character over its maximum, is refused by both validators` and `..., at its maximum, is accepted by both validators`, and the drift test `has one committed file per built schema, and no others`.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @wayscribe/protocol typecheck`

Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/protocol/src/event.ts packages/protocol/src/event.test.ts packages/protocol/src/json-schema.test.ts packages/protocol/schemas
git commit -m "feat(protocol): optional error.fields names the rejected paths (#8)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Ingestion stores `fields` as given

**Files:**
- Modify: `apps/api/src/ingestion/ingest-event.ts` (`storedError` doc comment, about line 323)
- Test: `apps/api/src/ingestion/ingest-event.integration.test.ts`

`storedError` already spreads `...rest`, which carries `fields` once Task 1's schema stops stripping it. This task proves that with a test against real PostgreSQL and documents it; it changes no behavior.

- [ ] **Step 1: Write the tests**

In `apps/api/src/ingestion/ingest-event.integration.test.ts`, inside `describe("ingestion stores labels, last steps and plain-text copies", ...)`, directly above `it("keeps the label of the newest event, whatever order a batch holds them in", ...)`, add:

```ts
  it("stores an error's fields as sent (ADR-072)", async () => {
    const fields = [
      "phone",
      "BillingAddress.PostalCode",
      "Opportunity_Lines__c[0].Unit_Price__c"
    ];
    await batch([
      envelope({
        id: "evt_error_fields",
        journeyId: "jrn_error_fields",
        operation: "delivered",
        name: "deliver-customer-to-target",
        error: { message: "A phone number is required.", code: "phone_required", fields }
      })
    ]);
    const row: unknown = await db("journey_events").where({ id: "evt_error_fields" }).first("error");
    expect(row).toEqual({
      error: { message: "A phone number is required.", code: "phone_required", fields }
    });
  });

  it.each([
    ["an empty list", []],
    ["an empty path", ["phone", ""]],
    [
      "twenty-one paths",
      Array.from({ length: 21 }, (_, index) => `Opportunity_Lines__c[${String(index)}].Quantity__c`)
    ],
    ["a path of 201 characters", ["x".repeat(201)]],
    ["a string", "phone"],
    ["a number", [42]]
  ])("refuses fields that are %s with the standard schema error", async (label, fields) => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: envelope({
        id: `evt_bad_fields_${label.replace(/\W+/g, "_")}`,
        journeyId: "jrn_bad_fields",
        error: { message: "The target refused the customer.", fields }
      }) as object
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: "invalid_event",
        message: "The event did not match protocol version 0.1.",
        requestId: expect.any(String)
      }
    });
  });
```

- [ ] **Step 2: Run them**

Run: `pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/ingestion/ingest-event.integration.test.ts -t "fields"`

Expected: PASS (7 tests). If `stores an error's fields as sent` fails with `fields` missing from the row, Task 1 is not in place: Zod is still stripping the key. Do not continue until it passes.

- [ ] **Step 3: Document what `storedError` keeps**

In `apps/api/src/ingestion/ingest-event.ts`, replace:

```ts
 * Under full capture it is kept, masked like the message.
 */
function storedError(
```

with:

```ts
 * Under full capture it is kept, masked like the message.
 *
 * `type`, `code` and `fields` are kept as given. `fields` (ADR-072) is a list
 * of names, not values, and the read side compares it with diff paths, so
 * masking it would only break the link it exists for.
 */
function storedError(
```

- [ ] **Step 4: Run the ingestion suite**

Run: `pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/ingestion`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/ingestion/ingest-event.ts apps/api/src/ingestion/ingest-event.integration.test.ts
git commit -m "test(api): ingestion stores error.fields and refuses malformed ones (#8)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The Node SDK reads `fields`

**Files:**
- Create: `packages/sdk-node/src/error-fields.ts`
- Create: `packages/sdk-node/src/error-fields.test.ts`
- Modify: `packages/sdk-node/src/types.ts` (`ErrorInput` about line 30, `FailureReason` about line 194)
- Modify: `packages/sdk-node/src/recorder.ts` (imports; `failureFrom` about line 520; `maskedError` about line 1102; `toErrorRecord` about line 1363)

- [ ] **Step 1: Write the failing tests**

Create `packages/sdk-node/src/error-fields.test.ts`:

```ts
import { errorSchema } from "@wayscribe/protocol";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { Diagnostic } from "./diagnostics.js";
import { MAX_ERROR_FIELDS, MAX_ERROR_FIELD_LENGTH, errorFields } from "./error-fields.js";
import { createRecorder, type Journey, type Recorder } from "./index.js";

/**
 * An error's `fields` (ADR-072): the paths the failing system named, read by
 * convention like `code`, kept to what the server accepts, and never allowed
 * to cost the step it describes.
 */

const LINES = Array.from(
  { length: 25 },
  (_, index) => `Opportunity_Lines__c[${String(index)}].Unit_Price__c`
);

describe("errorFields", () => {
  it("keeps the paths a list names, in order", () => {
    expect(
      errorFields(["phone", "BillingAddress.PostalCode", "Opportunity_Lines__c[0].Unit_Price__c"])
    ).toEqual(["phone", "BillingAddress.PostalCode", "Opportunity_Lines__c[0].Unit_Price__c"]);
  });

  it("keeps only non-empty strings", () => {
    expect(errorFields(["", 42, null, { path: "phone" }, ["phone"], "phone"])).toEqual(["phone"]);
  });

  it("cuts the list to twenty and each path to two hundred code points", () => {
    const kept = errorFields(["😀".repeat(250), ...LINES]);
    expect(kept).toEqual(["😀".repeat(200), ...LINES.slice(0, 19)]);
    expect(kept).toHaveLength(MAX_ERROR_FIELDS);
  });

  it.each([
    ["a string", "phone"],
    ["an object", { phone: true }],
    ["a number", 7],
    ["null", null],
    ["undefined", undefined],
    ["an empty list", []],
    ["a list of nothing usable", ["", 0, false]]
  ])("answers undefined for %s", (_label, value) => {
    expect(errorFields(value)).toBeUndefined();
  });

  it("matches the protocol's limits", () => {
    // Copied, like the error text limits, because the SDK cannot import the
    // private protocol package at runtime.
    const accepts = (fields: string[]): boolean =>
      errorSchema.safeParse({ message: "m", fields }).success;
    expect(
      accepts(Array.from({ length: MAX_ERROR_FIELDS }, () => "x".repeat(MAX_ERROR_FIELD_LENGTH)))
    ).toBe(true);
    expect(accepts(Array.from({ length: MAX_ERROR_FIELDS + 1 }, () => "x"))).toBe(false);
    expect(accepts(["x".repeat(MAX_ERROR_FIELD_LENGTH + 1)])).toBe(false);
  });
});

const base = {
  apiKey: "wsk_test",
  serviceName: "demo-worker",
  environment: "development"
};

/** Every event the recorder sends, through a real HTTP server, and every diagnostic. */
async function capture(
  run: (recorder: Recorder) => Promise<void> | void
): Promise<{ events: Record<string, unknown>[]; diagnostics: Diagnostic[] }> {
  const events: Record<string, unknown>[] = [];
  const server = createServer((incoming, response) => {
    let body = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk: string) => {
      body += chunk;
    });
    incoming.on("end", () => {
      const parsed = JSON.parse(body) as { events: { event: Record<string, unknown> }[] };
      events.push(...parsed.events.map((entry) => entry.event));
      response.writeHead(202, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ data: { results: parsed.events.map(() => ({ status: "accepted" })) } })
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const diagnostics: Diagnostic[] = [];
  const recorder = createRecorder({
    ...base,
    endpoint: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    onDiagnostic: (d) => diagnostics.push(d)
  });
  try {
    await run(recorder);
    await recorder.shutdown({ timeoutMs: 5_000 });
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
  return { events, diagnostics };
}

const journeyIn = (recorder: Recorder): Journey =>
  recorder.startJourney({ entity: { type: "customer", id: "0018Z00002ABC" } });

describe("an error's fields on the wire (ADR-072)", () => {
  it("records the fields of a thrown error", async () => {
    const rejected = Object.assign(new Error("A phone number is required."), {
      code: "phone_required",
      fields: ["phone", "BillingAddress.PostalCode"]
    });
    const { events } = await capture((recorder) => {
      journeyIn(recorder).fail("move-message-to-dead-letter", rejected);
    });
    expect(events[0]?.["error"]).toEqual({
      message: "A phone number is required.",
      type: "Error",
      code: "phone_required",
      fields: ["phone", "BillingAddress.PostalCode"]
    });
  });

  it("records the fields of an error passed to record()", async () => {
    const { events } = await capture((recorder) => {
      journeyIn(recorder).record({
        operation: "delivered",
        name: "deliver-customer-to-target",
        error: {
          message: 'Property "status" has the value "former customer".',
          code: "invalid_property_value",
          fields: ["status"]
        }
      });
    });
    expect(events[0]?.["error"]).toEqual({
      message: 'Property "status" has the value "former customer".',
      code: "invalid_property_value",
      fields: ["status"]
    });
  });

  it("records the fields an isFailure reason names", async () => {
    const { events } = await capture(async (recorder) => {
      await journeyIn(recorder).deliver(
        "deliver-customer-to-target",
        { externalId: "0018Z00002ABC", phone: null },
        () => Promise.resolve({ status: 422 }),
        { isFailure: (result) => (result.status === 422 ? { fields: ["phone"] } : false) }
      );
    });
    expect(events[0]?.["error"]).toEqual({
      message: "deliver-customer-to-target reported a failed result.",
      code: "result_failed",
      fields: ["phone"]
    });
  });

  it("sends only what the server accepts", async () => {
    const { events } = await capture((recorder) => {
      journeyIn(recorder).fail(
        "move-message-to-dead-letter",
        Object.assign(new Error("rejected"), { fields: ["", 42, "x".repeat(250), ...LINES] })
      );
    });
    expect((events[0]?.["error"] as { fields: unknown }).fields).toEqual([
      "x".repeat(200),
      ...LINES.slice(0, 19)
    ]);
  });

  it("leaves fields off when nothing survives", async () => {
    const values: unknown[] = ["phone", [], ["", 7], { phone: true }];
    const { events } = await capture((recorder) => {
      const journey = journeyIn(recorder);
      for (const fields of values) {
        journey.fail(
          "move-message-to-dead-letter",
          Object.assign(new Error("rejected"), { fields })
        );
      }
    });
    expect(events.map((event) => event["error"])).toEqual(
      values.map(() => ({ message: "rejected", type: "Error" }))
    );
  });

  it("never lets a fields getter or a revoked list escape into the host", async () => {
    const throwing = new Error("A phone number is required.");
    Object.defineProperty(throwing, "fields", {
      get(): never {
        throw new Error("host bug");
      }
    });
    const revocable = Proxy.revocable<string[]>([], {});
    revocable.revoke();
    const revoked = Object.assign(new Error("A phone number is required."), {
      fields: revocable.proxy
    });
    const recorded = {
      message: "rejected",
      get fields(): string[] {
        throw new Error("host bug");
      }
    };

    const { events, diagnostics } = await capture((recorder) => {
      const journey = journeyIn(recorder);
      journey.fail("move-message-to-dead-letter", throwing);
      journey.fail("move-message-to-dead-letter", revoked);
      journey.record({
        operation: "delivered",
        name: "deliver-customer-to-target",
        error: recorded
      });
    });

    expect(events.map((event) => event["error"])).toEqual([
      { message: "A phone number is required.", type: "Error" },
      { message: "A phone number is required.", type: "Error" },
      { message: "rejected" }
    ]);
    expect(diagnostics.some((diagnostic) => diagnostic.kind === "capture_error")).toBe(true);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm exec vitest run packages/sdk-node/src/error-fields.test.ts`

Expected: FAIL with `Failed to load url ./error-fields.js` (the module does not exist).

- [ ] **Step 3: Write the sanitizer**

Create `packages/sdk-node/src/error-fields.ts`:

```ts
/**
 * The limits on an error's `fields` (ADR-072), as the protocol accepts them: a
 * list of 1 to 20 non-empty paths of at most 200 code points.
 *
 * Copied, like the error text limits, because the SDK cannot import the
 * private protocol package at runtime; `error-fields.test.ts` holds them to
 * `errorSchema`.
 */
export const MAX_ERROR_FIELDS = 20;
export const MAX_ERROR_FIELD_LENGTH = 200;

/**
 * The `fields` an error carries, kept to what the server accepts, or
 * undefined when nothing usable is left.
 *
 * Read only from a list, and only its strings: an empty one is dropped, a
 * long one is cut by code point, and the list stops at twenty. Names, not
 * values, so nothing is masked (ADR-046 is for free text). Throws only what
 * the host's own value throws, such as a revoked Proxy or a getter on an
 * index; every caller reads it inside a `safely` boundary.
 */
export function errorFields(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const kept: string[] = [];
  for (const entry of value as readonly unknown[]) {
    if (typeof entry !== "string" || entry === "") continue;
    kept.push(cut(entry));
    if (kept.length === MAX_ERROR_FIELDS) break;
  }
  return kept.length === 0 ? undefined : kept;
}

/** At most 200 code points, so a character outside the BMP is never split. */
function cut(path: string): string {
  if (path.length <= MAX_ERROR_FIELD_LENGTH) return path;
  const points = Array.from(path);
  return points.length <= MAX_ERROR_FIELD_LENGTH
    ? path
    : points.slice(0, MAX_ERROR_FIELD_LENGTH).join("");
}
```

- [ ] **Step 4: Run the sanitizer tests**

Run: `pnpm exec vitest run packages/sdk-node/src/error-fields.test.ts -t errorFields`

Expected: PASS for `describe("errorFields")`; the wire tests still fail (`fields` missing from the recorded error).

- [ ] **Step 5: Add `fields` to `ErrorInput`**

In `packages/sdk-node/src/types.ts`, replace:

```ts
 * Each field is read once, on its own, and only these four are sent: a field
```

with:

```ts
 * Each field is read once, on its own, and only these five are sent: a field
```

and replace:

```ts
  /** Cut to 256 characters. */
  code?: string | undefined;
```

with:

```ts
  /** Cut to 256 characters. */
  code?: string | undefined;
  /**
   * The paths the failing system named, such as `phone` or `lines[0].sku`
   * (ADR-072). Only a list's non-empty strings are sent, at most 20, each cut
   * to 200 characters, and nothing when none is left. Not masked: they are
   * names, not values.
   */
  fields?: readonly string[] | undefined;
```

and replace:

```ts
export interface FailureReason {
  message?: string | undefined;
  code?: string | undefined;
}
```

with:

```ts
export interface FailureReason {
  message?: string | undefined;
  code?: string | undefined;
  /**
   * The paths the failing system named (ADR-072), kept as `ErrorInput.fields`
   * keeps them. A reason with only `fields` keeps the generic message and
   * `result_failed`.
   */
  fields?: readonly string[] | undefined;
}
```

- [ ] **Step 6: Read `fields` in the recorder**

In `packages/sdk-node/src/recorder.ts`:

(a) After `import { fitsCodePoints } from "./code-points.js";` add:

```ts
import { errorFields } from "./error-fields.js";
```

(b) In `failureFrom`, replace:

```ts
    const read = (field: "message" | "code"): unknown =>
      safely(diagnostics, "capture_error", () => (verdict as Record<string, unknown>)[field]);
    const message = read("message");
    const code = read("code");
    return {
      message: isIdentifier(message) ? message : generic,
      code: isIdentifier(code) ? code : "result_failed"
    };
```

with:

```ts
    const read = (field: "message" | "code" | "fields"): unknown =>
      safely(diagnostics, "capture_error", () => (verdict as Record<string, unknown>)[field]);
    const message = read("message");
    const code = read("code");
    // ADR-072: the paths the result says were refused. Walking the host's
    // list is the host's code too, so it has a boundary of its own.
    const fields = safely(diagnostics, "capture_error", () => errorFields(read("fields")));
    return {
      message: isIdentifier(message) ? message : generic,
      code: isIdentifier(code) ? code : "result_failed",
      ...(fields === undefined ? {} : { fields })
    };
```

(c) In the comment above `maskedError`, replace:

```ts
   * used to (F-041 review). Only the four fields the protocol has are sent,
   * each a string: a message that cannot be read, or is not a non-empty
   * string, becomes a fixed text rather than one the server would refuse, and
   * any other field that is not a string is left off.
```

with:

```ts
   * used to (F-041 review). Only the five fields the protocol has are sent:
   * a message that cannot be read, or is not a non-empty string, becomes a
   * fixed text rather than one the server would refuse; `type`, `code` and
   * `stack` are left off unless they are strings; and `fields` keeps only
   * what `errorFields` keeps (ADR-072).
```

(d) In `maskedError`, replace:

```ts
    const stack = read("stack");
```

with:

```ts
    const stack = read("stack");
    const fields = safely(diagnostics, "capture_error", () => errorFields(read("fields")));
```

and replace:

```ts
      ...(typeof stack === "string"
        ? { stack: boundedMaskedText(stack, MAX_ERROR_STACK_LENGTH) }
        : {})
    };
  }
```

with:

```ts
      ...(typeof stack === "string"
        ? { stack: boundedMaskedText(stack, MAX_ERROR_STACK_LENGTH) }
        : {}),
      ...(fields === undefined ? {} : { fields })
    };
  }
```

(e) In `toErrorRecord`, replace:

```ts
        const { message, name, code } = error as {
          message: unknown;
          name: unknown;
          code?: unknown;
        };
        return {
          message: String(message),
          type: String(name),
          ...(typeof code === "string" ? { code } : {})
        };
```

with:

```ts
        const { message, name, code } = error as {
          message: unknown;
          name: unknown;
          code?: unknown;
        };
        // ADR-072: read on its own, so a `fields` getter that throws costs
        // the fields and not the message, the type and the code.
        const fields = safely(diagnostics, "capture_error", () =>
          errorFields((error as { fields?: unknown }).fields)
        );
        return {
          message: String(message),
          type: String(name),
          ...(typeof code === "string" ? { code } : {}),
          ...(fields === undefined ? {} : { fields })
        };
```

- [ ] **Step 7: Run the tests and watch them pass**

Run: `pnpm exec vitest run packages/sdk-node/src/error-fields.test.ts`

Expected: PASS (all tests in both describes).

- [ ] **Step 8: Run the whole SDK suite and typecheck**

Run: `pnpm exec vitest run packages/sdk-node && pnpm --filter @wayscribe/node typecheck`

Expected: PASS, no type errors. `error-limits.test.ts`, `isolation.test.ts`, `result-verdict.test.ts` and `limits-agreement` are unchanged in behavior.

- [ ] **Step 9: Verify on the oldest supported Node**

Run: `scripts/sdk-node-versions.sh 22.12.0`

Expected: ends with the script's success lines for the build, the SDK and CLI unit tests, and the ESM and CommonJS consumer checks on 22.12.0. (CI runs the same in the `sdk-node` matrix job for `22.12.0` and `24`.)

- [ ] **Step 10: Commit**

```bash
git add packages/sdk-node/src/error-fields.ts packages/sdk-node/src/error-fields.test.ts packages/sdk-node/src/types.ts packages/sdk-node/src/recorder.ts
git commit -m "feat(sdk-node): record error.fields from thrown errors, record() and isFailure (#8)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The Python SDK reads `fields`

**Files:**
- Modify: `packages/sdk-python/src/wayscribe/_errors.py` (`capture_error`, about line 201)
- Modify: `packages/sdk-python/src/wayscribe/recorder.py` (`_failure`, about line 646)
- Create: `packages/sdk-python/tests/test_error_fields.py`

- [ ] **Step 1: Write the failing tests**

Create `packages/sdk-python/tests/test_error_fields.py`:

```python
from helpers import *
from wayscribe._errors import capture_error, error_fields
from wayscribe.recorder import _failure

LINES = [f"Opportunity_Lines__c[{i}].Unit_Price__c" for i in range(25)]


class TargetRejected(Exception):
    def __init__(self, message, fields):
        super().__init__(message)
        self.fields = fields


class ExplodingFields(Exception):
    @property
    def fields(self):
        raise RuntimeError("host bug")


class ErrorFieldsTests(unittest.TestCase):
    def test_an_exception_attribute_is_recorded(self):
        c, d, _ = setup()
        e = event(
            c,
            d,
            error=TargetRejected(
                "A phone number is required.",
                ["phone", "BillingAddress.PostalCode", "Opportunity_Lines__c[0].Unit_Price__c"],
            ),
        )
        self.assertEqual(
            e["error"],
            {
                "message": "A phone number is required.",
                "type": "TargetRejected",
                "fields": [
                    "phone",
                    "BillingAddress.PostalCode",
                    "Opportunity_Lines__c[0].Unit_Price__c",
                ],
            },
        )

    def test_a_mapping_key_is_recorded(self):
        _, d, _ = setup()
        out = capture_error(
            {
                "message": "rejected",
                "code": "invalid_property_value",
                "fields": ("status",),
            },
            d,
        )
        self.assertEqual(
            out,
            {"message": "rejected", "code": "invalid_property_value", "fields": ["status"]},
        )

    def test_only_non_empty_strings_survive_cut_to_twenty_and_two_hundred(self):
        self.assertEqual(
            error_fields(["", 42, None, {"path": "phone"}, "😀" * 250] + LINES),
            ["😀" * 200] + LINES[:19],
        )

    def test_anything_but_a_list_or_tuple_is_ignored(self):
        for value in ("phone", {"phone": True}, 7, None, {"phone"}):
            with self.subTest(value=value):
                self.assertIsNone(error_fields(value))

    def test_fields_are_omitted_when_nothing_survives(self):
        _, d, _ = setup()
        for value in ([], ["", ""], [1, 2], "phone"):
            with self.subTest(value=value):
                out = capture_error(TargetRejected("rejected", value), d)
                self.assertEqual(out, {"message": "rejected", "type": "TargetRejected"})

    def test_a_throwing_fields_property_never_escapes(self):
        c, d, reports = setup()
        e = event(c, d, error=ExplodingFields("A phone number is required."))
        self.assertEqual(
            e["error"],
            {"message": "A phone number is required.", "type": "ExplodingFields"},
        )
        self.assertIn("capture_error", [r["kind"] for r in reports])

    def test_an_is_failure_mapping_passes_its_fields(self):
        self.assertEqual(
            _failure(
                {"code": "phone_required", "fields": ["phone"]},
                "deliver-customer-to-target",
            ),
            {
                "message": "deliver-customer-to-target reported a failed result.",
                "code": "phone_required",
                "fields": ["phone"],
            },
        )
        self.assertEqual(
            _failure({"code": "phone_required"}, "deliver-customer-to-target"),
            {
                "message": "deliver-customer-to-target reported a failed result.",
                "code": "phone_required",
            },
        )


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run them and watch them fail**

Run: `sh packages/sdk-python/scripts/test.sh discover -s packages/sdk-python/tests -p test_error_fields.py -v`

Expected: FAIL with `ImportError: cannot import name 'error_fields' from 'wayscribe._errors'`.

- [ ] **Step 3: Add the sanitizer and read `fields` in `capture_error`**

In `packages/sdk-python/src/wayscribe/_errors.py`, replace the whole `def capture_error(error: object, diagnostics: Diagnostics) -> dict[str, str]:` function (through its final `return {"message": "[UNCAPTURABLE]"}`) with:

```python
MAX_ERROR_FIELDS = 20
MAX_ERROR_FIELD_LENGTH = 200


def error_fields(value: object) -> list[str] | None:
    """The paths an error names (ADR-072), kept to what the server accepts.

    Read only from a list or a tuple, and only its strings: an empty one is
    dropped, a long one is cut to 200 code points, and the list stops at 20.
    Names, not values, so nothing is masked. None when nothing is left.
    """
    if not isinstance(value, (list, tuple)):
        return None
    kept: list[str] = []
    for entry in value:
        if type(entry) is not str or entry == "":
            continue
        kept.append(repair_text(entry)[:MAX_ERROR_FIELD_LENGTH])
        if len(kept) == MAX_ERROR_FIELDS:
            break
    return kept or None


def _fields_of(error: object, diagnostics: Diagnostics) -> list[str] | None:
    """An exception's `fields` attribute or a mapping's `fields` key, read in a
    boundary of its own so a property that raises costs only the fields."""
    try:
        if isinstance(error, BaseException):
            value = getattr(error, "fields", None)
        elif isinstance(error, Mapping):
            value = error.get("fields")
        else:
            return None
        return error_fields(value)
    except Exception:
        diagnostics.emit("capture_error", "unexpected_error", {"field": "error.fields"})
        return None


def capture_error(error: object, diagnostics: Diagnostics) -> dict[str, object]:
    try:
        if isinstance(error, BaseException):
            message = str(error)
            kind = type(error).__name__
            code = None
            stack = None
        elif isinstance(error, Mapping):
            message = error.get("message", "[UNCAPTURABLE]")
            kind = error.get("type")
            code = error.get("code")
            stack = error.get("stack")
        elif type(error) is str:
            message = error
            kind = None
            code = None
            stack = None
        else:
            message = "[UNCAPTURABLE]"
            kind = None
            code = None
            stack = None
        if type(message) is not str:
            message = "[UNCAPTURABLE]"
        masked = mask_text(message)
        out: dict[str, object] = {
            "message": (
                masked if len(masked) <= 4096 else masked[:4085] + "[TRUNCATED]"
            )
            or "[UNCAPTURABLE]"
        }
        for key, value, limit in (
            ("type", kind, 256),
            ("code", code, 256),
            ("stack", stack, 16384),
        ):
            if type(value) is str:
                out[key] = mask_text(value)[:limit]
        fields = _fields_of(error, diagnostics)
        if fields is not None:
            out["fields"] = fields
        public_warning(out["message"], "error", diagnostics)
        return out
    except Exception:
        diagnostics.emit("capture_error", "unexpected_error", {"field": "error"})
        return {"message": "[UNCAPTURABLE]"}
```

`repair_text` is already imported at the top of the module (`from ._capture import REDACTED, SECRETS, fold, repair_text`).

- [ ] **Step 4: Pass an `is_failure` mapping's `fields` along**

In `packages/sdk-python/src/wayscribe/recorder.py`, replace:

```python
    if isinstance(verdict, Mapping):
        message, code = verdict.get("message"), verdict.get("code")
        return {
            "message": message if type(message) is str and message else generic,
            "code": code if type(code) is str and code else "result_failed",
        }
```

with:

```python
    if isinstance(verdict, Mapping):
        message, code = verdict.get("message"), verdict.get("code")
        failure = {
            "message": message if type(message) is str and message else generic,
            "code": code if type(code) is str and code else "result_failed",
        }
        # ADR-072: capture_error keeps only what the server accepts.
        if "fields" in verdict:
            failure["fields"] = verdict.get("fields")
        return failure
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `sh packages/sdk-python/scripts/test.sh discover -s packages/sdk-python/tests -p test_error_fields.py -v`

Expected: `Ran 7 tests ... OK`.

- [ ] **Step 6: Run the whole Python suite, on the floor too**

Run: `pnpm test:python`, then, if Python 3.11 is installed, `WAYSCRIBE_TEST_PYTHON=python3.11 pnpm test:python`.

Expected: `OK` for both. CI's `sdk-python` job runs 3.11 and 3.14.

- [ ] **Step 7: Commit**

```bash
git add packages/sdk-python/src/wayscribe/_errors.py packages/sdk-python/src/wayscribe/recorder.py packages/sdk-python/tests/test_error_fields.py
git commit -m "feat(sdk-python): record error.fields from exceptions, mappings and is_failure (#8)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The Go SDK reads `fields`

**Files:**
- Modify: `packages/sdk-go/types.go` (`ErrorInfo` about line 55, `FailureReason` about line 79)
- Modify: `packages/sdk-go/errors.go` (imports, `hostError` about line 63, `captureError` about line 76)
- Modify: `packages/sdk-go/wrappers.go` (about line 181)
- Create: `packages/sdk-go/errors_fields_test.go`

- [ ] **Step 1: Write the failing tests**

Create `packages/sdk-go/errors_fields_test.go`:

```go
package wayscribe

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

// targetRejected is a host error that names the fields it refused (ADR-072).
type targetRejected struct{ names []string }

func (targetRejected) Error() string      { return "A phone number is required." }
func (e targetRejected) Fields() []string { return e.names }

type panickingFields struct{}

func (panickingFields) Error() string    { return "A phone number is required." }
func (panickingFields) Fields() []string { panic("host bug") }

func opportunityLines(n int) []string {
	lines := make([]string, 0, n)
	for i := 0; i < n; i++ {
		lines = append(lines, fmt.Sprintf("Opportunity_Lines__c[%d].Unit_Price__c", i))
	}
	return lines
}

func TestHostErrorReadsFields(t *testing.T) {
	_, d := core(t, testConfig())
	out := captureError(*hostError(targetRejected{names: []string{"phone", "BillingAddress.PostalCode"}}), d)
	if !reflect.DeepEqual(out["fields"], []string{"phone", "BillingAddress.PostalCode"}) {
		t.Fatal(out)
	}
	if out["message"] != "A phone number is required." || out["type"] != "targetRejected" {
		t.Fatal(out)
	}
}

func TestHostErrorReadsWrappedFields(t *testing.T) {
	wrapped := fmt.Errorf("deliver-customer-to-target: %w", targetRejected{names: []string{"phone"}})
	if got := hostError(wrapped).Fields; !reflect.DeepEqual(got, []string{"phone"}) {
		t.Fatal(got)
	}
}

func TestErrorFieldsSanitized(t *testing.T) {
	_, d := core(t, testConfig())
	lines := opportunityLines(25)
	long := strings.Repeat("😀", 250)
	out := captureError(ErrorInfo{Message: "rejected", Fields: append([]string{"", long}, lines...)}, d)
	want := append([]string{strings.Repeat("😀", 200)}, lines[:19]...)
	if !reflect.DeepEqual(out["fields"], want) {
		t.Fatal(out["fields"])
	}
}

func TestErrorFieldsOmittedWhenNothingSurvives(t *testing.T) {
	_, d := core(t, testConfig())
	for _, given := range [][]string{nil, {}, {"", ""}} {
		out := captureError(ErrorInfo{Message: "rejected", Fields: given}, d)
		if _, ok := out["fields"]; ok {
			t.Fatal(out)
		}
	}
	if got := hostError(ConnectionError{}).Fields; got != nil {
		t.Fatal(got)
	}
	if got := hostError(targetRejected{names: []string{"", ""}}).Fields; got != nil {
		t.Fatal(got)
	}
}

func TestPanickingFieldsNeverEscapes(t *testing.T) {
	info := hostError(panickingFields{})
	if info.Message != "A phone number is required." || info.Type != "panickingFields" || info.Fields != nil {
		t.Fatal(info)
	}
}

func TestFailureReasonFieldsRecorded(t *testing.T) {
	r, s := testRecorder(t, nil)
	j := r.Journey(Entity{"customer", "0018Z00002ABC"})
	_, _ = Deliver(context.Background(), j, "deliver-customer-to-target", 0,
		func(context.Context) (int, error) { return 422, nil },
		Options[int, int]{IsFailure: func(int) *FailureReason {
			return &FailureReason{Message: "A phone number is required.", Code: "phone_required", Fields: []string{"phone"}}
		}})
	es := flushedEvents(t, r, s)
	if len(es) != 1 {
		t.Fatal(es)
	}
	got := es[0]["error"].(map[string]any)
	want := map[string]any{"message": "A phone number is required.", "code": "phone_required", "fields": []any{"phone"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatal(got)
	}
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `GOTOOLCHAIN=local GOWORK=off go -C packages/sdk-go test -run 'TestHostErrorRead|TestErrorFields|TestPanickingFields|TestFailureReasonFields' ./...`

Expected: FAIL to compile: `unknown field Fields in struct literal of type ErrorInfo`, `hostError(...).Fields undefined`, `unknown field Fields in struct literal of type FailureReason`.

- [ ] **Step 3: Add the fields to the types**

In `packages/sdk-go/types.go`, replace:

```go
type ErrorInfo struct {
	Type    string `json:"type,omitempty"`
	Message string `json:"message"`
	Code    string `json:"code,omitempty"`
	Stack   string `json:"stack,omitempty"`
}
```

with:

```go
// ErrorInfo is an event's error. Fields names the paths the failing system
// rejected (ADR-072); only non-empty paths are sent, at most 20, each cut to
// 200 runes, and none when nothing is left.
type ErrorInfo struct {
	Type    string   `json:"type,omitempty"`
	Message string   `json:"message"`
	Code    string   `json:"code,omitempty"`
	Stack   string   `json:"stack,omitempty"`
	Fields  []string `json:"fields,omitempty"`
}
```

and replace:

```go
type FailureReason struct{ Message, Code string }
```

with:

```go
// FailureReason is what IsFailure returns for a failed result. Fields names
// the paths the failing system rejected (ADR-072).
type FailureReason struct {
	Message, Code string
	Fields        []string
}
```

- [ ] **Step 4: Read and sanitize `Fields`**

In `packages/sdk-go/errors.go`, replace:

```go
import (
	"reflect"
	"regexp"
	"strings"
)
```

with:

```go
import (
	"errors"
	"reflect"
	"regexp"
	"strings"
)
```

Replace:

```go
		out.Type = t.Name()
		out.Message = err.Error()
	}
	return out
}
```

with:

```go
		out.Type = t.Name()
		out.Message = err.Error()
		out.Fields = fieldsOf(err)
	}
	return out
}

// maxErrorFields and maxErrorFieldRunes are the protocol's limits on an
// error's fields (ADR-072).
const (
	maxErrorFields     = 20
	maxErrorFieldRunes = 200
)

// fieldsReporter is the convention a host error follows to name the paths
// the failing system rejected, as Code-like conventions do in the other SDKs.
type fieldsReporter interface{ Fields() []string }

// fieldsOf reads Fields() from err or anything it wraps. A panicking Fields()
// costs the fields only: the message and type are already read.
func fieldsOf(err error) (fields []string) {
	defer func() {
		if recover() != nil {
			fields = nil
		}
	}()
	var reporter fieldsReporter
	if errors.As(err, &reporter) {
		return errorFields(reporter.Fields())
	}
	return nil
}

// errorFields keeps the non-empty paths, cut to 200 runes, at most 20, or nil
// when none is left. Names, not values, so nothing is masked.
func errorFields(fields []string) []string {
	var kept []string
	for _, field := range fields {
		if field == "" {
			continue
		}
		kept = append(kept, prefixRunes(repairText(field), maxErrorFieldRunes))
		if len(kept) == maxErrorFields {
			break
		}
	}
	return kept
}
```

and in `captureError`, replace:

```go
	if e.Stack != "" {
		out["stack"] = prefixRunes(maskText(e.Stack), 16384)
	}
	publicWarning(message, "errorMessage", d)
```

with:

```go
	if e.Stack != "" {
		out["stack"] = prefixRunes(maskText(e.Stack), 16384)
	}
	if fields := errorFields(e.Fields); len(fields) > 0 {
		out["fields"] = fields
	}
	publicWarning(message, "errorMessage", d)
```

In `packages/sdk-go/wrappers.go`, replace:

```go
						failure = &ErrorInfo{Message: reason.Message, Code: reason.Code}
```

with:

```go
						failure = &ErrorInfo{Message: reason.Message, Code: reason.Code, Fields: reason.Fields}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `GOTOOLCHAIN=local GOWORK=off go -C packages/sdk-go test -run 'TestHostErrorRead|TestErrorFields|TestPanickingFields|TestFailureReasonFields' ./...`

Expected: `ok  	wayscribe.dev/go`.

- [ ] **Step 6: Format, vet, race, and the whole module**

Run: `gofmt -l packages/sdk-go` (expected: no output), then `GOTOOLCHAIN=local GOWORK=off go -C packages/sdk-go vet ./...` and `GOTOOLCHAIN=local GOWORK=off go -C packages/sdk-go test -race ./...`.

Expected: no vet findings; `ok` for every package. CI's `sdk-go` job runs Go 1.22.0 and 1.26.4; locally, `GOTOOLCHAIN=go1.22.0 GOWORK=off go -C packages/sdk-go test ./...` checks the floor when that toolchain can be fetched.

- [ ] **Step 7: Commit**

```bash
git add packages/sdk-go/types.go packages/sdk-go/errors.go packages/sdk-go/wrappers.go packages/sdk-go/errors_fields_test.go
git commit -m "feat(sdk-go): record error fields from Fields() and FailureReason (#8)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Share pairing with the API: a canonical copy in `@wayscribe/payload-diff`, the web's copy held to it

**Files:**
- Create: `tests/diff-pairing-parity.test.ts`
- Modify: `apps/web/src/lib/diff-pairing.ts` (imports nothing; the shared code between `// pairChanges: begin` and `// pairChanges: end`)
- Create: `packages/payload-diff/src/pairing.ts` (the canonical copy, which the API imports)
- Create: `packages/payload-diff/src/pairing.test.ts` (the web's pairing tests, run against the package)
- Modify: `packages/payload-diff/src/index.ts`

The web app keeps depending on no workspace package (Deviation 8). The repository's convention for code both sides need is a copy in each, with a test in `tests/` that holds the copies to one text and one behaviour: `tests/throttle-key-parity.test.ts` does it for `throttleKey` with marked blocks and shared vectors, and this task does the same for `pairChanges`. `apps/web/src/lib/event-display.ts`, `apps/web/package.json`, `next.config.ts` and the web Dockerfile do not change. Behaviour is unchanged.

- [ ] **Step 1: Write the failing sync test**

Create `tests/diff-pairing-parity.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  diffPayloads,
  normalizeKey as apiNormalizeKey,
  pairChanges as apiPairChanges,
  type Change
} from "../packages/payload-diff/src/index.js";
import {
  normalizeKey as webNormalizeKey,
  pairChanges as webPairChanges
} from "../apps/web/src/lib/diff-pairing.js";

const root = fileURLToPath(new URL("../", import.meta.url));

/**
 * One pairing, in the diff table and in the likely cause (ADR-072).
 *
 * The API finds a failure's likely cause with `pairChanges` from
 * `@wayscribe/payload-diff`, and the web app pairs the diff it displays with
 * its own copy, because it depends on no workspace package: a workspace
 * package in the web image has broken it before. So the code exists twice, and
 * this test holds the copies to one behaviour and one text. A rename paired in
 * one and not the other would show a reader a diff that disagrees with the
 * likely cause printed above it.
 */
const ACCOUNT = {
  Id: "0018Z00002ABC",
  Name: "Acme Field Services",
  Phone: "+1 919 555 1234",
  Status__c: "Former Customer",
  BillingAddress: { city: "Raleigh", postalCode: "27601" },
  Opportunity_Lines__c: [{ Product_Code__c: "SKU-100", Unit_Price__c: 49.5 }]
};
const CUSTOMER = {
  externalId: "0018Z00002ABC",
  name: "Acme Field Services",
  phone: null,
  status: "former customer",
  address: { city: "Raleigh", postalCode: "27601" },
  lines: [{ sku: "SKU-100", unitPrice: 49.5 }]
};

const VECTORS: [name: string, changes: Change[]][] = [
  ["a Salesforce account mapped to a customer", diffPayloads(ACCOUNT, CUSTOMER).changes],
  [
    "two removed keys that normalize alike, left unpaired",
    [
      { path: "Phone", kind: "removed", before: "+1 919 555 1234" },
      { path: "Phone__c", kind: "removed", before: "+1 919 555 1234" },
      { path: "phone", kind: "added", after: "+1 919 555 1234" }
    ]
  ],
  [
    "keys paired only within their parent",
    [
      { path: "BillingAddress.PostalCode", kind: "removed", before: "27601" },
      { path: "address.postalCode", kind: "added", after: "27601" }
    ]
  ],
  [
    "array elements, which never pair",
    [
      { path: "lines[2]", kind: "removed", before: "SKU-300" },
      { path: "lines[3]", kind: "added", after: "SKU-300" }
    ]
  ],
  ["no changes at all", []]
];

describe("pairChanges", () => {
  for (const [name, changes] of VECTORS) {
    it(`pairs ${name} the same in the API and the web app`, () => {
      expect(webPairChanges(changes)).toEqual(apiPairChanges(changes));
    });
  }

  it.each(["Phone", "PHONE", "Status__c", "First_Name__c", "x-request-id", "my__cfield"])(
    "normalizes %s the same in both",
    (key) => {
      expect(webNormalizeKey(key)).toBe(apiNormalizeKey(key));
    }
  );

  it("is the same text in both copies", () => {
    const block = (relative: string): string => {
      const text = readFileSync(`${root}${relative}`, "utf8");
      const found = /\/\/ pairChanges: begin\n([\s\S]*?)\/\/ pairChanges: end\n/.exec(text);
      expect(found, `${relative} has no marked pairChanges block`).not.toBeNull();
      return found?.[1] ?? "";
    };
    expect(block("apps/web/src/lib/diff-pairing.ts")).toBe(
      block("packages/payload-diff/src/pairing.ts")
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run tests/diff-pairing-parity.test.ts`

Expected: FAIL, all 12 cases. `@wayscribe/payload-diff` exports no pairing yet (`TypeError: pairChanges is not a function`, `TypeError: normalizeKey is not a function`), and the web copy has no marked block.

- [ ] **Step 3: Make the web copy self-contained and mark the shared block**

The root TypeScript project (`tsc -b`, `NodeNext`) type-checks the sync test and everything it imports, and it cannot resolve the web's extensionless `./api` import. So the web copy writes its one type out instead of importing it; `DiffChange` in `./api` is structurally the same, so every caller is unchanged.

```bash
sed -i.bak -e 's/DiffChange/Change/g' apps/web/src/lib/diff-pairing.ts && rm apps/web/src/lib/diff-pairing.ts.bak
```

In `apps/web/src/lib/diff-pairing.ts`, replace:

```ts
import type { Change } from "./api";
```

with:

```ts
/** A diff change, as `DiffChange` in `./api`, written out so this file imports nothing. */
interface Change {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
}

// A copy of `packages/payload-diff/src/pairing.ts`, the one the API uses: the
// web app depends on no workspace package. tests/diff-pairing-parity.test.ts
// holds the two to one text and one behaviour (ADR-072).
// pairChanges: begin
```

and replace:

```ts
 * damage first. Display only: the stored diff and the API's answer keep their
 * three kinds.
```

with:

```ts
 * damage first. The stored diff and the API's diff answers keep their three
 * kinds: the web pairs to display a diff, and the API pairs only to find a
 * likely cause (ADR-072).
```

Then end the block: `printf '// pairChanges: end\n' >> apps/web/src/lib/diff-pairing.ts`. The file's last two lines are now the closing `}` of `pairChanges` and `// pairChanges: end`.

- [ ] **Step 4: Create the canonical copy in the package**

```bash
cp apps/web/src/lib/diff-pairing.ts packages/payload-diff/src/pairing.ts
cp apps/web/src/lib/diff-pairing.test.ts packages/payload-diff/src/pairing.test.ts
sed -i.bak \
  -e 's#import type { DiffChange } from "./api";#import type { Change } from "./diff.js";#' \
  -e 's#from "./diff-pairing";#from "./pairing.js";#' \
  -e 's/DiffChange/Change/g' \
  packages/payload-diff/src/pairing.test.ts && rm packages/payload-diff/src/pairing.test.ts.bak
```

In `packages/payload-diff/src/pairing.ts`, replace everything above `// pairChanges: begin`, that is:

```ts
/** A diff change, as `DiffChange` in `./api`, written out so this file imports nothing. */
interface Change {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
}

// A copy of `packages/payload-diff/src/pairing.ts`, the one the API uses: the
// web app depends on no workspace package. tests/diff-pairing-parity.test.ts
// holds the two to one text and one behaviour (ADR-072).
// pairChanges: begin
```

with:

```ts
import type { Change } from "./diff.js";

// The copy the API uses. The web app keeps its own in
// `apps/web/src/lib/diff-pairing.ts`, because it depends on no workspace
// package; tests/diff-pairing-parity.test.ts holds the two to one text and one
// behaviour (ADR-072).
// pairChanges: begin
```

The first three lines of `packages/payload-diff/src/pairing.test.ts` now read:

```ts
import { describe, expect, it } from "vitest";
import type { Change } from "./diff.js";
import { normalizeKey, pairChanges, type PairedChange } from "./pairing.js";
```

Replace the whole of `packages/payload-diff/src/index.ts` with:

```ts
export {
  diffPayloads,
  type Change,
  type ChangeKind,
  type DiffOptions,
  type DiffResult
} from "./diff.js";
export { normalizeKey, pairChanges, type DisplayKind, type PairedChange } from "./pairing.js";
```

- [ ] **Step 5: Run the sync test, both copies' tests, typecheck and lint**

Run:

```bash
pnpm exec vitest run tests/diff-pairing-parity.test.ts packages/payload-diff apps/web/src/lib
pnpm typecheck
pnpm exec eslint tests/diff-pairing-parity.test.ts packages/payload-diff/src apps/web/src/lib/diff-pairing.ts
pnpm --filter @wayscribe/web build
```

Expected: PASS (the sync test's 12 cases, the package's `diff.test.ts` and `pairing.test.ts`, and the web's own `diff-pairing.test.ts` and `event-display.test.ts` unchanged); `pnpm typecheck` exits 0, root `tsc -b` included; no lint findings; `Compiled successfully`. To see the sync test bite, change one character inside the package copy's marked block and rerun it: `is the same text in both copies` fails. Undo the change.

- [ ] **Step 6: Commit**

```bash
git add tests/diff-pairing-parity.test.ts apps/web/src/lib/diff-pairing.ts packages/payload-diff/src/pairing.ts packages/payload-diff/src/pairing.test.ts packages/payload-diff/src/index.ts
git commit -m "refactor(payload-diff): share rename pairing with the API, the web copy held to it (#8)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `findLikelyCauses`, a pure function

**Files:**
- Create: `apps/api/src/journeys/likely-cause.ts`
- Create: `apps/api/src/journeys/likely-cause.test.ts`

Every fixture diff is made by `diffPayloads`, the function ingestion stores diffs with, from Salesforce-shaped payloads. The expected objects below were checked against `diffPayloads` and `pairChanges` as they are at the time of writing.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/journeys/likely-cause.test.ts`:

```ts
import { diffPayloads } from "@wayscribe/payload-diff";
import { describe, expect, it } from "vitest";
import {
  MAX_JOURNEY_EVENTS_FOR_CAUSES,
  findLikelyCauses,
  type CauseEvent
} from "./likely-cause.js";

/**
 * Salesforce-shaped fixtures: an Account as the webhook delivers it, with a
 * nested billing address, opportunity line items and `__c` custom fields, and
 * the customer the integration turns it into. Every diff is made by
 * `diffPayloads`, the function ingestion stores diffs with, so the paths are
 * the ones a real journey holds.
 */
const ACCOUNT = {
  Id: "0018Z00002ABC",
  Name: "Acme Field Services",
  Phone: "+1 919 555 1234",
  Status__c: "Active",
  BillingAddress: {
    street: "100 Main St",
    city: "Raleigh",
    state: "NC",
    postalCode: "27601",
    country: "US"
  },
  Opportunity_Lines__c: [
    { Product_Code__c: "SKU-100", Quantity__c: 2, Unit_Price__c: 49.5 },
    { Product_Code__c: "SKU-200", Quantity__c: 1, Unit_Price__c: 120 }
  ]
};

const CUSTOMER = {
  externalId: "0018Z00002ABC",
  name: "Acme Field Services",
  phone: "+1 919 555 1234",
  status: "Active",
  address: {
    street: "100 Main St",
    city: "Raleigh",
    state: "NC",
    postalCode: "27601",
    country: "US"
  },
  lines: [
    { sku: "SKU-100", quantity: 2, unitPrice: 49.5 },
    { sku: "SKU-200", quantity: 1, unitPrice: 120 }
  ]
};

/** The demo's defect: the transform reads `Phone__c`, which this account does not have. */
const PHONE_LOST = { ...CUSTOMER, phone: null };

const REJECTED = {
  status: 422,
  body: {
    error: { code: "phone_required", message: "A phone number is required.", fields: ["phone"] }
  }
};

const step = (id: string, name: string, input?: unknown, output?: unknown): CauseEvent => ({
  id,
  step: name,
  failed: false,
  fields: undefined,
  diff: input !== undefined && output !== undefined ? diffPayloads(input, output) : null
});

const failure = (
  id: string,
  name: string,
  fields?: unknown,
  input?: unknown,
  output?: unknown
): CauseEvent => ({
  ...step(id, name, input, output),
  failed: true,
  fields
});

const received = step("evt_received", "receive-salesforce-webhook");
const transformed = step("evt_transform", "transform-salesforce-account", ACCOUNT, PHONE_LOST);

/** As the transform records it: `Phone` paired with `phone`, its value gone. */
const PHONE_LOST_AT_TRANSFORM = {
  field: "phone",
  reportedBy: "evt_deliver",
  eventId: "evt_transform",
  step: "transform-salesforce-account",
  change: {
    kind: "renamed-changed",
    lost: true,
    path: "phone",
    from: "Phone",
    before: "+1 919 555 1234",
    after: null
  },
  alsoChangedAt: []
};

describe("findLikelyCauses", () => {
  it("names the step where a renamed field lost its value", () => {
    const causes = findLikelyCauses([
      received,
      transformed,
      failure("evt_deliver", "deliver-customer-to-target", ["phone"], PHONE_LOST, REJECTED)
    ]);
    expect(causes).toEqual(new Map([["evt_deliver", [PHONE_LOST_AT_TRANSFORM]]]));
  });

  it("matches a nested path, comparing keys as pairing normalizes them", () => {
    const moved = { ...CUSTOMER, address: { ...CUSTOMER.address, postalCode: "27601-1234" } };
    const causes = findLikelyCauses([
      step("evt_transform", "transform-salesforce-account", ACCOUNT, CUSTOMER),
      step("evt_geocode", "geocode-billing-address", CUSTOMER, moved),
      failure("evt_deliver", "deliver-customer-to-target", ["address.postal_code"])
    ]);
    expect(causes.get("evt_deliver")).toEqual([
      {
        field: "address.postal_code",
        reportedBy: "evt_deliver",
        eventId: "evt_geocode",
        step: "geocode-billing-address",
        change: {
          kind: "changed",
          lost: false,
          path: "address.postalCode",
          before: "27601",
          after: "27601-1234"
        },
        alsoChangedAt: []
      }
    ]);
  });

  it("treats removing an ancestor as changing the field under it", () => {
    const { address, ...withoutAddress } = CUSTOMER;
    const causes = findLikelyCauses([
      step("evt_transform", "transform-salesforce-account", ACCOUNT, CUSTOMER),
      step("evt_strip", "strip-unverified-address", CUSTOMER, withoutAddress),
      failure("evt_deliver", "deliver-customer-to-target", ["address.postalCode"])
    ]);
    expect(causes.get("evt_deliver")).toEqual([
      {
        field: "address.postalCode",
        reportedBy: "evt_deliver",
        eventId: "evt_strip",
        step: "strip-unverified-address",
        change: { kind: "removed", lost: true, path: "address", before: address, after: undefined },
        alsoChangedAt: []
      }
    ]);
  });

  it("answers nothing when no earlier step changed the field", () => {
    const causes = findLikelyCauses([
      received,
      transformed,
      failure("evt_deliver", "deliver-customer-to-target", ["email"])
    ]);
    expect(causes).toEqual(new Map([["evt_deliver", []]]));
  });

  it("chooses the nearest step and lists the earlier ones, nearest first", () => {
    const fromCrm = { ...ACCOUNT, Phone: null };
    const enriched = { ...ACCOUNT, Phone: "+1 (919) 555-1234" };
    const causes = findLikelyCauses([
      step("evt_enrich", "enrich-from-crm", fromCrm, enriched),
      step("evt_normalize", "normalize-phone", enriched, ACCOUNT),
      transformed,
      failure("evt_deliver", "deliver-customer-to-target", ["phone"])
    ]);
    expect(causes.get("evt_deliver")).toEqual([
      {
        ...PHONE_LOST_AT_TRANSFORM,
        alsoChangedAt: [
          { eventId: "evt_normalize", step: "normalize-phone" },
          { eventId: "evt_enrich", step: "enrich-from-crm" }
        ]
      }
    ]);
  });

  it("carries the last reporting failure's fields to a dead-letter, and skips failed steps as candidates", () => {
    const causes = findLikelyCauses([
      received,
      transformed,
      failure("evt_deliver", "deliver-customer-to-target", ["phone"], PHONE_LOST, REJECTED),
      failure("evt_retry_2", "retry-customer-delivery", ["phone"], PHONE_LOST, REJECTED),
      failure("evt_retry_3", "retry-customer-delivery", ["phone"], PHONE_LOST, REJECTED),
      failure("evt_dead_letter", "move-message-to-dead-letter")
    ]);
    // Each delivery's own diff, request against 422 response, removes `phone`:
    // a failed step is where the field was refused, not where it changed.
    expect(causes).toEqual(
      new Map([
        ["evt_deliver", [PHONE_LOST_AT_TRANSFORM]],
        ["evt_retry_2", [{ ...PHONE_LOST_AT_TRANSFORM, reportedBy: "evt_retry_2" }]],
        ["evt_retry_3", [{ ...PHONE_LOST_AT_TRANSFORM, reportedBy: "evt_retry_3" }]],
        ["evt_dead_letter", [{ ...PHONE_LOST_AT_TRANSFORM, reportedBy: "evt_retry_3" }]]
      ])
    );
  });

  it("gives a failure before any reporting failure nothing", () => {
    const causes = findLikelyCauses([
      transformed,
      failure("evt_timeout", "deliver-customer-to-target"),
      failure("evt_deliver", "retry-customer-delivery", ["phone"])
    ]);
    expect(causes.has("evt_timeout")).toBe(false);
    expect(causes.get("evt_deliver")?.map((cause) => cause.eventId)).toEqual(["evt_transform"]);
  });

  it("does not count a rename that kept the value", () => {
    const causes = findLikelyCauses([
      step("evt_transform", "transform-salesforce-account", ACCOUNT, CUSTOMER),
      failure("evt_deliver", "deliver-customer-to-target", ["status"])
    ]);
    expect(causes.get("evt_deliver")).toEqual([]);
  });

  it("does not count a field a step added", () => {
    const causes = findLikelyCauses([
      step("evt_contact", "attach-billing-contact", CUSTOMER, {
        ...CUSTOMER,
        billingEmail: "ap@acme.example"
      }),
      failure("evt_deliver", "deliver-customer-to-target", ["billingEmail"])
    ]);
    expect(causes.get("evt_deliver")).toEqual([]);
  });

  it("does not count a whole-payload replacement, which has no field path", () => {
    const causes = findLikelyCauses([
      step("evt_persist", "persist-customer", CUSTOMER, 4711),
      failure("evt_deliver", "deliver-customer-to-target", ["phone"])
    ]);
    expect(causes.get("evt_deliver")).toEqual([]);
  });

  it("marks a cause incomplete when a nearer step's diff was cut short", () => {
    const sync: CauseEvent = {
      id: "evt_sync",
      step: "sync-opportunity-lines",
      failed: false,
      fields: undefined,
      diff: {
        changes: [{ path: "lines[0].quantity", kind: "changed", before: 2, after: 3 }],
        truncated: true
      }
    };
    const causes = findLikelyCauses([
      received,
      transformed,
      sync,
      failure("evt_deliver", "deliver-customer-to-target", ["phone"])
    ]);
    expect(causes.get("evt_deliver")).toEqual([{ ...PHONE_LOST_AT_TRANSFORM, incomplete: true }]);
  });

  it("does not mark a cause incomplete for a cut-short diff further back than it", () => {
    const early: CauseEvent = {
      id: "evt_early",
      step: "load-account-history",
      failed: false,
      fields: undefined,
      diff: { changes: [], truncated: true }
    };
    const causes = findLikelyCauses([
      early,
      transformed,
      failure("evt_deliver", "deliver-customer-to-target", ["phone"])
    ]);
    expect(causes.get("evt_deliver")).toEqual([PHONE_LOST_AT_TRANSFORM]);
  });

  it("answers one entry per field that matched, in the order the error named them", () => {
    const moved = { ...PHONE_LOST, address: { ...CUSTOMER.address, postalCode: "27601-1234" } };
    const causes = findLikelyCauses([
      transformed,
      step("evt_geocode", "geocode-billing-address", PHONE_LOST, moved),
      failure("evt_deliver", "deliver-customer-to-target", ["phone", "email", "address.postalCode"])
    ]);
    expect(causes.get("evt_deliver")).toEqual([
      PHONE_LOST_AT_TRANSFORM,
      {
        field: "address.postalCode",
        reportedBy: "evt_deliver",
        eventId: "evt_geocode",
        step: "geocode-billing-address",
        change: {
          kind: "changed",
          lost: false,
          path: "address.postalCode",
          before: "27601",
          after: "27601-1234"
        },
        alsoChangedAt: []
      }
    ]);
  });

  it("compares array indexes literally", () => {
    const repriced = {
      ...CUSTOMER,
      lines: [CUSTOMER.lines[0], { sku: "SKU-200", quantity: 1, unitPrice: null }]
    };
    const causes = findLikelyCauses([
      step("evt_price", "apply-price-book", CUSTOMER, repriced),
      failure("evt_deliver", "deliver-customer-to-target", [
        "lines[0].unitPrice",
        "lines[1].unitPrice"
      ])
    ]);
    expect(causes.get("evt_deliver")).toEqual([
      {
        field: "lines[1].unitPrice",
        reportedBy: "evt_deliver",
        eventId: "evt_price",
        step: "apply-price-book",
        change: {
          kind: "changed",
          lost: true,
          path: "lines[1].unitPrice",
          before: 120,
          after: null
        },
        alsoChangedAt: []
      }
    ]);
  });

  it("ignores fields that are not a list of non-empty strings", () => {
    const causes = findLikelyCauses([
      transformed,
      failure("evt_deliver", "deliver-customer-to-target", "phone"),
      failure("evt_retry", "retry-customer-delivery", [42, "", "phone", "phone"])
    ]);
    expect(causes.has("evt_deliver")).toBe(false);
    expect(causes.get("evt_retry")).toEqual([
      { ...PHONE_LOST_AT_TRANSFORM, reportedBy: "evt_retry" }
    ]);
  });

  it("computes nothing for a journey over the cap, and still does at the cap", () => {
    const filler = (count: number): CauseEvent[] =>
      Array.from({ length: count }, (_, index) =>
        step(`evt_poll_${String(index)}`, "poll-salesforce", ACCOUNT, ACCOUNT)
      );
    const tail = [transformed, failure("evt_deliver", "deliver-customer-to-target", ["phone"])];

    const atCap = [...filler(MAX_JOURNEY_EVENTS_FOR_CAUSES - tail.length), ...tail];
    expect(atCap).toHaveLength(1_000);
    expect(findLikelyCauses(atCap).get("evt_deliver")).toEqual([PHONE_LOST_AT_TRANSFORM]);

    const overCap = [...filler(MAX_JOURNEY_EVENTS_FOR_CAUSES - tail.length + 1), ...tail];
    expect(overCap).toHaveLength(1_001);
    expect(findLikelyCauses(overCap)).toEqual(new Map());
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm exec vitest run apps/api/src/journeys/likely-cause.test.ts`

Expected: FAIL with `Failed to load url ./likely-cause.js`.

- [ ] **Step 3: Write `findLikelyCauses`**

Create `apps/api/src/journeys/likely-cause.ts`:

```ts
import { normalizeKey, pairChanges, type Change, type PairedChange } from "@wayscribe/payload-diff";

/**
 * Past this many events a journey gets no likely causes (ADR-072): the
 * function never answers from part of a journey, and the read stays bounded.
 */
export const MAX_JOURNEY_EVENTS_FOR_CAUSES = 1_000;

/** One event as the search reads it, in timeline order. */
export interface CauseEvent {
  id: string;
  /** The event's `name`, its operation name. */
  step: string;
  /** It carries an error, or its operation is `failed`. */
  failed: boolean;
  /** The stored `error.fields`, unchecked: it is read back from the database. */
  fields: unknown;
  /** The stored `payload_diff`, unchecked, or null when the step has none. */
  diff: unknown;
}

export type CauseKind = "removed" | "changed" | "renamed-changed";

/** The nearest earlier step that changed a field a failure named (ADR-072). */
export interface LikelyCause {
  /** As the error reported it. */
  field: string;
  /** The event whose error named the field: the failure itself, or an earlier one. */
  reportedBy: string;
  /** The likely-cause step's event id and operation name. */
  eventId: string;
  step: string;
  change: {
    kind: CauseKind;
    /** The input had a non-null value and the output has null or nothing. */
    lost: boolean;
    /** The output-side path, or the input path when removed. */
    path: string;
    /** The input-side path, for a rename. */
    from?: string;
    /** As stored, so possibly masked. */
    before: unknown;
    after: unknown;
  };
  /** Every other earlier step that changed the field, nearest first. */
  alsoChangedAt: { eventId: string; step: string }[];
  /** A step nearer than the cause had a diff too large to check. */
  incomplete?: true;
}

const COUNTED: ReadonlySet<string> = new Set<CauseKind>(["removed", "changed", "renamed-changed"]);
const DIFF_KINDS: ReadonlySet<unknown> = new Set(["added", "removed", "changed"]);
/** A path's segments: `[3]` for an index, a key otherwise, as `diffPayloads` writes them. */
const SEGMENT = /\[\d+\]|[^.[\]]+/g;

interface PairedDiff {
  rows: PairedChange[];
  truncated: boolean;
}

/**
 * The likely causes of each failed event of one journey, keyed by its id.
 *
 * `events` is the whole journey in timeline order (`event_timestamp`,
 * `received_at`, `id`, as `listJourneyEvents` orders it). For each failed
 * event, the fields are its own error's, or else those of the most recent
 * earlier failed event that named some: the reporter. The candidates are the
 * events before the reporter that are not failed and have a stored diff; a
 * failed step is where a field was refused, not where it changed. A paired
 * change matches a field when its path on either side equals the field or is
 * an ancestor of it, comparing keys as `normalizeKey` does and indexes
 * literally. `removed`, `changed` and `renamed-changed` count; a rename that
 * kept the value, an added field and a whole-payload replacement (path `""`)
 * do not. The nearest match is the cause, the rest are `alsoChangedAt`.
 *
 * A failed event before any reporter has no entry. A journey over
 * `MAX_JOURNEY_EVENTS_FOR_CAUSES` gets an empty map.
 */
export function findLikelyCauses(events: readonly CauseEvent[]): Map<string, LikelyCause[]> {
  const causes = new Map<string, LikelyCause[]>();
  if (events.length > MAX_JOURNEY_EVENTS_FOR_CAUSES) return causes;

  // Each diff is paired once, however many failures look back past it.
  const paired = new Map<number, PairedDiff | null>();
  const pairedAt = (index: number): PairedDiff | null => {
    if (!paired.has(index)) paired.set(index, pairedDiff(events[index]?.diff));
    return paired.get(index) ?? null;
  };

  let reporter: { index: number; fields: string[] } | null = null;
  for (const [index, event] of events.entries()) {
    if (!event.failed) continue;
    const own = reportedFields(event.fields);
    if (own !== null) reporter = { index, fields: own };
    if (reporter === null) continue;
    const reporterIndex = reporter.index;
    causes.set(
      event.id,
      reporter.fields.flatMap((field) => causeOf(events, pairedAt, field, reporterIndex))
    );
  }
  return causes;
}

function causeOf(
  events: readonly CauseEvent[],
  pairedAt: (index: number) => PairedDiff | null,
  field: string,
  reporterIndex: number
): LikelyCause[] {
  const reporter = events[reporterIndex];
  const target = segments(field);
  if (reporter === undefined || target.length === 0) return [];

  const matches: { event: CauseEvent; row: PairedChange }[] = [];
  let incomplete = false;
  for (let index = reporterIndex - 1; index >= 0; index -= 1) {
    const candidate = events[index];
    if (candidate === undefined || candidate.failed) continue;
    const diff = pairedAt(index);
    if (diff === null) continue;
    // `pairChanges` puts lost values first, so the most damaging match wins.
    const row = diff.rows.find(
      (one) =>
        COUNTED.has(one.kind) &&
        (covers(one.path, target) || (one.from !== null && covers(one.from, target)))
    );
    if (row === undefined) {
      // Unknown, not unchanged: only a nearer one than the cause matters.
      if (diff.truncated && matches.length === 0) incomplete = true;
      continue;
    }
    matches.push({ event: candidate, row });
  }

  const [nearest, ...earlier] = matches;
  if (nearest === undefined) return [];
  const { row } = nearest;
  return [
    {
      field,
      reportedBy: reporter.id,
      eventId: nearest.event.id,
      step: nearest.event.step,
      change: {
        kind: row.kind as CauseKind,
        lost: row.lost,
        path: row.path,
        ...(row.from === null ? {} : { from: row.from }),
        before: row.before,
        after: row.after
      },
      alsoChangedAt: earlier.map(({ event }) => ({ eventId: event.id, step: event.step })),
      ...(incomplete ? { incomplete: true as const } : {})
    }
  ];
}

/** A list's distinct non-empty strings, or null when there are none. */
function reportedFields(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const fields = [
    ...new Set(value.filter((one): one is string => typeof one === "string" && one !== ""))
  ];
  return fields.length === 0 ? null : fields;
}

/** A stored diff, paired; null for anything that is not one. */
function pairedDiff(value: unknown): PairedDiff | null {
  if (typeof value !== "object" || value === null) return null;
  const { changes, truncated } = value as { changes?: unknown; truncated?: unknown };
  if (!Array.isArray(changes)) return null;
  const valid = changes.filter(
    (one): one is Change =>
      typeof one === "object" &&
      one !== null &&
      typeof (one as { path?: unknown }).path === "string" &&
      DIFF_KINDS.has((one as { kind?: unknown }).kind)
  );
  return { rows: pairChanges(valid), truncated: truncated === true };
}

function segments(path: string): string[] {
  return (path.match(SEGMENT) ?? []).map((segment) =>
    segment.startsWith("[") ? segment : normalizeKey(segment)
  );
}

/** Whether `path` is the target or an ancestor of it. The empty path is neither. */
function covers(path: string, target: readonly string[]): boolean {
  const own = segments(path);
  return (
    own.length > 0 &&
    own.length <= target.length &&
    own.every((segment, index) => segment === target[index])
  );
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm exec vitest run apps/api/src/journeys/likely-cause.test.ts`

Expected: PASS, 16 tests.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm --filter @wayscribe/api typecheck && pnpm exec eslint apps/api/src/journeys`

Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/journeys/likely-cause.ts apps/api/src/journeys/likely-cause.test.ts
git commit -m "feat(api): findLikelyCauses links a failure to the step that changed its field (#8)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The journey, timeline and event reads return `likelyCauses`

**Files:**
- Modify: `packages/database/src/repositories/event-reads.ts` (append two reads)
- Modify: `packages/database/src/repositories/journey-reads.ts` (`JourneyDetail`, `findJourneyDetail`)
- Modify: `packages/database/src/index.ts` (exports, about line 121)
- Create: `apps/api/src/journeys/journey-causes.ts`
- Modify: `apps/api/src/routes/queries.ts` (routes at about lines 170, 190 and 237)
- Create: `apps/api/src/routes/likely-causes.integration.test.ts`
- Modify: `apps/api/src/routes/dry-run.integration.test.ts` (the preview has no read-time `likelyCauses`)

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/src/routes/likely-causes.integration.test.ts`:

```ts
import { createKnexConfig, insertReturningId } from "@wayscribe/database";
import { startPostgres, type TestDatabase } from "@wayscribe/database/testing";
import { createKeyring, issueApiKey } from "@wayscribe/payload-security";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");

const MINUTE = 60 * 1000;
/** Relative to the real clock, a minute apart, so timeline order is send order. */
const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * MINUTE).toISOString();

const ACCOUNT = {
  Id: "0018Z00002RCL",
  Name: "Acme Field Services",
  Phone: "+1 919 555 1234",
  Status__c: "Active",
  BillingAddress: { street: "100 Main St", city: "Raleigh", state: "NC", postalCode: "27601" }
};
/** The demo's defect: `Phone` read as `Phone__c`, so `phone` arrives null. */
const CUSTOMER = {
  externalId: "0018Z00002RCL",
  name: "Acme Field Services",
  phone: null,
  status: "active",
  address: { street: "100 Main St", city: "Raleigh", state: "NC", postalCode: "27601" }
};
const REJECTED = {
  status: 422,
  body: {
    error: { code: "phone_required", message: "A phone number is required.", fields: ["phone"] }
  }
};

const JOURNEY = "jrn_likely_cause";
const QUIET = "jrn_likely_cause_quiet";

const CAUSE = {
  field: "phone",
  reportedBy: "evt_lc_deliver",
  eventId: "evt_lc_transform",
  step: "transform-salesforce-account",
  change: {
    kind: "renamed-changed",
    lost: true,
    path: "phone",
    from: "Phone",
    before: "+1 919 555 1234",
    after: null
  },
  alsoChangedAt: []
};

/** ADR-072 through the real routes, with events ingested for real. */
describe("likelyCauses on the journey reads", () => {
  let container: TestDatabase;
  let db: Knex;
  let app: FastifyInstance;
  let apiKey: string;

  const send = async (
    journeyId: string,
    id: string,
    minutes: number,
    operation: string,
    name: string,
    fields: Record<string, unknown> = {}
  ): Promise<void> => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        protocolVersion: "0.1",
        event: {
          id,
          journeyId,
          environment: "development",
          service: "demo-integration",
          entity: { type: "customer", id: `customer-${journeyId}` },
          operation,
          name,
          timestamp: minutesAgo(minutes),
          ...fields
        }
      }
    });
    expect(response.statusCode, response.body).toBe(202);
  };

  const get = async (url: string): Promise<Record<string, unknown>> => {
    const response = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${apiKey}` }
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ data: Record<string, unknown> }>().data;
  };

  const rows = (data: Record<string, unknown>): Record<string, unknown>[] =>
    data["items"] as Record<string, unknown>[];

  beforeAll(async () => {
    container = await startPostgres();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();
    const projectId = await insertReturningId(db, "projects", { name: "P", slug: "p" });
    const environmentId = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: "development"
    });
    const generated = issueApiKey(keyring);
    apiKey = generated.apiKey;
    await db("api_keys").insert({
      project_id: projectId,
      environment_id: environmentId,
      name: "development",
      key_prefix: generated.keyPrefix,
      key_hash: generated.verifier,
      key_hash_key_id: generated.keyHashKeyId
    });
    app = buildApp({
      db,
      keyring,
      adminToken: "admin-token-for-tests-0000000000",
      logLevel: "silent"
    });

    await send(JOURNEY, "evt_lc_received", 10, "received", "receive-salesforce-webhook", {
      input: ACCOUNT
    });
    await send(JOURNEY, "evt_lc_transform", 9, "transformed", "transform-salesforce-account", {
      input: ACCOUNT,
      output: CUSTOMER
    });
    // A whole-payload replacement: the customer in, its id out.
    await send(JOURNEY, "evt_lc_persist", 8, "persisted", "persist-customer", {
      input: CUSTOMER,
      output: 4711
    });
    await send(JOURNEY, "evt_lc_deliver", 7, "delivered", "deliver-customer-to-target", {
      input: CUSTOMER,
      output: REJECTED,
      error: {
        message: "deliver-customer-to-target reported a failed result.",
        code: "result_failed",
        fields: ["phone"]
      }
    });
    await send(JOURNEY, "evt_lc_dead_letter", 6, "failed", "move-message-to-dead-letter", {
      error: {
        message: "The target refused the customer; the message moved to the dead-letter queue."
      }
    });

    // A failure that names no field: a timeout.
    await send(QUIET, "evt_lcq_transform", 10, "transformed", "transform-salesforce-account", {
      input: ACCOUNT,
      output: CUSTOMER
    });
    await send(QUIET, "evt_lcq_deliver", 9, "delivered", "deliver-customer-to-target", {
      input: CUSTOMER,
      error: { message: "The operation was aborted due to timeout", type: "TimeoutError" }
    });
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await container.stop();
  });

  it("puts likelyCauses on each failed row of the timeline, and on no other", async () => {
    const data = await get(`/v1/journeys/${JOURNEY}/events?limit=100`);
    expect(rows(data).map((row) => [row["id"], row["likelyCauses"]])).toEqual([
      ["evt_lc_received", undefined],
      ["evt_lc_transform", undefined],
      ["evt_lc_persist", undefined],
      ["evt_lc_deliver", [CAUSE]],
      ["evt_lc_dead_letter", [CAUSE]]
    ]);
  });

  it("computes them over the whole journey, whatever page is asked for", async () => {
    const first = await get(`/v1/journeys/${JOURNEY}/events?limit=4`);
    const cursor = first["nextCursor"];
    expect(typeof cursor).toBe("string");
    const second = await get(
      `/v1/journeys/${JOURNEY}/events?limit=4&cursor=${encodeURIComponent(String(cursor))}`
    );
    // The transform the cause names is not on this page. (The page may repeat
    // the previous page's last row: the cursor keeps `received_at` to the
    // millisecond and PostgreSQL stores microseconds.)
    expect(rows(second).map((row) => row["id"])).not.toContain("evt_lc_transform");
    expect(
      rows(second).find((row) => row["id"] === "evt_lc_dead_letter")?.["likelyCauses"]
    ).toEqual([CAUSE]);
  });

  it("returns the failed step's likely causes on the journey read", async () => {
    const journey = await get(`/v1/journeys/${JOURNEY}`);
    expect(journey["failedStep"]).toBe("move-message-to-dead-letter");
    expect(journey["likelyCauses"]).toEqual([CAUSE]);
    expect(journey).not.toHaveProperty("failedStepEventId");
  });

  it("returns them on a failed event's read, and leaves them off any other", async () => {
    expect((await get("/v1/events/evt_lc_dead_letter"))["likelyCauses"]).toEqual([CAUSE]);
    expect(await get("/v1/events/evt_lc_transform")).not.toHaveProperty("likelyCauses");
  });

  it("answers an empty list where the failure names no field", async () => {
    expect((await get(`/v1/journeys/${QUIET}`))["likelyCauses"]).toEqual([]);
    const timeline = await get(`/v1/journeys/${QUIET}/events`);
    expect(rows(timeline).map((row) => [row["id"], row["likelyCauses"]])).toEqual([
      ["evt_lcq_transform", undefined],
      ["evt_lcq_deliver", []]
    ]);
    expect((await get("/v1/events/evt_lcq_deliver"))["likelyCauses"]).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/routes/likely-causes.integration.test.ts`

Expected: FAIL. Every row's `likelyCauses` is `undefined` (first test: `expected [ [ 'evt_lc_deliver', undefined ], ... ] to deeply equal ...`), and the journey read has no `likelyCauses`.

- [ ] **Step 3: Add the two database reads**

Append to `packages/database/src/repositories/event-reads.ts`:

```ts
/** One event as the likely-cause search reads it (ADR-072): no payload, no message. */
export interface JourneyFailureFact {
  id: string;
  name: string;
  /** It carries an error, or its operation is `failed`: what fails a journey. */
  failed: boolean;
  /** The stored `error.fields`, unchecked, or null. */
  errorFields: unknown;
}

/**
 * Up to `limit` of a journey's events, in timeline order, with only what says
 * whether one failed and which fields it named. The search reads this first,
 * and the diffs only when some failure named a field.
 */
export async function listJourneyFailureFacts(
  db: Knex,
  scope: ReadScope,
  journeyId: string,
  limit: number
): Promise<JourneyFailureFact[]> {
  const rows: unknown = await scoped(db("journey_events"), scope)
    .where({ journey_id: journeyId })
    .select(
      "id",
      "name",
      db.raw(`(error is not null or operation = 'failed') as "failed"`),
      db.raw(`error -> 'fields' as "errorFields"`)
    )
    .orderBy([{ column: "event_timestamp" }, { column: "received_at" }, { column: "id" }])
    .limit(limit);
  return rows as JourneyFailureFact[];
}

/** Every stored diff of a journey, by event id. Read only for a journey under the cap. */
export async function listJourneyPayloadDiffs(
  db: Knex,
  scope: ReadScope,
  journeyId: string
): Promise<Map<string, unknown>> {
  const rows: unknown = await scoped(db("journey_events"), scope)
    .where({ journey_id: journeyId })
    .whereNotNull("payload_diff")
    .select("id", "payload_diff as payloadDiff");
  return new Map(
    (rows as { id: string; payloadDiff: unknown }[]).map((row) => [row.id, row.payloadDiff])
  );
}
```

In `packages/database/src/index.ts`, replace:

```ts
export {
  findEventDetail,
  listJourneyEvents,
  type EventDetail,
  type EventListItem,
  type EventPage
} from "./repositories/event-reads.js";
```

with:

```ts
export {
  findEventDetail,
  listJourneyEvents,
  listJourneyFailureFacts,
  listJourneyPayloadDiffs,
  type EventDetail,
  type EventListItem,
  type EventPage,
  type JourneyFailureFact
} from "./repositories/event-reads.js";
```

In `packages/database/src/repositories/journey-reads.ts`, replace:

```ts
  failedStep: string | null;
  eventCount: number;
```

with:

```ts
  failedStep: string | null;
  /**
   * The id of the event `failedStep` names, under the same rule, and null
   * whenever `failedStep` is (ADR-072). Not presented: the journey read
   * answers that event's likely causes instead.
   */
  failedStepEventId: string | null;
  eventCount: number;
```

and replace:

```ts
    db.raw(`case when status = 'failed' then failed_step end as "failedStep"`),
```

with:

```ts
    db.raw(`case when status = 'failed' then failed_step end as "failedStep"`),
    db.raw(`case when status = 'failed' then failed_step_event_id end as "failedStepEventId"`),
```

- [ ] **Step 4: Connect the database to the pure function**

Create `apps/api/src/journeys/journey-causes.ts`:

```ts
import {
  listJourneyFailureFacts,
  listJourneyPayloadDiffs,
  type ReadScope
} from "@wayscribe/database";
import type { Knex } from "knex";
import {
  MAX_JOURNEY_EVENTS_FOR_CAUSES,
  findLikelyCauses,
  type LikelyCause
} from "./likely-cause.js";

/** Whether an event fails a journey: `deriveStatus`'s test, on a read row. */
export function isFailedEvent(event: { hasError: boolean; operation: string }): boolean {
  return event.hasError || event.operation === "failed";
}

/**
 * Every failed event's likely causes for one journey (ADR-072), by event id.
 *
 * One past the cap is read, so a journey at it is told from one over it; over
 * it, or when no failure names a field, the diffs are never read and the
 * answer is empty.
 */
export async function journeyLikelyCauses(
  db: Knex,
  scope: ReadScope,
  journeyId: string
): Promise<Map<string, LikelyCause[]>> {
  const facts = await listJourneyFailureFacts(
    db,
    scope,
    journeyId,
    MAX_JOURNEY_EVENTS_FOR_CAUSES + 1
  );
  if (
    facts.length > MAX_JOURNEY_EVENTS_FOR_CAUSES ||
    !facts.some((fact) => fact.failed && Array.isArray(fact.errorFields))
  ) {
    return new Map();
  }
  const diffs = await listJourneyPayloadDiffs(db, scope, journeyId);
  return findLikelyCauses(
    facts.map((fact) => ({
      id: fact.id,
      step: fact.name,
      failed: fact.failed,
      fields: fact.errorFields,
      diff: diffs.get(fact.id) ?? null
    }))
  );
}
```

- [ ] **Step 5: Attach `likelyCauses` in the three routes**

In `apps/api/src/routes/queries.ts`, after:

```ts
import { databaseApiKeys, logVerifierReplaceFailure } from "../auth.js";
```

add:

```ts
import { isFailedEvent, journeyLikelyCauses } from "../journeys/journey-causes.js";
import type { LikelyCause } from "../journeys/likely-cause.js";
```

In `app.get("/v1/journeys/:journeyId", ...)`, replace:

```ts
    return reply.send({ data: presentJourneyDetail(keyring, detail, warnUnknownKey) });
```

with:

```ts
    // ADR-072: over the whole journey, for the event that failed it.
    const likelyCauses =
      detail.failedStepEventId === null
        ? []
        : ((await journeyLikelyCauses(app.db, readScope(principal), journeyId)).get(
            detail.failedStepEventId
          ) ?? []);
    return reply.send({
      data: { ...presentJourneyDetail(keyring, detail, warnUnknownKey), likelyCauses }
    });
```

In `app.get("/v1/journeys/:journeyId/events", ...)`, replace:

```ts
      return await reply.send({
        data: {
          items: page.items.map(presentEventListItem),
          nextCursor: page.nextCursor
        }
      });
```

with:

```ts
      // From the whole journey (ADR-072): a page without the step that
      // changed a field still names it. Not read for a page with no failure.
      const causes = page.items.some(isFailedEvent)
        ? await journeyLikelyCauses(app.db, readScope(principal), journeyId)
        : new Map<string, LikelyCause[]>();

      return await reply.send({
        data: {
          items: page.items.map((item) => ({
            ...presentEventListItem(item),
            ...(isFailedEvent(item) ? { likelyCauses: causes.get(item.id) ?? [] } : {})
          })),
          nextCursor: page.nextCursor
        }
      });
```

In `app.get("/v1/events/:eventId", ...)`, replace:

```ts
    return reply.send({ data: presentEvent(keyring, detail, warnUnknownKey) });
```

with:

```ts
    // ADR-072: a failed event's likely causes, from its whole journey.
    const likelyCauses = isFailedEvent(detail)
      ? ((await journeyLikelyCauses(app.db, readScope(principal), detail.journeyId)).get(
          detail.id
        ) ?? [])
      : undefined;
    return reply.send({
      data: {
        ...presentEvent(keyring, detail, warnUnknownKey),
        ...(likelyCauses === undefined ? {} : { likelyCauses })
      }
    });
```

- [ ] **Step 6: Run the test and watch it pass**

Run: `pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/routes/likely-causes.integration.test.ts`

Expected: PASS, 5 tests.

- [ ] **Step 7: Keep the dry run's preview equal to the reads, minus the read-time field**

`apps/api/src/routes/dry-run.integration.test.ts` asserts that a dry run's `stored.journey` equals `GET /v1/journeys/:id`. `likelyCauses` is computed when read and never stored (spec decision 3), so the preview has none. Run it first to see the failure:

Run: `pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/routes/dry-run.integration.test.ts`

Expected: FAIL in `previews the stored event and journey the reads return, minus receivedAt`: `expected { journeyId: 'jrn_preview', …(12) } to deeply equal { journeyId: 'jrn_preview', …(13) }`.

In `apps/api/src/routes/dry-run.integration.test.ts`, replace:

```ts
      expect(stored.journey).toEqual(readJourney.json().data);
```

with:

```ts
      // `likelyCauses` is computed when read (ADR-072), so a preview of what is
      // stored has none.
      const { likelyCauses, ...expectedJourney } = readJourney.json().data as Record<
        string,
        unknown
      >;
      expect(likelyCauses).toEqual([]);
      expect(stored.journey).toEqual(expectedJourney);
```

Run it again. Expected: PASS, 28 tests. (Task 13 updates `docs/INGESTION_CONTRACT.md` to say so.)

- [ ] **Step 8: Run the read-route and database suites, and typecheck**

Run:

```bash
pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/routes packages/database
pnpm --filter @wayscribe/database typecheck && pnpm --filter @wayscribe/api typecheck
```

Expected: PASS (in particular `failed-step.integration.test.ts`, `journey-browse.integration.test.ts`, `reader.integration.test.ts` and the dry-run tests, whose stored journey goes through `presentJourneyDetail` and is unchanged); no type errors.

- [ ] **Step 9: Check the 1,000-event cap against real journey sizes**

The spec asks for the cap to be checked against real journeys. On the demo stack (`docker compose -f infrastructure/compose.yaml -f infrastructure/compose.demo.yaml up -d`), run:

```bash
docker compose -f infrastructure/compose.yaml -f infrastructure/compose.demo.yaml exec -T postgres \
  psql -U wayscribe -d wayscribe -At -c "select max(event_count), percentile_disc(0.99) within group (order by event_count) from journeys"
```

Expected: two numbers, both 10 or less (demo journeys hold 2 to 10 events, which ADR-072 in Task 13 states). If either is above 10, correct that sentence in Task 13's ADR text. If Jorge has a real deployment whose p99 is near 1,000, raise it with him before merging rather than changing the constant here.

- [ ] **Step 10: Commit**

```bash
git add packages/database/src/repositories/event-reads.ts packages/database/src/repositories/journey-reads.ts packages/database/src/index.ts apps/api/src/journeys/journey-causes.ts apps/api/src/routes/queries.ts apps/api/src/routes/likely-causes.integration.test.ts apps/api/src/routes/dry-run.integration.test.ts
git commit -m "feat(api): journey, timeline and event reads return likelyCauses (#8)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The web app shows the likely cause

**Files:**
- Create: `apps/web/src/lib/likely-cause-display.ts`, `apps/web/src/lib/likely-cause-display.test.ts`
- Create: `apps/web/app/components/LikelyCauseLines.tsx`, `apps/web/app/components/LikelyCauseLines.test.tsx`
- Create: `apps/web/app/components/AboutJourneyView.test.tsx`
- Modify: `apps/web/src/lib/api.ts` (types, about lines 1 to 143 and 299)
- Modify: `apps/web/src/lib/event-display.ts` (`ApiEventDetail`, `eventForDisplay`, `ApiEventRow`, `rowForDisplay`)
- Modify: `apps/web/app/components/EventDetail.tsx` (+ `EventDetail.test.tsx`)
- Modify: `apps/web/app/components/JourneyTimeline.tsx` (+ `JourneyTimeline.test.tsx`)
- Modify: `apps/web/app/components/AboutJourneyView.tsx`
- Modify: `apps/web/app/(authenticated)/journeys/[journeyId]/page.tsx`
- Modify: `apps/web/app/api/journeys/[journeyId]/events/route.ts` (+ `route.test.ts`)

Only text crosses to the browser (`event-display.ts` says why): the API's causes become `DisplayedLikelyCause` on the server, and timeline rows drop them (timeline rows are unchanged, per the spec).

- [ ] **Step 1: Write the failing display tests**

Create `apps/web/src/lib/likely-cause-display.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { likelyCausesForDisplay } from "./likely-cause-display";

/** As `GET /v1/journeys/:id` answers it for the demo's dead-letter. */
const CAUSE = {
  field: "phone",
  reportedBy: "evt_retry_3",
  eventId: "evt_transform",
  step: "transform-salesforce-account",
  change: {
    kind: "renamed-changed",
    lost: true,
    path: "phone",
    from: "Phone",
    before: "+1 919 555 1234",
    after: null
  },
  alsoChangedAt: []
};

describe("likelyCausesForDisplay", () => {
  it("turns a lost field into text", () => {
    expect(likelyCausesForDisplay([CAUSE])).toEqual([
      {
        field: "phone",
        reportedBy: "evt_retry_3",
        eventId: "evt_transform",
        step: "transform-salesforce-account",
        verb: "lost",
        before: "+1 919 555 1234",
        after: "null",
        alsoChangedAt: [],
        incomplete: false
      }
    ]);
  });

  it("says changed for an altered value, and keeps the earlier steps and the incomplete mark", () => {
    const changed = {
      ...CAUSE,
      field: "status",
      reportedBy: "evt_deliver",
      change: {
        kind: "renamed-changed",
        lost: false,
        path: "status",
        from: "Status__c",
        before: "Former Customer",
        after: "former customer"
      },
      alsoChangedAt: [{ eventId: "evt_normalize", step: "normalize-status" }],
      incomplete: true
    };
    expect(likelyCausesForDisplay([changed])).toEqual([
      {
        field: "status",
        reportedBy: "evt_deliver",
        eventId: "evt_transform",
        step: "transform-salesforce-account",
        verb: "changed",
        before: "Former Customer",
        after: "former customer",
        alsoChangedAt: [{ eventId: "evt_normalize", step: "normalize-status" }],
        incomplete: true
      }
    ]);
  });

  it("says removed for a removed field, and writes a nested value as JSON", () => {
    const removedNull = {
      ...CAUSE,
      change: { kind: "removed", lost: false, path: "phone", before: null }
    };
    const removedAddress = {
      ...CAUSE,
      field: "BillingAddress.PostalCode",
      change: {
        kind: "removed",
        lost: true,
        path: "BillingAddress",
        before: { city: "Raleigh", postalCode: "27601" }
      }
    };
    expect(
      likelyCausesForDisplay([removedNull, removedAddress]).map(({ verb, before, after }) => [
        verb,
        before,
        after
      ])
    ).toEqual([
      ["removed", "null", "—"],
      ["lost", '{"city":"Raleigh","postalCode":"27601"}', "—"]
    ]);
  });

  it("leaves out what it cannot read, and reads no inherited key", () => {
    expect(
      likelyCausesForDisplay([
        null,
        "phone",
        { ...CAUSE, field: 7 },
        { ...CAUSE, change: { ...CAUSE.change, kind: "added" } },
        JSON.parse(`{"__proto__": ${JSON.stringify(CAUSE)}}`) as unknown,
        {
          ...CAUSE,
          alsoChangedAt: [{ eventId: "evt_x" }, { eventId: "evt_enrich", step: "enrich-from-crm" }]
        }
      ]).map((cause) => cause.alsoChangedAt)
    ).toEqual([[{ eventId: "evt_enrich", step: "enrich-from-crm" }]]);
    expect(likelyCausesForDisplay(undefined)).toEqual([]);
    expect(likelyCausesForDisplay({ 0: CAUSE })).toEqual([]);
  });
});
```

Create `apps/web/app/components/LikelyCauseLines.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DisplayedLikelyCause } from "../../src/lib/likely-cause-display";
import { LikelyCauseLines } from "./LikelyCauseLines";

const LOST: DisplayedLikelyCause = {
  field: "phone",
  reportedBy: "evt_retry_3",
  eventId: "evt_transform",
  step: "transform-salesforce-account",
  verb: "lost",
  before: "+1 919 555 1234",
  after: "null",
  alsoChangedAt: [],
  incomplete: false
};

const NAMES: Record<string, string> = { evt_retry_3: "retry-customer-delivery attempt 3" };
const describeEvent = (eventId: string): string | null => NAMES[eventId] ?? null;
const line = (): string | null | undefined => document.querySelector(".likely-cause")?.textContent;

describe("LikelyCauseLines", () => {
  it("says which step lost the field, and links to it", () => {
    render(
      <LikelyCauseLines
        causes={[LOST]}
        journeyId="jrn_demo_pinned_5550100"
        failedEventId="evt_retry_3"
        describeEvent={describeEvent}
      />
    );
    expect(line()).toBe(
      "Likely cause: phone lost at transform-salesforce-account (was +1 919 555 1234)"
    );
    expect(
      screen.getByRole("link", { name: "transform-salesforce-account" }).getAttribute("href")
    ).toBe("/journeys/jrn_demo_pinned_5550100?event=evt_transform");
  });

  it("names the event that reported the field when it is another one", () => {
    render(
      <LikelyCauseLines
        causes={[LOST]}
        journeyId="jrn_1"
        failedEventId="evt_dead_letter"
        describeEvent={describeEvent}
      />
    );
    expect(line()).toBe(
      "Likely cause: phone lost at transform-salesforce-account (was +1 919 555 1234), reported by retry-customer-delivery attempt 3"
    );
    expect(
      screen.getByRole("link", { name: "retry-customer-delivery attempt 3" }).getAttribute("href")
    ).toBe("/journeys/jrn_1?event=evt_retry_3");
  });

  it("describes a reporter the timeline has not loaded", () => {
    render(
      <LikelyCauseLines causes={[LOST]} journeyId="jrn_1" failedEventId={null} describeEvent={() => null} />
    );
    expect(line()).toBe(
      "Likely cause: phone lost at transform-salesforce-account (was +1 919 555 1234), reported by an earlier failed step"
    );
  });

  it("gives both values of a change, and the earlier steps nearest first", () => {
    const changed: DisplayedLikelyCause = {
      ...LOST,
      field: "status",
      reportedBy: "evt_deliver",
      verb: "changed",
      before: "Former Customer",
      after: "former customer",
      alsoChangedAt: [
        { eventId: "evt_normalize", step: "normalize-status" },
        { eventId: "evt_enrich", step: "enrich-from-crm" }
      ]
    };
    render(
      <LikelyCauseLines
        causes={[changed]}
        journeyId="jrn_1"
        failedEventId="evt_deliver"
        describeEvent={describeEvent}
      />
    );
    const [first, second] = Array.from(document.querySelectorAll(".likely-causes p"));
    expect(first?.textContent).toBe(
      "Likely cause: status changed at transform-salesforce-account (was Former Customer, now former customer)"
    );
    expect(second?.textContent).toBe("Also changed earlier at: normalize-status, enrich-from-crm");
  });

  it("says when a nearer step's changes were too large to check", () => {
    render(
      <LikelyCauseLines
        causes={[{ ...LOST, incomplete: true }]}
        journeyId="jrn_1"
        failedEventId="evt_retry_3"
        describeEvent={describeEvent}
      />
    );
    expect(screen.getByText("Some earlier steps' changes were too large to check.")).toBeTruthy();
  });

  it("renders nothing without causes", () => {
    const { container } = render(
      <LikelyCauseLines causes={[]} journeyId="jrn_1" failedEventId={null} describeEvent={describeEvent} />
    );
    expect(container.innerHTML).toBe("");
  });
});
```

Create `apps/web/app/components/AboutJourneyView.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AboutJourneyView } from "./AboutJourneyView";

describe("AboutJourneyView", () => {
  it("says what a likely cause is (ADR-072)", () => {
    render(
      <AboutJourneyView
        startedAt="2026-10-12T10:00:00.000Z"
        lastEventAt="2026-10-12T10:00:09.400Z"
        hasAliases={false}
      />
    );
    expect(screen.getByText("Likely cause").tagName).toBe("DT");
    expect(
      screen.getByText(
        "When an error names the field it rejected, the likely cause is the nearest earlier step that changed that field."
      ).tagName
    ).toBe("DD");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm exec vitest run apps/web/src/lib/likely-cause-display.test.ts apps/web/app/components/LikelyCauseLines.test.tsx apps/web/app/components/AboutJourneyView.test.tsx`

Expected: FAIL: the two new modules cannot be loaded, and `Unable to find an element with the text: Likely cause`.

- [ ] **Step 3: Write the display function**

Create `apps/web/src/lib/likely-cause-display.ts`:

```ts
import { bounded } from "./metadata";

/**
 * A likely cause (ADR-072) as the page shows it, made on the server from the
 * API's `likelyCauses`, for the reason `eventForDisplay` gives: only text
 * crosses to the browser.
 */
export interface DisplayedLikelyCause {
  /** The field as the failing system named it. */
  field: string;
  /** The event whose error named the field. */
  reportedBy: string;
  /** The step that likely caused the failure, and its event. */
  eventId: string;
  step: string;
  /** What that step did to the field. */
  verb: "lost" | "removed" | "changed";
  /** As stored, so possibly masked: a string as it is, anything else as JSON, `—` for none. */
  before: string;
  after: string;
  /** Earlier steps that also changed the field, nearest first. */
  alsoChangedAt: { eventId: string; step: string }[];
  /** A nearer step's changes were too large to check. */
  incomplete: boolean;
}

const KINDS: ReadonlySet<unknown> = new Set(["removed", "changed", "renamed-changed"]);

/**
 * The API's `likelyCauses` as text. An entry it cannot read is left out
 * rather than guessed at, and only a value's own keys are read, as
 * `statedAliases` reads an alias.
 */
export function likelyCausesForDisplay(value: unknown): DisplayedLikelyCause[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown): DisplayedLikelyCause[] => {
    const field = text(own(entry, "field"));
    const reportedBy = text(own(entry, "reportedBy"));
    const eventId = text(own(entry, "eventId"));
    const step = text(own(entry, "step"));
    const change = own(entry, "change");
    const kind = own(change, "kind");
    if (
      field === null ||
      reportedBy === null ||
      eventId === null ||
      step === null ||
      !KINDS.has(kind)
    ) {
      return [];
    }
    const lost = own(change, "lost") === true;
    return [
      {
        field,
        reportedBy,
        eventId,
        step,
        verb: lost ? "lost" : kind === "removed" ? "removed" : "changed",
        before: valueText(own(change, "before")),
        after: valueText(own(change, "after")),
        alsoChangedAt: earlierSteps(own(entry, "alsoChangedAt")),
        incomplete: own(entry, "incomplete") === true
      }
    ];
  });
}

function earlierSteps(value: unknown): { eventId: string; step: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    const eventId = text(own(entry, "eventId"));
    const step = text(own(entry, "step"));
    return eventId === null || step === null ? [] : [{ eventId, step }];
  });
}

/** A key the object holds itself, never one it inherits. */
function own(value: unknown, key: string): unknown {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? bounded(value) : null;
}

function valueText(value: unknown): string {
  if (value === undefined) return "—";
  return bounded(typeof value === "string" ? value : JSON.stringify(value));
}
```

- [ ] **Step 4: Write the lines component**

Create `apps/web/app/components/LikelyCauseLines.tsx`:

```tsx
import Link from "next/link";
import type { DisplayedLikelyCause } from "../../src/lib/likely-cause-display";

/**
 * "Likely cause: `phone` lost at **transform-salesforce-account** (was ...)",
 * one line per cause (ADR-072). The step links to its event in the timeline.
 * The reporter is named when it is not the failure being shown; the journey
 * header passes `failedEventId={null}`, so it always names it. "Likely", never
 * "cause": the link is the nearest change, not a proof.
 */
export function LikelyCauseLines({
  causes,
  journeyId,
  failedEventId,
  describeEvent
}: {
  causes: readonly DisplayedLikelyCause[];
  journeyId: string;
  /** The failed event the causes belong to, or null where it is not known. */
  failedEventId: string | null;
  /** A loaded step as the line names it, or null when the timeline has not loaded it. */
  describeEvent: (eventId: string) => string | null;
}) {
  if (causes.length === 0) return null;
  const href = (eventId: string): string =>
    `/journeys/${encodeURIComponent(journeyId)}?event=${encodeURIComponent(eventId)}`;
  return (
    <div className="likely-causes">
      {causes.map((cause) => (
        <div key={cause.field}>
          <p className="likely-cause wrap">
            Likely cause: <code>{cause.field}</code> {cause.verb} at{" "}
            <strong>
              <Link href={href(cause.eventId)}>{cause.step}</Link>
            </strong>
            {cause.verb === "changed"
              ? ` (was ${cause.before}, now ${cause.after})`
              : ` (was ${cause.before})`}
            {cause.reportedBy === failedEventId ? null : (
              <>
                , reported by{" "}
                <Link href={href(cause.reportedBy)}>
                  {describeEvent(cause.reportedBy) ?? "an earlier failed step"}
                </Link>
              </>
            )}
          </p>
          {cause.alsoChangedAt.length === 0 ? null : (
            <p className="muted wrap">
              Also changed earlier at:{" "}
              {cause.alsoChangedAt.map((earlier, index) => (
                <span key={earlier.eventId}>
                  {index === 0 ? "" : ", "}
                  <Link href={href(earlier.eventId)}>{earlier.step}</Link>
                </span>
              ))}
            </p>
          )}
          {cause.incomplete ? (
            <p className="muted">Some earlier steps&apos; changes were too large to check.</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Add the About this view definition**

In `apps/web/app/components/AboutJourneyView.tsx`, replace:

```tsx
        <dt>Times</dt>
```

with:

```tsx
        <dt>Likely cause</dt>
        <dd>
          When an error names the field it rejected, the likely cause is the nearest earlier step
          that changed that field.
        </dd>
        <dt>Times</dt>
```

- [ ] **Step 6: Run the three new test files and watch them pass**

Run: `pnpm exec vitest run apps/web/src/lib/likely-cause-display.test.ts apps/web/app/components/LikelyCauseLines.test.tsx apps/web/app/components/AboutJourneyView.test.tsx`

Expected: PASS. JSX collapses the line break inside the `<dd>` to one space, so `getByText` matches the sentence.

- [ ] **Step 7: Write the failing wiring tests**

In `apps/web/app/components/EventDetail.test.tsx`, append:

```tsx
describe("EventDetail's likely cause (ADR-072)", () => {
  it("shows a failed event's likely cause under its error", () => {
    render(
      <EventDetail
        event={event({
          id: "evt_dead_letter",
          name: "move-message-to-dead-letter",
          operation: "failed",
          hasError: true,
          error: {
            message: "The target refused the customer; the message moved to the dead-letter queue."
          },
          likelyCauses: [
            {
              field: "phone",
              reportedBy: "evt_retry_3",
              eventId: "evt_transform",
              step: "transform-salesforce-account",
              change: {
                kind: "renamed-changed",
                lost: true,
                path: "phone",
                from: "Phone",
                before: "+1 919 555 1234",
                after: null
              },
              alsoChangedAt: []
            }
          ]
        })}
        describeEvent={(id) => (id === "evt_retry_3" ? "retry-customer-delivery attempt 3" : null)}
      />
    );
    const line = document.querySelector(".likely-cause");
    if (line === null) throw new Error("no likely cause line");
    expect(line.textContent).toBe(
      "Likely cause: phone lost at transform-salesforce-account (was +1 919 555 1234), reported by retry-customer-delivery attempt 3"
    );
    expect(
      screen.getByText("Error").compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("shows nothing for an event the API gave no causes", () => {
    render(<EventDetail event={event({ operation: "failed", hasError: true, error: { message: "boom" } })} />);
    expect(document.querySelector(".likely-causes")).toBeNull();
  });
});
```

In `apps/web/app/components/JourneyTimeline.test.tsx`, add inside the describe that holds `it("says which step a failed journey failed at", ...)`, directly after that test:

```tsx
  // ADR-072: the failed step's likely cause, under the summary line.
  it("shows the failed step's likely cause under the summary line", () => {
    mount({
      initialStatus: "failed",
      initialFailedStep: "step-evt_4",
      initialLikelyCauses: [
        {
          field: "phone",
          reportedBy: "evt_3",
          eventId: "evt_2",
          step: "step-evt_2",
          verb: "lost",
          before: "+1 919 555 1234",
          after: "null",
          alsoChangedAt: [],
          incomplete: false
        }
      ]
    });
    expect(document.querySelector(".journey-likely-cause")?.textContent).toBe(
      "Likely cause: phone lost at step-evt_2 (was +1 919 555 1234), reported by step-evt_3"
    );
    // The summary line itself is unchanged.
    expect(summaryLine().textContent).toBe(
      "failed at step-evt_4 · 4 events · webhook-api, sync-worker · span 3 s · times UTC"
    );
  });

  it("shows no likely cause line for a journey that is not failed", () => {
    mount({
      initialStatus: "completed",
      initialFailedStep: null,
      initialLikelyCauses: [
        {
          field: "phone",
          reportedBy: "evt_3",
          eventId: "evt_2",
          step: "step-evt_2",
          verb: "lost",
          before: "+1 919 555 1234",
          after: "null",
          alsoChangedAt: [],
          incomplete: false
        }
      ]
    });
    expect(document.querySelector(".journey-likely-cause")).toBeNull();
  });
```

In `apps/web/app/api/journeys/[journeyId]/events/route.test.ts`, replace:

```ts
      // The journey came from an API older than ADR-063, which omits it.
      journeyFailedStep: null
    });
```

with:

```ts
      // The journey came from an API older than ADR-063, which omits it.
      journeyFailedStep: null,
      // And older than ADR-072.
      journeyLikelyCauses: []
    });
```

and append, before the file's final `});`:

```ts
  // ADR-072: the failed step's likely causes ride along too, as text.
  it("sends the journey's likely causes as text", async () => {
    listEventsMock.mockResolvedValue({ items: [], nextCursor: null });
    getJourneyMock.mockResolvedValue({
      status: "failed",
      eventCount: 10,
      failedStep: "move-message-to-dead-letter",
      likelyCauses: [
        {
          field: "phone",
          reportedBy: "evt_retry_3",
          eventId: "evt_transform",
          step: "transform-salesforce-account",
          change: {
            kind: "renamed-changed",
            lost: true,
            path: "phone",
            from: "Phone",
            before: "+1 919 555 1234",
            after: null
          },
          alsoChangedAt: []
        }
      ]
    });
    const cookie = signSession(ADMIN_TOKEN, { projectId: "proj_1", expiresAt: Date.now() + 60_000 });
    const response = await GET(requestFor(cookie), {
      params: Promise.resolve({ journeyId: "jrn_1" })
    });
    expect(((await response.json()) as Record<string, unknown>)["journeyLikelyCauses"]).toEqual([
      {
        field: "phone",
        reportedBy: "evt_retry_3",
        eventId: "evt_transform",
        step: "transform-salesforce-account",
        verb: "lost",
        before: "+1 919 555 1234",
        after: "null",
        alsoChangedAt: [],
        incomplete: false
      }
    ]);
  });
```

In `apps/web/src/lib/event-display.test.ts`, append:

```ts
describe("likely causes on events and rows (ADR-072)", () => {
  const CAUSE = {
    field: "phone",
    reportedBy: "evt_retry_3",
    eventId: "evt_transform",
    step: "transform-salesforce-account",
    change: { kind: "renamed-changed", lost: true, path: "phone", from: "Phone", before: "+1 919 555 1234", after: null },
    alsoChangedAt: []
  };

  it("turns an event's causes into text", () => {
    const shown = eventForDisplay({
      id: "evt_dead_letter",
      journeyId: "jrn_1",
      operation: "failed",
      name: "move-message-to-dead-letter",
      service: "demo-worker",
      eventTimestamp: "2026-10-12T10:00:09.400Z",
      receivedAt: "2026-10-12T10:00:09.500Z",
      durationMs: null,
      hasInput: false,
      hasOutput: false,
      hasError: true,
      traceId: null,
      messageId: null,
      inputPayload: null,
      outputPayload: null,
      payloadDiff: null,
      error: { message: "dead-lettered" },
      likelyCauses: [CAUSE]
    });
    expect(shown.likelyCauses).toEqual([
      {
        field: "phone",
        reportedBy: "evt_retry_3",
        eventId: "evt_transform",
        step: "transform-salesforce-account",
        verb: "lost",
        before: "+1 919 555 1234",
        after: "null",
        alsoChangedAt: [],
        incomplete: false
      }
    ]);
  });

  it("drops causes from a timeline row, which shows none", () => {
    const row = rowForDisplay({
      id: "evt_dead_letter",
      operation: "failed",
      name: "move-message-to-dead-letter",
      service: "demo-worker",
      eventTimestamp: "2026-10-12T10:00:09.400Z",
      receivedAt: "2026-10-12T10:00:09.500Z",
      durationMs: null,
      hasInput: false,
      hasOutput: false,
      hasError: true,
      likelyCauses: [CAUSE]
    });
    expect(row).not.toHaveProperty("likelyCauses");
  });
});
```

`eventForDisplay` and `rowForDisplay` are already imported at the top of `event-display.test.ts`.

- [ ] **Step 8: Run them and watch them fail**

Run: `pnpm exec vitest run apps/web/app/components/EventDetail.test.tsx apps/web/app/components/JourneyTimeline.test.tsx "apps/web/app/api/journeys/[journeyId]/events/route.test.ts" apps/web/src/lib/event-display.test.ts`

Expected: FAIL: no `.likely-cause` in the detail or under the summary line, `journeyLikelyCauses` missing from the proxy's body, `shown.likelyCauses` undefined, and the row still carries `likelyCauses`.

- [ ] **Step 9: Add the types**

In `apps/web/src/lib/api.ts`, replace:

```ts
import type { EventMetadataLists } from "./metadata";
```

with:

```ts
import type { DisplayedLikelyCause } from "./likely-cause-display";
import type { EventMetadataLists } from "./metadata";
```

In `interface JourneyDetail`, replace:

```ts
  /** As on `SearchItem`: the step that failed the journey. An older API omits it. */
  failedStep?: string | null;
```

with:

```ts
  /** As on `SearchItem`: the step that failed the journey. An older API omits it. */
  failedStep?: string | null;
  /**
   * The failed step's likely causes (ADR-072) as the API sent them: read on
   * the server only, through `likelyCausesForDisplay`. An older API omits it.
   */
  likelyCauses?: unknown;
```

In `interface EventDetailData`, replace:

```ts
  statedAliases: StatedAlias[] | null;
}
```

with:

```ts
  statedAliases: StatedAlias[] | null;
  /** A failed event's likely causes (ADR-072), as text. Absent or `[]` when none. */
  likelyCauses?: DisplayedLikelyCause[];
}
```

In `interface EventsPageResponse`, replace:

```ts
  journeyFailedStep: string | null;
}
```

with:

```ts
  journeyFailedStep: string | null;
  /** The failed step's likely causes (ADR-072), as text, beside the status. */
  journeyLikelyCauses?: DisplayedLikelyCause[];
}
```

- [ ] **Step 10: Make causes text in `event-display.ts`, and drop them from rows**

In `apps/web/src/lib/event-display.ts`, after `import { bounded, metadataEntries, runtimeFormat } from "./metadata";` add:

```ts
import { likelyCausesForDisplay } from "./likely-cause-display";
```

Replace:

```ts
  | "timingContext"
  | "recordedHost"
> & {
```

with:

```ts
  | "timingContext"
  | "recordedHost"
  | "likelyCauses"
> & {
```

Replace:

```ts
  timingContext?: unknown;
  recordedHost?: unknown;
};

/** Markers the SDK stores in place of a payload it could not capture. */
```

with:

```ts
  timingContext?: unknown;
  recordedHost?: unknown;
  /** A failed event's causes (ADR-072); absent for any other event and from an older API. */
  likelyCauses?: unknown;
};

/** Markers the SDK stores in place of a payload it could not capture. */
```

In `eventForDisplay`, replace:

```ts
    timingContext,
    recordedHost,
    ...event
  } = raw;
```

with:

```ts
    timingContext,
    recordedHost,
    likelyCauses,
    ...event
  } = raw;
```

and replace:

```ts
    timingContext: readTimingContext(timingContext),
    recordedHost: readRecordedHost(recordedHost)
  };
}

/** One alias an event stated, as the page shows it. */
```

with:

```ts
    timingContext: readTimingContext(timingContext),
    recordedHost: readRecordedHost(recordedHost),
    likelyCauses: likelyCausesForDisplay(likelyCauses)
  };
}

/** One alias an event stated, as the page shows it. */
```

Replace:

```ts
export type ApiEventRow = Omit<EventListItem, "build" | "timingContext" | "recordedHost"> & {
  deploymentMetadata?: unknown;
  timingContext?: unknown;
  recordedHost?: unknown;
};
```

with:

```ts
export type ApiEventRow = Omit<EventListItem, "build" | "timingContext" | "recordedHost"> & {
  deploymentMetadata?: unknown;
  timingContext?: unknown;
  recordedHost?: unknown;
  /** A failed row's causes (ADR-072). The timeline shows none, so they are dropped. */
  likelyCauses?: unknown;
};
```

and in `rowForDisplay`, replace:

```ts
  const { deploymentMetadata, timingContext, recordedHost, ...row } = raw;
```

with:

```ts
  // Rows show no cause (the detail and the header do), and only text may
  // cross to the browser, so the raw causes stop here.
  const { deploymentMetadata, timingContext, recordedHost, likelyCauses: _causes, ...row } = raw;
```

- [ ] **Step 11: Render the line under the error**

In `apps/web/app/components/EventDetail.tsx`, after `import { EXPLANATIONS } from "./explanations";` add:

```tsx
import { LikelyCauseLines } from "./LikelyCauseLines";
```

and above `export function EventDetail(` add:

```tsx
/** A step the panel cannot name, when it is shown without a timeline. */
const UNNAMED = (): null => null;
```

Replace:

```tsx
export function EventDetail({
  event,
  notice = null,
  canReplay = true
}: {
  event: EventDetailData;
  /** Rendered under the heading and its meta line, where the eye already is. */
  notice?: DetailNotice | null;
  /** False for a reader: replay is an admin's act (ADR-070). */
  canReplay?: boolean;
}) {
```

with:

```tsx
export function EventDetail({
  event,
  notice = null,
  canReplay = true,
  describeEvent = UNNAMED
}: {
  event: EventDetailData;
  /** Rendered under the heading and its meta line, where the eye already is. */
  notice?: DetailNotice | null;
  /** False for a reader: replay is an admin's act (ADR-070). */
  canReplay?: boolean;
  /** Names a loaded step for a likely-cause line (ADR-072); the timeline passes it. */
  describeEvent?: (eventId: string) => string | null;
}) {
```

Replace:

```tsx
          <pre className="mono block">{event.errorText}</pre>
        </>
      )}

      <EventAliases event={event} />
```

with:

```tsx
          <pre className="mono block">{event.errorText}</pre>
        </>
      )}

      <LikelyCauseLines
        causes={event.likelyCauses ?? []}
        journeyId={event.journeyId}
        failedEventId={event.id}
        describeEvent={describeEvent}
      />

      <EventAliases event={event} />
```

- [ ] **Step 12: Render the line under the journey's status, and keep it current**

In `apps/web/app/components/JourneyTimeline.tsx`:

After `import { type Fetched, eventsUrl, fetchJson } from "../../src/lib/api-client";` add:

```tsx
import type { DisplayedLikelyCause } from "../../src/lib/likely-cause-display";
```

After `import { HostlessJourneyContext } from "./JourneyClockContext";` add:

```tsx
import { LikelyCauseLines } from "./LikelyCauseLines";
```

Replace:

```tsx
  initialFailedStep: string | null;
  initialEvents: EventListItem[];
```

with:

```tsx
  initialFailedStep: string | null;
  /**
   * The likely causes of the event that failed the journey (ADR-072), as text
   * from `likelyCausesForDisplay`. Each poll brings them again.
   */
  initialLikelyCauses?: DisplayedLikelyCause[];
  initialEvents: EventListItem[];
```

Replace:

```tsx
  const [failedStep, setFailedStep] = useState(props.initialFailedStep);
```

with:

```tsx
  const [failedStep, setFailedStep] = useState(props.initialFailedStep);
  const [likelyCauses, setLikelyCauses] = useState(props.initialLikelyCauses ?? []);
```

Replace:

```tsx
  const services = useMemo(
    () => [...new Set([...props.knownServices, ...distinctServices(events)])],
    [props.knownServices, events]
  );
```

with:

```tsx
  const services = useMemo(
    () => [...new Set([...props.knownServices, ...distinctServices(events)])],
    [props.knownServices, events]
  );

  /** A loaded step as a likely-cause line names it: its name, and its attempt past the first. */
  const describeEvent = useCallback(
    (eventId: string): string | null => {
      const row = events.find((event) => event.id === eventId);
      if (row === undefined) return null;
      const attempt = row.timingContext?.attempt;
      return attempt === undefined || attempt === 1
        ? row.name
        : `${row.name} attempt ${String(attempt)}`;
    },
    [events]
  );
```

Replace:

```tsx
    setFailedStep(page.journeyFailedStep);
```

with:

```tsx
    setFailedStep(page.journeyFailedStep);
    setLikelyCauses(page.journeyLikelyCauses ?? []);
```

Replace:

```tsx
          {span === null ? "unknown" : formatDuration(span)} · times UTC
        </span>
      </p>
      <HostlessJourneyContext.Provider value={clock.hostless}>
```

with:

```tsx
          {span === null ? "unknown" : formatDuration(span)} · times UTC
        </span>
      </p>
      {/* ADR-072: the failed step's likely cause, straight under its status. */}
      {status === "failed" && likelyCauses.length > 0 ? (
        <div className="journey-likely-cause">
          <LikelyCauseLines
            causes={likelyCauses}
            journeyId={journeyId}
            failedEventId={null}
            describeEvent={describeEvent}
          />
        </div>
      ) : null}
      <HostlessJourneyContext.Provider value={clock.hostless}>
```

Replace:

```tsx
            <EventDetail event={detail} canReplay={props.canReplay} />
```

with:

```tsx
            <EventDetail event={detail} canReplay={props.canReplay} describeEvent={describeEvent} />
```

- [ ] **Step 13: Pass the causes from the server**

In `apps/web/app/(authenticated)/journeys/[journeyId]/page.tsx`, after `import { failedStepOf } from "../../../../src/lib/failed-step";` add:

```tsx
import { likelyCausesForDisplay } from "../../../../src/lib/likely-cause-display";
```

and replace:

```tsx
          initialFailedStep={failedStepOf(journey)}
```

with:

```tsx
          initialFailedStep={failedStepOf(journey)}
          initialLikelyCauses={likelyCausesForDisplay(journey.likelyCauses)}
```

In `apps/web/app/api/journeys/[journeyId]/events/route.ts`, after `import { failedStepOf } from "../../../../../src/lib/failed-step";` add:

```ts
import { likelyCausesForDisplay } from "../../../../../src/lib/likely-cause-display";
```

and replace:

```ts
      journeyFailedStep: failedStepOf(journey)
    };
```

with:

```ts
      journeyFailedStep: failedStepOf(journey),
      // ADR-072: the failed step's likely causes, as text, on the same poll.
      journeyLikelyCauses: likelyCausesForDisplay(journey.likelyCauses)
    };
```

- [ ] **Step 14: Run the web tests and watch them pass**

Run: `pnpm exec vitest run apps/web`

Expected: PASS, every web test including the new ones and `page.test.tsx`.

- [ ] **Step 15: Typecheck, lint and build**

Run: `pnpm --filter @wayscribe/web typecheck && pnpm exec eslint apps/web && pnpm --filter @wayscribe/web build`

Expected: no type or lint errors; `Compiled successfully`.

- [ ] **Step 16: Commit**

```bash
git add apps/web/src/lib/likely-cause-display.ts apps/web/src/lib/likely-cause-display.test.ts apps/web/app/components/LikelyCauseLines.tsx apps/web/app/components/LikelyCauseLines.test.tsx apps/web/app/components/AboutJourneyView.tsx apps/web/app/components/AboutJourneyView.test.tsx apps/web/src/lib/api.ts apps/web/src/lib/event-display.ts apps/web/src/lib/event-display.test.ts apps/web/app/components/EventDetail.tsx apps/web/app/components/EventDetail.test.tsx apps/web/app/components/JourneyTimeline.tsx apps/web/app/components/JourneyTimeline.test.tsx "apps/web/app/(authenticated)/journeys/[journeyId]/page.tsx" "apps/web/app/api/journeys/[journeyId]/events/route.ts" "apps/web/app/api/journeys/[journeyId]/events/route.test.ts"
git commit -m "feat(web): show a failed step's likely cause in its detail and the journey header (#8)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The CLI prints the likely cause

**Files:**
- Modify: `packages/cli/src/client.ts` (types)
- Modify: `packages/cli/src/format.ts` (`formatJourney`, `formatEvent`, a new `formatLikelyCauses`)
- Test: `packages/cli/src/cli.test.ts`

- [ ] **Step 1: Write the failing tests**

In `packages/cli/src/cli.test.ts`, inside `describe("the command line", ...)`, after `it("renders a journey timeline in order, across services", ...)`, add:

```ts
  describe("likely causes (ADR-072)", () => {
    const CAUSE = {
      field: "phone",
      reportedBy: "evt_deliver",
      eventId: "evt_transform",
      step: "transform-salesforce-account",
      change: {
        kind: "renamed-changed",
        lost: true,
        path: "phone",
        from: "Phone",
        before: "+1 919 555 1234",
        after: null
      },
      alsoChangedAt: [{ eventId: "evt_normalize", step: "normalize-phone" }]
    };
    const row = (
      id: string,
      operation: string,
      name: string,
      at: string,
      extra: Record<string, unknown> = {}
    ): Record<string, unknown> => ({
      id,
      operation,
      name,
      service: "sync-worker",
      eventTimestamp: `2026-08-06T10:00:0${at}.000Z`,
      durationMs: null,
      hasInput: false,
      hasOutput: false,
      hasError: false,
      ...extra
    });
    const TIMELINE = [
      row("evt_transform", "transformed", "transform-salesforce-account", "0"),
      row("evt_deliver", "delivered", "deliver-customer-to-target", "2", {
        hasError: true,
        likelyCauses: [CAUSE]
      }),
      row("evt_dead_letter", "failed", "move-message-to-dead-letter", "5", {
        hasError: true,
        likelyCauses: [CAUSE]
      })
    ];

    it("prints the journey's likely cause under the step that failed it, and nowhere else", async () => {
      respond = (path) =>
        path.startsWith("/v1/journeys/jrn_1/events")
          ? { status: 200, body: { data: { items: TIMELINE, nextCursor: null } } }
          : {
              status: 200,
              body: {
                data: {
                  ...JOURNEY,
                  eventCount: 3,
                  failedStep: "move-message-to-dead-letter",
                  likelyCauses: [CAUSE]
                }
              }
            };
      const { out, io } = capture(env());
      expect(await run(["journey", "jrn_1"], io)).toBe(0);
      const lines = out.join("\n").split("\n");
      const failed = lines.findIndex((line) => line.includes("move-message-to-dead-letter"));
      expect(lines.slice(failed + 1, failed + 3)).toEqual([
        "  Likely cause: phone lost at transform-salesforce-account (was +1 919 555 1234), reported by deliver-customer-to-target",
        "  Also changed earlier at: normalize-phone"
      ]);
      expect(lines.filter((line) => line.includes("Likely cause:"))).toHaveLength(1);
    });

    it("prints a failed event's likely cause", async () => {
      respond = () => ({
        status: 200,
        body: {
          data: {
            ...row("evt_dead_letter", "failed", "move-message-to-dead-letter", "5", {
              hasError: true,
              likelyCauses: [CAUSE]
            }),
            journeyId: "jrn_1",
            error: { message: "The target refused the customer." }
          }
        }
      });
      const { out, io } = capture(env());
      expect(await run(["event", "evt_dead_letter"], io)).toBe(0);
      const lines = out.join("\n").split("\n");
      expect(lines).toContain(
        "  Likely cause: phone lost at transform-salesforce-account (was +1 919 555 1234), reported by evt_deliver"
      );
      expect(lines).toContain("  Also changed earlier at: normalize-phone");
    });
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm exec vitest run packages/cli/src/cli.test.ts -t "likely causes"`

Expected: FAIL: `expected [ ... ] to deeply equal [ '  Likely cause: phone lost ...' ]` (no line printed).

- [ ] **Step 3: Add the types**

In `packages/cli/src/client.ts`, above `export interface JourneyDetail extends JourneySummary {` add:

```ts
/** The nearest earlier step that changed a field a failure named (ADR-072). */
export interface LikelyCause {
  field: string;
  reportedBy: string;
  eventId: string;
  step: string;
  change: {
    kind: "removed" | "changed" | "renamed-changed";
    lost: boolean;
    path: string;
    from?: string;
    before?: unknown;
    after?: unknown;
  };
  alsoChangedAt: { eventId: string; step: string }[];
  incomplete?: true;
}
```

and replace:

```ts
  services: string[];
  completedAt: string | null;
}

export interface EventSummary {
```

with:

```ts
  services: string[];
  completedAt: string | null;
  /** The step that failed the journey; null or absent when it is not failed. */
  failedStep?: string | null;
  /** That step's likely causes; absent from an older API. */
  likelyCauses?: LikelyCause[];
}

export interface EventSummary {
```

and replace:

```ts
  hasOutput: boolean;
  hasError: boolean;
}

export interface DiffChange {
```

with:

```ts
  hasOutput: boolean;
  hasError: boolean;
  /** On a failed event only (ADR-072). */
  likelyCauses?: LikelyCause[];
}

export interface DiffChange {
```

- [ ] **Step 4: Print the lines**

In `packages/cli/src/format.ts`, replace:

```ts
import type {
  DiffChange,
  EventDetail,
  EventSummary,
  JourneyDetail,
  JourneySummary,
  Project
} from "./client.js";
```

with:

```ts
import type {
  DiffChange,
  EventDetail,
  EventSummary,
  JourneyDetail,
  JourneySummary,
  LikelyCause,
  Project
} from "./client.js";
```

In `formatJourney`, replace:

```ts
  const spansDays = new Set(events.map((e) => e.eventTimestamp.slice(0, 10))).size > 1;
```

with:

```ts
  const spansDays = new Set(events.map((e) => e.eventTimestamp.slice(0, 10))).size > 1;
  // ADR-072: the journey's likely cause goes under the step that failed it,
  // the last failing event of that name, as the API chose it.
  const failedRow =
    journey.status === "failed" && typeof journey.failedStep === "string"
      ? events.findLast(
          (e) => (e.hasError || e.operation === "failed") && e.name === journey.failedStep
        )
      : undefined;
  const nameOf = (eventId: string): string | null =>
    events.find((e) => e.id === eventId)?.name ?? null;
```

and replace:

```ts
    lines.push(
      `${style.dim(when)}${flag} ${cell(event.operation, opWidth, operationColour(event.operation, style))}  ${pad(event.name, nameWidth)}  ${style.dim(event.service)}${duration}`
    );
  }
```

with:

```ts
    lines.push(
      `${style.dim(when)}${flag} ${cell(event.operation, opWidth, operationColour(event.operation, style))}  ${pad(event.name, nameWidth)}  ${style.dim(event.service)}${duration}`
    );
    if (event === failedRow) {
      lines.push(...formatLikelyCauses(journey.likelyCauses, null, nameOf, style));
    }
  }
```

In `formatEvent`, replace:

```ts
  if (event.error !== undefined && event.error !== null) {
    lines.push("");
    lines.push(style.red(`error  ${event.error.message}`));
  }
```

with:

```ts
  if (event.error !== undefined && event.error !== null) {
    lines.push("");
    lines.push(style.red(`error  ${event.error.message}`));
  }
  lines.push(...formatLikelyCauses(event.likelyCauses, event.id, () => null, style));
```

and above `export function formatDiff(` add:

```ts
/**
 * The likely-cause lines (ADR-072), indented under a failed step: the same
 * sentence the web app shows. The reporter is named when it is not the
 * failure itself, by step name where the timeline has it, else by id.
 */
export function formatLikelyCauses(
  causes: readonly LikelyCause[] | undefined,
  failedEventId: string | null,
  nameOf: (eventId: string) => string | null,
  style: Style
): string[] {
  const lines: string[] = [];
  for (const cause of causes ?? []) {
    const { change } = cause;
    const verb = change.lost ? "lost" : change.kind === "removed" ? "removed" : "changed";
    const values =
      verb === "changed"
        ? ` (was ${causeValue(change.before)}, now ${causeValue(change.after)})`
        : ` (was ${causeValue(change.before)})`;
    const reporter =
      cause.reportedBy === failedEventId
        ? ""
        : `, reported by ${nameOf(cause.reportedBy) ?? cause.reportedBy}`;
    lines.push(`  ${style.bold("Likely cause:")} ${cause.field} ${verb} at ${cause.step}${values}${reporter}`);
    if (cause.alsoChangedAt.length > 0) {
      lines.push(
        style.dim(`  Also changed earlier at: ${cause.alsoChangedAt.map((s) => s.step).join(", ")}`)
      );
    }
    if (cause.incomplete === true) {
      lines.push(style.dim("  Some earlier steps' changes were too large to check."));
    }
  }
  return lines;
}

/** A string as it is, anything else as `render` shows a diff value. */
function causeValue(value: unknown): string {
  return typeof value === "string" ? value : render(value);
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `pnpm exec vitest run packages/cli`

Expected: PASS, the two new tests and every existing CLI test.

- [ ] **Step 6: Typecheck, and the oldest supported Node**

Run: `pnpm --filter @wayscribe/cli typecheck && scripts/sdk-node-versions.sh 22.12.0`

Expected: no type errors; the script's CLI unit tests pass on 22.12.0 (`Array.prototype.findLast` is there from Node 18).

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/client.ts packages/cli/src/format.ts packages/cli/src/cli.test.ts
git commit -m "feat(cli): journey and event print a failed step's likely cause (#8)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: The demo names the refused field

**Files:**
- Modify: `apps/demo/src/failures.ts` (`PHONE_REQUIRED` about line 101, `invalidStatus` about line 106)
- Modify: `apps/demo/src/delivery.ts` (`targetError`, `deliveryFailure`; a new `rejectedFields`)
- Modify: `apps/demo/src/history.ts` (`HistoryEvent.error` about line 133; the schema-rejected verdict about line 368; the three delivery errors about lines 395 to 430)
- Test: `apps/demo/src/delivery.test.ts`, `apps/demo/src/history.test.ts`

`contacts.ts` answers with `PHONE_REQUIRED` and `invalidStatus(...)`, so it changes with them. `worker.ts` already passes `isFailure: deliveryFailure`, which the Node SDK now reads `fields` from (Task 3).

- [ ] **Step 1: Write the failing demo tests**

In `apps/demo/src/delivery.test.ts`, replace:

```ts
    expect(deliveryFailure(phoneRequired)).toBe(true);
```

with:

```ts
    // The SDK's generic message and `result_failed`, plus the field the
    // target named (ADR-072).
    expect(deliveryFailure(phoneRequired)).toEqual({ fields: ["phone"] });
```

and add inside `describe("the worker's delivery decision", ...)`, after its last test:

```ts
  it("names the fields the target refused, so the failure links to the step that changed them (ADR-072)", () => {
    expect(
      contactResponse({
        externalId: "0018Z00002ABC",
        name: "Jorge Polanco",
        phone: null,
        status: "active"
      }).body
    ).toEqual({
      error: {
        code: "phone_required",
        message: "A phone number is required.",
        fields: ["phone"]
      }
    });
    expect(deliveryFailure(unmappedStatus)).toEqual({
      message: unmappedStatus.body.error.message,
      code: "invalid_property_value",
      fields: ["status"]
    });
    // Only non-empty strings are copied; with none left, the verdict is plain.
    expect(
      deliveryFailure({ status: 422, body: { error: { code: "phone_required", fields: ["", 7] } } })
    ).toBe(true);
    // A retryable 5xx keeps the fields it named.
    expect(deliveryFailure({ status: 503, body: { error: { fields: ["phone"] } } })).toEqual({
      fields: ["phone"]
    });
  });
```

In `apps/demo/src/history.test.ts`, above `describe("pinnedEnvelopes", ...)`, add:

```ts
/**
 * The envelopes as they were before ADR-072, which added `fields` to the
 * target's 422 bodies and to the errors recorded from them and changed
 * nothing else. Deleted in place on a copy, so every other key keeps its order
 * and the digests below still describe the same bytes.
 */
function beforeFields(envelopes: HistoryEnvelope[]): HistoryEnvelope[] {
  const copy = structuredClone(envelopes);
  for (const { event } of copy) {
    if (event.error !== undefined) delete event.error.fields;
    const output = event.output as { body?: { error?: { fields?: unknown } } } | undefined;
    if (output?.body?.error !== undefined) delete output.body.error.fields;
  }
  return copy;
}
```

Replace the whole test `it("is, apart from absolute times, the journey the docs, the site and the smoke check describe", ...)`, from that line through its closing `});` (just before the `});` that closes `describe("pinnedEnvelopes")`), with:

```ts
  it("is, apart from absolute times and ADR-072's fields, the journey the docs, the site and the smoke check describe", () => {
    // Everything but each event's absolute timestamp, which now follows the
    // send time, and the `fields` ADR-072 added: ids, aliases, payloads, the
    // transform event and the failure. A change here changes what the banner,
    // DEMO_SCENARIO.md and the smoke check point at: update them together,
    // then this digest.
    const content = (now: Date): string =>
      JSON.stringify(
        beforeFields(pinnedEnvelopes(now, "development")).map((envelope) => ({
          ...envelope,
          event: {
            ...envelope.event,
            timestamp: Date.parse(envelope.event.timestamp) - now.getTime()
          }
        }))
      );
    expect(content(new Date("2027-02-28T23:59:59.999Z"))).toBe(content(NOW));
    expect(createHash("sha256").update(content(NOW)).digest("hex")).toBe(
      "b3b22f5b19ff29017d660d9c3a383791ca0d639e5651f5df1bc71f0dabd48959"
    );
    // Before ADR-071 the journey started half an hour before `now`, and this
    // was its digest: the same envelopes, byte for byte, moved in time.
    const halfAnHourEarlier = new Date(NOW.getTime() - 30 * 60 * 1000);
    expect(
      createHash("sha256")
        .update(JSON.stringify(beforeFields(pinnedEnvelopes(halfAnHourEarlier, "development"))))
        .digest("hex")
    ).toBe("2a782328ec371be628fec8f6dc003140a10ba7760aa633edcb7a054b8f5562a0");
  });

  it("names the refused field on each 422 and on each delivery's error, and nowhere else (ADR-072)", () => {
    const events = eventsOf(pinnedEnvelopes(NOW, "development"));
    const deliveries = events.filter((event) =>
      ["deliver-customer-to-target", "retry-customer-delivery"].includes(event.name)
    );
    expect(deliveries).toHaveLength(3);
    for (const delivery of deliveries) {
      expect(delivery.error).toEqual({
        message: `${delivery.name} reported a failed result.`,
        code: "result_failed",
        fields: ["phone"]
      });
      expect(
        (delivery.output as { body: { error: { fields: unknown } } }).body.error.fields
      ).toEqual(["phone"]);
    }
    // The dead-letter names none: the API carries the last attempt's forward.
    expect(events.at(-1)?.error?.fields).toBeUndefined();
    // And beforeFields removed exactly these: nothing else has `fields`.
    expect(JSON.stringify(beforeFields(pinnedEnvelopes(NOW, "development")))).not.toContain(
      '"fields"'
    );
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm exec vitest run apps/demo/src/delivery.test.ts apps/demo/src/history.test.ts`

Expected: FAIL. `deliveryFailure(phoneRequired)` is `true`, not `{ fields: ["phone"] }`; the 422 body has no `fields`; the pinned deliveries' errors have no `fields`. The two digest assertions still PASS (nothing has `fields` yet, so `beforeFields` changes nothing): that is the control.

- [ ] **Step 3: Name the field in the target's 422s**

In `apps/demo/src/failures.ts`, replace:

```ts
/** The target's error bodies. */
export const PHONE_REQUIRED = {
  code: "phone_required",
  message: "A phone number is required."
} as const;

export function invalidStatus(status: string): { code: string; message: string } {
  return {
    code: "invalid_property_value",
    message: `Property "status" has the value "${status}", which is not one of: ${TARGET_STATUSES.join(", ")}.`
  };
}
```

with:

```ts
/**
 * The target's error bodies. Each names the field it refused in `fields`, as
 * a real API's validation error does, so the recorded error can be linked to
 * the step that changed that field (ADR-072). `fields` comes last, so the
 * pinned journey's bytes are the old ones with it removed (history.test.ts).
 */
export const PHONE_REQUIRED = {
  code: "phone_required",
  message: "A phone number is required.",
  fields: ["phone"]
} as const;

export function invalidStatus(status: string): {
  code: string;
  message: string;
  fields: string[];
} {
  return {
    code: "invalid_property_value",
    message: `Property "status" has the value "${status}", which is not one of: ${TARGET_STATUSES.join(", ")}.`,
    fields: ["status"]
  };
}
```

- [ ] **Step 4: Copy the fields onto the recorded verdict**

In `apps/demo/src/delivery.ts`, replace:

```ts
function targetError(body: unknown): { code?: unknown; message?: unknown } | undefined {
```

with:

```ts
function targetError(
  body: unknown
): { code?: unknown; message?: unknown; fields?: unknown } | undefined {
```

and replace:

```ts
/**
 * The `isFailure` verdict for a delivery. A permanent rejection is recorded
 * with the target's own message and code, so the timeline says why nothing
 * was retried; any other failure keeps the SDK's generic text.
 */
export function deliveryFailure(
  result: DeliveryResult
): boolean | { message: string; code: string } {
  if (result.status < 400) return false;
  if (!isPermanentRejection(result)) return true;
  const error = targetError(result.body);
  return {
    message:
      typeof error?.message === "string" ? error.message : "The target refused the customer.",
    code: typeof error?.code === "string" ? error.code : "result_failed"
  };
}
```

with:

```ts
/**
 * The fields the target named in its error body (ADR-072): its non-empty
 * strings, or undefined when it named none. The SDK bounds them again.
 */
export function rejectedFields(body: unknown): string[] | undefined {
  const fields = targetError(body)?.fields;
  if (!Array.isArray(fields)) return undefined;
  const named = fields.filter(
    (field): field is string => typeof field === "string" && field !== ""
  );
  return named.length === 0 ? undefined : named;
}

/** What `deliveryFailure` hands the SDK. */
export type DeliveryVerdict =
  | boolean
  | { fields: string[] }
  | { message: string; code: string; fields?: string[] };

/**
 * The `isFailure` verdict for a delivery. A permanent rejection is recorded
 * with the target's own message and code, so the timeline says why nothing
 * was retried; any other failure keeps the SDK's generic text. Either way the
 * fields the target named ride along, so the failure can be linked to the
 * step that changed them (ADR-072).
 */
export function deliveryFailure(result: DeliveryResult): DeliveryVerdict {
  if (result.status < 400) return false;
  const fields = rejectedFields(result.body);
  if (!isPermanentRejection(result)) return fields === undefined ? true : { fields };
  const error = targetError(result.body);
  return {
    message:
      typeof error?.message === "string" ? error.message : "The target refused the customer.",
    code: typeof error?.code === "string" ? error.code : "result_failed",
    ...(fields === undefined ? {} : { fields })
  };
}
```

- [ ] **Step 5: Make the backfilled journeys match the live ones**

In `apps/demo/src/history.ts`, replace:

```ts
  error?: { message: string; type?: string; code?: string };
```

with:

```ts
  error?: { message: string; type?: string; code?: string; fields?: string[] };
```

Replace:

```ts
        ...(typeof verdict === "object" ? { error: verdict } : {})
```

with:

```ts
        ...(typeof verdict === "object" && "message" in verdict ? { error: verdict } : {})
```

Replace:

```ts
        error: {
          message: "deliver-customer-to-target reported a failed result.",
          code: "result_failed"
        }
```

with:

```ts
        error: {
          message: "deliver-customer-to-target reported a failed result.",
          code: "result_failed",
          fields: ["phone"]
        }
```

Replace:

```ts
        metadata: { attempt: 2 },
        error: {
          message: "retry-customer-delivery reported a failed result.",
          code: "result_failed"
        }
```

with:

```ts
        metadata: { attempt: 2 },
        error: {
          message: "retry-customer-delivery reported a failed result.",
          code: "result_failed",
          fields: ["phone"]
        }
```

Replace:

```ts
        metadata: { attempt: 3 },
        error: {
          message: "retry-customer-delivery reported a failed result.",
          code: "result_failed"
        }
```

with:

```ts
        metadata: { attempt: 3 },
        error: {
          message: "retry-customer-delivery reported a failed result.",
          code: "result_failed",
          fields: ["phone"]
        }
```

- [ ] **Step 6: Run the demo's unit tests and watch them pass**

Run: `pnpm exec vitest run apps/demo`

Expected: PASS, including both digests (on `beforeFields` content), the new `fields` assertions, `parseEnvelope` over every generated envelope (Task 1 accepts `fields`), and the schema-rejected history, whose verdict now carries `fields: ["status"]`.

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @wayscribe/demo typecheck`

Expected: no errors. `worker.ts`'s `{ isFailure: deliveryFailure, attempt }` type-checks because Task 3 added `fields` to the SDK's `FailureReason`.

- [ ] **Step 8: Commit**

```bash
git add apps/demo/src/failures.ts apps/demo/src/delivery.ts apps/demo/src/delivery.test.ts apps/demo/src/history.ts apps/demo/src/history.test.ts
git commit -m "feat(demo): the target's 422s name the refused field, and the worker records it (#8)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Demo acceptance test, Playwright and the smoke check

**Files:**
- Modify: `apps/demo/src/demo.e2e.test.ts`
- Create: `apps/web/e2e/likely-cause.spec.ts`
- Modify: `deploy/demo/smoke-check.sh`, `tests/demo-overlay.test.ts`, `apps/web/app/components/LikelyCauseLines.test.tsx`

The demo test and the browser test need the whole stack; CI runs them as the manual `demo` and `e2e` jobs (see Verification before merge). The smoke check is what proves the pinned journey on the public demo overlay (`demo-overlay` job).

- [ ] **Step 1: Add the demo acceptance assertions**

In `apps/demo/src/demo.e2e.test.ts`, inside `describe("the reference journey", ...)`, after `it("records the target's rejection on every delivery attempt", ...)`, add:

```ts
  it("links the dead-letter and the journey to the transform that lost the phone (ADR-072)", async () => {
    const transform = events.find((event) => event.name === "transform-salesforce-account");
    const deliveries = events.filter((event) =>
      ["deliver-customer-to-target", "retry-customer-delivery"].includes(event.name)
    );
    const lastAttempt = deliveries.at(-1);
    const deadLetter = events.at(-1);
    expect(deadLetter?.name).toBe("move-message-to-dead-letter");

    const cause = {
      field: "phone",
      reportedBy: lastAttempt?.id,
      eventId: transform?.id,
      step: "transform-salesforce-account",
      change: {
        kind: "renamed-changed",
        lost: true,
        path: "phone",
        from: "Phone",
        before: "+1 919 555 1234",
        after: null
      },
      alsoChangedAt: []
    };
    const page = await get(`/v1/journeys/${journeyId}/events?limit=100`);
    const rows = page["items"] as (EventItem & { likelyCauses?: unknown })[];
    expect(rows.find((row) => row.id === deadLetter?.id)?.likelyCauses).toEqual([cause]);
    expect((await get(`/v1/journeys/${journeyId}`))["likelyCauses"]).toEqual([cause]);
    expect((await get(`/v1/events/${deadLetter?.id ?? ""}`))["likelyCauses"]).toEqual([cause]);
  });
```

Inside `describe("the other failure shapes", ...)`, after `it("records the transform's own error and the database's constraint", ...)`, add:

```ts
  // Deviation 3 in the plan, decided by Jorge on 2026-10-12: the transform
  // lowercases the status, and a case-only change counts, so this journey is
  // linked.
  it("links schema-rejected's status to the transform that lowercased it (ADR-072)", async () => {
    const journey = journeys.get("schema-rejected");
    const transform = journey?.events.find(
      (event) => event.name === "transform-salesforce-account"
    );
    const delivery = journey?.events.at(-1);
    expect((await errorOf(delivery))["fields"]).toEqual(["status"]);
    expect((await get(`/v1/journeys/${journey?.journeyId ?? ""}`))["likelyCauses"]).toEqual([
      {
        field: "status",
        reportedBy: delivery?.id,
        eventId: transform?.id,
        step: "transform-salesforce-account",
        change: {
          kind: "renamed-changed",
          lost: false,
          path: "status",
          from: "Status__c",
          before: "Former Customer",
          after: "former customer"
        },
        alsoChangedAt: []
      }
    ]);
  });

  it("links nothing for a timeout, whose errors name no field", async () => {
    const journey = journeys.get("timeout");
    expect((await get(`/v1/journeys/${journey?.journeyId ?? ""}`))["likelyCauses"]).toEqual([]);
  });
```

Run: `pnpm --filter @wayscribe/demo typecheck && pnpm exec eslint apps/demo/src/demo.e2e.test.ts`

Expected: no errors. (The suite itself runs in Step 6.)

- [ ] **Step 2: Write the Playwright spec**

Create `apps/web/e2e/likely-cause.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { API_KEY, API_URL, signIn } from "./session";

/**
 * ADR-072: a dead-letter names the step that lost the field the target
 * refused, in its detail and under the journey's status line, and the step's
 * name opens that step. Stamped per run: an event is immutable.
 */
const RUN = Date.now().toString(36);
const JOURNEY_ID = `jrn_e2e_likely_cause_${RUN}`;
const IDS = {
  received: `evt_e2e_lc_${RUN}_0`,
  transform: `evt_e2e_lc_${RUN}_1`,
  persist: `evt_e2e_lc_${RUN}_2`,
  deliver: `evt_e2e_lc_${RUN}_3`,
  deadLetter: `evt_e2e_lc_${RUN}_4`
};

const ACCOUNT = {
  Id: `0018ZE2E${RUN}`,
  Name: "Acme Field Services",
  Phone: "+1 919 555 1234",
  Status__c: "Active",
  BillingAddress: { street: "100 Main St", city: "Raleigh", state: "NC", postalCode: "27601" }
};
/** The demo's defect: `Phone` read as `Phone__c`, so `phone` arrives null. */
const CUSTOMER = {
  externalId: ACCOUNT.Id,
  name: "Acme Field Services",
  phone: null,
  status: "active",
  address: { street: "100 Main St", city: "Raleigh", state: "NC", postalCode: "27601" }
};
const REJECTED = {
  status: 422,
  body: {
    error: { code: "phone_required", message: "A phone number is required.", fields: ["phone"] }
  }
};

const LINE =
  "Likely cause: phone lost at transform-salesforce-account (was +1 919 555 1234), reported by deliver-customer-to-target";

async function post(id: string, at: number, fields: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${API_URL}/v1/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      protocolVersion: "0.1",
      event: {
        id,
        journeyId: JOURNEY_ID,
        environment: "development",
        entity: { type: "customer", id: ACCOUNT.Id },
        timestamp: new Date(at).toISOString(),
        ...fields
      }
    })
  });
  expect(response.ok, `seeding ${id} answered ${String(response.status)}`).toBe(true);
}

test.beforeAll(async () => {
  // A minute ago: finished, and too old to follow live.
  const base = Date.now() - 60_000;
  await post(IDS.received, base, {
    service: "demo-integration",
    operation: "received",
    name: "receive-salesforce-webhook",
    input: ACCOUNT
  });
  await post(IDS.transform, base + 12, {
    service: "demo-integration",
    operation: "transformed",
    name: "transform-salesforce-account",
    input: ACCOUNT,
    output: CUSTOMER,
    durationMs: 1
  });
  await post(IDS.persist, base + 35, {
    service: "demo-integration",
    operation: "persisted",
    name: "persist-customer",
    input: CUSTOMER,
    output: 4711,
    durationMs: 18
  });
  await post(IDS.deliver, base + 290, {
    service: "demo-worker",
    operation: "delivered",
    name: "deliver-customer-to-target",
    input: CUSTOMER,
    output: REJECTED,
    durationMs: 19,
    error: {
      message: "deliver-customer-to-target reported a failed result.",
      code: "result_failed",
      fields: ["phone"]
    }
  });
  await post(IDS.deadLetter, base + 9_400, {
    service: "demo-worker",
    operation: "failed",
    name: "move-message-to-dead-letter",
    error: {
      message: "The target refused the customer; the message moved to the dead-letter queue."
    }
  });
});

const deadLetterPage = `/journeys/${JOURNEY_ID}?event=${IDS.deadLetter}`;

test("the dead-letter's detail and the journey header name the likely cause", async ({ page }) => {
  await signIn(page, JOURNEY_ID);
  await page.goto(deadLetterPage);
  await expect(page.locator(".detail h2")).toHaveText("move-message-to-dead-letter");
  await expect(page.locator(".detail .likely-cause")).toHaveText(LINE);
  await expect(page.locator(".journey-likely-cause .likely-cause")).toHaveText(LINE);
});

test("the step's name opens the step that lost the field", async ({ page }) => {
  await signIn(page, JOURNEY_ID);
  await page.goto(deadLetterPage);
  await page
    .locator(".detail .likely-cause")
    .getByRole("link", { name: "transform-salesforce-account" })
    .click();
  await expect(page).toHaveURL(new RegExp(`[?&]event=${IDS.transform}(&|$)`));
  await expect(page.locator(".detail h2")).toHaveText("transform-salesforce-account");
});

test.describe("with JavaScript disabled", () => {
  test.use({ javaScriptEnabled: false });

  test("the server's HTML carries both lines", async ({ page }) => {
    await signIn(page, JOURNEY_ID);
    await page.goto(deadLetterPage);
    await expect(page.locator(".detail .likely-cause")).toHaveText(LINE);
    await expect(page.locator(".journey-likely-cause .likely-cause")).toHaveText(LINE);
  });
});

for (const width of [375, 1440]) {
  test(`the likely cause lines do not scroll sideways at ${String(width)} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page, JOURNEY_ID);
    await page.goto(deadLetterPage);
    const lines = page.locator(".likely-cause");
    await expect(lines).toHaveCount(2);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
    for (const line of await lines.all()) {
      const box = await line.boundingBox();
      expect(box, "a likely cause line has no box").not.toBeNull();
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(width);
    }
  });
}
```

Run: `pnpm exec tsc -p apps/web/tsconfig.json --noEmit && pnpm exec eslint apps/web/e2e/likely-cause.spec.ts`

Expected: no errors. (The spec itself runs in Step 7.)

- [ ] **Step 3: Pin the header line in the smoke check, against rendered markup**

In `apps/web/app/components/LikelyCauseLines.test.tsx`, add to the imports:

```tsx
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToString } from "react-dom/server";
```

and add inside `describe("LikelyCauseLines", ...)`:

```tsx
  // deploy/demo/smoke-check.sh matches the server's HTML, where React puts
  // comment markers between adjacent text nodes: only this prefix is stable.
  it("renders on the server the markup the demo's smoke check matches", () => {
    const html = renderToString(
      <LikelyCauseLines
        causes={[LOST]}
        journeyId="jrn_demo_pinned_5550100"
        failedEventId={null}
        describeEvent={describeEvent}
      />
    );
    expect(html).toContain("Likely cause: <code>phone</code>");
    const smoke = readFileSync(join(__dirname, "../../../../deploy/demo/smoke-check.sh"), "utf8");
    expect(smoke).toContain('*"Likely cause: <code>phone</code>"*');
  });
```

Run: `pnpm exec vitest run apps/web/app/components/LikelyCauseLines.test.tsx`

Expected: FAIL on the last assertion only: the smoke check does not contain the pattern yet.

In `deploy/demo/smoke-check.sh`, replace:

```sh
echo "smoke-check: ok ${BASE}"
```

with:

```sh
# ADR-072: the journey header names the transform as the likely cause of the
# dead-letter. LikelyCauseLines.test.tsx checks this against a server render.
# Double quotes on purpose: DiffTable.test.tsx expects every single-quoted
# pattern in this file to be diff markup.
case "${journey}" in
  *"Likely cause: <code>phone</code>"*) ;;
  *) fail "the pinned journey names no likely cause for phone" ;;
esac

echo "smoke-check: ok ${BASE}"
```

In `tests/demo-overlay.test.ts`, in `it("matches markup the web app really renders", ...)`, replace:

```ts
      ["What changed", "apps/web/app/components/EventDetail.tsx", "What changed"],
```

with:

```ts
      ["What changed", "apps/web/app/components/EventDetail.tsx", "What changed"],
      [
        "Likely cause: <code>phone</code>",
        "apps/web/app/components/LikelyCauseLines.tsx",
        "Likely cause: <code>{cause.field}</code>"
      ],
```

Run: `pnpm exec vitest run apps/web/app/components/LikelyCauseLines.test.tsx tests/demo-overlay.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/demo/src/demo.e2e.test.ts apps/web/e2e/likely-cause.spec.ts apps/web/app/components/LikelyCauseLines.test.tsx deploy/demo/smoke-check.sh tests/demo-overlay.test.ts
git commit -m "test(demo,web): likely cause on the demo, in the browser and in the smoke check (#8)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Push the branch so CI can run the manual jobs**

Only when Jorge has said the branch may be pushed. `git push -u origin HEAD`, then open the merge request for issue #8.

- [ ] **Step 6: Run the demo suite (CI job `demo`, or locally)**

Locally, with Docker running:

```bash
cp .env.example .env
docker compose -f infrastructure/compose.yaml -f infrastructure/compose.demo.yaml up --build -d
npx wait-on --timeout 300000 http://localhost:8080/health http://localhost:3100/health http://localhost:3000/health
pnpm test:demo
docker compose -f infrastructure/compose.yaml -f infrastructure/compose.demo.yaml down -v
```

(`cp .env.example .env` only if there is no `.env` yet: never read or print an existing one.)

Expected: every test in `demo.e2e.test.ts` passes, including the three new ones. On the merge request pipeline, play the manual `demo` job as the Verification section says.

- [ ] **Step 7: Run the browser suite (CI job `e2e`)**

Play the manual `e2e` job on the merge request pipeline (Verification section). It builds with `pnpm build`, seeds a key, and runs `pnpm test:e2e` twice, once with a second project.

Expected: `likely-cause.spec.ts` passes in both runs: 5 tests (detail and header, link, no-JavaScript, 375 px, 1440 px).

---

### Task 13: Documentation, ADR-072 and the changelog

**Files:**
- Modify: `docs/EVENT_PROTOCOL.md` (section 8, about line 384)
- Modify: `docs/API_SPEC.md` (sections 7, 8 and 9)
- Modify: `packages/sdk-node/README.md`, `packages/sdk-python/README.md`, `packages/sdk-go/README.md`
- Modify: `docs/DECISIONS.md` (append ADR-072), `README.md` (ADR count), `CHANGELOG.md` (Unreleased)
- Modify: `docs/INGESTION_CONTRACT.md` (`stored` has no read-time `likelyCauses`)

No em or en dashes anywhere below: `tests/docs-claims.test.ts` refuses them.

- [ ] **Step 1: ADR-072**

Append to `docs/DECISIONS.md` (after ADR-071's `**Rejected.**` paragraph, separated by one blank line):

```markdown

## ADR-072: A failure that names a field links to the nearest earlier step that changed it

**Status:** Accepted, 2026-10-12. Adds one optional protocol field, `error.fields`, and one
read-time answer, `likelyCauses`, on the journey read, the timeline and the event read.
Follows issue #8 and `docs/superpowers/specs/2026-10-12-root-cause-linking-design.md`. The
protocol version stays `0.1`: an added optional field is a compatible change
(EVENT_PROTOCOL.md section 11).

**Context.** When a step fails because a field is missing or wrong, the journey already holds
both halves of the explanation: the failure, and the earlier step whose diff lost or changed
the field. In the demo the target answers 422 `phone_required`, the message is dead-lettered,
and the reader had to open the transform step to see `Phone` paired with `phone` and its value
gone. Nothing in a recorded error said which field it was about, so nothing could connect the
two. Tracing tools cannot make the link because they hold no payloads; Wayscribe holds both.

**Decision.**

1. An error may carry `fields`: 1 to 20 paths of 1 to 200 characters, in the path syntax the
   stored diff writes (`address.postalCode`, `lines[0].sku`), as the failing system names
   them. Wayscribe never infers a field from a message or a code: a wrong link costs more
   trust than a missing one.
2. The SDKs read `fields` by convention, as they read `code`. Node reads `err.fields` on a
   thrown error, an `isFailure` reason and an error passed to `record()`; Python reads an
   exception's `fields` attribute, a mapping's `fields` key and an `is_failure` mapping; Go
   reads `Fields() []string` on an error or anything it wraps, and `FailureReason.Fields`.
   Each keeps only a list's non-empty strings, at most 20 of at most 200 characters, sends no
   `fields` when none is left, and drops a value whose read throws or panics. Fields are
   names, so they are not masked.
3. The API computes `likelyCauses` at read time over the whole journey, in timeline order,
   for each failed event (an error, or the operation `failed`). The fields are the event's
   own, or else those of the most recent earlier failed event that named some, which is
   reported as `reportedBy`. The candidates are the events before the reporter that are not
   failed and have a stored diff, paired with `pairChanges`, whose canonical copy is now in
   `@wayscribe/payload-diff`. A change matches a field when its path on either side equals
   the field or is an ancestor of it, comparing keys as pairing normalizes them and array
   indexes literally. `removed`, `changed` and `renamed-changed` count; a rename that kept
   the value, an added field, and a whole-payload replacement at the empty path do not. The
   nearest match is the likely cause and the others are listed in `alsoChangedAt`, nearest
   first.
4. A journey over 1,000 events gets no causes; the demo's journeys hold 2 to 10. A truncated
   diff nearer than the cause sets `incomplete`.
5. The web app shows "Likely cause: `phone` lost at **transform-salesforce-account**" under
   the error and under the journey's status line, with the step linked; About this view
   defines it; `wayscribe journey` and `wayscribe event` print the same line. The wording is
   "Likely cause", never "Cause".

**Consequences.** The demo's target names the field in its 422s, so its dead-letter reads
"Likely cause: phone lost at transform-salesforce-account", reported by the last delivery
attempt. Its `schema-rejected` journey links `status` to the transform, which lowercases it
("Former Customer" to "former customer"); its `timeout` journey, whose errors name no field,
links nothing. A read of a journey with a failure reads the first 1,001 events' failure facts,
and every stored diff only when one failure names a field. The web app still depends on no
workspace package: it keeps its own copy of the pairing code, and
`tests/diff-pairing-parity.test.ts` fails when the two copies differ in text or behaviour.

**Rejected.** Inferring the field from the message or the code. Computing the link at ingest:
events arrive out of order and in batches, and a stored link goes stale when the rule changes.
Computing it in the web app alone: the CLI and API callers would never see it. Counting failed
steps as candidates: a failed delivery's diff compares a request with an error response, and
in the demo it removes `phone` on every attempt. Counting the empty path: persisting a customer
and answering its id would be the likely cause of every field. Excluding case-only changes:
case changes are a real integration bug class (case-sensitive picklists and enums), the line
shows the value before and after so the reader judges, and each exclusion invites the next
(whitespace, number and date formatting). Importing the pairing code into the web app from
the package: workspace packages have broken the images before (`pnpm deploy --legacy`
symlinks, production-install pruning), and a copy held by a test avoids that risk.
```

- [ ] **Step 2: Watch the count test fail**

Run: `pnpm exec vitest run tests/docs-truth.test.ts`

Expected: FAIL in `counts the ADRs correctly` and `states the ADR count correctly wherever the README states one`: the README claims 71 and `docs/DECISIONS.md` now holds 72.

- [ ] **Step 3: The ADR count**

Run: `sed -i.bak 's/71 ADRs/72 ADRs/g' README.md && rm README.md.bak`

Expected: `git diff README.md` shows exactly two changed lines, "[the decision log](docs/DECISIONS.md): 72 ADRs, including ..." and "[the decision log](docs/DECISIONS.md), which holds 72 ADRs.".

- [ ] **Step 4: EVENT_PROTOCOL.md section 8**

In `docs/EVENT_PROTOCOL.md`, replace:

```markdown
text before storage (SECURITY.md section 4, ADR-046).

## 9. Metadata
```

with:

````markdown
text before storage (SECURITY.md section 4, ADR-046).

An error may name the fields the failing system rejected, as `fields`: a list of 1 to 20
paths, each 1 to 200 characters, in the path syntax a stored diff writes. Object keys are
joined with `.` and array indexes are in brackets (`address.postalCode`, `lines[0].sku`).
Write a path as the failing system names it (`phone`, not `Phone__c`): the server compares
keys the way it pairs renamed fields, ignoring case, a trailing `__c`, `_` and `-`. A
malformed `fields` refuses the event with `invalid_event`, like any other schema violation.
Fields are names, not values, and are not masked.

```json
{
  "message": "A phone number is required.",
  "code": "phone_required",
  "fields": ["phone"]
}
```

With `fields`, the API links a failed step to the nearest earlier step whose diff removed or
changed that field, or a field containing it, and returns it as `likelyCauses` (API_SPEC
sections 7 to 9, ADR-072). A failed step with no `fields` of its own uses those of the most
recent earlier failure that named some, which is how a dead-letter is linked. Wayscribe never
infers a field from the message or the code: an error without `fields` gets no link.

The SDKs read `fields` from the error the host throws or records, keep only non-empty
strings, cut the list to 20 and each path to 200 characters, and leave `fields` off when
nothing is left.

## 9. Metadata
````

- [ ] **Step 5: API_SPEC.md sections 7, 8 and 9**

In `docs/API_SPEC.md`, replace:

```markdown
    "services": [],
    "eventCount": 8,
    "startedAt": "2026-08-06T18:31:02.000Z",
    "completedAt": null,
    "lastEventAt": "2026-08-06T18:34:38.000Z"
  }
}
```

with:

```markdown
    "services": [],
    "eventCount": 8,
    "startedAt": "2026-08-06T18:31:02.000Z",
    "completedAt": null,
    "lastEventAt": "2026-08-06T18:34:38.000Z",
    "likelyCauses": [
      {
        "field": "phone",
        "reportedBy": "evt_07",
        "eventId": "evt_02",
        "step": "map-hubspot",
        "change": {
          "kind": "renamed-changed",
          "lost": true,
          "path": "phone",
          "from": "Phone",
          "before": "+1 919 555 1234",
          "after": null
        },
        "alsoChangedAt": []
      }
    ]
  }
}
```

and replace:

```markdown
`label`, `lastStep` and `failedStep` are as in a search result (section 5).
```

with:

```markdown
`likelyCauses` is section 8's, for the event that failed the journey, the one `failedStep`
names. It is `[]` when the journey is not failed, when no failure names a field, and when no
earlier step changed one.

`label`, `lastStep` and `failedStep` are as in a search result (section 5).
```

Replace:

```markdown
Every item carries all thirteen fields.
```

with:

```markdown
Every item carries all thirteen fields, and a failed item (`hasError`, or the operation
`failed`) carries a fourteenth, `likelyCauses`.
```

Replace:

```markdown
payloads stay off timeline rows. Older API versions may omit both added fields.
```

with:

```markdown
payloads stay off timeline rows. Older API versions may omit both added fields.

### Likely causes

`likelyCauses` (ADR-072) links a failed event to the earlier step that most likely broke it,
when its error names the fields it rejected (EVENT_PROTOCOL.md section 8). It is computed when
read, over the whole journey, whatever page is asked for:

| Key | Meaning |
| --- | --- |
| `field` | A field as the error named it. One entry per named field that matched. |
| `reportedBy` | The event whose error named the field: this event, or for a failure that named none (a dead-letter), the most recent earlier failure that did. |
| `eventId`, `step` | The likely cause: the nearest event before the reporter, not itself failed, whose stored diff removed or changed the field or a field containing it. |
| `change.kind` | `removed`, `changed` or `renamed-changed`. A rename that kept the value and an added field never count. |
| `change.lost` | The input had a non-null value and the output has null or nothing. |
| `change.path`, `change.from` | The output-side path (the input path when removed), and the input-side path of a rename. |
| `change.before`, `change.after` | The values as stored, so possibly masked. Absent for a side that does not have the field. |
| `alsoChangedAt` | Every other earlier step that changed the field, `{ eventId, step }`, nearest first. |
| `incomplete` | `true` when a step nearer than the cause had a diff too large to check. Absent otherwise. |

Keys are compared the way renamed fields are paired (case, a trailing `__c`, `_` and `-` are
ignored) and array indexes literally. A journey over 1,000 events gets `[]`.
```

Replace:

```markdown
metadata. An API key reads events of its own environment only.
```

with:

```markdown
metadata. An API key reads events of its own environment only. A failed event also carries
`likelyCauses`, as section 8 describes; any other event does not.
```

- [ ] **Step 6: The SDK READMEs**

In `packages/sdk-node/README.md`, replace:

```markdown
error, the SDK records the error's `message`, `name` as `type`, and a string
`code`. It sends no `stack`.
```

with:

````markdown
error, the SDK records the error's `message`, `name` as `type`, and a string
`code`. It sends no `stack`.

An error may also name the fields the failing system rejected, as `fields`: a
list of paths such as `phone` or `lines[0].sku`, written as that system names
them. The SDK reads it from a thrown error, from an `isFailure` reason and from
an error passed to `record()`, keeps only non-empty strings, at most 20 of at
most 200 characters, and sends none when nothing is left. With it, Wayscribe
links the failure to the nearest earlier step that changed the field (ADR-072):

```ts
throw Object.assign(new Error(body.error.message), {
  code: body.error.code,
  fields: body.error.fields
});
```
````

In `packages/sdk-python/README.md`, replace:

```markdown
null. Pass trace/span IDs explicitly; no OpenTelemetry installation is needed.
```

with:

````markdown
null. Pass trace/span IDs explicitly; no OpenTelemetry installation is needed.

An error may name the fields the failing system rejected: an exception's
`fields` attribute, a mapping's `fields` key, or an `is_failure` mapping's
`fields`, as a list of paths such as `phone` or `lines[0].sku`. Only non-empty
strings are kept, at most 20 of at most 200 characters, and nothing is sent when
none is left. Wayscribe then links the failure to the nearest earlier step that
changed the field (ADR-072):

```python
class TargetRejected(Exception):
    def __init__(self, error):
        super().__init__(error["message"])
        self.fields = error.get("fields", [])
```
````

In `packages/sdk-go/README.md`, replace:

```markdown
populates `error` with its `Message`/`Code` without changing the host return.
```

with:

```markdown
populates `error` with its `Message`/`Code`/`Fields` without changing the host return.
```

and replace:

```markdown
one object; additional objects are safely diagnosed and ignored.
```

with:

````markdown
one object; additional objects are safely diagnosed and ignored.

An error that implements `Fields() []string`, found with `errors.As`, names the
fields the failing system rejected, as `FailureReason.Fields` does for a
classified result: paths such as `phone` or `lines[0].sku`. Only non-empty
paths are sent, at most 20 of at most 200 runes, and none when nothing is left;
a panicking `Fields()` costs only the fields. Wayscribe then links the failure
to the nearest earlier step that changed the field (ADR-072):

```go
type TargetRejected struct{ Message string; Names []string }

func (e TargetRejected) Error() string    { return e.Message }
func (e TargetRejected) Fields() []string { return e.Names }
```
````

In `docs/INGESTION_CONTRACT.md`, replace:

```markdown
  the journey as `GET /v1/journeys/:journeyId` returns it. It is omitted for a
  duplicate and for a rejection.
```

with:

```markdown
  the journey as `GET /v1/journeys/:journeyId` returns it. Neither holds
  `likelyCauses`, which those reads compute and nothing stores (ADR-072). It is
  omitted for a duplicate and for a rejection.
```

- [ ] **Step 7: The changelog**

In `CHANGELOG.md`, replace:

```markdown
## [Unreleased]

## [0.2.5] - 2026-10-10
```

with:

```markdown
## [Unreleased]

### Added

- **A failed step names its likely cause.** When an error names the fields it rejected, in
  the new optional `error.fields` (up to 20 paths of up to 200 characters), the API answers
  `likelyCauses`: the nearest earlier step whose diff removed or changed that field, and any
  earlier ones, on the timeline's failed rows, the journey read and the event read. A
  dead-letter with no fields of its own uses those of the failure before it. The web app shows
  it under the error and under the journey's status line, `wayscribe journey` and
  `wayscribe event` print it, and the Node, Python and Go SDKs read `fields` from the error the
  host throws or records. The demo's target names the field in its 422s, so its dead-letter
  now reads "Likely cause: phone lost at transform-salesforce-account" (ADR-072).

## [0.2.5] - 2026-10-10
```

- [ ] **Step 8: Run the full unit suite**

Run: `pnpm test`

Expected: PASS, including `tests/docs-truth.test.ts` (72 ADRs, ADR numbers in order), `tests/docs-claims.test.ts` (no dashes), `tests/docs-links.test.ts`, and `tests/site.test.ts`.

- [ ] **Step 9: Commit**

```bash
git add docs/EVENT_PROTOCOL.md docs/API_SPEC.md docs/INGESTION_CONTRACT.md packages/sdk-node/README.md packages/sdk-python/README.md packages/sdk-go/README.md docs/DECISIONS.md README.md CHANGELOG.md
git commit -m "docs: error.fields, likelyCauses and ADR-072 (#8)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Verification before merge

Green unit tests in the working tree are not enough here: the change crosses three languages, a Docker image build and two manual CI jobs.

- [ ] **1. The whole suite on a clean clone of the branch**

```bash
BRANCH=$(git branch --show-current)
CLONE=$(mktemp -d)
git clone --branch "${BRANCH}" "$(git rev-parse --show-toplevel)" "${CLONE}/wayscribe"
cd "${CLONE}/wayscribe"
pnpm install --frozen-lockfile
pnpm format:check && pnpm lint && pnpm typecheck
pnpm test
export DOCKER_CONFIG=$(mktemp -d) && ln -s ~/.docker/cli-plugins "$DOCKER_CONFIG/cli-plugins"
pnpm test:integration
pnpm test:python
pnpm test:go
pnpm build
scripts/sdk-node-versions.sh 22.12.0
```

Expected: every command exits 0. `pnpm test` includes `tests/diff-pairing-parity.test.ts`, which proves the two pairing copies agree; `sdk-node-versions.sh 22.12.0` proves the Node SDK and CLI on the oldest supported Node.

- [ ] **2. The images build as CI builds them**

From the clean clone: `docker build -f apps/web/Dockerfile -t scan/web:verify . && scripts/verify-image-contents.sh scan/web:verify web`, and the same for `apps/api/Dockerfile` (`api`) and `apps/demo/Dockerfile` (`demo`).

Expected: all three build and every image check passes.

- [ ] **3. The merge request pipeline, including the manual jobs**

The `demo` and `e2e` jobs are `when: manual` on merge request pipelines and nothing plays them for you. After pushing (only with Jorge's go-ahead):

```bash
MR=$(glab mr view --output json | jq -r .iid)
PIPELINE=$(glab api "projects/:id/merge_requests/${MR}/pipelines" | jq -r '.[0].id')
job_id() {
  glab api "projects/:id/pipelines/${PIPELINE}/jobs?per_page=100" \
    | jq -r --arg name "$1" '.[] | select(.name == $name) | .id' | head -n 1
}
DEMO_JOB=$(job_id demo)
E2E_JOB=$(job_id e2e)
glab api -X POST "projects/:id/jobs/${DEMO_JOB}/play"
glab api -X POST "projects/:id/jobs/${E2E_JOB}/play"
```

Poll each job with a deadline (no unbounded loop), up to 45 minutes each:

```bash
wait_for_job() {
  deadline=$(( $(date +%s) + 2700 ))
  status=unknown
  while [ "$(date +%s)" -lt "${deadline}" ]; do
    status=$(glab api "projects/:id/jobs/$1" | jq -r .status)
    case "${status}" in success|failed|canceled) break ;; esac
    sleep 30
  done
  echo "job $1: ${status}"
}
wait_for_job "${DEMO_JOB}"
wait_for_job "${E2E_JOB}"
```

Expected: `demo`, `e2e`, `demo-overlay` (which runs the smoke check against the pinned journey), `unit`, `sdk-node` (22.12.0 and 24), `sdk-python` (3.11 and 3.14), `sdk-go` (1.22.0 and 1.26.4), `database`, `build`, `typecheck`, `lint`, `format` and `container-scan` all `success`.

- [ ] **4. The demo at phone width and desktop width, by eye**

On the demo stack (Task 12, Step 6), open `http://localhost:3000`, search for the reference journey (`0018Z00002ABC`), open its dead-letter, and check at 375 px and at 1440 px wide (browser pane `resize_window` or the browser's device toolbar): the header line and the detail line both read "Likely cause: phone lost at transform-salesforce-account (was +1 919 555 1234), reported by retry-customer-delivery...", wrap inside the page with no sideways scroll, and the step name opens the transform with its phone diff. Then open the `schema-rejected` journey and check its `status` line, and the `timeout` journey, which shows none.

- [ ] **5. Done when**

The pinned demo journey's dead-letter and journey header show "Likely cause: `phone` lost at transform-salesforce-account", reported by the delivery attempt's 422 (`demo-overlay` smoke check, and `demo` for the live reference journey), and every job above is green, the manual `demo` and `e2e` jobs included.

## Spec coverage

| Spec section | Task |
|---|---|
| Decisions 1, 2 (structural `fields`, read by convention) | 1, 3, 4, 5 |
| 1. SDKs, sanitizing, failure isolation | 3, 4, 5 |
| 1. Path syntax | 1 (schema doc), 7 (segment matching), 13 |
| 1. Protocol and ingestion, no migration | 1, 2 |
| 1. Documentation (EVENT_PROTOCOL, READMEs) | 13 |
| 2. Shared pairing | 6 |
| 2. The function (fields, candidates, match, kinds, choice, one per field) | 7 (Deviations 1 and 2) |
| 2. Bounds and honesty (cap, truncated, redaction, no match) | 7, 8 |
| 2. API shape, both endpoints, whole journey | 8 (plus the event read, Deviation 4) |
| 3. Web: event detail, header, timeline rows unchanged, About this view, 375/1440 | 9, 12 |
| 3. CLI | 10 |
| 4. Demo | 11, 12 (Deviation 3) |
| 5. Testing | 1 to 12 |
| ADR-072, API_SPEC | 13 |
| Done when | Verification before merge |
