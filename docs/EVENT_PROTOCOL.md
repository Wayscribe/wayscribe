# Event Protocol

## 1. Purpose

The event protocol is the stable wire contract between instrumented applications and Wayscribe.

It must remain separate from:

- database models
- internal API implementation
- UI view models
- provider-specific telemetry formats

## 2. Envelope

```typescript
interface EventEnvelopeV01 {
  protocolVersion: "0.1";
  event: JourneyEventV01;
}
```

Every request event is wrapped in an envelope so future protocol versions can be handled explicitly.

## 3. Journey event

```typescript
type JourneyOperation =
  | "received"
  | "identified"
  | "transformed"
  | "validated"
  | "persisted"
  | "published"
  | "consumed"
  | "delivered"
  | "failed"
  | "retried"
  | "completed";

interface JourneyEventV01 {
  id: string;
  journeyId: string;

  environment: string;
  service: string;

  entity: {
    type: string;
    id: string;
  };

  operation: JourneyOperation;
  name: string;
  timestamp: string;

  aliases?: Record<string, string>;
  displayableAliases?: string[]; // alias types a reader may see in full
  journeyLabel?: string; // public display text for the journey, 1 to 200 characters

  durationMs?: number; // whole milliseconds, 0 to 2147483647
  parentEventId?: string;

  traceId?: string;
  spanId?: string;
  messageId?: string;
  correlationId?: string;

  input?: unknown;
  output?: unknown;

  error?: {
    type?: string;
    message: string;
    code?: string;
    stack?: string;
  };

  runtime?: {
    language?: string; // at most 64
    version?: string; // at most 64
    hostname?: string; // at most 256
    processId?: number;
    sdk?: {
      name: string; // 1 to 128 characters
      version: string; // 1 to 64 characters
      commit?: string; // 1 to 128 characters
    };
  };

  deployment?: {
    gitCommit?: string;
    version?: string;
    image?: string;
  };

  metadata?: Record<string, unknown>;
}
```

`journeyLabel` is optional display text for the event's journey, written by the
instrumenting code, for example `"Mirantis · Senior SWE, AI Infra"`. It holds 1
to 200 characters, counted as Unicode code points like every other string
maximum in this schema. An empty string is refused as `invalid_event` with the
detail path `event.journeyLabel`, rather than read as clearing the label: a
host that wants no label sends none, and an event without the field leaves the
journey's label as it was. When events carry different labels, the label of the
event with the latest `timestamp` wins, whatever order the events arrive in.
Timestamps are compared at millisecond precision, the precision they are
stored at, so two events less than a millisecond apart tie. A tie is broken by
the order the server received the events, the order the journey's timeline
shows them in, and a tie on both by the larger event `id`, compared byte by
byte. Events a client sends one after another, in one batch or in successive
requests, are received in that order; events sent concurrently in different
requests are received in no guaranteed order. An older event
that arrives later therefore never replaces a newer label, and a replayed event
can at worst leave a stale one. The label is shown and searchable in full and is
not redacted, so it must not hold personal data.

`runtime` says what was running when the event was recorded, and `runtime.sdk`
names the recorder itself: the SDK's package name, its version, and the commit
it was built from when it knows one, for example
`{ "name": "@wayscribe/node", "version": "0.1.0", "commit": "27f4d64..." }`
with the full commit. It answers which services run which SDK build, which
matters most during an upgrade (F-046, ADR-063). `name` and `version` are
required inside `sdk`, because an `sdk` without them says nothing; a value over
a limit, or an empty one, is `invalid_event` with the path
`event.runtime.sdk.<field>`. The field is optional and was added in `0.1`
(section 11): an event without it was recorded by an SDK from before it or by
another client, and a server from before it strips it as an unknown key and
stores the rest of `runtime`. The server stores `runtime` as the event's
`runtimeMetadata` and returns it on the event read. Like every protocol field,
`runtime.sdk` is covered by the event's content hash, so an event first
delivered to a server from before it (which stripped the field), whose response
was lost, and resent after that server was upgraded, is answered
`event_id_conflict`: it is stored, and the SDK counts it `rejected`. Upgrading
the server before the services, as the upgrade notes advise, never meets this.

The journey also keeps its last step: the `name` of the event with the latest
`timestamp`, under the same tie rule, so an event that arrives late never moves
it backwards, and it is the step the journey's timeline shows last. `name` is required, so every event is a candidate.

A failed journey also keeps its failed step (ADR-063): the `name` of the
failing event that comes last in the same order among the failures applied
since the journey last became failed. A failing event is one that carries an
`error` or has the operation `failed`. So while a retry is in flight, the last
step moves on to the retry's steps and the failed step still names the step
that failed. It is null whenever the journey is not failed: a successful retry
that clears the failure (section 5, `retried`) and a `completed` that sets the
status (section 5, `completed`) clear it.
Reads return it as `failedStep` (`API_SPEC.md` section 5).

## 4. Required field semantics

### `id`

A globally unique, client-generated event identifier.

The API uses this field for idempotency.

Recommended format:

```text
evt_<uuidv7>
```

The exact prefix format is presentation guidance, not a protocol requirement.

### `journeyId`

The stable identifier that joins events across processes and traces.

A journey id is an opaque string of 1 to 128 characters. The server checks
nothing about its shape. One character cannot be stored: an event whose
journey id contains a NUL is refused `unstorable_payload`, and the read routes
answer `404` for such an id. The Node SDK makes ids in two shapes:

- **random:** `jrn_` and a lowercase hyphenated UUID, 40 characters, such as
  `jrn_dd37c205-7ea6-4e14-bc8f-c07022f96696`;
- **derived:** `jrn_` and 32 lowercase hex characters, 36 characters, such as
  `jrn_5f93deccb9b599e792d560765761bec6`, computed from the entity under a
  secret the host holds, as `SDK_SPEC.md` SDK-55 says.

Another client may use any unpredictable id. **A reader must not parse or
validate the shape** of a journey id: both shapes above occur in one
installation, and a client in another language may make a third. The shapes
are described so that an id can be recognised in a log, not so that it can be
checked. The one check that exists is the Node SDK's, when it reads a
propagated context (section 10): it requires the `jrn_` prefix and the
characters it accepts in any propagated value, which both shapes satisfy.

**A journey id must be unpredictable.** A journey belongs to the environment
whose key recorded its first event, and an event for it from any other
environment is refused with `journey_environment_mismatch` (`API_SPEC.md` §3).
An id derived from business data, such as `jrn_order_1001`, can be guessed, and a
key for another environment of the project can record it first: every event the
rightful environment then sends for that journey is refused, and that journey is
not recorded. The Node SDK generates a random UUID for every journey it starts,
unless the host configures derived ids, which are keyed by a secret the host
holds and so cannot be guessed without it (ADR-052). An application that
chooses its own ids should do one or the other, and keep business
identifiers in `entity` and `aliases`, where they are searchable anyway.

A journey id carried across a boundary between environments is refused the same
way. If a staging service propagates its context (HTTP headers, queue
attributes, or a payload envelope) to a production service, the production
service's events for that journey are refused. Each environment records its own
journey; start a new one where a request crosses from one environment into
another.

### `environment`

The logical deployment environment, such as:

- `local`
- `development`
- `staging`
- `production`

The authenticated API key must be authorized for the submitted environment.

### `service`

The application component that performed the operation.

Examples:

- `salesforce-webhook-api`
- `customer-sync-worker`
- `billing-reconciliation-job`

### `entity`

The primary business object represented by the journey.

```json
{
  "type": "customer",
  "id": "18492"
}
```

The ID may be an internal or external identifier. Additional representations belong in `aliases`.

### `operation`

A stable semantic category used for filtering and visual display.

### `name`

A developer-selected, human-readable operation name.

Examples:

- `transform-salesforce-account`
- `update-customer-record`
- `publish-customer-updated`
- `deliver-customer-to-hubspot`

### `timestamp`

ISO 8601 timestamp in UTC.

Example:

```text
2026-08-06T18:31:04.120Z
```

## 5. Operation semantics

### `received`

An input entered the observed workflow.

Examples:

- webhook accepted
- API request accepted
- file received

### `identified`

New aliases were associated with the entity. Emitted by `journey.identify()`.

### `transformed`

The shape or values of data were intentionally changed.

Normally includes both `input` and `output`.

### `validated`

A rule or schema check was performed.

### `persisted`

Data was written to durable application storage.

### `published`

A message or event was sent to a queue, topic, or event bus.

### `consumed`

A message or event was received by a worker or subscriber.

### `delivered`

Data was sent to an external or downstream system.

A failed delivery attempt uses `delivered` (or `retried` for subsequent attempts),
with `error` populated and the HTTP status in `metadata`. The `failed` operation is
reserved for terminal journey or branch failure, such as a dead-letter transition.
See ADR-022.

### `failed`

A processing step ended in failure.

### `retried`

A previous operation was attempted again. Whether the attempt succeeded is in
`error`: a `retried` event carrying an error is a failed attempt, and one
carrying none is the attempt that worked.

A successful `retried` event **clears an earlier failure**, returning the
journey's status to `active`, and never completes it (ADR-061). It clears
rather than completes because a journey that retried successfully and then
died without finishing must not read as completed: a falsely reassuring
status is worse than a stale alarming one. The clearing follows the same
ordering rules as any other status change, so an event stamped before the
newest one changes nothing, and a `failed` recorded for a terminal transition
is cleared the same way as any other failure.

### `completed`

The journey or a major branch completed successfully. For the journey's
status this is the only operation that sets `completed`, and only when it is
at or after the newest event's timestamp; in practice it is what `finish()`
records.

## 6. Aliases

Aliases map alternate identifiers to the same logical entity.

```json
{
  "salesforceAccountId": "0018Z00002ABC",
  "internalCustomerId": "18492",
  "hubspotContactId": "9182736"
}
```

Rules:

- Alias names are developer-defined but should be stable.
- Alias values may be sensitive.
- Alias values are encrypted at rest and masked when read. An event may list
  alias types in `displayableAliases` to have them shown in full; an alias is
  shown in full only while every event that stated it listed it, and a listed
  type the event's `aliases` does not name is ignored (ADR-053). While an alias
  is displayable the server also stores its value in plain text, so the
  journey list can match it by partial text; the statement that masks the
  alias removes that copy, and a masked alias never has one (ADR-054).
- Searchable aliases should have normalized hashes.
- Aliases must not be propagated through HTTP headers unless explicitly safe.

## 7. Payload capture

`input` and `output` are optional.

Capture modes:

- `metadata-only`
- `allowlisted-fields`
- `redacted-payload`
- `full-payload`

The environment policy may override SDK requests and capture less data.

The server must reject payloads exceeding configured limits.

## 8. Errors

The error object records application evidence, not a generated diagnosis.

Stack traces may contain sensitive values and file paths. The server stores
`stack` only when the environment captures full payloads, and drops it in every
other mode. `message`, and a stored `stack`, are masked for credential-shaped
text before storage (SECURITY.md section 4, ADR-046).

## 9. Metadata

`metadata` is for additional structured context. Its wire type stays arbitrary:
an invalid value under a recognized name does not refuse the event, and unknown
keys are accepted as before. Readers may project this optional timing vocabulary
from the already-redacted stored metadata (ADR-064):

| Key | Meaning and valid value |
| --- | --- |
| `queue` | Queue name, nonempty string up to 256 Unicode code points. |
| `queueWaitMs` | Whole milliseconds, 0 through 2,147,483,647, from the stated readiness boundary to this attempt starting. |
| `queueWaitBasis` | `initial-enqueue` or `retry-ready`. |
| `deliveryCount` | Positive safe integer explicitly reported by the broker or caller. |
| `targetHost` | Destination hostname with optional port, up to 256 code points; no URL userinfo, path or query. |
| `httpStatusCode` | Integer 100 through 599. |
| `retryAfterMs` | Whole milliseconds, 0 through 2,147,483,647, requested by the remote system before another call. |
| `attempt` | Caller-supplied positive safe integer. Wrapper ownership and operation rules are unchanged. |
| `retryGroup` | Nonempty caller-supplied retry identity up to 256 code points, grouped only within one journey, service and step name. It must contain no secrets. |

`queueWaitMs` is presented only with consistent evidence: `initial-enqueue`
requires attempt 1, while `retry-ready` requires an attempt above 1. The
original enqueue timestamp is not a retry-readiness boundary. Missing, invalid,
negative, fractional, non-finite, out-of-range or redacted values are unknown
and are omitted from the projection, never replaced with zero. A valid measured
zero remains zero. Redaction and capture markers are not queue, host or retry
identity: grouping records under `[REDACTED]`, for example, would join unrelated
work.

The protocol package exports `TimingContext` and `timingContext(metadata)`. The
parser returns a new object holding only valid recognized fields, validates each
stored JSON field independently, and never mutates the event. Raw metadata is
still returned on event detail. Timeline rows project only these named keys;
they do not copy arbitrary metadata or payloads. A timeline may expose
`recordedHost` separately from an already-redacted `runtime.hostname`, bounded
to 256 code points, to explain clock uncertainty. A redaction marker is not
host evidence.

Examples:

```json
{
  "attempt": 2,
  "queue": "customer-updates",
  "queueWaitMs": 120,
  "queueWaitBasis": "retry-ready",
  "httpStatusCode": 429,
  "retryAfterMs": 2000,
  "sourceSystem": "salesforce"
}
```

Metadata keys should not replace first-class protocol fields.

## 10. Context propagation

### HTTP headers

```text
x-wayscribe-journey-id
x-wayscribe-entity-type
x-wayscribe-entity-id
traceparent
```

Only non-sensitive primary identity should be propagated. Projects may disable entity headers and propagate only the journey ID.

### Queue attributes

Preferred:

```json
{
  "wayscribeJourneyId": "jrn_123",
  "wayscribeEntityType": "customer",
  "wayscribeEntityId": "18492"
}
```

Fallback reserved envelope:

```json
{
  "_wayscribe": {
    "journeyId": "jrn_123",
    "entityType": "customer",
    "entityId": "18492"
  },
  "data": {}
}
```

Payload mutation must be opt-in.

## 11. Versioning rules

### Compatible changes

- adding optional fields
- adding optional metadata
- adding a new operation when older servers reject it clearly or treat it as unknown according to documented policy

### Breaking changes

- removing fields
- changing required field meaning
- changing data types
- changing idempotency semantics
- changing timestamp semantics

Breaking changes require a new `protocolVersion`.

## 12. Validation error format

[`INGESTION_CONTRACT.md` section 4](INGESTION_CONTRACT.md) is normative and lists **every** refusal, with its HTTP status and whether a client should send the event again; that table is checked row by row against the code. Do not read the list below as the full set, which is what it used to look like: these are the six codes this document defines, the ones about the protocol itself, and ingestion sends seven more about limits, storage and the request.

- `unsupported_protocol_version`
- `invalid_event`
- `payload_too_large`
- `unauthorized_environment`
- `event_id_conflict`
- `journey_environment_mismatch`: the journey id belongs to another environment; a journey cannot span environments

This list once also carried `missing_required_field`, `invalid_timestamp` and `invalid_operation`. No code path ever sent them: a missing field, an unparseable timestamp and an operation outside the eleven are all `invalid_event`, with the failing field in `details`. They were removed rather than reserved (ADR-049). Another implementation of this protocol reports those conditions as `invalid_event` too.

A client treats a code it does not recognize by its HTTP status, so a code added later is a compatible change.

The full API error shape is documented in `API_SPEC.md`.
