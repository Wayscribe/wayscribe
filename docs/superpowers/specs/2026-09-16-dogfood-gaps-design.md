# Dogfood gaps: design

Instrumenting job-radar, a Node job run by launchd, turned up seven gaps. Its
instrumentation (`job-radar/src/recording/`) works around each of them: it fits
events to the server's limits itself (`payload.js`), wraps steps by hand to
project a PDF buffer (`runStep`), loops over journeys for one digest write
(`deliver`), derives journey ids with an unkeyed SHA-256 (`journeyIdFor`), and
vendors a packed tarball of the SDK. This design removes the need for all of
that except the tarball, which it documents.

The owner decided four things before this was written: truncate then omit (1),
a keyed helper for journey ids (4), opt-in display per alias (6b), and the
questions left open in 7. Everything else below is decided here, with the
reason beside it.

## 1. Payload limits agree by construction

### The defect

The SDK measured each payload on its own against `maxPayloadBytes`, and raised
its string limit to the same number. The API measures the whole envelope with
`DEFAULT_LIMITS` (strings at 65,536 UTF-16 code units, depth 32 from the
envelope's root, 1,000 keys) and `MAX_EVENT_PAYLOAD_BYTES`. So a 70,000
character string, two 200 KB payloads on one event, or a payload 31 levels deep
passed the SDK and was refused by the API, and a refused event is lost whole.

### Decision

The limits live in one place. `packages/payload-security` exports:

- `eventLimits(maxEventBytes)`: what ingestion applies to one envelope. The API's
  `ingestEvent` calls `checkLimits(body, eventLimits(maxPayloadBytes))`, so the
  API's check is this function and nothing else.
- `payloadLimits(maxEventBytes)`: the same limits as they fall on a payload,
  which sits two levels below the envelope's root (`envelope.event.input`), so
  its depth budget is 30; strings are measured as they will be after
  truncation.
- `truncateText(text, max)` and `truncateStrings(value, max)`: the cut.

`checkLimits` gains one optional field, `truncateStringsTo`. When it is set, a
long string is not a violation, and the byte measurement counts it as
`truncateText` will leave it. That keeps one checker rather than adding a
second measurement.

The SDK's capture, per payload (`input`, `output`, `metadata`):

1. `checkLimits(value, payloadLimits(maxPayloadBytes))`. A failure omits the
   payload, as today. This is also the guard that keeps a host from spending CPU
   redacting a payload that can never be sent.
2. `toStorable(redact(value))`, as today.
3. `truncateStrings(result, 65,536)`.

Then, per event, the SDK builds the envelope and runs
`checkLimits(envelope, eventLimits(maxPayloadBytes))`, the exact call ingestion
makes. While it fails and a payload remains, the larger of `input` and `output`
is replaced with `[PAYLOAD_TOO_LARGE]`, then `metadata` is dropped (the protocol
types it as a record, so a marker string would refuse the event). An envelope
that still fails after that has a problem no payload caused (a thousand aliases,
say); it is sent, and the server's refusal is counted as `rejected`. **The event
is always sent.**

Truncating after redaction rather than before is deliberate. The masked string
is cut, so a cut cannot expose anything masking had hidden: a prefix of a
masked string holds nothing the whole did not. The only thing a cut can change
is how the server's own pass reads a header block whose value was cut short,
and that pass can only mask more.

`maxPayloadBytes` now means the byte budget of **one event**, and should equal
the server's `MAX_EVENT_PAYLOAD_BYTES`. The default is unchanged (262,144). The
old reading, "one payload", was the defect: raising it above the server's limit
produced events the server refused. The string limit is no longer scaled with
it, because the server never scaled its own. Recorded as ADR-051.

### Per string, not per payload

Truncation happens to each string on its own. The server's limit is per
string, so cutting only the strings that break it is the smallest change that
makes the event acceptable. The case that found this, an evidence corpus of
49,000 characters and a job description written as an essay, is one long field
among many short ones; cutting per payload would need a rule for which of the
short fields to sacrifice, and the diff on every other field keeps working
when only the long one is cut.

### The marker

```text
[TRUNCATED: 4500 characters removed]
```

The kept prefix and the marker together are exactly 65,536 code units, so a cut
string keeps as much as the server allows. "Characters" are UTF-16 code units,
the unit the limit counts; the README and the contract say so. A surrogate pair
split by the cut is repaired to U+FFFD, which is one code unit, so the length
does not move.

Why this text: it belongs to the family of markers the SDK already writes
(`[REDACTED]`, `[PAYLOAD_TOO_LARGE]`, `[UNCAPTURABLE]`, and `[TRUNCATED]` on
error text); it says how much is missing, which is the question a reader of a
cut payload asks next; and it names no product, which is being renamed.

### Diagnostics and counters

A new diagnostic kind, `payload_truncated`, and a counter, `payloadsTruncated`:
one per payload that was sent with at least one string cut. Its detail is
`{ field, strings, charactersRemoved }`. `payload_omitted` gains `field` in its
detail. A payload that was cut and then omitted anyway is reported as omitted
only, because nothing cut reached the server. Neither counter is part of
`sent + rejected + dropped = recorded`: the event is sent either way.

A string under a redaction path is masked before the cut, so it is never
reported as truncated.

### Conformance

- `sdk/long-string-truncated`: a 70,000 character string arrives as 65,500
  characters and `[TRUNCATED: 4500 characters removed]`, and the server stores
  it.
- `sdk/event-over-budget`: two payloads, each under the budget, together over
  it. The larger is omitted and the other arrives whole.
- `sdk/truncated-then-omitted`: five 70,000 character strings; cut, still over
  the budget, omitted.
- `sdk/too-deep-payload`: a payload 31 levels deep is omitted rather than sent
  and refused.
- `sdk/oversize-payload` keeps its meaning under the new reading of the budget.

And a unit test in `apps/api` drives the real recorder over a set of hostile
inputs (strings at and around the limit, astral characters at the cut, depth
and width at the boundary, several payloads near the budget), takes the
envelopes it sent, and runs each through `ingestEvent`'s limit check. Every one
must pass. That is the test that runs the same inputs through both.

## 2. Wrappers project what they capture

`WrapOptions` becomes generic in the callback's result and gains two options:

```typescript
interface WrapOptions<T = unknown> {
  isFailure?: (result: T) => boolean;
  attempt?: number;
  metadata?: Record<string, unknown>;
  captureInput?: (input: unknown, journey: JourneyContext) => unknown;
  captureOutput?: (result: T, journey: JourneyContext) => unknown;
}
```

The callback still receives nothing and the wrapper still returns the
callback's own value, so `deliver("render", job, () => renderPdf(job), {
captureOutput: (pdf) => ({ bytes: pdf.length }) })` returns the `Buffer`, typed
as one. `T` is inferred from the callback, so `captureOutput` and `isFailure`
see the resolved value, not the promise.

`captureInput` runs when the wrapper is called, before the callback, so it sees
the input as it went in. `captureOutput` runs when the callback has returned or
resolved. The journey context is the second argument so that a projection used
across several journeys (section 3) can give each its own view.

A projection that throws, or returns a thenable, records `[UNCAPTURABLE]` in
place of that payload and reports `payload_omitted` with reason
`projection_failed`. A returned thenable gets a no-op rejection handler, so it
cannot become an unhandled rejection. The host's call and return value are
untouched in every case.

Conformance: two host tags, `$projection` (a function returning the value at a
JSON pointer into its argument) and `$throwingProjection` (a function that
throws), let a case pass projections. `sdk/projected-output` and
`sdk/projection-throws`.

## 3. One operation, many journeys

```typescript
const group = recorder.across(journeys);
await group.persist("write-digest", digest, () => writeDigest(digest), {
  captureInput: (_digest, journey) => digestLineFor(journey.journeyId)
});
```

`across(journeys)` returns a `JourneyGroup` with `record`, `transform`,
`persist`, `publish`, `deliver`, `fail` and `finish`. Each call records one
event per journey, each with its own event id, all with the same `startedAt` and
`durationMs`, and runs the callback once. The wrappers keep every guarantee of
the single-journey ones (value unchanged, exact error rethrown, synchronous stays
synchronous).

Decisions:

- **A group, not a list argument on every method.** The single-journey methods
  keep their signatures, and a host that already holds a list of journeys writes
  one extra call.
- **No `identify`.** An alias identifies one record; stating it on many
  journeys is the mistake the method would make easy.
- **Duplicates by journey id are recorded once.** A digest that mentions one
  record twice is still one write for that record.
- **An empty group runs the callback and records nothing.**
- The SDK only. Nothing on the wire changes: the server receives ordinary
  events.

Conformance: a call may carry `"journeys": n`, which the harness reads as "on a
group of n journeys". `sdk/across-journeys`.

## 4. Deterministic journey ids

```typescript
const recorder = createRecorder({ ..., journeyIdSecret: process.env.JOURNEY_ID_SECRET });
const journey = recorder.continueJourney({
  journeyId: recorder.journeyIdFor(entity),
  entity
});
```

The option is named by role, `journeyIdSecret`, and the SDK reads no
environment variable (SDK-50); the example's variable name belongs to the host.

### Derivation

```text
key     = UTF-8 bytes of journeyIdSecret, at least 32 bytes
message = field("journey-id/v1") || field(environment) || field(entity.type) || field(entity.id)
field(s) = 4-byte big-endian length of UTF-8(s) || UTF-8(s)
id      = "jrn_" || lowercase hex of the first 16 bytes of HMAC-SHA256(key, message)
```

Length prefixes rather than a separator, because an entity id may contain any
character and another language must reproduce the bytes exactly. The
environment is in the message because ingestion refuses an event from one
environment into another's journey (ADR-038); without it, the same record in
staging and production would collide. The label versions the derivation. 128
bits of output is far past collision risk at any volume this product records,
and the id is 36 characters, within the protocol's 128. The result
satisfies the grammar propagation extraction accepts: the prefix, `[0-9a-f]`,
well under 256 characters.

Test vectors are in `packages/protocol/fixtures/journey-id-derivation.json`,
with the secret, environment, entity and expected id, including a non-ASCII id
and an id containing the separator a naive encoding would use. The SDK test reproduces every vector; another SDK
does the same.

### Why keyed

An unkeyed hash of the entity is predictable by anybody who knows the entity
and the scheme, and a predictable journey id is the squatting risk the contract
documents (`INGESTION_CONTRACT.md` section 5): a key from another environment,
or a forged propagated context, can claim or append to the journey first. The
secret makes the id as unguessable as a random one to anybody who does not hold
it. Rotating the secret starts new journeys for every entity; old journeys are
kept, and nothing links them.

### Without a secret

A missing secret, or one shorter than 32 bytes, is a programming error, but it
reaches the SDK as a configuration value that is often read from the deploy
environment, so from the host's side it arrives at run time. Throwing at
`createRecorder` breaks startup, which SDK-6 forbids; throwing from
`journeyIdFor` breaks the host's code path, which SDK-1 forbids (ADR-007).

So: a short secret is reported once at `createRecorder` as a new diagnostic
kind, `configuration_error`, counted in `configurationErrors`. A call to
`journeyIdFor` without a usable secret reports `configuration_error` and
returns a fresh random journey id, so recording continues and nothing
predictable is ever produced. The failure is loud in the only ways the SDK is
allowed to be loud: a counter that is not zero, a distinct kind for
`onDiagnostic`, and a line under `logDiagnostics`. A host's own test catches it
on the first run by asserting `configurationErrors` is zero. An entity that is
not a string pair is the same error.

Recorded as ADR-052, because ADR-038 says journey ids are random.

`SDK_SPEC.md` gains the derivation as a SHOULD with ADR-052 as its source.

## 5. Installing the unpublished SDK

Documented in the SDK README and the main README:

```bash
pnpm --filter @flight-recorder/node pack --pack-destination vendor/
# in the host: "@flight-recorder/node": "file:vendor/flight-recorder-node-0.1.0.tgz"
npm install
```

Why a tarball rather than a path into a checkout: a `file:` path to a directory
installs a symlink whose target has to stay built, so a job with no build step
of its own breaks the day somebody runs `git clean` or checks out a branch in
that clone. A tarball is a built copy, committed with the host, and installs
the same way on every machine. And after pulling a change that adds or updates
the tarball, run `npm ci`: the lockfile's integrity hash changed, and without
the install the job keeps loading the old copy or, as job-radar's deploy did,
waits on a prompt nobody sees.

## 6a. Timeline labels

A timeline row now leads with the event's `name` (`classify`,
`normalize-greenhouse`), then the operation as a small badge, then the service.
An empty name falls back to the operation. The operation keeps its failed
colour. The event list already carries `name`; no API change.

The Recent page and search results list journeys, not events, and label each
row with its entity (`job_posting: greenhouse:123`), so they do not repeat one
label down the page. No change there.

Playwright's timeline spec asserts the step name, and `pnpm screenshots`
regenerates the README images.

## 6b. Displayable aliases

### Wire

The event gains an optional field:

```json
{ "aliases": { "postingId": "gh_123", "email": "a@example.com" },
  "displayableAliases": ["postingId"] }
```

An array of alias types, at most 1,000 entries of at most 128 characters each,
the bounds of the `aliases` keys. A type named there and absent from the same
event's `aliases` is ignored rather than refused: a refusal would lose the event,
and ignoring errs toward masking. Alias values keep their type (strings); the
change is additive, and a server that predates it accepts and drops the field
(ADR-049).

### Storage

`entity_aliases.displayable boolean not null default false`, migration 017.
PostgreSQL 11 and later add a column with a constant default without rewriting
the table, so the `ALTER` is a catalogue change. It still takes an exclusive
lock for an instant, and that lock queues behind any long transaction on the
table and then blocks ingestion behind itself, so the migration sets
`lock_timeout` to five seconds: it fails rather than waits, and running
`migrate` again retries it. The previous API, still running while the migration
is applied (migrate, then deploy), inserts without the column and gets `false`.

### Two statements that disagree

**Displayable only if every statement says so.** The alias row is written with
the flag on first insert; a later event stating the same alias sets it to
`existing AND new`. Once masked, an alias stays masked.

Why not "the most recent statement wins": events arrive out of order (retries,
batches, several processes), so "most recent" would mean arrival order, and a
retried old event could unmask a value a newer one had masked. The conjunction
is order-independent and idempotent, errs toward masking, and a mistaken
`displayable` is corrected by one event that states the alias without it.
The cost is that a host must mark the alias every time it states it; the
README says so.

The upsert only writes when the flag moves from true to false, so a service
repeating `identify` on every event does not turn a no-op into an update. Key
rotation keeps the rule: moving a row onto the current token keeps its flag,
and deleting a stale duplicate first folds its flag into the survivor.

### API and interface

`GET /v1/journeys/:journeyId` (and the dry run's `stored.journey`) returns each
alias as `{ type, displayValue, displayable }`. `displayValue` is the full value
when `displayable` is true and masked exactly as today otherwise. The web page
shows a displayable value as it is and marks a masked one as masked.

### SDK

`journey.identify(aliases, { displayable: ["postingId"] })`,
`recorder.startJourney({ entity, aliases, displayable })`, and
`displayableAliases` on `record()`. The default is none.

Documented in the contract, `EVENT_PROTOCOL.md`, `SDK_SPEC.md`, the schemas,
`docs/SECURITY.md` section 6 (the masking rule and this exception), and
ADR-053. Conformance: `wire/displayable-alias`,
`wire/displayable-alias-every-statement` and `sdk/identify-displayable`, and
`wire`/`sdk` identify cases updated for the new field.

## 7. `GET /v1/journeys` and `since`

**No default.** A server-computed "last 24 hours" would be recomputed on every
page request, which moves the window under the cursor, the exact failure
`API_SPEC.md` warns clients about; and a default hides that the list is
windowed, which reads as "the journey I recorded two days ago is gone". The
web page already sends one.

Instead the refusal says what to send: `since is required: an ISO 8601 instant
with a time zone, such as 2026-08-06T18:00:00Z.` And `API_SPEC.md` says it where
a reader looks first: the route line reads `since=<instant, required>`, and a
sentence under the heading says the list is always windowed.

## Not changed

- The propagation names, the rename's business.
- The event protocol version: every wire change here is an additive optional
  field or a new response field.
