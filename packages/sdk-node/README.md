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
- Nothing is written to your console. Pass `onDiagnostic` if you want to hear
  about failures.

```typescript
const recorder = createRecorder({
  // ...
  onDiagnostic: (d) => logger.warn({ kind: d.kind }, d.reason)
});

const counters = await recorder.shutdown();
// { dropped, transportErrors, captureErrors, breakerOpened, sent }
```

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
| `**.authorization` | that name **wherever it is filed**, at any depth, in the shapes listed below |

Use the `**.` form for anything that is a secret by virtue of its name rather
than its location. The built-in list is written entirely that way, because a
secret is identified by the name it is filed under and not by where in a request
somebody happened to nest it — `config.headers.authorization` is three levels
down and is exactly what an axios error carries.

A `**.` rule, and every built-in name, is matched in exactly these shapes, with
case, `-` and `_` ignored:

- an object key at any depth, including in objects inside arrays and in the
  contents of a `Map`, `Headers` or `URLSearchParams`
- a name-value pair: an array element that is a two-element array whose first
  item is a string, such as fetch's `[["Authorization", "Bearer …"]]`
- a name-value object in an array, with exactly the keys `name` and `value`
  (HAR) or `key` and `value` (Playwright's `headersArray`)
- an interleaved header list: a flat string array of even length whose
  even-indexed items are all valid HTTP header names or HTTP/2 pseudo-headers
  such as `:path`, and include at least one common header (`host`,
  `user-agent`, `content-type`, `authorization`, `cookie`, the pseudo-headers
  and a few others), such as Node's `rawHeaders` from `node:http` and
  `node:http2`, on a request or a response
- a `Name: value` line in an HTTP header block: a string containing a CRLF, read
  up to its first empty line, such as the `_header` of the `http.ClientRequest`
  axios puts on `error.request`; only the rest of that line is replaced

In the positional shapes, a value that is itself a common header name is kept,
so `allowedHeaders: ["Authorization", "Content-Type"]` is not altered.

A name filed any other way is not matched. Payload strings are not masked by
shape. The known gaps are listed in `SECURITY.md` section 4: header values held
as `Buffer`s, header blocks with LF-only or CR-only line endings, a header block
after an empty line, obs-fold continuation lines, names padded with whitespace,
and arrays of three or more elements.

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
| `batchSize` | `20` | |
| `flushIntervalMs` | `1000` | |
| `requestTimeoutMs` | `1500` | |
| `maxBufferedEvents` | `1000` | oldest are dropped past this |
| `maxPayloadBytes` | `262144` | larger payloads record a marker instead |
| `onDiagnostic` | — | |

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
