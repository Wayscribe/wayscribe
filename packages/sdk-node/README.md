# @flight-recorder/node

Record what happened to one customer record as it crossed your services, and see
where a value changed.

This is the Node.js SDK for [Flight Recorder](https://gitlab.com/jojithedev/flight-recorder),
a self-hosted, record-level debugging tool. You run the server yourself; nothing
leaves your infrastructure.

- **No runtime dependencies.** This package is embedded in your application, so
  it brings nothing with it.
- **Cannot break your application.** Every entry point is wrapped so that a
  recorder failure is counted, not thrown. Details below.
- Apache-2.0.

## Install (not yet on npm)

**The package is not published yet.** Until it is, install it from a clone of
this repository, as [`examples/instrument-a-service`](../../examples/instrument-a-service/README.md)
does. Once it is published, this will be:

```bash
npm install @flight-recorder/node
```

## Record a journey

```typescript
import { createRecorder } from "@flight-recorder/node";

const recorder = createRecorder({
  endpoint: process.env.FLIGHT_RECORDER_URL ?? "http://localhost:8080",
  apiKey: process.env.FLIGHT_RECORDER_API_KEY ?? "",
  serviceName: "billing-api",
  environment: "production"
});

async function handleWebhook(account) {
  const journey = recorder.startJourney({
    entity: { type: "customer", id: account.Id }
  });

  journey.record({
    operation: "received",
    name: "receive-account-webhook",
    input: account
  });

  const customer = await journey.transform("map-account", account, () =>
    toCustomer(account)
  );

  const id = await journey.persist("save-customer", customer, () =>
    db.customers.insert(customer)
  );

  // Aliases are the other identifiers this record is known by. They make the
  // journey findable by any of them.
  journey.identify({ internalCustomerId: String(id) });
}
```

Then search your Flight Recorder for `account.Id` and read the timeline.

## Wrappers

`transform`, `persist`, `publish`, and `deliver` each run your callback, return
its value unchanged, and rethrow its exact error object. They differ only in the
operation they record, which is what makes the timeline readable.

**They preserve the shape of your callback.** A callback that returns a value
returns a value; one that returns a promise returns a promise. So wrapping a
synchronous call does not change the control flow around it:

```typescript
try {
  // Returns the parsed value, and throws synchronously on bad input.
  const parsed = journey.transform("parse-body", raw, () => JSON.parse(raw));
  return { status: 200, body: parsed };
} catch {
  return { status: 400, body: { error: "malformed json" } };
}
```

```typescript
await journey.deliver("send-to-crm", payload, () => post(payload));
```

**A failure that does not throw.** An HTTP 422 is a failure your code inspects
rather than catches, so say so:

```typescript
const response = await journey.deliver("send-to-crm", payload, () => post(payload), {
  isFailure: (result) => result.status >= 400
});
```

**Retries.** Pass the attempt number and the wrapper records `retried` instead of
the natural verb. The SDK cannot count attempts itself: a retry usually happens
in a different process consuming a redelivered message.

```typescript
await journey.deliver("send-to-crm", payload, () => post(payload), { attempt: 2 });
```

## Crossing a process boundary

A journey that stops at a service boundary is three unrelated timelines. Inject
context on the way out and extract it on the way in.

```typescript
// Producer
await fetch(url, { headers: recorder.injectHttpHeaders({}, journey.context()) });

await sqs.send(
  new SendMessageCommand({
    QueueUrl: url,
    MessageBody: JSON.stringify(message),
    MessageAttributes: recorder.toQueueAttributes(journey.context())
  })
);
```

```typescript
// Consumer
const journey = recorder.consume({
  context: recorder.fromQueueAttributes(message.MessageAttributes),
  entityFallback: { type: "customer", id: body.customer.externalId }
});
```

`entityFallback` is not optional in practice. By default the entity **ID does not
propagate** — it is often a real customer identifier, and sending it by default
would write it into the headers, queue metadata, and logs of systems you may not
control. The consumer supplies the ID it already has from the message body.

| `propagate` | Emits |
| --- | --- |
| `journey-only` | journey ID |
| `journey-and-type` (default) | journey ID, entity type |
| `full` | journey ID, entity type, entity ID |

**Aliases never propagate, at any level.** Not configurable.

## It cannot break your application

An observability library that takes down the service it observes is worse than
no library. This one is built so that cannot happen:

- Every public entry point is wrapped. A failure inside the recorder increments a
  counter and returns; it never propagates to your code.
- Wrappers return your callback's value unchanged and rethrow its exact error
  object — the same instance, so `instanceof` checks and custom properties on
  your errors keep working.
- The event queue is bounded. Under backpressure it drops the oldest events and
  counts the drops rather than growing without limit.
- The transport retries with a circuit breaker, and gives up rather than piling
  up.
- `shutdown()` never hangs; it races the final flush against a timeout.
- Nothing is written to your console unless you set `logDiagnostics`. Pass
  `onDiagnostic` if you want to hear about failures in your own logger.

```typescript
const recorder = createRecorder({
  // ...
  onDiagnostic: (d) => logger.warn({ kind: d.kind }, d.reason)
});

const counters = await recorder.shutdown();
// { dropped, rejected, transportErrors, captureErrors, breakerOpened, sent }
```

## Is it sending?

While you are setting up, turn on `logDiagnostics`:

```typescript
const recorder = createRecorder({
  // ...
  // Turn this off once the service is known to send.
  logDiagnostics: true
});
```

The first batch the server stores anything from prints one line, once:

```text
[flight-recorder] delivered_first: Connected to http://localhost:8080; the server accepted 3 events.
```

If that line never appears, the lines that do say why:

```text
[flight-recorder] rejected: unauthorized_environment: This key is not authorized for environment production.
[flight-recorder] transport_error: fetch failed
```

Each diagnostic kind prints at most one line a minute, and the next line of that
kind, or `shutdown()`, says how many repeats were suppressed. A line holds the
kind and the diagnostic's reason only, never a payload, a key, or the
diagnostic's `detail`. The reason is masked by the same rules as error messages,
cut to 512 characters, and kept to one line. For a refusal it is the server's
code, message, and first field error, such as
`event.name: Too big: expected string to have <=256 characters`: the field's
path can name an alias or metadata key, but never its value.

`delivered_first` also reaches `onDiagnostic`, as
`{ kind: "delivered_first", reason, endpoint, accepted }`, whether or not
`logDiagnostics` is on. It is the only diagnostic that is good news and does not
change any counter.

| Kind | Means | Counter |
| --- | --- | --- |
| `delivered_first` | the server stored events from this recorder for the first time | none |
| `rejected` | the server understood an event and refused it; it is not retried | `rejected` |
| `transport_error` | a request failed, or the server could not store an event for now; see below | `transportErrors` |
| `dropped` | an event, or a payload, was not recorded: the queue was full, the payload was too large, the recorder was shut down, or the server was still refusing it after 30 seconds or 10 sends | `dropped` |
| `capture_error` | recording failed inside the SDK; your call was unaffected | `captureErrors` |
| `breaker_open` | sends pause for 30 seconds after five failed in a row | `breakerOpened` |

### When the server cannot store an event for now

The batch route answers each event separately. A refusal with a status below 500
means the event is wrong, and it is reported as `rejected` and not sent again. A
refusal of 500 or above, such as `storage_error` or `query_timeout`, means the
server could not store it this time, so the SDK sends that event again, on its
own, after the same backoff it uses for a failed request.

Each send tries a refused event three times, a few hundred milliseconds apart.
If the server is still refusing it, the event goes back to the front of the
queue and rides in a later send, and each send that ends that way reports a
`transport_error` with the server's reason. A database restart takes seconds,
so the event keeps being retried for 30 seconds from its first refusal, or
through 10 sends, whichever comes first. Only when the server refuses it again
past one of those bounds is it given up, and a `dropped` counts it. It can also
be dropped earlier if the queue fills and it is the oldest event there.

The 30 seconds match the breaker's cooldown and are twice the API's default
statement timeout. The bound is checked only when the server refuses the event
again, so an event waiting out an open breaker is sent once more when the
breaker closes, not dropped unsent. The 10 sends stop an event the server can
never store from riding in every batch of a busy stream for the whole 30
seconds.

A send in which the server stored other events does not count toward the
breaker, so one event the server can never store does not pause delivery of
everything else. A send in which it stored nothing does, as a failed request
does.

## Redaction

Payloads are redacted before they leave your process, against a built-in list of
secret names. Paths you add are appended to that list rather than replacing it,
so adding one cannot silently disable the rest.

```typescript
createRecorder({
  // ...
  captureMode: "redacted-payload", // default; "metadata-only" captures no payloads
  redact: ["customer.taxId", "**.ssn"]
});
```

The grammar is small on purpose, so a rule never matches more than you expected:

| Rule | Matches |
| --- | --- |
| `customer.ssn` | exactly that path |
| `*.password` | `password` one level down, under any key |
| `items[*].cardNumber` | `cardNumber` in every element of `items` |
| `authorization` | that key at the top level only |
| `**.authorization` | that key **wherever it appears**, at any depth, including inside arrays |

Use the `**.` form for anything that is a secret by virtue of its name rather
than its location. The built-in list is written entirely that way, because a
secret is identified by the name it is filed under and not by where in a request
somebody happened to nest it — `config.headers.authorization` is three levels
down and is exactly what an axios error carries.

Matched values are replaced with `[REDACTED]` rather than deleted, so the
timeline still shows that the field existed.

### Error messages

When a wrapped callback throws, or you call `fail()` or `record()` with an
error, the SDK records the error's `message`, `name` as `type`, and a string
`code`. It sends no `stack`.

A message is free text, so name-based redaction cannot reach inside it, and
error messages are where credentials tend to appear. Before the event is queued,
the message is masked by shape:

```text
connect ECONNREFUSED postgres://app:hunter2@db.internal:5432/orders
connect ECONNREFUSED postgres://[REDACTED]@db.internal:5432/orders
```

The masker recognises:

- URL userinfo, and the secret segment of Slack and Discord webhook URLs
- `Bearer`, `Basic` and `Digest` credentials of eight characters or more
- values assigned to a secret name: `password=`, `"api_key": "…"`,
  `?access_token=`, and names whose last words say secret, such as
  `DB_PASSWORD=`, `STRIPE_API_KEY=` and `x-auth-token: …`. Names that only point
  at a secret or page through results, such as `SecretId` and `nextPageToken`,
  are left alone.
- JSON Web Tokens, and PEM and PGP private keys
- provider-prefixed keys from Stripe, Slack, GitHub, GitLab, AWS, Google,
  OpenAI, Anthropic, npm, SendGrid, Hugging Face and Flight Recorder

A message longer than the 4096 characters the server accepts is masked over its
first 8192 characters and then cut to 4096, ending in `[TRUNCATED]`; a `stack`
you pass to `record()` is handled the same way at 16384.

It does not guess at entropy, so record identifiers such as Salesforce ids,
UUIDs and order numbers are never masked, and a credential in an unlisted shape
is sent as written. It also misses:

- a plain word after a secret's name and a colon, where it reads as a
  sentence: `DB_PASSWORD: not set` is kept, and so is `DB_PASSWORD: sunshine`.
  Attached to `=`, as in `DB_PASSWORD=sunshine`, it is masked.
- a name written without separators, such as `DBPASSWORD`
- the error's `type` and `code`, which are sent as they are

The server masks again with the same rules, which catches nothing more for an
event the SDK sent.

## What happens to your values

Payloads are stored as PostgreSQL `jsonb`, so anything JSON cannot represent has
to be rendered as something. The rule is that a value is repaired rather than
refused: the point of recording a payload is to show what actually arrived, and
losing the whole thing over one field would throw away the evidence you came for.

Every row below is what the SDK actually stored, not what it intends to.

| You pass | It is stored as |
| --- | --- |
| `Date` | ISO 8601 string — `"2026-01-02T03:04:05.678Z"` |
| anything with `toJSON()` | whatever that returns, then walked again |
| `BigInt` | decimal string — `"9007199254740993"`, digits intact |
| a cycle | `"[CIRCULAR]"` at the point the loop closes; the rest is kept |
| the same object twice | expanded both times — a shared reference is not a cycle |
| `undefined`, a function, a symbol | the key is omitted, as `JSON.stringify` does |
| `NaN`, `Infinity` | `null`, as `JSON.stringify` does |
| a NUL byte in a string | removed — PostgreSQL rejects it in `jsonb` |
| half an emoji left by `slice()` | repaired to `U+FFFD` |
| `Buffer` | `{"type": "Buffer", "data": [...]}` |
| `Map`, `Headers`, `URLSearchParams` | an object, under the keys the data already had |
| `Set` | an array |
| `Error` | `{name, message}` plus its own properties and its `cause` — no `stack` |
| `RegExp` | the literal, `"/secret-(\\d+)/gi"` |
| over `maxPayloadBytes` | `"[PAYLOAD_TOO_LARGE]"`, and a `dropped` diagnostic |
| a getter that throws | `"[UNCAPTURABLE]"`, and the event is still recorded |

Redaction runs *inside* all of these, so an `authorization` entry in a header
`Map` and an axios error's `config.headers.authorization` are both `[REDACTED]`
before anything leaves your process.

Two consequences worth knowing:

- A `Map` is stored as an ordinary object and a `Set` as an ordinary array, so
  neither is distinguishable from one once it reaches the timeline. That is the
  price of storing them under their own keys: any wrapper that recorded the type
  would push the data a level down, and the redaction rule that looked right
  would match nothing.
- A `Map` may be keyed by anything, and two keys can render to one name — `1`
  and `"1"`, or two different objects. When that happens the entry is reported
  as `"[COLLIDED_KEYS]": n` rather than lost quietly.

An `Error`'s `stack` is left out: it is the largest field on a typical error and
the timeline already carries the failure. An error with its own `toJSON` is
asked first, so a library that chooses to include its stack still does.

A value that cannot be captured never costs you the event. The step is recorded
either way, with a marker in place of the payload, because the step whose payload
would not serialize is very often the step you are trying to debug.

## What it costs

Measured with the SDK's own benchmark on an Apple M3 Pro (12 cores, 18 GiB),
macOS 26.2, Node 24.19.0, with the default configuration and
`maxConcurrentSends` of 4. The machine was running other work at the time, so
read the numbers as orders of magnitude; the maximums in particular are noisy.
To reproduce, from the repository root (about ten minutes):

```bash
pnpm --filter @flight-recorder/node bench
```

**Time added to each wrapped call**, in microseconds, against a local stub
answering like ingestion. A `transform` records its input and its output, so it
captures the payload twice; the `persist` here returns a small object. Each 1 KiB
row is 10,000 calls; each 64 KiB row is 2,500, so its p99 is the 25th slowest
call and moves a lot between runs.

| Wrapper | Payload | Added p50 | Added p99 |
| --- | --- | --- | --- |
| `transform` (sync) | 1 KiB | 30 | 513 |
| `persist` (async) | 1 KiB | 75 | 1,146 |
| `transform` (sync) | 64 KiB | 1,420 | 19,555 |
| `persist` (async) | 64 KiB | 1,079 | 10,337 |

Most of that is redaction and the copy that makes a payload safe to store, and
it grows with the payload. The p99 is dominated by one call in every batch of
50: the call that fills a batch starts its send, and serialising the batch
happens inside that call. At 64 KiB a separate one-off measurement, timing
`JSON.stringify` inside those calls, put it at about 8 ms of an 11 ms call. The
event loop spends that time whichever call it lands in.

**Capture never waits on the network.** With the endpoint refusing connections,
or answering after 200 ms, the added p50 stayed in the range measured against
the local stub: across three full runs, 20 to 116 µs at 1 KiB and 694 to
1,854 µs at 64 KiB for every endpoint, with no ordering by endpoint that held
from one run to the next. Unreachable, every event is eventually dropped from
the bounded queue and counted. Against the 200 ms stub at 2,000 calls a second,
one process sending 4 batches at a time stores about 1,000 events a second and
drops the rest, which the concurrency table below shows in detail.

**Sustained load:** 2,000 wrapped calls a second for 60 seconds, 1 KiB,
alternating `transform` and `persist`.

| | Unwrapped | Wrapped |
| --- | --- | --- |
| Heap after GC, start to end | 6.9 to 7.8 MiB | 9.0 to 9.1 MiB |
| Heap, highest of one sample a second | 8.6 MiB | 61.3 MiB |
| Resident set size at the end | 76 MiB | 219 MiB |
| Event-loop delay beyond its 10 ms timer, p50 / p99 | 0.39 / 0.96 ms | 0.19 / 1.71 ms |
| Events stored / dropped | | 124,000 / 0 |

The heap after collection does not grow over the minute. The heap figure
between collections is a sample taken once a second, not a true peak. The
resident set is about 140 MiB larger; the heap between collections accounts for
about 50 MiB of that, and the benchmark does not break down the rest.

**Send concurrency:** one process producing events for 15 seconds against a stub
with a fixed delay per batch.

This table models one process against a server that can serve any number of
requests at once. It shows what a low cap costs that one process; it does not
justify a higher default for a fleet, and the default stays 4 because of what it
leaves out. Every ingestion request holds one database connection, so a fleet of
processes shares instances times pool size. Simulated with one API instance, a
pool of ten, and ten SDK processes under a burst, a cap of 8 queued requests past
`requestTimeoutMs`: the SDK abandoned and resent batches the server went on to
store, 44 to 48 percent of the server's work was duplicates, the breaker opened
40 times, and unique events stored fell from about 43,600 at a cap of 4 to about
14,000.

| Server time per batch | Events/s produced | `maxConcurrentSends` | Stored per second | Dropped |
| --- | --- | --- | --- | --- |
| 50 ms | 2,000 | 1 | 873 | 52.9% |
| 50 ms | 2,000 | 2 | 1,733 | 9.8% |
| 50 ms | 2,000 | 4 | 1,994 | 0% |
| 50 ms | 2,000 | 8 | 1,993 | 0%, never more than 4 in flight |
| 50 ms | 8,000 | 1 | 867 | 88.3% |
| 50 ms | 8,000 | 2 | 1,726 | 77.6% |
| 50 ms | 8,000 | 4 | 3,466 | 55.8% |
| 50 ms | 8,000 | 8 | 7,092 | 10.3% |
| 200 ms | 2,000 | 1 | 240 | 84.7% |
| 200 ms | 2,000 | 2 | 473 | 72.7% |
| 200 ms | 2,000 | 4 | 947 | 48.7% |
| 200 ms | 2,000 | 8 | 1,916 | 0.0% (6 events) |
| 200 ms | 8,000 | 1 | 240 | 96.1% |
| 200 ms | 8,000 | 2 | 477 | 93.2% |
| 200 ms | 8,000 | 4 | 947 | 87.2% |
| 200 ms | 8,000 | 8 | 1,893 | 75.2% |

### Sizing `maxConcurrentSends`

Keep the sum of `maxConcurrentSends` across every process that sends to one
installation under **API instances × database pool size**, with headroom for
searches and the retention sweep. The API's pool is 10 connections per instance.
Twenty services at the default of 4 want 80 connections at once in a burst,
which is eight instances' worth.

Past that, requests wait for a connection, run past `requestTimeoutMs`, and are
abandoned by the SDK and sent again while the server still finishes the first
copy. The duplicates are harmless to the data, because event ids are
idempotent, but they are pure load on a server that is already behind, and the
table above cannot show it.

Raise it only for a few high-volume processes in front of a scaled-out API, and
watch `transportErrors` and `breakerOpened` when you do. Lower it for a large
fleet against one instance. It is clamped to 1-16.

## Configuration

| Option | Default | |
| --- | --- | --- |
| `endpoint` | — | required |
| `apiKey` | — | required |
| `serviceName` | — | required |
| `environment` | — | required; must match the API key's environment |
| `captureMode` | `redacted-payload` | or `metadata-only`, `full-payload` |
| `redact` | `[]` | appended to the built-in secret paths |
| `propagate` | `journey-and-type` | see above |
| `batchSize` | `50` | at most 100, the server's limit |
| `flushIntervalMs` | `1000` | |
| `requestTimeoutMs` | `1500` | |
| `maxBufferedEvents` | `1000` | oldest are dropped past this |
| `maxPayloadBytes` | `262144` | larger payloads record a marker instead |
| `onDiagnostic` | — | |
| `logDiagnostics` | `false` | see [Is it sending?](#is-it-sending) |
| `maxConcurrentSends` | `4` | 1-16; see [Sizing](#sizing-maxconcurrentsends) |

The SDK reads no environment variables. A library that changes behaviour based on
ambient state is a library that behaves differently in your tests.

## OpenTelemetry

If OpenTelemetry is installed, the SDK reads the active trace and span IDs onto
each event. It is resolved once, optional, and absent it degrades silently.

The SDK does not write `traceparent`. OpenTelemetry owns that header and has its
own propagator.

## Requirements

Node 20.19 or later.

The package is ESM. `import` works on any Node 20; `require()` of it needs the
`require(esm)` support backported in 20.19, which is why the floor is there
rather than at 20.0. Verified against Node 20, 22, and 24, from both ESM and
CommonJS.

## License

Apache-2.0
