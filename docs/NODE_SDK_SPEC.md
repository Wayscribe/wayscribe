# Node.js SDK Specification

## 1. Package

```text
@flight-recorder/node
```

The first SDK targets Node.js active LTS and TypeScript applications.

## 2. Goals

The SDK should make explicit instrumentation easy while guaranteeing that recorder failures do not break application work.

It should support:

- journey creation
- journey continuation
- event recording
- input/output capture
- aliases
- wrappers around transformations and side effects
- HTTP and queue context propagation
- batching
- redaction
- bounded reliability behavior

## 3. Initialization

```typescript
import { createRecorder } from "@flight-recorder/node";

export const recorder = createRecorder({
  endpoint: process.env.FLIGHT_RECORDER_URL!,
  apiKey: process.env.FLIGHT_RECORDER_API_KEY!,
  serviceName: "customer-integration",
  environment: process.env.NODE_ENV ?? "development",

  captureMode: "redacted-payload",

  redact: [
    "authorization",
    "cookie",
    "*.password",
    "*.access_token",
    "*.refresh_token",
    "customer.ssn"
  ],

  batchSize: 20,
  flushIntervalMs: 1_000,
  requestTimeoutMs: 1_500,
  maxBufferedEvents: 1_000
});
```

## 4. Public API

### `createRecorder`

```typescript
function createRecorder(config: RecorderConfig): Recorder;
```

### `startJourney`

```typescript
const journey = recorder.startJourney({
  entity: {
    type: "customer",
    id: salesforceAccount.Id
  },
  aliases: {
    salesforceAccountId: salesforceAccount.Id
  }
});
```

Returns a lightweight journey handle.

### `continueJourney`

```typescript
const journey = recorder.continueJourney(context);
```

Used by downstream HTTP handlers and queue consumers.

### `identify`

```typescript
journey.identify({
  internalCustomerId: customer.id,
  hubspotContactId: target.id
});
```

Alias updates should be emitted as part of the next event or as a small dedicated event, depending on the final protocol decision.

### `record`

```typescript
journey.record({
  operation: "validated",
  name: "validate-customer-status",
  input: customer,
  output: result,
  metadata: {
    ruleSet: "customer-v2"
  }
});
```

`record` should enqueue asynchronously and not wait for the network.

### `transform`

```typescript
const customer = await journey.transform(
  "transform-salesforce-account",
  salesforceAccount,
  async () => transformSalesforceAccount(salesforceAccount)
);
```

Behavior:

- capture start time
- execute callback
- capture output
- record duration
- emit `transformed`
- rethrow application callback errors
- never replace application error semantics with recorder transport errors

### `persist`

```typescript
await journey.persist(
  "update-customer-record",
  customer,
  async () => customerRepository.update(customer)
);
```

The callback result may be captured according to configuration.

### `publish`

```typescript
await journey.publish(
  "publish-customer-updated",
  message,
  async (context) => {
    return sqs.send(buildCommand(message, context.queueAttributes));
  }
);
```

The helper should make propagation metadata available without forcing payload mutation.

### `consume`

```typescript
const journey = recorder.consume({
  message,
  attributes: message.MessageAttributes,
  entityFallback: {
    type: "customer",
    id: message.Body.customerId
  }
});
```

### `deliver`

```typescript
await journey.deliver(
  "deliver-customer-to-hubspot",
  customer,
  async (context) => {
    return httpClient.post("/contacts", customer, {
      headers: context.httpHeaders
    });
  }
);
```

### `fail`

```typescript
journey.fail("customer-sync-failed", error, {
  attempt: 3
});
```

### `finish`

```typescript
journey.finish({
  status: "completed"
});
```

## 5. Context model

```typescript
interface JourneyContext {
  journeyId: string;
  entity: {
    type: string;
    id: string;
  };
  parentEventId?: string;
  traceparent?: string;
}
```

Do not place sensitive aliases in propagated context.

## 6. HTTP helpers

Planned helpers:

```typescript
recorder.injectHttpHeaders(headers, journey.context());
recorder.extractHttpContext(headers);
```

Potential later framework adapters:

- Express
- Fastify
- NestJS
- native fetch
- Axios

Framework adapters are not required before explicit helpers work.

## 7. Queue helpers

V0 prioritizes SQS message attributes.

```typescript
const attributes = recorder.toQueueAttributes(journey.context());
const context = recorder.fromQueueAttributes(message.MessageAttributes);
```

Payload-envelope propagation is optional and explicitly enabled.

## 8. Batching

The SDK should:

- enqueue events in memory
- flush at batch size
- flush on interval
- flush on explicit call
- attempt graceful shutdown flush
- enforce a maximum queue size

When the queue is full, use a configurable policy:

- drop newest
- drop oldest
- optional local spool in a future release

Default should avoid unbounded memory growth.

## 9. Transport reliability

- short connection and request timeouts
- capped exponential backoff
- jitter
- failure counter
- circuit open period after repeated failures
- no infinite retries
- idempotent event IDs
- debug logs only when enabled

Transport errors should be reported through callbacks or internal diagnostics, not thrown into wrapped business logic by default.

## 10. Payload capture and redaction

Redaction should run before an event enters the in-memory queue.

Supported path patterns should be intentionally limited and documented.

Examples:

```text
authorization
headers.cookie
*.password
customer.ssn
items[*].cardNumber
**.authorization
```

The last form matches that key name at any depth, including inside arrays. Every
other form is anchored at the root, which is why the built-in secret list is
written entirely in the `**.` form — see ADR-035.

The server will repeat redaction according to environment policy.

## 11. OpenTelemetry interoperability

When `@opentelemetry/api` is installed and an active span exists, the SDK may capture:

- trace ID
- span ID
- trace flags

OpenTelemetry is optional.

The SDK should avoid forcing an OpenTelemetry SDK installation.

## 12. Error behavior

The SDK distinguishes:

- application callback error
- recorder serialization error
- recorder buffer error
- recorder transport error

Application callback errors are rethrown unchanged after the corresponding failure evidence is enqueued where possible.

Recorder errors do not change callback results by default.

## 13. Shutdown

Expose:

```typescript
await recorder.shutdown({
  timeoutMs: 2_000
});
```

Shutdown:

- stops accepting new events
- attempts final flush
- respects timeout
- returns diagnostics
- does not hang indefinitely

## 14. Testing requirements

- wrapper preserves callback return values
- wrapper preserves callback errors
- recorder outage does not fail callback
- duplicate transport retry uses same event ID
- buffer is bounded
- redaction occurs before buffering
- shutdown timeout works
- trace context is optional
- queue context round-trips
- event timestamps and duration are valid
