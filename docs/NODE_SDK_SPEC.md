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
@wayscribe/node
```

The first SDK targets Node.js active LTS and TypeScript applications.

## 2. Goals

The SDK makes explicit instrumentation easy while guaranteeing that recorder failures do not break application work.

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
import { createRecorder } from "@wayscribe/node";

export const recorder = createRecorder({
  endpoint: process.env.WAYSCRIBE_URL!,
  apiKey: process.env.WAYSCRIBE_API_KEY!,
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
  // SDK_SPEC.md section 7, in the README, and in each option's @defaultValue,
  // and are resolved in packages/sdk-node/src/config.ts.
  batchSize: 50,
  flushIntervalMs: 1_000,
  requestTimeoutMs: 1_500,
  maxBufferedEvents: 1_000,
  // The budget of one whole event: the server's MAX_EVENT_PAYLOAD_BYTES.
  maxEventBytes: 262_144,
  maxConcurrentSends: 4,

  // Silent by default. `logDiagnostics` prints one line per kind per minute to
  // stderr; `onDiagnostic` hands each one to your own logging instead.
  logDiagnostics: false,
  onDiagnostic: undefined,

  // Used only by journeyIdFor (SDK-55). Undefined is accepted, as it is for
  // every optional setting.
  journeyIdSecret: process.env.JOURNEY_ID_SECRET,

  // Key names that look like secrets and are not. They silence the
  // `unredacted_secret_name` warning, which is printed once per process and
  // name even with logDiagnostics off, and never affect redaction (SDK-61,
  // SDK-62, ADR-055).
  knownSafeNames: [],

  // Three levels; the default is the middle one. SDK_SPEC.md section 10.
  propagation: "journey-and-type",

  // Which build this process is, sent on every event as `deployment`
  // (ADR-060). Read and copied once, here; a field the protocol would refuse,
  // or one that is only whitespace, is left off and reported by its own name,
  // such as `deployment.version` (ADR-062).
  deployment: { version: process.env.APP_VERSION, gitCommit: process.env.GIT_SHA }
});
```

A setting that cannot be used never stops the recorder starting; it is
reported as `configuration_error` and replaced by its default (SDK-6, SDK-60),
and printed once per process whether or not `logDiagnostics` is on. Which
settings were rejected is in `counters().rejectedSettings`, which is fixed once
`createRecorder` returns; an option a later call was refused is in
`counters().rejectedOptions` instead (F-038, ADR-062). A part of `deployment`
is named by its path: `deployment.gitCommit`, `deployment.version` or
`deployment.image` for a field that is not sent, `deployment.*` for keys the
protocol does not have, and `deployment` when events carry no deployment at
all (F-031).

Every event also carries `runtime`, which no setting controls (SDK-64,
ADR-063): `language` `"node"`, `version` `process.versions.node` (left out if
it cannot be read), and `sdk` `{ name: "@wayscribe/node", version, commit? }`.
`version` and `commit` are baked into `dist/index.js` when
`scripts/bundle.mjs` builds it: the version is `package.json`'s, and the commit
is the first of `BUILD_COMMIT`, when `git archive` filled it through
`export-subst` with 40 or 64 lowercase hex characters; `WAYSCRIBE_BUILD_COMMIT`
then `CI_COMMIT_SHA` (a value that is set and is not 7 to 64 lowercase hex
characters fails the build, whichever source gives the commit); and
`git rev-parse HEAD` when git's top level is the repository that contains the
package; otherwise `commit` is left out. Run from source, where nothing is
baked in, the version is `0.0.0-development`. The runtime is read once, when
the recorder is created, and frozen, so an event carries it as one property.
`hostname` and `processId` are not sent.

## 4. Public API

The package exports three values, `createRecorder`, `OPERATIONS` and
`hasJourney`, and types.
Everything below is a method of the recorder or of a journey. ADR-056 records
why the surface has this shape.

### `createRecorder`

```typescript
function createRecorder(config: RecorderConfig): Recorder;
```

### `startJourney`

```typescript
const journey = recorder.startJourney({
  entity: { type: "customer", id: salesforceAccount.Id },
  aliases: { salesforceAccountId: salesforceAccount.Id }, // optional
  displayableAliases: ["salesforceAccountId"], // optional
  label: `${account.Name}` // optional, experimental
});
```

`StartJourneyOptions`. Returns a lightweight journey handle with a new random
journey id. `aliases` records an `identify` straight away, with
`displayableAliases` as its options; `label` is set before it.

### `continueJourney`

```typescript
// From a context another process propagated, with the entity the consumer has.
const journey = recorder.continueJourney({
  context: recorder.extractSqsContext(message.MessageAttributes),
  entity: { type: "customer", id: body.customerId },
  label: "optional, experimental"
});

// From a journey id this process holds, such as a derived one.
const journey = recorder.continueJourney({ journeyId, entity });
```

`ContinueJourneyOptions`: `{ context?, journeyId?, entity?, label? }`. The
journey id is the context's, else `journeyId`, else the id derived from the
entity when the recorder has a usable `journeyIdSecret` (ADR-060), else a new
random one; the
entity is the context's, else `entity`, else `{ type: "unknown", id: "unknown"
}`. A `context` or a `journeyId` without a non-empty string id is reported as
`configuration_error` with code `journey_id_invalid` and treated as absent, so
the next step decides: after a context, the `journeyId` option if there is one;
after either, the derived id, or a new random one without a secret. Deriving reports nothing: a recorder without a secret
is the default, and its journey is new, as it has always been. A journey's
own `context()` is a valid `context`; the journey handle itself is not. Records
nothing by itself. Used by downstream HTTP handlers and queue consumers.

An entity that is missing, or whose type or id is not a non-empty string, in
the options or in the context, is reported as `entity_invalid`; the journey's
steps are recorded under `{ type: "unknown", id: "unknown" }`, as they are for
`startJourney`, so they are kept rather than refused by the server. Options
that are not an object are reported once, as `capture_error` with code
`invalid_options`. `entityFallback`, the old name, is reported as
`setting_renamed`.

### `journeyIdFor` (experimental)

```typescript
const journeyId = recorder.journeyIdFor({ type: "job_posting", id: posting.id });
```

Derives the journey id under `journeyIdSecret` (SDK-55, ADR-052). Never throws:
without a usable secret it reports `configuration_error` and returns a random
id (SDK-56).

### `identify`

```typescript
journey.identify({
  internalCustomerId: customer.id,
  hubspotContactId: target.id
});

journey.identify({ postingId: posting.id }, { displayableAliases: ["postingId"] });

// Two services identifying one record can name their own steps (ADR-060).
journey.identify({ hubspotContactId: target.id }, { name: "identify-crm" });
```

`identify` emits its own dedicated event, named `identify` (operation
`identified`) unless `IdentifyOptions.name` gives it another name; a name that
is not a non-empty string is reported as `invalid_options` and the default is
used. The optional `IdentifyOptions` also list alias types a reader may see
in full. They are sent as `displayableAliases`, and an alias stays displayable
only while every statement of it lists it (SDK-57, ADR-053).

### `label` (experimental)

```typescript
journey.label(`${posting.company} · ${posting.title}`);
```

Sets the journey's label and records nothing. Every later event of this handle
carries it as `journeyLabel`, including events recorded through `across`.
`startJourney` and `continueJourney` take the same text as `label`. Over 200
code points it is cut to 199 and `…`; an empty or non-string label is not set
and is reported. It is shown in plain text, so it must not hold personal data
(SDK-58, SDK-59).

### `record`

```typescript
journey.record({
  operation: "validated", // Operation: one of OPERATIONS
  name: "validate-customer-status",
  input: customer,
  output: result,
  metadata: { ruleSet: "customer-v2" },
  aliases: undefined,
  displayableAliases: undefined,
  startedAt: Date.now(), // epoch milliseconds; defaults to now
  durationMs: 12, // whole milliseconds
  error: { message: "m", type: "T", code: "C", stack: undefined } // ErrorInput
});
```

`RecordInput`. `record` queues the event and never waits for the network.
`error.message` is masked and cut to 4,096 characters, and `error.stack` to
16,384 (SDK-22); the SDK sends no stack of its own.

`OPERATIONS` is the readonly list of the eleven operations, and `Operation` its
union type.

### The wrappers: `transform`, `persist`, `publish`, `deliver`

```typescript
const customer = await journey.transform(
  "transform-salesforce-account",
  salesforceAccount,
  async () => transformSalesforceAccount(salesforceAccount)
);

await journey.persist("update-customer-record", customer, async () =>
  customerRepository.update(customer)
);

await journey.publish("publish-customer-updated", message, async () =>
  sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(message),
      MessageAttributes: recorder.injectSqsAttributes({}, journey.context())
    })
  )
);

await journey.deliver("deliver-customer-to-hubspot", customer, async () =>
  httpClient.post("/contacts", customer, {
    headers: recorder.injectHttpHeaders({}, journey.context())
  })
);
```

The callback takes no argument: propagation is done with the helpers in
sections 6 and 7, inside the callback. Each wrapper records `transformed`,
`persisted`, `published` or `delivered` with the input and the callback's
value, the time the callback started and its duration, and:

- returns the callback's value unchanged, and rethrows its exact error;
- returns a value for a callback that returns a value, and a native promise of
  the resolved value for one that returns a promise or any other thenable;
- never replaces the application's error with a recorder error.

```typescript
transform<T, I = unknown>(name: string, input: I, fn: () => T,
  options?: WrapOptions<Awaited<T>, I>): WrapResult<T>;

type WrapResult<T> = T extends PromiseLike<infer R> ? Promise<Awaited<R>> : T;
```

One signature, not two: a second implementation that runs the callback and
forwards its result the same way either time can be typed once and assigned to
all four wrappers with no cast (F-021, ADR-060). Its body still casts its own
return to `WrapResult<T>`, because a conditional type cannot resolve while `T`
is a type parameter (F-037).

### Wrapper options

```typescript
interface WrapOptions<T = unknown, I = unknown> {
  isFailure?: ((result: T) => boolean | string | FailureReason | undefined) | undefined;
  attempt?: number | undefined; // default 1
  metadata?: Record<string, unknown> | undefined;
  captureInput?: ((input: I, journey: JourneyContext) => unknown) | undefined; // experimental
  captureOutput?: ((result: T, journey: JourneyContext) => unknown) | undefined; // experimental
  metadataFrom?: ((result: T, journey: JourneyContext) => Record<string, unknown>) | undefined; // experimental
}

interface FailureReason {
  message?: string | undefined;
  code?: string | undefined;
}
```

`T` is inferred from the callback and is the resolved value when the callback
returns a thenable; `I` is inferred from the wrapper's input. An attempt above
one records `retried` (SDK-13). A projection runs inside the recorder's failure
boundary: one that throws or returns a promise records `[UNCAPTURABLE]` and a
`payload_omitted` diagnostic with code `projection_failed` (SDK-53).

`isFailure` returning `true` records the generic `<name> reported a failed
result.` with code `result_failed`; a string is that message, and a
`FailureReason` gives the message, the code, or both, so a 429 and a 400 with a
validation message do not read alike (ADR-060). A field that is not a non-empty
string falls back to the generic one, and every falsy value, `0` and `NaN`
included, is not a failure. One that throws costs the verdict alone: the step
is recorded as a success and a `capture_error` says so, and a reason whose own
fields throw costs those fields and not the step. The message is masked for
credential shapes like any other error message, and personal data in it is
not masked: an email address or an international telephone number in any
error message raises the label's `personal_data_in_public_value` warning, with
`detail.field` `errorMessage`, once per process and shape for error messages,
so it never silences a label's or an alias's warning, and is sent
unchanged (F-041, ADR-062).

`metadataFrom` computes metadata from the resolved value, merged over
`metadata`, which is copied before the callback runs. It runs on that value
whether or not `isFailure` calls it a failure, and not when the callback throws
or its promise rejects; once per call, or once per journey in an `across`
group, with nothing remembered between calls (F-040). It follows the
projection rules above; anything
it returns that is not a plain object, and any getter on it that throws, leaves
`metadata` exactly as it was and reports `projection_failed` with field
`metadata` (ADR-060). The wrapper's own `attempt` is applied after the merge,
so a projection cannot rename the attempt the wrapper counted.

### `fail` and `finish`

```typescript
journey.fail("customer-sync-failed", error, { metadata: { attempt: 3 } });
journey.finish({ status: "completed" }); // or "failed"; default "completed"
```

`FailOptions` and `FinishOptions`. `fail` records `failed` for a terminal
failure (SDK-14). Options that are not an object, or hold keys other than
`metadata` (as the old positional metadata did), are reported as
`invalid_options`; the failure is still recorded. `finish` records `completed` or `failed`, named `finish`.

### `across` (experimental)

```typescript
const group = recorder.across(journeys); // Iterable<Journey | JourneyContext>
await group.persist("write-digest", digest, () => writeDigest(digest));
```

Returns a `JourneyGroup`: `record`, `transform`, `persist`, `publish`,
`deliver`, `fail` and `finish`, as on a journey, plus `journeys()`. Each call
records one event per distinct journey id, each with its own event id and the
same `timestamp` and `durationMs`; a wrapper runs its callback once. There is no
`identify` and no `label`. Something that is neither a journey nor a context is
left out and reported as `capture_error` with code `not_a_journey`. SDK-54.

### Propagation helpers (experimental)

`injectHttpHeaders`, `extractHttpContext`, `injectSqsAttributes`,
`extractSqsContext`, `injectPayload`, `extractPayload`: sections 6 and 7.

### `flush`, `shutdown`, `counters`

```typescript
await recorder.flush(): Promise<void>;
await recorder.shutdown({ timeoutMs: 2_000 }): Promise<Counters>; // ShutdownOptions
recorder.counters(): Counters;
```

`flush` sends everything queued and resolves when it has been sent or given
up on. `shutdown` stops accepting events, drains for up to `timeoutMs`
(default 2,000), counts what it gave up as `dropped`, and resolves with the
counters; it never throws or hangs (SDK-37 to SDK-39). `counters` returns a
copy of the counters at any time.

`Counters` (experimental: fields may be added) has `recorded`, `sent`,
`rejected`, `dropped`, `droppedByCause`, `transportErrors`, `captureErrors`, `breakerOpened`,
`payloadsOmitted`, `payloadsTruncated`, `keysDropped`, `configurationErrors`,
`rejectedSettings` and `rejectedOptions` (the names those reports carried, at
creation and on later calls, not numbers), `unredactedSecretNames` and
`personalDataInPublicValues`. Every counter but `recorded` and `sent` counts
reports of one diagnostic kind. `droppedByCause` is a
`Readonly<Record<DroppedCause, number>>`, where the exported type `DroppedCause`
is `DroppedDiagnostic["code"]`: `queue_full`, `after_shutdown`, `shutdown`,
`retry_budget` and `no_verdict`. Every key is present from creation at zero,
each `dropped` report increments its key beside `dropped`, and every read is a
fresh copy, so `dropped` is always the sum of `droppedByCause` (ADR-063). Once
`shutdown` has returned, `sent + rejected + dropped === recorded` (SDK-38,
SDK-42).

### Diagnostics

`onDiagnostic` receives `{ kind, code, reason, detail }`, a union of one
interface per kind (`DroppedDiagnostic`, `PayloadTruncatedDiagnostic`, and so
on). `code` is stable and is what code matches on; `reason` is prose that may
change in any release; `detail` is an object typed per kind. New kinds and
codes may be added in any minor release, so a `switch` needs a `default`
branch. The kinds and codes are listed in the README.

## 5. Context model

```typescript
interface Entity {
  type: string;
  id: string;
}

interface JourneyContext {
  journeyId: string;
  entity: Entity;
}

// What crosses a boundary: the entity only at the levels that send it.
interface PropagatedContext {
  journeyId: string;
  entity?: Entity | undefined;
}
```

Aliases are never part of a context, and never propagate (SDK-44).

## 6. HTTP helpers

```typescript
const headers = recorder.injectHttpHeaders({ accept: "application/json" }, journey.context());
const context = recorder.extractHttpContext(request.headers); // or a fetch Headers
```

`injectHttpHeaders` returns a copy with the journey added at the configured
`propagation` level, and the headers unchanged when there is no context.
`extractHttpContext` takes an `HttpHeadersInput`: a fetch `Headers`, or a plain
object such as Node's `IncomingHttpHeaders`, where values that are not strings
are ignored and the first of a list is read. It returns `undefined` for a
request that carries no well-formed journey.

Potential later framework adapters:

- Express
- Fastify
- NestJS
- native fetch
- Axios

Framework adapters are not required before explicit helpers work.

## 7. Queue and payload helpers

V0 prioritizes SQS message attributes.

```typescript
const attributes = recorder.injectSqsAttributes({}, journey.context());
const context = recorder.extractSqsContext(message.MessageAttributes);
```

`injectSqsAttributes(attributes, context)` returns a copy of `attributes` with
the journey added in the SQS and SNS `MessageAttributeValue` shape
(`SqsMessageAttributes`). `extractSqsContext` takes that shape or plain
name-to-value pairs.

A carrier with neither headers nor attributes can carry the journey in an
envelope around the payload. The helpers are always available; nothing enables
them.

```typescript
const envelope = recorder.injectPayload(order, journey.context()); // PayloadEnvelope<Order>
const { context, data } = recorder.extractPayload(body); // ExtractedPayload
```

`extractPayload` returns a body that is not an envelope as `data`, with no
context. `PayloadEnvelope<T>` is `ContextEnvelope<T>` or `NoContextEnvelope<T>`,
the empty envelope a recorder with no context to inject produces, so the value
the SDK itself makes satisfies its own type (F-014, ADR-060). A nested
discriminant does not narrow a union, so `hasJourney(value)`, an exported
type guard, is what narrows one to `ContextEnvelope<T>`. It takes `unknown`, so
a body off a queue needs no cast to reach it, and its `false` covers both a
value that is not an envelope and an envelope with no journey (F-034). The
README's propagation section states the formulations that work. The header,
attribute and envelope names are not specified in
`SDK_SPEC.md` yet (its section 1); they wait on the propagation specification.

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
written entirely in the `**.` form; see ADR-035.

The server will repeat redaction according to environment policy.

## 10. OpenTelemetry interoperability

When `@opentelemetry/api` is installed and an active span exists, the SDK
captures:

- trace ID
- span ID

It does not capture trace flags, and it never writes `traceparent` (SDK-46).
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

Node 22.12 or later, as `engines` declares (`>=22.12.0`). ESM only: the package
is published as `"type": "module"` with no CommonJS entry point, and
`require()` of it works because Node 22.12 is the first 22 release where
`require()` of an ES module needs no flag. Node 20 is past its end of life.

The tarball holds one bundle, `dist/index.js`, and one declaration file,
`dist/index.d.ts`, rolled up by API Extractor. `exports` names `.` and
`./package.json`; no other path is importable, under any module resolution.

`@opentelemetry/api` is optional and is reached through `createRequire`, so a
bundler must not try to follow it. When it is absent the SDK works unchanged and
records no trace ids.
