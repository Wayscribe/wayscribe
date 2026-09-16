# Language-Neutral Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Each task is test-first. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Somebody who is not this repository can send events correctly: generated
JSON Schema for the wire shapes, an ingestion contract that states the routes,
limits, refusals and idempotency, a language-neutral SDK specification, a dry run
that validates without storing, and conformance fixtures any implementation can
run through it.

**Spec:** `docs/superpowers/specs/2026-09-15-language-neutral-contract-design.md`.
The spec is authoritative for behaviour; this plan fixes the order, the file
boundaries, and what each task must prove.

**Depends on:** nothing open. Everything here is name-independent. The propagation
spec (C4) and every OpenTelemetry item wait for the rename and are not in this
plan.

**Tech stack:** TypeScript, Node 24, Fastify, Knex, PostgreSQL 17 (15 is the
supported floor), Zod 4, Vitest; integration tests use Testcontainers through
`pnpm test:integration`.

**Conventions for every task:**

- Prefix commands with `export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"`; run from the repository root.
- Work on branch `contract-spec`.
- Before each commit: `pnpm format && pnpm lint && pnpm typecheck && pnpm test`. Tasks that touch the database or the API also run `pnpm test:integration`.
- `.ts` files need explicit return types; `noUncheckedIndexedAccess` is on; no non-null assertions (lint forbids them).
- Comments explain why, in the repository's existing voice. No em dashes in docs prose or CHANGELOG entries added by these tasks.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Stage only your own files.
- Do not introduce any identifier carrying the product name: no new header, queue attribute, environment variable, key prefix or metric name. Where an existing one has to be mentioned, mention the existing one.

---

## Task 1: The decision, and the documents it changes

**Files:** `docs/DECISIONS.md` (ADR-049), `AGENTS.md`, `docs/ROADMAP.md`,
`README.md` (ADR count), `CHANGELOG.md` (Unreleased).

Write ADR-049 as the spec's "The decision (C1)" section describes: context,
decision, the unknown-fields ruling, consequences, and the two rejected
alternatives. Make the two `AGENTS.md` edits exactly as the spec quotes them, and
the three `docs/ROADMAP.md` edits (two new Next items, two rewritten Later items).
Add a note to ADR-010's status line saying ADR-049 amends its wording on OTLP
ingestion and not its principle. Add the ADR-003 link where the ADR says
"language-neutral protocol design is still required".

The ADR names `docs/INGESTION_CONTRACT.md`, `docs/SDK_SPEC.md` and
`packages/protocol/conformance/` as inline code, not as markdown links, because
they arrive later in this branch.

Prove: `pnpm vitest run tests/docs-truth.test.ts` passes, which means the README
says 49 ADRs and the numbers still run without gaps. `git grep -n "Python, Go, Java"`
returns nothing outside `docs/superpowers/`.

## Task 2: JSON Schema, generated and checked

**Files:** `packages/protocol/src/json-schema.ts` and `json-schema.test.ts`
(create), `packages/protocol/scripts/write-schemas.mjs` (create),
`packages/protocol/schemas/0.1/*.schema.json` (generated),
`packages/protocol/fixtures/v0.1-boundaries.json` (create),
`packages/protocol/package.json` (the `schemas` script, the `./schemas/*` export,
`ajv` as a devDependency), `.prettierignore`, `pnpm-lock.yaml`.

Build, test-first:

- `buildJsonSchemas()` returning `event`, `envelope` for now, with the envelope
  composed rather than emitted: `protocolVersion` as `{ "const": "0.1" }` and
  `event` as `{ "$ref": "event.schema.json" }`. Each file's `$id` is its own
  basename. `title` and `description` on each, with no product name in either.
- The `\d` to `[0-9]` rewrite over generated `pattern` values, and a test that no
  generated pattern contains `\d`.
- `serializeSchema()`: `JSON.stringify(value, null, 2)` plus a trailing newline.
- The drift test: build in memory, serialize, compare byte for byte with the
  committed files, and fail with the exact command to regenerate.
- The parity test: `parseEnvelope` against Ajv 2020 (`strict: true`,
  `allErrors: true`, `validateFormats: false`) over the five existing fixtures and
  every case in `v0.1-boundaries.json`, requiring identical accept and reject, and
  requiring that a rejected case's expected code is `invalid_event` or
  `unsupported_protocol_version`.
- `v0.1-boundaries.json` covers, at least: 128 and 129 astral characters in `id`;
  a timestamp with Arabic-Indic digits, with a lowercase `t`, with a leap second,
  with an offset written without a colon, with no seconds, with a twenty-digit
  fraction, with `+02:00`, and with `-00:00`; `durationMs` at 2,147,483,647 and
  2,147,483,648 and written as `5.0`; a `processId` beyond the safe integer range;
  an unknown top-level field; `__proto__` in `aliases` and in `metadata`; an
  unsupported `protocolVersion`; a missing `event`; a `null` event; an event that
  is an array; an empty `error.message`; a non-string alias value.

Prove: the drift test fails when a committed file is edited by hand (do it, watch
it fail, restore it, and paste both in the task report); the parity test fails
when the envelope composition is replaced by the raw `z.toJSONSchema(envelopeSchema)`
output, because version 9.9 then validates; `pnpm format` leaves the generated
directory alone; `pnpm install --frozen-lockfile` still succeeds and the lockfile
diff is an importer entry rather than a new package version.

## Task 3: The ingestion shapes as schemas, and one batch constant

**Files:** `packages/protocol/src/ingestion.ts` and `ingestion.test.ts` (create),
`packages/protocol/src/index.ts`, `packages/protocol/src/json-schema.ts` (the
seven further files), `packages/protocol/schemas/0.1/` (regenerated),
`apps/api/src/routes/events.ts`, `apps/api/src/app.ts` (use the shared constant),
`apps/api/src/routes/events.integration.test.ts`.

Build, test-first:

- `MAX_BATCH_EVENTS = 100` in the protocol package, used by the route and by the
  body-limit calculation in `app.ts`, which each hold their own copy today.
- `batchRequestSchema`, `eventResultSchema`, `batchResponseSchema`,
  `eventAcceptedSchema`, `errorBodySchema`, `storedEventSchema`,
  `storedJourneySchema`, written to describe what the API already sends. The
  request schema types `events` as an array of at most `MAX_BATCH_EVENTS` items of
  any shape, with a description saying per-item validation is per event.
- Those seven schemas join the generated set.

Prove: a corpus test where the batch request schema, its generated JSON Schema
and the route agree on accept versus whole-request refusal for zero events, one
hundred events, one hundred and one events, a missing `events`, a non-array
`events`, a null body and an unknown extra field; and an integration test that
validates every response body the existing events integration tests receive
against the generated `batch-response` and `error-body` schemas. The route's
existing status codes and messages do not change: `invalid_event` for a body with
no events array, `payload_too_large` for more than one hundred.

## Task 4: A `__proto__` key survives parsing

**Files:** `packages/protocol/src/envelope.ts` (or a small helper beside it),
`packages/protocol/src/event.test.ts`, `packages/protocol/src/envelope.test.ts`,
`apps/api/src/routes/events.integration.test.ts`.

Zod's `z.record` assigns parsed keys onto a fresh object, so a `__proto__` key in
`aliases` or in `metadata` is spent on the prototype and vanishes; `input` and
`output` keep theirs because they are `z.unknown()`. That is the defect
`docs/WHAT_RUNNING_IT_FOUND.md` records, on the server side, and a conformance
case cannot be written until it is fixed.

Build: after a successful parse, restore own `__proto__` keys onto the parsed
`aliases` and `metadata` with `Object.defineProperty`, from the input object's own
properties, with a comment saying why. Do not change what is accepted.

Prove, test-first: a unit test that `parseEnvelope` keeps `__proto__` in both
records with the value the sender wrote, and that the parsed object's prototype is
untouched; an integration test that reads the row back out of PostgreSQL and finds
the key in `custom_metadata` and in the journey's aliases, paired with an
assertion that the neighbouring ordinary key is still there.

## Task 5: Dry-run validation

**Files:** `apps/api/src/routes/events.ts`, `apps/api/src/routes/present.ts` (the
event and journey presenters move here), `apps/api/src/routes/queries.ts` (use
them), `apps/api/src/ingestion/ingest-event.ts` (accept a transaction as its
`db`, if it does not already), `apps/api/src/routes/dry-run.integration.test.ts`
(create), `docs/DECISIONS.md` (ADR-050), `README.md` (ADR count), `CHANGELOG.md`.

Build per the spec's C6 section: the `dryRun` query parameter on the batch route
only, strictly `true` or `false` and given once; `400 invalid_query` for anything
else and for the parameter on the single-event route; one outer transaction with
a savepoint per event, rolled back on every path; results identical in shape to a
real batch, `200` with `data.dryRun: true`; `stored.event` and `stored.journey`
read inside the transaction through the same repository functions and presenters
the read routes use, `receivedAt` omitted, `stored` absent for a duplicate or a
rejection; `last_used_at` and the verifier migration happen as for a real send;
dry-run events are not counted in the events metric; one info log line per
request with the request id, the key's row id and the counts.

ADR-050 records the rolled-back-real-ingestion decision, the alternatives (a
separate validation path, per-event isolation without an outer transaction) and
why they were refused, the bookkeeping decision, the row locks held for the length
of a batch, and the no-trace probe in "Security consequences".

Prove: every item in the spec's "Tests" list under C6, as integration tests
against PostgreSQL. In particular the dry run's results must be compared with the
results of the *same* batch sent for real in the same test, event by event, rather
than with a list written by hand.

## Task 6: The conformance harness and the wire cases

**Files:** `packages/protocol/src/conformance.ts` and `conformance.test.ts`
(create), `packages/protocol/package.json` (the `./conformance` export),
`vitest.config.ts` (the alias, beside the `payload-security/redaction` one),
`packages/protocol/conformance/wire/*.json` (create),
`apps/api/src/routes/conformance.integration.test.ts` (create),
`apps/api/Dockerfile`, `scripts/verify-image-contents.sh`, `.gitleaks.toml`.

Build:

- The loader, the `{{run}}` substitution, the builder expansion (`$string`,
  `$array`, `$nest`), the host-value tags, the matchers (`$matches`, `$absent`)
  and the subset-at-the-top, exact-underneath comparison, with unit tests of their
  own, including that a listed nested key set must match exactly so a dropped
  field fails.
- A validation schema for a case file, and a test that every committed case
  matches it, so a typo in a case is a failing test rather than a silently skipped
  expectation.
- The wire cases, all twenty-seven groups in the spec's list. Fake credentials
  carry the marker `cfx-fake`; add one value-shaped allowance to `.gitleaks.toml`
  in the style of the existing entries, never a path allowance.
- The API integration test running every wire case twice, for real and through the
  dry run, against a fresh project with the environments the cases name.
- Prune `packages/protocol/conformance` from the runtime image in
  `apps/api/Dockerfile`, and assert its absence in `scripts/verify-image-contents.sh`.

Write each expectation from the documents before running it, as the spec's
"Expected values are written, not captured" section requires. Where a run
disagrees with an expectation, decide which is wrong and say so in the task
report; if the code is wrong, fix it in this task only when the fix is small and
clearly a defect, and otherwise stop and report.

Prove: every case passes through both paths; the case-file schema test fails on a
malformed case (make one, watch it fail, restore it); the image check fails
against an image built without the prune, reported in the task report as ADR-043
requires; `gitleaks` is satisfied, run locally through its container image if
Docker is available and otherwise confirmed in CI before the branch is finished.

## Task 7: The SDK conformance cases

**Files:** `packages/protocol/conformance/sdk/*.json` (create),
`packages/sdk-node/src/conformance.test.ts` (create),
`apps/api/src/routes/sdk-conformance.integration.test.ts` (create).

Build the fifteen SDK case groups in the spec's list. The unit test drives the
real recorder against a stub endpoint, captures the request body and compares it
with `expect.wire`. The integration test takes the captured body and sends it to
the dry run, comparing `expect.results[].stored`, which is the procedure a second
SDK in another language will follow.

Prove: every applicable case passes; a case marked for Node only is skipped with a
reported reason on a harness that cannot build its value; the `nul-byte` and
`lone-surrogate` cases show the SDK repairing what the wire cases show the server
refusing, so the pair documents both halves.

## Task 8: `docs/INGESTION_CONTRACT.md`

**Files:** `docs/INGESTION_CONTRACT.md` (create), `docs/API_SPEC.md` (sections 3
and 4 reduced to a summary and a link), `docs/EVENT_PROTOCOL.md` (a pointer from
section 12 to the refusal table), `packages/protocol/src/errors.ts` (the registry
of code, status and whether it is transient), `tests/docs-truth.test.ts`,
`README.md`, `CHANGELOG.md`.

Write the document as the spec's C3 section lists it, in order: routes and
authentication, transport refusals, limits with their configuration names and
defaults, the per-event refusal table with the retry rule, the two 409s,
idempotency and the keyed content hash with the rotation consequence, what the
server does to an accepted event, the dry run, and the conformance case format.

Prove, in `tests/docs-truth.test.ts`: the limits table's numbers equal
`MAX_BATCH_EVENTS`, `DEFAULT_LIMITS` and the `MAX_EVENT_PAYLOAD_BYTES` default in
`packages/config`; the refusal table's rows equal the registry in `errors.ts`,
including the status and the transient flag; `API_SPEC.md` no longer documents the
ingestion routes in full; and every code the registry marks transient is a 5xx.

## Task 9: `docs/SDK_SPEC.md` and the Node appendix

**Files:** `docs/SDK_SPEC.md` (create), `docs/NODE_SDK_SPEC.md` (becomes the
appendix), `packages/sdk-node/README.md` (a link to both), `README.md`,
`CHANGELOG.md`, `docs/TESTING_STRATEGY.md` (the conformance suites).

Write the thirteen sections in the spec's C5 list, with RFC 2119 wording, a stable
identifier for every requirement, and a source column naming the ADR, the security
document section, or the Node specification section each one comes from. Move what
the spec says moves; leave what it says stays; reconcile the appendix with what is
actually built (batch size 50, drop-oldest only, `maxConcurrentSends`,
`logDiagnostics`, `onDiagnostic`, `propagate`).

Say nothing about header names, queue attribute names or environment variable
names: section 10 states only the level rules, the alias rule, the entity-id rule
and the `traceparent` rule, and refers to the propagation spec as pending.

Copy the eleven built-in secret names into section 5, and add the docs-truth
check that the list in the document equals `DEFAULT_SECRET_PATHS`.

Prove: every MUST and SHOULD in `docs/SDK_SPEC.md` has a source; the built-in
name check fails when a name is added to the code and not to the document; every
requirement that the conformance fixtures check names its case, and every one they
cannot check appears in section 13; a reader following section 7 alone can
implement the retry rule, which is checked by comparing it line by line with
`packages/sdk-node/src/transport.ts` and `recorder.ts` in the task report.

## Task 10: The whole branch, on a real stack and in real CI

No new files unless a defect is found.

- From a clean clone of the branch: `pnpm install --frozen-lockfile`, `pnpm format:check`,
  `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`.
- Bring up the demo stack, trigger a journey, and send one conformance batch
  through the dry run against it with `curl`, pasting the request and the response
  into the task report. Confirm with `psql` that the dry run added no rows.
- Push the branch and read the pipeline: `format`, `lint`, `typecheck`, `unit`,
  `database`, `secrets`, `audit`, `debt`. The container jobs run on the default
  branch only, so build the API image locally and run
  `scripts/verify-image-contents.sh` against it, pasting the output, since Task 6
  changed what the image is allowed to carry.
- Re-read `docs/INGESTION_CONTRACT.md` and `docs/SDK_SPEC.md` against the code one
  last time, looking for a sentence that was true when it was written and is not
  true now.

Prove: green locally and in the pipeline, with the output in the task report, and
a written statement of anything the run found that the documents got wrong.
