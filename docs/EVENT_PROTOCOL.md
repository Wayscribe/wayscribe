# Event Protocol

## 1. Purpose

The event protocol is the stable wire contract between instrumented applications and Flight Recorder.

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

  durationMs?: number;
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

A failed delivery attempt uses `delivered` — or `retried` for subsequent attempts —
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
- Server configuration determines whether display values are encrypted, redacted, or omitted.
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
x-flight-journey-id
x-flight-entity-type
x-flight-entity-id
traceparent
```

Only non-sensitive primary identity should be propagated. Projects may disable entity headers and propagate only the journey ID.

### Queue attributes

Preferred:

```json
{
  "flightJourneyId": "jrn_123",
  "flightEntityType": "customer",
  "flightEntityId": "18492"
}
```

Fallback reserved envelope:

```json
{
  "_flight": {
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

Protocol errors should use stable codes, for example:

- `unsupported_protocol_version`
- `invalid_event`
- `missing_required_field`
- `payload_too_large`
- `unauthorized_environment`
- `invalid_timestamp`
- `invalid_operation`

The full API error shape is documented in `API_SPEC.md`.
