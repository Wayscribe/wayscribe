# Node SDK public API before the first release: design

Source: the API review at
`~/workspace/leadline/docs/reference/sdk-api-review-2026-09-16.md`, written
against main `4a68a1e`. Main is now `56a199b`, which adds the secret-name
warning (ADR-055: kind `unredacted_secret_name`, counter
`unredactedSecretNames`, option `knownSafeNames`, SDK-61, SDK-62); those are
part of the consistency pass below.

The owner decided the scope:

- Every **must** item except M7, the product rename (header, queue attribute
  and payload envelope names, the `_flight` key, the `[flight-recorder]` print
  prefix, the `fr_` key prefix, the package name and repository fields). That
  waits for the name decision. Nothing that carries the product name is
  renamed here. The propagation helpers are marked experimental, as M7 asks.
- Every **should** item.
- The experimental markers and the Stability section.
- The docs parity list, except the README's relative links, which change with
  the repository URL at the rename.
- The SDK conformance suite reports no skipped tests.

The wire format does not change. The recorder is unpublished; the owner's
job-radar and the Leadline build use it from a tarball, so the CHANGELOG lists
every rename they have to follow.

## 1. Changes, before and after

### Recorder

| Before | After | Item |
| --- | --- | --- |
| `continueJourney(context: JourneyContext)` | `continueJourney(options: ContinueJourneyOptions)`; `{ journeyId, entity }` still works, because it is the same object | M1 |
| `consume({ context, entityFallback })` | `continueJourney({ context, entity, label })` | M1 |
| `diagnostics(): Counters` | `counters(): Counters` | M2 |
| `toQueueAttributes(context)` | `injectSqsAttributes(attributes, context)`, merged like the HTTP helper | M6 |
| `fromQueueAttributes(attributes)` | `extractSqsContext(attributes)` | M6 |
| `wrapPayload(payload, context)` | `injectPayload(payload, context): ContextEnvelope<T>` | M6 |
| `unwrapPayload(body)` | `extractPayload(body): ExtractedPayload` | M6 |
| `extractHttpContext(Record<string, string \| string[] \| undefined> \| undefined)` | also accepts a fetch `Headers` and numeric values (`HttpHeadersInput`) | S9 |
| `startJourney({ entity, aliases, displayable, label })` | `startJourney({ entity, aliases, displayableAliases, label })` | M9 |
| `shutdown(options?: { timeoutMs?: number })` | `shutdown(options?: ShutdownOptions)`, same shape | S2 |

`ContinueJourneyOptions` is `{ context?, journeyId?, entity?, label? }`. The
journey id is the context's, else `journeyId`, else a new random one. The
entity is the context's, else `entity`, else `{ type: "unknown", id: "unknown"
}`, as `consume` did. `label` is applied as `startJourney` applies it. The
options are read inside the failure boundary, one at a time; a journey id that
is not a non-empty string is reported as `configuration_error`
(`journey_id_invalid`) and replaced by a random one.

### Journey and group

| Before | After | Item |
| --- | --- | --- |
| `fail(name, error, metadata?)` | `fail(name, error, options?: FailOptions)`, `{ metadata? }` | M8 |
| `identify(aliases, { displayable })` | `identify(aliases, { displayableAliases })` | M9 |
| `finish(options?: { status? })` | `finish(options?: FinishOptions)`, same shape | S2 |
| wrapper overload `fn: () => Promise<T>` returning `Promise<T>` | `fn: () => PromiseLike<T>` returning `Promise<Awaited<T>>`; `isFailure` and `captureOutput` receive `Awaited<T>` | S4 |
| `WrapOptions<T>`, `captureInput(input: unknown, ...)` | `WrapOptions<T, I = unknown>`, `captureInput(input: I, ...)`, `I` inferred from the wrapper's input | S4 |
| `record({ error: { message, type?, code? } })` | `error: ErrorInput`, which adds `stack?` | S5 |

A thenable that is not a native promise now comes back as a native promise
(`Promise.resolve(thenable).then(...)`), which is what the type says. A native
promise is handled exactly as before.

### Configuration

| Before | After | Item |
| --- | --- | --- |
| `maxPayloadBytes` | `maxEventBytes` | S7 |
| `propagate` | `propagation` | S7 |
| four options with a JSDoc default | every option has `@defaultValue` | S7 |
| optional options typed `?: T` | `?: T \| undefined` on every input type | S3 |

### Diagnostics

| Before | After | Item |
| --- | --- | --- |
| `{ kind, reason, detail? }` | `{ kind, code, reason, detail }` on every diagnostic; `reason` is prose that may change in any release | M3 |
| `FailureDiagnostic` for nine kinds, `detail?: unknown` | one interface per kind, `detail` typed and always present | M4 |
| `breaker_open` | `breaker_opened` (and its printed line) | M5 |
| `delivered_first` with `endpoint`, `accepted` at the top level | `detail: { endpoint, accepted }` | M4 |
| `insecure_endpoint` with `scheme`, `host` at the top level | `detail: { scheme, host }` | M4 |
| `payload_omitted` `detail.reason` | `code` | M3 |
| `dropped` reasons `queue_full`, `no_verdict: ...`, `shutdown: ...` | codes `queue_full`, `no_verdict`, `shutdown`, `after_shutdown`, `retry_budget`; prose reasons | M3 |
| `rejected` `detail` = the server's error body | `detail.serverError` | M4 |
| whole-request `rejected` `detail: { permanent, events }` | code `request_refused`, `detail: { events, httpStatus }` | M4 |
| `capture_error`, `transport_error` `detail` = the thrown value | `detail.error` | M4 |
| `keysDropped` counts keys | counts `key_dropped` reports, like every other counter; `detail.keys` still counts keys | S6 |
| no `recorded` counter | `recorded`; `sent + rejected + dropped === recorded` once shutdown returns | S6 |
| `FailureDiagnostic`, `FailureKind` exported | removed; the per-kind interfaces replace them | M4 |

The codes, per kind:

| Kind | Codes | `detail` |
| --- | --- | --- |
| `delivered_first` | `first_delivery` | `{ endpoint, accepted }` |
| `insecure_endpoint` | `unencrypted_endpoint` | `{ scheme, host }` |
| `rejected` | `event_refused`, `request_refused` | `{ serverError?, events?, httpStatus? }` |
| `transport_error` | `request_failed`, `refused_for_now`, `unexpected_error` | `{ unsent?, abandoned?, error? }` |
| `payload_omitted` | `too_large`, `too_deep`, `too_wide`, `string_too_long`, `unserialisable`, `projection_failed` | `{ field, error? }` |
| `payload_truncated` | `strings_cut`, `label_cut` | `{ field, strings, charactersRemoved }` |
| `key_dropped` | `aliases_not_object`, `alias_invalid`, `displayable_alias_invalid`, `metadata_key_too_long`, `label_invalid` | `{ field, keys }` |
| `dropped` | `queue_full`, `after_shutdown`, `shutdown`, `retry_budget`, `no_verdict` | `{ name?, operation? }` (set for `after_shutdown`) |
| `capture_error` | `unexpected_error`, `not_a_journey` | `{ error? }` |
| `configuration_error` | `setting_unusable`, `required_setting_unusable`, `journey_id_secret_missing`, `journey_id_secret_unusable`, `entity_invalid`, `journey_id_invalid` | `{ setting? }` |
| `breaker_opened` | `consecutive_failures` | `{ failures, cooldownMs }` |
| `unredacted_secret_name` | `secret_like_name` | `{ field, name, path }` |

`DiagnosticKind` stays a closed union so a `switch` narrows. The README says
new kinds and codes may arrive in any minor release, and its example has a
`default` branch.

Codes are the Node SDK's API, not part of the language-neutral contract: the
conformance cases keep comparing kinds and details, not codes.

### Types

Exported and named: `Entity`, `StartJourneyOptions`, `ContinueJourneyOptions`,
`IdentifyOptions`, `FailOptions`, `FinishOptions`, `ShutdownOptions`,
`WrapOptions`, `RecordInput`, `ErrorInput`, `CaptureMode`, `HttpHeadersInput`,
`SqsMessageAttributes`, `SqsMessageAttributeValue`, `ContextEnvelope`,
`ExtractedPayload`, `DiagnosticCode`, and one interface per diagnostic kind.
`TraceContext` is no longer exported (M11).

### Package

| Before | After | Item |
| --- | --- | --- |
| `engines.node` `>=20.19.0` | `>=22.12.0`; the bundle targets `node22` | M10 |
| 13 `.d.ts` and 14 `.d.ts.map` files in `dist` | one rolled-up `dist/index.d.ts` (API Extractor), no maps | S1 |
| `exports` has `.` | also `./package.json` | S8 |
| packed manifest keeps `devDependencies` and `scripts` | stripped by the release pack script | S8 |

No API report is checked in, although the review suggested one: the demo
image builds this package from a Docker context that excludes markdown, where
API Extractor fails a build whose report is missing. API Extractor still fails
the build when a public type refers to one that is not exported. A report can
follow with a check of its own.

Node 20 reached end of life in April 2026, and `require()` of an ES module is
unflagged from 22.12, so `>=22.12.0` is the one honest floor.

### Stability markers

`@experimental` in JSDoc, and a README Stability section, on: `across` and
`JourneyGroup`; `captureInput` and `captureOutput`; `journeyIdFor` and
`journeyIdSecret`; the six propagation helpers, `PropagationLevel`,
`propagation` and the envelope and attribute types; `label` (the method and
the option); `maxConcurrentSends`; and the `Counters` fields, which may grow.

## 2. Docs parity

- `NODE_SDK_SPEC.md`: section 4 rewritten against the real API (`flush`,
  `shutdown({ timeoutMs })` with its 2,000 ms default, `counters`, the payload
  helpers, `OPERATIONS`, `label` on `startJourney`, `record`'s `startedAt` and
  `durationMs` and `error.stack`); callbacks take no argument, so the
  `publish` and `deliver` examples stop reading `context.queueAttributes`;
  `JourneyContext` loses the `parentEventId` and `traceparent` it never had;
  trace flags are not captured; envelope propagation is always available, not
  "explicitly enabled"; the supported Node versions follow `engines`.
- The SDK README: the Stability section, a code column in the diagnostics
  table and advice to match on `code`, `flush()`, the payload helpers, an
  `extractHttpContext` consumer example, `OPERATIONS`, the option and type
  names, the Requirements section. The relative links stay until the rename.
- `SDK_SPEC.md`: the defaults check follows `maxEventBytes`; SDK-42's counter
  list already names `recorded`.
- `INGESTION_CONTRACT.md` section 9: a `fail` call's args are `error` and
  `options`; the conformance cases use `maxEventBytes` and
  `displayableAliases`.
- `OPERATIONS.md`: `maxEventBytes`.
- ADR-056 records the surface decisions; the root README's ADR count follows.
- CHANGELOG, Unreleased, one Changed entry with every rename.

## 3. Conformance suite

`packages/sdk-node/src/conformance.test.ts` registered "reports the expected
diagnostics" and "puts none of the listed text in any diagnostic" for every
case with `it.runIf`, so 72 were reported as skipped. They are registered only
for cases that carry the expectation. The API's SDK conformance file registers
one unconditional test per applicable case and needs no change.

## 4. Verification

`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm
test:integration`, gitleaks, the bundle test, `pnpm test:demo` and `pnpm
test:e2e` against a stack of this worktree, and the packed tarball installed
with npm in an empty directory, imported, and type-checked against a file that
uses every public entry point with `strict` and `exactOptionalPropertyTypes`,
under `node10`, `node16` and `bundler` module resolution, where no internal
path may be importable.
