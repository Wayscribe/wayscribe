# Node.js SDK Specification

> **The Node appendix to [`SDK_SPEC.md`](SDK_SPEC.md).** That document says what
> a recorder in any language must do, with a numbered requirement and a source
> for each rule. This one is the Node half: the package, the public API with its
> TypeScript signatures, the context model, the helper names, and the Node value
> renderings. Where the two overlap, the neutral one is normative.
>
> The path is kept so existing links hold.

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

  // Every one of these has a default; none has to be set. The defaults are in
  // SDK_SPEC.md section 7 and in the README, and are resolved in
  // packages/sdk-node/src/config.ts.
  batchSize: 50,
  flushIntervalMs: 1_000,
  requestTimeoutMs: 1_500,
  maxBufferedEvents: 1_000,
  // The budget of one whole event: the server's MAX_EVENT_PAYLOAD_BYTES.
  maxPayloadBytes: 262_144,
  maxConcurrentSends: 4,

  // Silent by default. `logDiagnostics` prints one line per kind per minute to
  // stderr; `onDiagnostic` hands each one to your own logging instead.
  logDiagnostics: false,
  onDiagnostic: undefined,

  // Three levels; the default is the middle one. SDK_SPEC.md section 10.
  propagate: "journey-and-type"
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

`identify` emits its own dedicated event, named `identify` (operation `identified`).

```typescript
journey.identify({ postingId: posting.id }, { displayable: ["postingId"] });
```

The optional second argument lists alias types a reader may see in full. It is
sent as `displayableAliases`, and an alias stays displayable only while every
statement of it lists it (SDK-57, ADR-053).

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

### `journeyIdFor`

```typescript
const journeyId = recorder.journeyIdFor({ type: "job_posting", id: posting.id });
```

Derives the journey id under `journeyIdSecret` (SDK-55, ADR-052). Never throws:
without a usable secret it reports `configuration_error` and returns a random
id (SDK-56).

### `across`

```typescript
const group = recorder.across(journeys); // Iterable<Journey | JourneyContext>
await group.persist("write-digest", digest, () => writeDigest(digest));
```

Returns a `JourneyGroup`: `record`, `transform`, `persist`, `publish`,
`deliver`, `fail` and `finish`, as on a journey, plus `journeys()`. Each call
records one event per distinct journey id, each with its own event id and the
same `timestamp` and `durationMs`; a wrapper runs its callback once. There is no
`identify`. SDK-54.

### `consume`

```typescript
const journey = recorder.consume({
  context: recorder.fromQueueAttributes(message.MessageAttributes),
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

### Wrapper options

Every wrapper takes a last `options` argument, typed by what the callback
returns:

```typescript
interface WrapOptions<T> {
  isFailure?: (result: T) => boolean;
  attempt?: number;
  metadata?: Record<string, unknown>;
  captureInput?: (input: unknown, journey: JourneyContext) => unknown;
  captureOutput?: (result: T, journey: JourneyContext) => unknown;
}
```

`T` is inferred from the callback and is the resolved value when the callback
returns a promise. The wrapper's own return type is still the callback's. A
projection runs inside the recorder's failure boundary: one that throws or
returns a promise records `[UNCAPTURABLE]` and a `payload_omitted` diagnostic
with reason `projection_failed` (SDK-53).

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

HTTP helpers:

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

## 8. Batching, transport and shutdown

Moved to [`SDK_SPEC.md`](SDK_SPEC.md), which states them as numbered
requirements for any language: buffering in section 6, transport and the retry
rule in section 7, and shutdown in section 8. Three things there are narrower
than this document once was, because the code is narrower:

- **The queue drops the oldest event**, and counts the drop. Drop-newest was
  offered here as a configurable policy and was never built.
- **A batch holds at most a hundred events**, and `batchSize` is clamped to it.
  An unclamped 150 produced a 400 the SDK read as a transport failure, retried,
  and requeued, losing 170 events while the counters read like a brief blip.
- **A per-event refusal of 500 or above is resent**, that event alone, for up to
  30 seconds from its first refusal or 10 sends. It used to be treated as
  permanent, so a database hiccup lost the event.

## 9. Payload capture and redaction

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

The last form matches that name at any depth wherever it is filed: as an object
key, as the name of a two-element `[name, value]` array element or of a
`{ name, value }` or `{ key, value }` array element, as a name in an
interleaved header list such as HTTP/1.1 or HTTP/2 `rawHeaders`, and as a header line in a
CRLF-delimited header block. SECURITY.md section 4 defines each shape. Every
other form is anchored at the root, which is why the built-in secret list is
written entirely in the `**.` form — see ADR-035.

The server will repeat redaction according to environment policy.

## 10. OpenTelemetry interoperability

When `@opentelemetry/api` is installed and an active span exists, the SDK may capture:

- trace ID
- span ID
- trace flags

OpenTelemetry is optional.

The SDK should avoid forcing an OpenTelemetry SDK installation.

## 11. Error behavior, shutdown and testing

Moved to [`SDK_SPEC.md`](SDK_SPEC.md): host safety and error identity in section
2, shutdown and its accounting in section 8, diagnostics in section 9, and the
list of requirements no fixture can check, with what a test for each has to do,
in section 14.

What stays Node's: a wrapper returns a value for a synchronous callback and a
promise for an asynchronous one, and never converts between them, so
instrumenting a synchronous call does not turn a handled error into an unhandled
rejection.

## 12. Node value renderings

What a Node value becomes on the wire is in
[the README's table](../packages/sdk-node/README.md), which is generated from
what the SDK actually stored rather than from what it intends to: `Date`,
`BigInt`, `Map`, `Set`, `Headers`, `URLSearchParams`, `Buffer`, `Error`,
`RegExp`, a thenable, `rawHeaders`, a cycle, a shared reference, a throwing
getter. The neutral half of that list, the repairs every SDK must make, is
`SDK_SPEC.md` section 5.

## 13. Supported Node versions

Node 20.19 or later, as `engines` declares. ESM only: the package is published
as `"type": "module"` with no CommonJS entry point.

`@opentelemetry/api` is optional and is reached through `createRequire`, so a
bundler must not try to follow it. When it is absent the SDK works unchanged and
records no trace ids.
