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
    language?: string;
    version?: string;
    hostname?: string;
    processId?: number;
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

The journey also keeps its last step: the `name` of the event with the latest
`timestamp`, under the same tie rule, so an event that arrives late never moves
it backwards, and it is the step the journey's timeline shows last. `name` is required, so every event is a candidate.

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

Recommended format:

```text
jrn_<uuidv7>
```

**A journey id must be unpredictable.** A journey belongs to the environment
whose key recorded its first event, and an event for it from any other
environment is refused with `journey_environment_mismatch` (`API_SPEC.md` §3).
An id derived from business data, such as `jrn_order_1001`, can be guessed, and a
key for another environment of the project can record it first: every event the
rightful environment then sends for that journey is refused, and that journey is
not recorded. The Node SDK generates a random UUID for every journey it starts.
An application that chooses its own ids should do the same, and keep business
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

A previous operation was attempted again.

### `completed`

The journey or a major branch completed successfully.

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

`metadata` is for additional structured context.

Examples:

```json
{
  "attempt": 2,
  "queue": "customer-updates",
  "httpStatus": 422,
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
