# Root-cause linking design

Date: 2026-10-12
Issue: GitLab jojithedev/wayscribe#8, "Link a failed step to the upstream change that caused it"
Decision record: ADR-072 (written with the implementation)

## Problem

When a step fails because a field is missing or wrong, Wayscribe already holds both halves of
the explanation in one journey: the failure, and the earlier step whose diff lost or changed
that field. Today the reader has to connect them by hand. In the demo, the target answers
422 `phone_required`, the message is dead-lettered, and the reader must open the transform
step to discover that `Phone → phone` lost its value there. Tracing tools cannot make this
link, because they do not hold payloads. Wayscribe can, and should say so on the failure.

## Decisions

1. **The field comes from the error, structurally.** A recorded error may carry
   `fields: string[]`, the paths the failing system named. Wayscribe never infers a field
   from message text or an error code. An error without `fields` gets no link. This is
   deliberate: a wrong link costs more trust than a missing one.
2. **The SDKs read `fields` by convention**, the same way they already read `code`: a
   property on whatever the host code throws or records. No new SDK option.
3. **The link is computed at read time, in the API**, over the whole journey. Not at ingest
   (events arrive out of order and in batches, and a stored link goes stale when the rule
   improves). Not in the web only (the CLI and API consumers would never see it).
4. **The nearest upstream step that changed the field is the likely cause.** Earlier steps
   that also changed it are listed, never hidden. The wording is "Likely cause", never
   "Cause".
5. **Fields carry forward to later failures.** A failed event with no `fields` (the demo's
   dead-letter) uses the fields of the most recent earlier failed event in the journey that
   has them, and says which event reported them.
6. **A pure rename is not a cause.** A change that moved a value under a new name without
   changing it did not break it.

## 1. Recording `fields`

### SDKs

All three SDKs gain the same behavior, so the contract does not drift.

| SDK | Where | Change |
|---|---|---|
| Node | `packages/sdk-node/src/recorder.ts`, `toErrorRecord` | read `err.fields` |
| Python | `packages/sdk-python/src/wayscribe/_errors.py`, `capture_error` | read a `fields` attribute on an exception, or a `fields` key on a mapping |
| Go | `packages/sdk-go/errors.go`, `ErrorInfo` / `hostError` / `captureError` | `ErrorInfo.Fields []string`; `hostError` reads it from an error implementing `interface{ Fields() []string }` |

Sanitizing, identical in all three, applied inside the existing failure-isolation boundary
so a bad value is dropped and never thrown:

- Read only when the value is a list; keep only string entries.
- Drop empty strings; truncate the list to 20 entries and each entry to 200 characters.
- Omit `fields` from the record entirely when nothing survives.

Fields are names, not values. They are not passed through the message text masking of
ADR-046.

### Path syntax

The same syntax `packages/payload-diff` writes into `Change.path`: object keys joined with
`.`, array indexes in brackets (`address.postalCode`, `lines[0].sku`). The host writes the
path as the failing system names it (`phone`, not `Phone__c`); rename pairing bridges the
difference.

### Protocol and ingestion

- `packages/protocol/src/event.ts` `errorSchema` gains optional
  `fields: z.array(z.string().min(1).max(200)).min(1).max(20)`. The generated JSON Schema
  picks it up.
- A malformed `fields` is rejected like any other schema violation. The SDKs sanitize
  before sending, so their own events never hit this.
- `storedError()` in `apps/api/src/ingestion/ingest-event.ts` keeps `fields` as given.
- Storage is the existing `journey_events.error` jsonb column. No migration.

### Documentation

- `docs/EVENT_PROTOCOL.md` section 8 "Errors": the `fields` property, its limits, its path
  syntax, and what it enables.
- Each SDK README: one paragraph and one example, for Node:
  `throw Object.assign(new Error(body.error.message), { code: body.error.code, fields: body.error.fields })`.

## 2. Finding the likely cause

### Shared pairing

`pairChanges`, `normalizeKey` and the `PairedChange` type move from
`apps/web/src/lib/diff-pairing.ts` to `packages/payload-diff`, with their tests. Behavior
is unchanged. The web imports them from the package; the API uses the same code.

### The function

`findLikelyCauses(events)` in `apps/api/src/journeys/likely-cause.ts`, pure, taking one
journey's events in timeline order (`event_timestamp`, `received_at`, `id`, as
`listJourneyEvents` orders them) and returning causes keyed by failed event id.

For each failed event F:

1. **Fields.** Use `F.error.fields`. If absent, use the fields of the most recent failed
   event before F that has them. The event whose error supplied the fields is the
   *reporter* (F itself, or the earlier one).
2. **Candidates.** Every event before the reporter that has a stored diff. Its changes are
   paired with `pairChanges`.
3. **Match.** A paired change matches field `f` when, comparing path segments after
   `normalizeKey` (array index segments compared literally):
   - the change's path on either side equals `f`, or
   - the change's path on either side is an ancestor of `f` (removing `address` loses
     `address.postalCode`).
4. **Counting kinds.** `removed`, `changed` and `renamed-changed` count (`PairedChange.kind`;
   `lost` is a flag on these, not a kind, and is shown when set). A pure `renamed` (value
   unchanged) and `added` do not.
5. **Choice.** The nearest matching candidate before the reporter is the likely cause.
   Every other matching candidate goes in `alsoChangedAt`, nearest first.
6. **One cause per field.** An error naming several fields yields one entry per field that
   matched. Fields with no match yield nothing.

### Bounds and honesty

- **Journey size cap: 1,000 events.** Past it, no causes are computed for that journey and
  the response says nothing. The function never answers from a partial journey. The number
  is checked against real journey sizes during implementation and may move.
- **Truncated diffs.** A candidate whose diff is `truncated` and has no matching change is
  treated as unknown. If any candidate nearer to the reporter than the chosen cause is
  truncated, the cause is still returned but `incomplete: true` is set, and the UI says
  "some earlier steps' changes were too large to check".
- **Redaction.** Diffs are stored after redaction, so `before` and `after` may be masked.
  Matching uses paths, so the link survives; the UI shows the masked value as stored.
- **No match.** An empty list. The UI shows nothing. No fallback.

### API shape

`GET /v1/journeys/:journeyId/events` gains `likelyCauses` on each failed event, and
`GET /v1/journeys/:journeyId` gains `likelyCauses` for the journey's failed step (ADR-063).
Both are computed over the whole journey, whatever page is requested.

```ts
type LikelyCause = {
  field: string;            // as reported
  reportedBy: string;       // event id whose error named the field
  eventId: string;          // the likely-cause step's event id
  step: string;             // its operation name
  change: {
    kind: "removed" | "changed" | "renamed-changed";
    lost: boolean;          // input non-null, output null or missing
    path: string;           // output-side path, or input path when removed
    from?: string;          // input-side path when renamed
    before: unknown;        // as stored (possibly masked)
    after: unknown;
  };
  alsoChangedAt: { eventId: string; step: string }[];
  incomplete?: true;
};
```

`docs/API_SPEC.md` documents both additions.

## 3. Showing it

### Web

- **Event detail** (`apps/web/app/components/EventDetail.tsx`, under the error block): one
  line per cause, for example:
  "Likely cause: `phone` lost at **transform-salesforce-account** (was `+1 919 555 1234`)".
  The step name links to that event in the timeline. When `reportedBy` is another event:
  "reported by the 422 on delivery attempt 3". When `alsoChangedAt` is non-empty, a second
  line lists those steps.
- **Journey header** (`JourneyTimeline.tsx` status summary): the same one-liner for the
  failed step.
- **Timeline rows** are unchanged.
- **About this view** (`AboutJourneyView.tsx`): one sentence, "When an error names the
  field it rejected, the likely cause is the nearest earlier step that changed that field."
- Phone width (375px) and desktop (1440px) both lay out without overflow.

### CLI

`wayscribe journey <id>` (`packages/cli`) prints the same line under the failed step, and
`wayscribe event <id>` prints it for a failed event.

## 4. Demo

- The target's `phone_required` 422 body adds `fields: ["phone"]` (`apps/demo/src/contacts.ts`,
  and the history flow's 422s in `apps/demo/src/history.ts`, so backfilled journeys match
  live ones).
- `apps/demo/src/delivery.ts` copies `body.error.fields` onto the error it records.
- `invalid_property_value` reports `fields: ["status"]`. The transform only renames
  `Status__c → status` with the value intact, so it correctly gets no link: an honest
  negative case in the live demo.
- `timeout`, `transform-failed` and `persist-failed` are unchanged.

## 5. Testing

- **`findLikelyCauses` unit tests**, with Salesforce-shaped fixtures (nested `Address`,
  arrays of line items, `__c` custom fields), not flat JSON: rename to lost; nested path;
  ancestor removal; no match; several matches (nearest plus `alsoChangedAt`); fields
  carried from a delivery attempt to the dead-letter; pure rename excluded; `added`
  excluded; truncated diff (`incomplete`); several fields; array index paths; the 1,000
  event cap.
- **`pairChanges`** keeps its existing tests after the move.
- **SDK tests**, all three: `fields` captured; non-list, non-string entries, empty strings,
  over 20 entries, over 200 characters all sanitized; absent when nothing survives; a
  throwing getter on `fields` never escapes.
- **Protocol and ingestion**: valid `fields` stored; malformed rejected with the standard
  schema error.
- **API integration**: both endpoints return `likelyCauses`; a page that excludes the cause
  step still returns it.
- **CLI**: output includes the line.
- **`pnpm test:demo`**: the pinned journey's dead-letter links to
  `transform-salesforce-account` with field `phone`; the `schema-rejected` journey has no
  link.
- **Playwright**: the line renders on the dead-letter detail and in the header, and the
  step link selects the transform event; layout holds at 375 and 1440px.

## Out of scope

- Inferring fields from message text or error codes.
- OTLP: there is no OTLP ingest yet. When it lands, it can map an exception attribute to
  `fields`.
- Capturing response bodies in the SDKs.
- Failure alerts (issue #9), which may later reuse `likelyCauses`.

## Done when

The pinned demo journey's dead-letter and journey header show "Likely cause: `phone` lost
at transform-salesforce-account", reported by the delivery attempt's 422, and the tests
above pass in CI, including the manual demo and e2e jobs.
