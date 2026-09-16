# Dogfood gaps: plan

Design: [`../specs/2026-09-16-dogfood-gaps-design.md`](../specs/2026-09-16-dogfood-gaps-design.md).

Each task is test-first: write the failing test, watch it fail for the right
reason, implement, run the package's tests and the repository gate
(`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`), self-review
the diff, commit. Integration tests run at the end of tasks that touch the API
or the database. Every task that changes wire or SDK behaviour updates the
contract, `SDK_SPEC.md`, the schemas (`pnpm --filter @flight-recorder/protocol
run schemas`), the conformance cases and the manifest (`pnpm --filter
@flight-recorder/protocol run conformance:manifest`) in the same commit.

No identifier carries the product name. No em dashes in docs or the CHANGELOG.

## Task 1: payload limits agree by construction

Files: `packages/payload-security/src/limits.ts`, `truncate.ts` (new),
`redaction.ts`, `index.ts`; `apps/api/src/ingestion/ingest-event.ts`;
`packages/sdk-node/src/recorder.ts`, `diagnostics.ts`, `config.ts`;
`packages/protocol/conformance/sdk/*`; `docs/INGESTION_CONTRACT.md`,
`docs/SDK_SPEC.md`, `docs/NODE_SDK_SPEC.md`, `docs/DECISIONS.md` (ADR-051),
`README.md` (ADR count), `packages/sdk-node/README.md`, `CHANGELOG.md`.

1. `truncate.test.ts`: `truncateText` leaves short text alone; cuts to exactly
   `max` with the marker; the count is right when the marker's own digits
   change it; a split surrogate pair is repaired; `truncateStrings` walks arrays
   and plain objects, keeps a `__proto__` key, returns the same reference when
   nothing is cut, and reports strings and characters removed.
2. `limits.test.ts`: `eventLimits` is `DEFAULT_LIMITS` with the byte budget;
   `payloadLimits` has depth 30 and measures long strings as truncated;
   `truncateStringsTo` makes a long string pass the structural check and counts
   its truncated bytes.
3. `recorder` tests (`payload-fit.test.ts`): a 70,000 character string is cut
   and reported as `payload_truncated`; two payloads over the budget together
   lose the larger; metadata is dropped last; a payload 31 levels deep is
   omitted; counters stay separate and `sent + rejected + dropped` still equals
   recorded.
4. `apps/api/src/ingestion/limits-agreement.test.ts`: hostile inputs through the
   real recorder, every captured envelope through `ingestEvent`, none refused by
   a limit.
5. Conformance: `sdk/long-string-truncated`, `sdk/event-over-budget`,
   `sdk/truncated-then-omitted`, `sdk/too-deep-payload`; manifest.
6. Implement; update docs, ADR-051, CHANGELOG.

## Task 2: projections on the wrappers

Files: `packages/sdk-node/src/recorder.ts`, `index.ts`;
`packages/protocol/src/conformance.ts` (two host tags);
`packages/protocol/conformance/sdk/*`; `docs/INGESTION_CONTRACT.md` (tags),
`docs/SDK_SPEC.md`, `docs/NODE_SDK_SPEC.md`, SDK README, CHANGELOG.

1. `projection.test.ts`: `captureOutput` records the projection and returns the
   real value (a `Buffer`), sync and async; `captureInput` sees the input before
   the callback mutates it; a throwing projection records `[UNCAPTURABLE]` and a
   `payload_omitted` with `projection_failed`, and the host's value and error are
   unchanged; a thenable projection is treated as a failure without an unhandled
   rejection; the types keep the callback's return type (a `expectTypeOf` check).
2. Conformance tags `$projection` and `$throwingProjection`, with tests in
   `conformance.test.ts`; cases `sdk/projected-output` and
   `sdk/projection-throws`.
3. Implement; docs.

## Task 3: one operation across journeys

Files: `packages/sdk-node/src/recorder.ts`, `index.ts`, conformance harness;
`packages/protocol/src/conformance.ts` (`journeys` on a call); a case; docs.

1. `across.test.ts`: one event per journey with distinct ids and shared
   timestamp and duration; the callback runs once; errors rethrown and recorded
   on every journey; duplicates by journey id recorded once; an empty group
   records nothing; `record`, `fail`, `finish` fan out; projections receive each
   journey's context; sync stays sync.
2. Case `sdk/across-journeys`; harness support; manifest.
3. Implement; docs.

## Task 4: deterministic journey ids

Files: `packages/sdk-node/src/journey-id.ts` (new), `config.ts`, `recorder.ts`,
`diagnostics.ts`, `index.ts`; `packages/protocol/fixtures/journey-id-derivation.json`;
`docs/SDK_SPEC.md`, `docs/DECISIONS.md` (ADR-053), READMEs, CHANGELOG.

1. `journey-id.test.ts`: every vector in the fixture reproduces; the id matches
   the propagation grammar and survives `extractHttpContext`; environment, type
   and id each change the result; a short or missing secret reports
   `configuration_error` (once at creation for a short one, per call otherwise)
   and returns a random id; nothing throws.
2. Generate the vectors with an independent computation in the test file
   (Node's `crypto` directly), then implement.
3. Docs, including why an unkeyed hash is unsafe and what rotation does.

## Task 5: displayable aliases

Files: `packages/protocol/src/event.ts`, `envelope.ts`, `ingestion.ts`, schemas;
`packages/database/migrations/017_alias_displayable.js`,
`src/repositories/aliases.ts`, `journey-reads.ts`, `rotation.ts`;
`apps/api/src/ingestion/ingest-event.ts`, `routes/present.ts`;
`packages/sdk-node/src/recorder.ts`; `apps/web` journey page and types;
conformance; `docs/INGESTION_CONTRACT.md`, `EVENT_PROTOCOL.md`, `API_SPEC.md`,
`DATABASE_SCHEMA.md`, `SECURITY.md`, `SDK_SPEC.md`, `DECISIONS.md` (ADR-052),
CHANGELOG.

1. Protocol tests: the field is optional, bounded, and a `__proto__` entry is
   harmless; schema drift test regenerates.
2. Database integration: the column exists with default false; an insert without
   the flag stores false; the conjunction holds in both orders; a repeat that
   does not lower the flag writes nothing; rotation keeps and folds the flag.
3. Presenter unit test: a displayable alias is shown in full, others masked.
4. Wire cases `wire/displayable-alias`,
   `wire/displayable-alias-every-statement`; `sdk/identify-displayable`;
   existing identify cases gain `displayable: false`.
5. SDK tests for the three entry points.
6. Web: the journey page marks masked values; component test.
7. Migration run through the upgrade test script.

## Task 6: timeline rows lead with the step name

Files: `apps/web/app/components/TimelineList.tsx`, `globals.css`,
`JourneyTimeline.test.tsx`, `apps/web/e2e/journey.spec.ts`, `docs/images/*`.

1. Component test: the row's first label is the name, the operation and
   service are still present, an empty name falls back to the operation.
2. Implement; update Playwright; regenerate screenshots on the live stack.

## Task 7: `since` on the recent list

Files: `apps/api/src/routes/recent-query.ts` and tests, `docs/API_SPEC.md`.

1. The refusal names the format; the route line and the heading say the list
   is windowed and `since` is required.

## Task 8: installing the unpublished SDK

Files: `packages/sdk-node/README.md`, `README.md`.

## Task 9: verification

The full gate, integration tests, gitleaks, the upgrade test, a live stack
under its own Compose project name on free ports, an SDK script exercising every
new option against it and reading the results back, Playwright screenshots of a
long journey and of a journey with one displayable and one masked alias, and
`pnpm test:e2e` against that stack. Then `down -v`.
