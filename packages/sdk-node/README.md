# @wayscribe/node

Record what happened to one customer record as it crossed your services, and see
where a value changed.

This is the Node.js SDK for [Wayscribe](https://gitlab.com/jojithedev/wayscribe),
a self-hosted, record-level debugging tool. You run the server yourself; nothing
leaves your infrastructure.

- **No runtime dependencies.** This package is embedded in your application, so
  it brings nothing with it.
- **Cannot break your application.** Every entry point is wrapped so that a
  recorder failure is counted, not thrown. Details below.
- Apache-2.0.

## Install (not yet on npm)

**The package is not published yet.** Until it is, pack it from a clone of this
repository and commit the tarball to your application:

```bash
# In the clone. `pack:release` builds first and prints the tarball's path. Give
# it an absolute directory: it runs from packages/sdk-node.
pnpm install
pnpm --silent --filter @wayscribe/node run pack:release /path/to/your-app/vendor/
```

`--silent` is there so that capturing stdout gives the tarball's path and
nothing else. `pack.mjs` itself prints only the path, and the build's output goes
to stderr; `--silent` also drops the announcement line `pnpm run` prints for the
script, which lands on stderr with pnpm 11 and has not always. Capture the whole
of stdout rather than its last line.

```json
{
  "dependencies": {
    "@wayscribe/node": "file:vendor/wayscribe-node-0.1.0.tgz"
  }
}
```

```bash
# In your application.
npm install
git add vendor/wayscribe-node-0.1.0.tgz package.json package-lock.json
```

**Why a tarball rather than a path into the clone.** `npm install
/path/to/wayscribe/packages/sdk-node` links your application to a
directory that has to stay built: its `dist` is not in git, so the day somebody
runs `git clean`, switches branch, or deploys to a machine without that clone,
the import fails. That matters most for a job with no build step of its own,
such as a script run by cron or launchd, where nothing rebuilds the SDK before
it runs. A tarball is a built copy that travels with your application and
installs the same way on every machine.

**After pulling a change that adds or updates the tarball, run `npm ci`** (or
`npm install`) before the next run. The lockfile's integrity hash for the
package changed, and until the install runs, `node_modules` still holds the
old copy, or holds none on a fresh deploy. The first service instrumented
this way had a deploy that skipped the install, and it hung.

To take a newer SDK, pack again, replace the tarball, run `npm install`, and
commit both. Once the package is published, all of this becomes:

```bash
npm install @wayscribe/node
```

[`examples/instrument-a-service`](../../examples/instrument-a-service/README.md)
installs from the clone's directory instead, because it lives inside the
clone.

## Record a journey

```typescript
import { createRecorder } from "@wayscribe/node";

const recorder = createRecorder({
  endpoint: process.env.WAYSCRIBE_URL ?? "http://localhost:8080",
  apiKey: process.env.WAYSCRIBE_API_KEY ?? "",
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

Then search Wayscribe for `account.Id` and read the timeline.

**Aliases are masked when they are read**, because they are other identifiers
for the record and a reader may not be entitled to them. An identifier that is
public by nature can be shown in full by listing its type:

```typescript
journey.identify(
  { postingId: posting.id, recruiterEmail: posting.contact },
  { displayableAliases: ["postingId"] }
);
```

List the type every time you state the alias: it is shown in full only while
every event that stated it listed it, so one `identify` without the list masks
it again for good (ADR-053). `startJourney({ entity, aliases, displayableAliases })`
and `record({ ..., aliases, displayableAliases })` take the same list, under the
same name. Never
list an email address, a customer number, or anything else a reader of the
timeline should not see: **a displayable alias is stored and searched in plain
text exactly as a label is**, and the API's `q` filter matches it the same way.
The SDK raises the same `personal_data_in_public_value` warning for a
displayable alias whose value looks like an email address or a telephone
number, once per process and shape for aliases, and never changes the value
(ADR-060). An
alias you do not mark displayable is masked when it is read, so nothing is said
about it.

**Name the step when more than one service identifies the record.** An
`identify` step is called `identify`, which reads well once and badly twice: an
intake service and a CRM sync both identifying one lead put two steps of the
same name on its timeline. Give the step its own name instead (ADR-060):

```typescript
journey.identify({ hubspotContactId: contact.id }, { name: "identify-crm" });
```

The operation is still `identified`, so the timeline reads the same way. A name
that is not a non-empty string is reported as `capture_error` with code
`invalid_options`, and the step is recorded as `identify`: the aliases are the
point of the call, and losing them over a name would be the worse trade.

## Name a journey

A label is what the Journeys page shows for a journey, and partial text typed
into its filter matches it, so a journey can be found from what you remember
of it rather than from an identifier:

```typescript
const journey = recorder.startJourney({
  entity: { type: "job_posting", id: posting.id },
  label: `${posting.company} · ${posting.title}`
});

// Or at any point later, once you know what to call it.
journey.label(`${posting.company} · ${posting.title}`);
```

`label` records nothing by itself. Every event this journey object records
after it carries the label, including events recorded through
`recorder.across`. The server keeps the label of the event that started last,
so repeating it on every event costs nothing, and an event that is lost cannot
take the label with it. A later `label` call replaces the label from the next
event on. Events started in the same millisecond keep the order the server
received them in, and the recorder sends a journey's events in the order they
were recorded unless it sends several batches at once (`maxConcurrentSends`),
in which case a label set within the same millisecond may lose to the one
before it. The label belongs to the object: a second handle for the same
journey, from `continueJourney`, carries none until you set one (pass `label`
to `continueJourney` to set it there),
and a group made from a journey's context rather than the journey itself
carries none either. In `recorder.across`, a journey handle made by a
different recorder carries no label.

**A label is stored, shown and searched in plain text, and is never
redacted.** It is text you wrote to be read. Do not put personal data in it:
no names of people, email addresses, customer numbers, or anything else a
reader of the journey list should not see.

The SDK warns when it sees one kind of mistake. A label, an alias you marked
displayable, or an error's message, that holds what looks like an email
address or an international telephone number raises one
`personal_data_in_public_value` diagnostic, and prints one line even with
`logDiagnostics` off, once per process for each of the three and each value
shape, so a warning about one never silences another. **The value is never changed**, and the warning is never a
refusal: this is ADR-055's rule for secret-looking names, applied to personal
data (ADR-060, ADR-062).

The check is deliberately dumb, an email shape and an international phone shape
and nothing else, so that it does not print at every deploy for text that is
fine. A telephone number is a `+` at the start or after a space, a bracket, a
quote, `,`, `;`, `=` or `:`, so `phone=+19195551234` counts, followed by 8 to
15 digits with separators between them, or 10 to 15 written as one run, so a
signed count such as `Received +12345678 bytes` does not. It does not catch a person's name, a customer number, a national
telephone number written without a `+`, or anything else, so the rule above
still needs reading. If what it found is not personal data, nothing needs
doing.

It never throws. A label over 200 characters (Unicode code points, as the
server counts them) is cut to its first 199 and `…`, never inside a character,
and reported once as `payload_truncated`. A label that is empty, is only
whitespace, or is not a string, is not set, and is reported as `key_dropped`; the journey keeps any
label it already had, and its events are sent as usual. Both are counted
(`payloadsTruncated`, `keysDropped`) once, when `label()` is called, not once
per event that carries the label.

## Wrappers

`transform`, `persist`, `publish`, and `deliver` each run your callback, return
its value unchanged, and rethrow its exact error object. They differ only in the
operation they record, which is what makes the timeline readable.

**They preserve the shape of your callback.** A callback that returns a value
returns a value; one that returns a promise, or any other thenable, returns a
native promise of its resolved value, which the exported type `WrapResult<T>`
states in one signature rather than two. So wrapping a synchronous call does not
change the control flow around it. (A second implementation of these wrappers,
such as a recorder that records nothing, is assigned to them with no cast, but
its body still casts its own return to `WrapResult<T>`: a conditional type
cannot resolve while `T` is a type parameter.)

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

`true` records `send-to-crm reported a failed result.` with the code
`result_failed`. **Return the reason instead** and the timeline says which
failure it was, so a 429 and a 400 with a validation message no longer read
alike (ADR-060):

```typescript
const response = await journey.deliver("send-to-crm", payload, () => post(payload), {
  isFailure: (result) =>
    result.status < 400 ? false : { message: result.body.error, code: `http_${result.status}` }
});
```

A string is the message on its own, and `{ message, code }` (the exported type
`FailureReason`) gives either or both; a field that is not a non-empty string
falls back to the generic text and `result_failed`, so a reason you got wrong
still records the failure rather than losing it. **Every falsy value is not a
failure**: `false`, `undefined`, `null`, `""`, `0` and `NaN`, so
`isFailure: (result) => result.errors.length` means what it has always meant. The message is masked for credential shapes
and bounded like any other error you give the SDK. **It is not masked for
personal data**: an email address or a telephone number in it is stored and
shown in plain text wherever the timeline is, and one that looks like it raises
the `personal_data_in_public_value` warning described under
[Name a journey](#name-a-journey). Build the message from what your code knows,
such as the status, rather than from a response body that may name a person
(F-041). An `isFailure` that throws
costs the verdict and nothing else: your value comes back, the step is recorded
as the success it looked like, and a `capture_error` says so.

**Metadata from the result.** `metadata` is copied when the wrapper is called,
before your callback runs, so an HTTP status or a `Retry-After` does not exist
yet. `metadataFrom` runs after the callback returned or resolved and is merged
over `metadata` (ADR-060):

```typescript
const response = await journey.deliver("push-crm", payload, () => post(payload), {
  metadata: { host: "api.hubapi.com" },
  metadataFrom: (result) => ({
    status: result.status,
    retryAfter: result.headers["retry-after"]
  })
});
```

It receives the resolved value and the journey's context, and runs on that value
whether or not `isFailure` calls it a failure, so a refused call records the
status that explains it. It is not called when the callback throws or its
promise rejects. It runs once per call, or once per journey in a
`recorder.across` group, and nothing is remembered between calls (F-040). Like
`captureInput` and `captureOutput` it must be synchronous and cannot break your
call: one that throws, returns a promise, or returns anything that is not a
plain object leaves the static metadata exactly as it was and reports
`payload_omitted` with code `projection_failed`.

**Recording a view of the value.** `captureInput` and `captureOutput` choose what
is recorded, while the wrapper still hands your code the real value. A step that
returns a PDF can record its size and still return the `Buffer`:

```typescript
const pdf = await journey.transform("render-invoice", invoice, () => renderPdf(invoice), {
  // Typed from the wrapper's input and the callback's resolved value.
  captureInput: (input) => ({ invoiceId: input.id }),
  captureOutput: (buffer) => ({ bytes: buffer.length })
});
// pdf is the Buffer renderPdf returned, typed as one.
```

`captureInput` runs when the wrapper is called, before your callback, and what
it returns is copied there and then, so the record shows the input as it went in
even when the projection returns objects your callback goes on to change. `captureOutput` runs when the callback has returned or
resolved, and receives the resolved value; it is not called when the callback
throws. Both receive the journey's context as a second argument. Both must be
synchronous: one that throws or returns a promise records `[UNCAPTURABLE]` and a
`payload_omitted` diagnostic with code `projection_failed`, and your call and
its return value are unaffected.

**Retries.** Pass the attempt number and the wrapper records `retried` instead of
the natural verb. The SDK cannot count attempts itself: a retry usually happens
in a different process consuming a redelivered message.

```typescript
await journey.deliver("send-to-crm", payload, () => post(payload), { attempt: 2 });
```

## Recording a step yourself

`record` takes an event as it is, for a step no wrapper fits: one that already
happened, or a verdict that ran no code.

```typescript
journey.record({
  operation: "validated", // one of OPERATIONS
  name: "check-credit",
  input: application,
  output: verdict,
  metadata: { ruleSet: "credit-v2" },
  startedAt: checkStartedAt, // epoch milliseconds; defaults to now
  durationMs: 42,
  error: { message: "limit exceeded", code: "over_limit" } // optional
});

journey.fail("move-to-dead-letter", error, { metadata: { queue: "orders-dlq" } });
journey.finish({ status: "completed" }); // or "failed"
```

`OPERATIONS` is the list of the eleven operations the server accepts, and
`Operation` is its type. `error` is an `ErrorInput`: `message`, and optionally
`type`, `code` and `stack`, bounded and masked as [Error messages](#error-messages)
describes. The wrappers and `fail` never send a stack, and you should not
either: it is the largest part of an error, and the timeline already shows
where the failure happened. `fail` is for a terminal failure; a failed attempt
that will be retried is the attempt's own operation with an error, which the
wrappers record.

## The same record, the same journey

A job that meets a record on many runs, with nowhere to keep a journey id
between them, can derive one from the record instead:

```typescript
const recorder = createRecorder({
  // ...
  journeyIdSecret: process.env.JOURNEY_ID_SECRET // at least 32 bytes
});

const entity = { type: "job_posting", id: posting.id };
const journey = recorder.continueJourney({
  journeyId: recorder.journeyIdFor(entity),
  entity
});
```

The id is the same on every run and every machine for the same entity in the
same environment, and it cannot be computed without the secret.

**Do not use an unkeyed hash of the entity instead.** Anybody who knows the
record and the scheme can compute it, and a journey id somebody else can
predict is one they can claim first or append to, from another environment or
through a forged propagated context. The
[ingestion contract](../../docs/INGESTION_CONTRACT.md#5-the-two-409s) describes
that risk. The secret is what makes a derived id as hard to guess as a random
one; keep it like any other credential, and do not reuse the API key.

**Rotating the secret starts new journeys** for every record. The old ones are
kept, and nothing links them to the new ones.

**A consumer with no propagated context can derive the id too.** When a
recorder has a usable `journeyIdSecret`, `continueJourney` that finds no
journey id, in a context or in its own options, derives one from the entity
rather than starting a random journey, so a redelivered message rejoins the
record's timeline instead of opening one per run (ADR-060):

```typescript
// The same journey as journeyIdFor(entity) would give.
const journey = recorder.continueJourney({ entity });
```

A journey id you pass wins over the derived one, and a context's wins over
both. **Without a secret this is unchanged: the journey is new, with a random
id, and nothing is reported**, because a recorder without a secret is the
default and not a misconfiguration. An entity the server would refuse starts a
new journey too, and is reported as it already was.

**Without a usable secret, `journeyIdFor` does not throw.** It reports a
`configuration_error`, counts it in `configurationErrors`, and returns a fresh
random id, so recording carries on and the journeys split until the secret is
set. A secret shorter than 32 bytes is reported once when the recorder is
created, and never used. Because split journeys are easy to miss, a missing or
short secret also prints one line to stderr, once per process, even with
`logDiagnostics` off; it is one of the six warnings the SDK prints unasked
([It cannot break your application](#it-cannot-break-your-application)). An entity
whose type or id is empty, or holds an unpaired surrogate, is refused the same
way (reported, random id, no warning line): the server refuses such an entity,
and an unpaired surrogate cannot be encoded faithfully either. The SDK reads no environment variable for it: the
variable name above is your application's. Assert
`recorder.counters().configurationErrors === 0` in a test to catch a missing
secret before it ships.

The derivation is specified in [SDK_SPEC.md](../../docs/SDK_SPEC.md) (SDK-55),
with test vectors in
[`journey-id-derivation.json`](../protocol/fixtures/journey-id-derivation.json).

## One operation, many records

A write that covers many records at once, such as a digest or a batch export,
is one operation in each of their timelines. `recorder.across` records it on
all of them in one call:

```typescript
const group = recorder.across(journeys);
await group.persist("write-digest", digest, () => writeDigest(digest), {
  // Each journey's event can carry its own view of the shared input.
  captureInput: (_digest, journey) => digest.lineFor(journey.entity.id)
});
```

Each journey gets its own event, with its own id, and all of them share one
timestamp and one duration. The callback runs once, and the group's wrappers
keep every promise the single-journey ones make. A group also has `record`,
`fail` and `finish`. It has no `identify`, because an alias identifies one
record. It has no `label` either: labels belong to journeys, and each event a
group records carries the label of its own journey, when the group was given
the journey rather than its context. A journey named twice, as a handle or as
a context, is recorded once, with the first handle's label; an empty group
runs the callback and records nothing.

## Crossing a process boundary

A journey that stops at a service boundary is three unrelated timelines. Inject
context on the way out, extract it on the way in, and continue the journey
with what you extracted.

```typescript
// Producer
await fetch(url, { headers: recorder.injectHttpHeaders({}, journey.context()) });

await sqs.send(
  new SendMessageCommand({
    QueueUrl: url,
    MessageBody: JSON.stringify(message),
    MessageAttributes: recorder.injectSqsAttributes({}, journey.context())
  })
);
```

```typescript
// Consumer of an HTTP request. A fetch Headers object works too.
const journey = recorder.continueJourney({
  context: recorder.extractHttpContext(request.headers),
  entity: { type: "customer", id: body.customer.externalId }
});

// Consumer of an SQS message
const journey = recorder.continueJourney({
  context: recorder.extractSqsContext(message.MessageAttributes),
  entity: { type: "customer", id: body.customer.externalId }
});
```

`continueJourney` takes the journey from `context` when there is one, and
starts a new journey when there is none, as for a request from a caller that
does not record. A context without a journey id, such as `{}` or a journey
handle passed instead of its `context()`, is reported as `journey_id_invalid`
and treated as absent. `entity` is the entity to use when the context carries
none, which is the default. By default the entity **ID does not propagate**: it is
often a real customer identifier, and sending it by default would write it into
the headers, queue metadata, and logs of systems you may not control. The
consumer supplies the ID it already has from the message body. A journey id you
already hold, such as one from `journeyIdFor`, is passed as `journeyId`
instead of `context`.

**An entity the server would refuse is not sent.** When `startJourney` or
`continueJourney` gets no entity, or one whose type or id is not a non-empty
string, it reports `entity_invalid` and records the journey's steps under the
entity `{ type: "unknown", id: "unknown" }`, so they are kept rather than
refused. Search finds them by their aliases and labels; fix the call to have
them filed under the record. The entity is copied, so changing your object
afterwards does not change what is recorded.

The helpers return a copy: the headers or attributes you pass are not changed,
and anything already in them is kept, except a journey's own headers or
attributes, which are replaced, so forwarding an inbound message's cannot pair
an old entity id with the new journey. Without a context, `injectHttpHeaders`
and `injectSqsAttributes` return what you passed and report `context_missing`;
a context passed as the only argument to `injectSqsAttributes` is not sent as
attributes. The extract helpers return `undefined` for anything that does not
carry a well-formed journey.

**A carrier with neither headers nor attributes** can carry the journey in an
envelope around the payload:

```typescript
const body = JSON.stringify(recorder.injectPayload(order, journey.context()));

// On the other side
const { context, data } = recorder.extractPayload(JSON.parse(raw));
const journey = recorder.continueJourney({ context, entity: { type: "order", id: data.id } });
```

`extractPayload` returns a body that is not an envelope as `data`, with no
context, so a consumer can read old and new messages alike.

`injectPayload` returns `PayloadEnvelope<T>`: `ContextEnvelope<T>` when there
was a journey to inject, and `NoContextEnvelope<T>`, whose `_wayscribe` is
empty, when there was not, which is what a recorder given no context produces.
Both are exported, so a queue typed on its job payload names the union and
needs no cast (ADR-060).

**Reading a journey back out of an envelope.** `extractPayload` is the usual
way, and the only one that also reads a body that is not an envelope at all.
For a reader holding the envelope itself, three formulations work, checked
under this repo's TypeScript settings:

```typescript
import { hasJourney, type PayloadEnvelope } from "@wayscribe/node";

// 1. The exported type guard narrows the envelope itself. It takes anything,
//    a body typed `unknown` included, and never throws.
if (hasJourney(envelope)) {
  const journey = recorder.continueJourney({ context: envelope._wayscribe, entity });
}

// 2. Destructuring first narrows too: the journey id is then a top-level
//    discriminant, and entityType and entityId are reachable beside it.
const { _wayscribe } = envelope;
if (_wayscribe.journeyId !== undefined) {
  const { journeyId, entityType } = _wayscribe;
}

// 3. Reading the id alone needs no narrowing: it is `string | undefined`, and
//    inside the check it is `string`.
const journeyId = envelope._wayscribe.journeyId;
```

**What does not work is the obvious fourth:**
`if (envelope._wayscribe.journeyId !== undefined)` does **not** narrow
`envelope`. TypeScript narrows a union on a discriminant it can see at the top
level, and this one is nested, so inside that block the envelope is still the
union and assigning it to `ContextEnvelope<T>` is an error. The compiler's
message talks about assignability and says nothing about narrowing, which is
why this looks right; use one of the three above.

`hasJourney` answers `false` both for a value that is not an envelope, such as
`{ a: 1 }`, and for an envelope with no journey, such as `{ _wayscribe: {},
data }`. A consumer that must tell those apart, to unwrap `data` from the
second and not the first, checks for `_wayscribe` itself (F-034).

| `propagation` | Emits |
| --- | --- |
| `journey-only` | journey ID |
| `journey-and-type` (default) | journey ID, entity type |
| `full` | journey ID, entity type, entity ID |

**Aliases never propagate, at any level.** Not configurable.

No propagation specification fixes the header, attribute and envelope names or
their value grammar yet, so these helpers are experimental (see
[Stability](#stability)).

## It cannot break your application

An observability library that takes down the service it observes is worse than
no library. This one is built so that cannot happen:

- Every public entry point is wrapped. A failure inside the recorder increments a
  counter and returns; it never propagates to your code.
- Wrappers return your callback's value unchanged and rethrow its exact error
  object: the same instance, so `instanceof` checks and custom properties on
  your errors keep working.
- The event queue is bounded. Under backpressure it drops the oldest events and
  counts the drops rather than growing without limit.
- The transport retries with a circuit breaker, and gives up rather than piling
  up.
- `shutdown()` never hangs; it races the final flush against a timeout, and
  counts every event it could not deliver as `dropped`, so `sent + rejected +
  dropped` equals `recorded`. A payload too large to capture is counted in
  `payloadsOmitted` instead, and one sent with a string cut in
  `payloadsTruncated`, because its event is still sent.
- Nothing is written to your console unless you set `logDiagnostics`, with
  six exceptions, each printed once per process: a `journeyIdSecret` that
  cannot be used; a required setting (`endpoint`, `apiKey`, `serviceName`,
  `environment`) that is missing, empty, blank or not a string, since nothing
  recorded reaches the server until it is fixed; an optional setting the
  recorder could not use, which it replaced with its default or clamped into
  range; a setting under its old name (`maxPayloadBytes`, `propagate`), since
  its value is not read; once per
  name, a field whose name looks like a secret that was sent in plain text; and,
  once per field and value shape, a journey label, a displayable alias or an
  error message that looks like personal data. A line names the setting or
  the field, never its value. Pass `onDiagnostic` if you want to hear about failures in your own
  logger.
  An optional setting used to be silent unless `logDiagnostics` was on, so a
  recorder could run on a default nobody chose while every event it was meant
  to bound or enrich kept flowing and the counters read healthy (ADR-060).
- **Those six exceptions are not turned off by anything.** Neither
  `logDiagnostics: false` nor an `onDiagnostic` of your own suppresses them:
  they print to `console.error` regardless, and they reach `onDiagnostic` as
  well, so a caller with both set sees one of them twice, once as structured
  output and once as a raw line. The two options decide whether and how the
  SDK's ordinary diagnostics are seen; these six stand outside them
  deliberately. Four of them mean a setting is not being used as you wrote it,
  and the first two of those mean nothing you record is reaching the server at
  all. The other two mean a value that looks like a credential, or like
  personal data, is now stored in plain text, which no later configuration
  change undoes. An operator looking for any of them goes to the container's
  logs, which is where the line lands whatever the SDK was configured with.
- A bad configuration value never stops your application starting. It is
  reported as a `configuration_error` and replaced by its default, or clamped
  into range. Values are not converted: `maxBufferedEvents: "5000"`, as read
  from `process.env`, is not a number, so the default is used and reported.
  An option under the name it had before 0.1 (`maxPayloadBytes`,
  `propagate`) is not read; it is reported as `setting_renamed`, naming the
  new option, and printed once per process like a missing required setting.
- A value your code throws that cannot even be described, such as a revoked
  Proxy, is still handled: the wrapper rethrows it as it was, and the step is
  recorded with the error message `The thrown value could not be read.`

```typescript
const recorder = createRecorder({
  // ...
  onDiagnostic: (d) => logger.warn({ kind: d.kind, code: d.code }, d.reason)
});
```

## Sending and shutting down

Events are sent in the background, in batches, and never while your code
waits. Three calls control that:

```typescript
await recorder.flush(); // send everything queued now, and wait for it

const counters = await recorder.shutdown({ timeoutMs: 2_000 }); // the default
// { recorded, sent, rejected, dropped, transportErrors, captureErrors,
//   breakerOpened, payloadsOmitted, payloadsTruncated, keysDropped,
//   configurationErrors, rejectedSettings, rejectedOptions,
//   unredactedSecretNames, personalDataInPublicValues }

recorder.counters(); // the same numbers, at any time
```

Call `shutdown()` before the process exits, or the last batch never leaves.
It stops accepting events, sends what is queued for up to `timeoutMs`, gives up
the rest, and resolves with the counters. An event recorded after it is not
sent, and is counted as `recorded` and `dropped`. `flush()` is for a
short-lived job that records more after sending, such as a test.

**Counters count one thing each.** `recorded` is every event the recorder
built, and `sent` every event the server stored. Every other counter counts the
diagnostics of one kind, one per report (see the table below). Once
`shutdown()` has returned, `sent + rejected + dropped === recorded`, which a
test can assert.

`rejectedSettings` and `rejectedOptions` are the exceptions, and the two
entries that are not numbers: they name what the `configuration_error` reports
were about, in the order first seen and once each, so a test or a health check
can say *which* setting was rejected rather than only how many were. Neither
holds a value, and each holds at most 50 names (ADR-060, ADR-062).

- `rejectedSettings` is what `createRecorder` refused: a setting, a setting
  given under its old name, an unusable `journeyIdSecret`, or a part of
  `deployment` (see [Which build recorded this](#which-build-recorded-this)).
  It is fixed once `createRecorder` returns, so it gives the same answer
  whenever you read it. An entry means the process is misconfigured.
- `rejectedOptions` is what a later call was refused: `entity`, `context`,
  `journeyId`, `journeyIdSecret` (a call that needed a secret the recorder does
  not have, or cannot use), and the old option names `entityFallback` and
  `displayable`. An entry means one call site passed something odd (F-038).

`configurationErrors` counts every report from both.

```typescript
// A recorder that started on a default nobody chose is a deploy that is wrong
// in a way nothing else reports. Calls never add to this list.
expect(recorder.counters().rejectedSettings).toEqual([]);
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
[wayscribe] delivered_first: Connected to http://localhost:8080; the server accepted 3 events.
```

If that line never appears, the lines that do say why:

```text
[wayscribe] rejected: unauthorized_environment (the server's message goes to onDiagnostic)
[wayscribe] transport_error: fetch failed
```

Each diagnostic kind prints at most one line a minute, and the next line of that
kind, or `shutdown()`, says how many repeats were suppressed. A line holds the
kind and a reason only, never a payload, a key, or the diagnostic's `detail`. The
reason is masked for credential shapes by the same rules as error messages, cut
to 512 characters, kept to one line, and stripped of control and bidirectional
formatting characters.

**A refusal prints the server's error code and the path of the first field it
names, and not the server's message**, as in
`rejected: invalid_event at event.name`. The message is the server's own text,
and masking catches only credential shapes. Wayscribe's API puts no event
values in its messages, but the SDK cannot tell that API from a proxy or another
server that echoes what it was sent, and a console line usually ends up in a
log store you may not control. The whole message, with the field error, still
reaches `onDiagnostic` as the diagnostic's `reason`, and its error as
`detail.serverError`, so while setting up:

```typescript
onDiagnostic: (d) => {
  if (d.kind === "rejected") console.error(d.reason, d.detail.serverError);
}
```

A server error code that does not look like an identifier prints as `rejected`, and a path
that does not look like a field path is left out. The same applies to a refusal
for now (below), whose `transport_error` and `dropped` lines carry the code and
not the message.

`delivered_first` also reaches `onDiagnostic`, as
`{ kind: "delivered_first", code: "first_delivery", reason, detail: { endpoint, accepted } }`,
whether or not `logDiagnostics` is on. Its `endpoint` is the scheme, host, and port only: a
path or query can carry a credential, so neither is reported or printed. It is the only diagnostic that is good news and does not
change any counter.

### Handling diagnostics in code

Every diagnostic is `{ kind, code, reason, detail }`. **Match on `kind` and
`code`**, never on `reason`: `reason` is a sentence for a person, and its
wording may change in any release. `detail` is always an object, typed for each
kind (`PayloadTruncatedDiagnostic`, `DroppedDiagnostic`, and so on), so it can
be read without a cast once `kind` is narrowed.

```typescript
onDiagnostic: (d) => {
  switch (d.kind) {
    case "dropped":
      metrics.increment("recorder.dropped", { code: d.code });
      break;
    case "payload_truncated":
      logger.info({ field: d.detail.field, cut: d.detail.charactersRemoved }, d.reason);
      break;
    default:
      // New kinds and codes may arrive in any minor release.
      logger.warn({ kind: d.kind, code: d.code }, d.reason);
  }
}
```

Keep the `default` branch, and do not assign `d` to `never` in it: a new kind
would then fail your build rather than reach your logger.

A counter's name follows its kind: `<noun>_<participle>` counts in
`<nouns><Participle>` (`payload_omitted` in `payloadsOmitted`), `<noun>_error`
in `<noun>Errors`, and a bare participle in itself (`dropped`).

| Kind | Codes | Means | `detail` | Counter |
| --- | --- | --- | --- | --- |
| `delivered_first` | `first_delivery` | the server stored events from this recorder for the first time | `{ endpoint, accepted }` | none |
| `insecure_endpoint` | `unencrypted_endpoint` | the endpoint is `http:` to a dotted name or an IP address off this machine, so the API key travels unencrypted | `{ scheme, host }` | none |
| `rejected` | `event_refused`, `request_refused` | the server understood an event and refused it (`event_refused`), or refused a whole request with a 4xx, once per event in it (`request_refused`); it is not retried | `{ serverError }`, or `{ events, httpStatus }` | `rejected` |
| `transport_error` | `request_failed`, `refused_for_now`, `unexpected_error` | a request failed, or the server could not store an event for now; see below | `{ unsent, abandoned }`, or `{ error }` | `transportErrors` |
| `payload_omitted` | `too_large`, `too_deep`, `too_wide`, `unserialisable`, `projection_failed` | a payload could not fit the server's limits, could not be read (a getter or `toJSON` threw), or a projection failed, and was replaced by a marker; the event is still sent | `{ field }`, and `error` for `unserialisable` and `projection_failed`, never printed | `payloadsOmitted` |
| `payload_truncated` | `strings_cut`, `label_cut` | strings in a payload were longer than the server accepts and were cut, or a label was; the event is still sent | `{ field, strings, charactersRemoved }` | `payloadsTruncated` |
| `key_dropped` | `aliases_not_object`, `alias_invalid`, `displayable_alias_invalid`, `metadata_key_too_long`, `label_invalid` | a metadata key or alias the server would refuse was left off: a key or alias type over 128 characters, or an alias value that is not a string of at most 512; or a label was not set; the event is still sent | `{ field, keys }`, `keys` being how many entries this report covers | `keysDropped`, per report |
| `dropped` | `queue_full`, `after_shutdown`, `shutdown`, `retry_budget`, `no_verdict` | an event was not delivered: the queue was full, it was recorded after shutdown or still undelivered when shutdown finished, the server was still refusing it after 30 seconds or 10 sends, or the server's reply gave no verdict for it | `{ name, operation }` for `after_shutdown`, otherwise `{}` | `dropped` |
| `capture_error` | `unexpected_error`, `not_a_journey`, `invalid_options`, `context_missing` | something threw inside the SDK; `across` was given something that is not a journey; a call's options were not an object or held keys it does not read (such as `fail`'s old positional metadata); or an inject helper was given no context; your call was unaffected | `{ error }` for `unexpected_error`, `{ call }` for `invalid_options` and `context_missing` | `captureErrors` |
| `configuration_error` | `setting_unusable`, `required_setting_unusable`, `setting_renamed`, `journey_id_secret_missing`, `journey_id_secret_unusable`, `entity_invalid`, `journey_id_invalid` | a configured setting could not be used, or was given under its old name; a call needed a setting the recorder does not have, such as `journeyIdFor` without a usable `journeyIdSecret`; or a call was given an entity or journey id it cannot record; the call returned something safe | `{ setting }`, naming what could not be used | `configurationErrors`, and the name in `rejectedSettings` when `createRecorder` reported it or `rejectedOptions` when a later call did |
| `breaker_opened` | `consecutive_failures` | sends pause for 30 seconds after five failed in a row | `{ failures, cooldownMs }` | `breakerOpened` |
| `unredacted_secret_name` | `secret_like_name` | a field whose name looks like a secret was sent in plain text because no redaction rule covers it; once per name; the event is sent unchanged. See [Names no rule covers](#names-no-rule-covers) | `{ field, name, path }`, never the value, with the name as written, cut to 128 characters | `unredactedSecretNames` |
| `personal_data_in_public_value` | `personal_data_shape` | a journey label, an alias marked displayable, or an error message (`field` is `journeyLabel`, `displayableAliases` or `errorMessage`) holds what looks like an email address or a telephone number, and all three are stored and shown in plain text; once per process, field and shape, so at most six; the value is never changed. See [Name a journey](#name-a-journey) | `{ field, shape }`, never the value | `personalDataInPublicValues` |

### An endpoint that is not encrypted

Every request carries the API key, and payloads with it. When `endpoint` is
`http:` and its host has a dot or is an IP address, other than `127.0.0.1`,
`[::1]`, or a `.localhost` name, the recorder reports one `insecure_endpoint`
diagnostic as it is created:

```text
[wayscribe] insecure_endpoint: The endpoint is http: to ingest.internal, so the API key and payloads travel unencrypted. Use https: for any endpoint off this machine.
```

It reaches `onDiagnostic` as
`{ kind: "insecure_endpoint", code: "unencrypted_endpoint", reason, detail: { scheme, host } }`
and names only the scheme and host, never a username, password, path, or query
from the URL. It is a warning: the recorder still starts and still sends, because
a telemetry library that refuses to start breaks the service it observes
(ADR-007). A private address is still reported, because anything else on that
network can read the key. Put TLS in front of the API, or at least terminate it
on the same machine as the service.

A single-label name with no dot, such as `api` or `wayscribe-api`, is not
reported, and neither is `localhost`. A name like that resolves only through
container or cluster DNS, so the traffic stays on the private network Docker
Compose or Kubernetes created, which is how the demo reaches the API. A dotted
name such as `api.example.com` or `ingest.internal`, and any IP address, still
warns.

### When the server cannot store an event for now

The batch route answers each event separately. A refusal with a status below 500
means the event is wrong, and it is reported as `rejected` and not sent again. A
refusal of 500 or above, such as `storage_error` or `query_timeout`, means the
server could not store it this time, so the SDK sends that event again, on its
own, after the same backoff it uses for a failed request.

Each send tries a refused event three times: after the first refusal it waits a
random 0 to 100 ms, and after the second a random 0 to 200 ms. If the server is
still refusing it, the event goes back to the front of the
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

**The 30 seconds and 10 sends apply only to these per-event refusals.** When a
whole request fails (the connection is refused or times out, or the API answers
the request itself with a 5xx), nothing reached a verdict, so the batch goes
back to the queue and is retried, with the same backoff and breaker, for as long
as the outage lasts. What bounds that is the queue: past `maxBufferedEvents`
(1,000 by default) the oldest events are dropped and counted, and whatever is
still queued when `shutdown()` finishes is dropped and counted then.

### When the response has no verdict

The batch route answers 202 with one result per event. If a 2xx response is not
JSON, has no results, or has fewer results than events, each event without a
result is counted as `dropped` with code `no_verdict`, and **not sent again**.
The request did succeed, so the server may well have stored those events, and
sending them again could store them twice; the SDK cannot tell which, so it
counts them as not known to be stored. This is what a proxy that rewrites
responses produces. The body of such a response is never printed or passed to
`onDiagnostic`: the line says `unparseable response body`, not what the body
was.

### At shutdown

`shutdown()` sends what is queued, one batch after another, until the queue is
empty, a pass leaves the queue no shorter than it was, or its timeout passes,
whichever comes first. A pass makes no progress when every event in it comes
back unsent, as against an unreachable endpoint or a server refusing everything
for now, so shutdown stops there, usually well before its timeout, rather than
waiting out the 30-second retry budget. Whatever is left, events the server was
still refusing for now, events queued behind an unreachable endpoint, and a
batch still in flight when the timeout wins, is given up: requests in flight are
aborted, and each of those events is counted once as `dropped`, with code
`shutdown`. An aborted request may already have been stored
by the server, so an event counted this way is not known to be lost, only not
known to be stored.

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
somebody happened to nest it: `config.headers.authorization` is three levels
down and is exactly what an axios error carries.

A `**.` rule, and every built-in name, is matched in exactly these shapes, with
case, `-` and `_` ignored:

- an object key at any depth, including in objects inside arrays and in the
  contents of a `Map`, `Headers` or `URLSearchParams`
- a name-value pair: an array element that is a two-element array whose first
  item is a string, such as fetch's `[["Authorization", "Bearer …"]]`
- a name-value object in an array: a plain object with a string `name` (HAR) or
  a string `key` (Playwright's `headersArray`) beside a `value`. Only `value` is
  replaced, whatever other keys the object has, such as HAR's `comment`
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

### Names no rule covers

Redaction goes by name, so a credential under a name neither list covers is
sent in plain text: rename `authToken` to `sessionCredential` and it is. The SDK
never redacts on a guess, because a guess would change what your diffs show.
It tells you instead, once per name per process, whether or not
`logDiagnostics` is on. With `logDiagnostics` off, the default, the line ends
with a note saying why it was printed:

```text
[wayscribe] unredacted_secret_name: A field named "sessionCredential" (at input.session.sessionCredential) looks like a secret and was sent unredacted. If it holds a secret, add "**.sessionCredential" to the redact option; if it does not, add "sessionCredential" to knownSafeNames. (printed once per process and name, whether or not logDiagnostics is on, because the value is stored in plain text)
```

With `logDiagnostics: true` the same line is printed without the note in
parentheses. Both forms were printed by the built SDK on 2026-09-16.

The line and the diagnostic name the field and where it was, with array
indices written `[*]`; they never include the value. Names are checked as
object keys and in the header shapes listed above: `[name, value]` pairs,
`{ name, value }` objects, `rawHeaders` lists and the lines of a header block.
The warning is given only for a payload the event still carries once it fits
the server's budget, and the event is sent as it was. The printed line is
masked; `onDiagnostic` receives the name as written, cut to 128 characters and
not masked, as it receives every other diagnostic.

A name looks like a secret when it ends in a word such as `token`, `secret`,
`password`, `credential`, `auth`, `cookie`, `signature`, `apiKey`,
`privateKey`, `connectionString` or `dsn`, with case, `-` and `_` ignored. Left
alone are names that only start with one (`tokenCount`, `secretName`),
pagination, cancel and tokenizer tokens (`nextPageToken`, `cancelToken`,
`eos_token`), values that are objects, booleans, empty, or setting words such
as `none` or `basic`, and strings under 8 characters under a name ending in
`auth` (`auth: "jwt"`). The full rule is in
[`SDK_SPEC.md`](../../docs/SDK_SPEC.md) section 13.

Webhook signature headers from Stripe, GitHub, Slack, HubSpot, Twilio and
Shopify are not warned about: they are on the built-in list and redacted,
because a stored signature and body are a request the receiver will accept.

**If it is a secret**, add a rule and the value is replaced from then on:

```typescript
createRecorder({
  // ...
  redact: ["**.sessionCredential"]
});
```

Values already stored stay until they are deleted or expire;
`docs/OPERATIONS.md` section 8 says how to delete them. A name containing `.`,
`*`, `[` or `]` cannot be written as a rule, and the warning says so: rename the
field, or leave it out of what you record.

**If it is not**, say so, and the warning stops. A `sessionId` is warned about,
because a server's session id is a login; an analytics session id is not:

```typescript
createRecorder({
  // ...
  knownSafeNames: ["sessionId"] // an analytics id, not a login session
});
```

`knownSafeNames` takes key names as written, including ones no rule can name,
compared like redaction names, and changes nothing about redaction: a name on
both lists is still redacted. An entry that is not a non-empty string is
ignored and reported as a `configuration_error`.

The server has the same check for senders that are not this SDK: `doctor`
samples recent stored payloads and lists the names it finds
(`docs/OPERATIONS.md` section 12).

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
  OpenAI, Anthropic, npm, SendGrid, Hugging Face and Wayscribe

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
| `Date` | ISO 8601 string, `"2026-01-02T03:04:05.678Z"` |
| anything with `toJSON()` | whatever that returns, then walked again |
| `BigInt` | decimal string, `"9007199254740993"`, digits intact |
| a cycle | `"[CIRCULAR]"` at the point the loop closes; the rest is kept |
| the same object twice | expanded both times; a shared reference is not a cycle |
| `undefined`, a function, a symbol | the key is omitted, as `JSON.stringify` does |
| `NaN`, `Infinity` | `null`, as `JSON.stringify` does |
| a NUL byte in a string | removed, because PostgreSQL rejects it in `jsonb` |
| half an emoji left by `slice()` | repaired to `U+FFFD` |
| `Buffer` | `{"type": "Buffer", "data": [...]}` |
| `Map`, `Headers`, `URLSearchParams` | an object, under the keys the data already had |
| `Set` | an array |
| `Error` | `{name, message}` plus its own properties and its `cause`, and no `stack` |
| `RegExp` | the literal, `"/secret-(\\d+)/gi"` |
| a string over 65,536 characters | its start and `[TRUNCATED: 4500 characters removed]`, 65,536 characters in all, and a `payload_truncated` diagnostic |
| a payload that cannot fit the event's budget, even cut | `"[PAYLOAD_TOO_LARGE]"`, and a `payload_omitted` diagnostic |
| nested more than 30 levels, or an object or array of more than 1,000 entries | `"[PAYLOAD_TOO_LARGE]"`, and a `payload_omitted` diagnostic |
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
- A `Map` may be keyed by anything, and two keys can render to one name, such as `1`
  and `"1"`, or two different objects. When that happens the entry is reported
  as `"[COLLIDED_KEYS]": n` rather than lost quietly.

An `Error`'s `stack` is left out: it is the largest field on a typical error and
the timeline already carries the failure. An error with its own `toJSON` is
asked first, so a library that chooses to include its stack still does.

### Fitting the server's limits

The server refuses a whole event that breaks one of its limits (the
[ingestion contract](../../docs/INGESTION_CONTRACT.md#3-limits) lists them), so
the SDK makes every event fit before sending it, with the same check the server
runs:

1. A payload nested more than 30 levels deep (the envelope takes the other two),
   or with an object or array of more than 1,000 entries, is replaced with
   `[PAYLOAD_TOO_LARGE]`.
2. Every string longer than 65,536 characters is cut to its start and
   `[TRUNCATED: 4500 characters removed]`, 65,536 characters in all.
   "Characters" are UTF-16 code units, what `string.length` counts. Cutting
   happens after redaction, so it never reveals a masked value.
3. If the whole event is still over `maxEventBytes`, the larger of `input` and
   `output` is replaced with `[PAYLOAD_TOO_LARGE]`, then the other, then
   `metadata` is left off.

4. A top-level `metadata` key over 128 characters is left off, and
   `"[KEY_TOO_LONG]": <n>` says how many went. An alias whose type is over 128
   characters, or whose value is not a string of at most 512, is left off with
   no marker, since a marker would be stored as an alias. Both are reported as
   `key_dropped`. Characters here are code points, as the server counts them.
5. An error's `type` or `code` over 256 characters is cut, ending in
   `[TRUNCATED]`.
6. A journey label over 200 code points is cut to 199 and `…`, as
   [Name a journey](#name-a-journey) describes.

The event is always sent. `maxEventBytes` is the budget of the whole event,
not of one payload, and should be the server's `MAX_EVENT_PAYLOAD_BYTES`:
raising it above that only produces events the server refuses.

A value that cannot be captured never costs you the event. The step is recorded
either way, with a marker in place of the payload, because the step whose payload
would not serialize is very often the step you are trying to debug.

## What it costs

Measured with the SDK's own benchmark on an Apple M3 Pro (12 cores, 18 GiB),
macOS 26.2, Node 24.19.0, with the default configuration and
`maxConcurrentSends` of 4. The time per call and the sustained load were
measured on 2026-09-17, with the SDK as it is now, including the check for
secret-looking names; the send concurrency tables are from 2026-09-15. The
machine was running other work, so read the numbers as orders of magnitude; the
maximums in particular are noisy. To reproduce, from the repository root (about
ten minutes for everything, three for the time per call):

```bash
pnpm --filter @wayscribe/node bench
pnpm --filter @wayscribe/node bench -- --only=latency --awake
pnpm --filter @wayscribe/node exec node bench/capture-cpu.mjs
```

**Time added to each wrapped call**, in microseconds, against a local stub
answering like ingestion. A `transform` records its input and its output, so it
captures the payload twice; the `persist` here returns a small object. Each 1 KiB
row is 10,000 calls at 2,000 a second; each 64 KiB row is 2,500 calls at 250 a
second, so its p99 is the 25th slowest call and moves a lot between runs.

The benchmark sleeps between calls, and how long a call takes depends on whether
the processor was idle before it. The first two columns are the default run, in
which the cores go idle between calls, like a service that is mostly waiting.
The last two are the same run with a thread in the process that wakes every
100 µs (`--awake`), which keeps a core awake the way a busy service does.

| Wrapper | Payload | Cores idle, p50 | Cores idle, p99 | Core awake, p50 | Core awake, p99 |
| --- | --- | --- | --- | --- | --- |
| `transform` (sync) | 1 KiB | 89 | 1,341 | 31 | 324 |
| `persist` (async) | 1 KiB | 67 | 1,507 | 18 | 205 |
| `transform` (sync) | 64 KiB | 1,816 | 14,424 | 1,563 | 12,336 |
| `persist` (async) | 64 KiB | 1,541 | 12,875 | 757 | 6,477 |

A second run of each gave 114, 48, 1,811 and 1,221 µs at p50 with the cores
idle, and 34, 18, 1,677 and 763 with a core awake. `bench/capture-cpu.mjs`, which
calls the wrappers in a tight loop with no network, measured 32, 17, 1,769 and
827 µs per call.

**What changed on 2026-09-16.** The run of 2026-09-15 gave 30, 75, 1,420 and
1,079 µs at p50, and one earlier on 2026-09-16 gave 112, 93, 2,172 and 1,717. Most
of that difference was the machine, not the SDK: the build measured on
2026-09-15 gives 84 µs for a 1 KiB `transform` with the cores idle and 27 µs
with a core awake, measured the same day as the rest of this section. The rest
was real. Fitting every event to the server's limits (ADR-051) had added a
second check of the whole event and a second walk to cut long strings, which
on its own made a 1 KiB `transform` about 40 percent slower (29 to 41 µs in the
tight loop, on the commits either side of it). From the 2026-09-15 build to the
one before this change, 28 µs became 41 µs, and 1,375 µs became 2,122 µs at
64 KiB. The check for secret-looking names (ADR-055) moved the tight loop by
less than 4 percent. The event is now
measured with plain `JSON.stringify` when it is certainly within its budget,
and long strings are cut in the same walk that makes the payload storable,
with the same result: 31 and 1,781 µs. The size check now also stops as soon
as a payload is certainly over budget, which costs about 2 µs at 1 KiB.

Most of what remains is redaction and the copy that makes a payload safe to
store, and it grows with the payload. The p99 is dominated by one call in every
batch of 50: the call that fills a batch starts its send, and serialising the
batch happens inside that call. At 64 KiB a separate one-off measurement, timing
`JSON.stringify` inside those calls on 2026-09-15, put it at about 8 ms of an
11 ms call. The event loop spends that time whichever call it lands in.

**Capture never waits on the network.** With a core awake, the added p50 was the
same against a stub that answers after 200 ms, against one that refuses
connections, and against the local stub: 31 to 34 µs for `transform` at 1 KiB
and 18 to 19 µs for `persist`, in two runs on 2026-09-17, and within 4 percent
of the local stub at 64 KiB. Neither comes near the 200 ms a call would add if
it waited on the request. The p99 was lower against the refusing endpoint (53
against 324 µs for `transform` at 1 KiB), because no batch is ever serialised.

With the cores idle the figures move more: 90 and 125 µs for `transform` at
1 KiB against the refusing endpoint, 89 and 114 against the local stub. On
2026-09-16 the refusing endpoint read higher in both runs (98 and 135 against 86
and 88). That is the processor, not the SDK: a process whose sends fail at once
does less between calls, so its cores sit idle longer. Before 2026-09-16 there was also a real difference, about 6 µs a call:
while the circuit breaker was open, every recorded event started a send that
failed at once and put its batch back. The recorder no longer starts a send
while the breaker is open; the interval tries again after the cooldown.

Unreachable, every event is dropped and counted: those beyond the queue's 1,000
as it fills, and the rest when `shutdown()` finishes. Against the 200 ms stub
at 2,000 calls a second, one process sending 4 batches at a time stores about
1,000 events a second and drops the rest, which the concurrency table below
shows in detail.

`src/capture-walks.test.ts` counts the calls instead of timing them: each payload
is checked, redacted and stored once, and an event within budget skips the
server's check, so the extra walks fail on any machine. `src/overhead.test.ts`
only trips on a gross slowdown, a ratio of 11 to plain work (7.2 to 8.0 on
2026-09-16, 9.31 to 10.05 before the fix). Run the benchmark above before a release all the same.

**Sustained load:** 2,000 wrapped calls a second for 60 seconds, 1 KiB,
alternating `transform` and `persist`, with the cores idle between calls.

| | Unwrapped | Wrapped |
| --- | --- | --- |
| Heap after GC, start to end | 7.0 to 8.0 MiB | 9.2 to 9.4 MiB |
| Heap, highest of one sample a second | 8.8 MiB | 60.5 MiB |
| Resident set size at the end | 76 MiB | 219 MiB |
| Event-loop delay beyond its 10 ms timer, p50 / p99 | 0.45 / 0.99 ms | 0.17 / 1.73 ms |
| Events stored / dropped | | 124,000 / 0 |

The 124,000 events stored are the 120,000 of the measured minute and the 4,000
recorded during the two seconds of warm-up before it.

The heap after collection grows by 0.2 MiB over the minute, as the unwrapped
run's grows by 1.0 MiB. The heap figure
between collections is a sample taken once a second, not a true peak. The
resident set is about 140 MiB larger; the heap between collections accounts for
about 50 MiB of that, and the benchmark does not break down the rest.

**Send concurrency:** one process producing events for 15 seconds against a stub
with a fixed delay per batch, measured on 2026-09-15.

This table models one process against a server that can serve any number of
requests at once. It shows what a low cap costs that one process; it does not
justify a higher default for a fleet, and the default stays 4 because of what it
leaves out. Every ingestion request holds one database connection, so a fleet of
processes shares instances times pool size.

`pnpm --filter @wayscribe/node bench:fleet` models that case: ten SDK
processes at 200 events a second each, five times that for ten seconds of a
thirty-second run, against one API instance with a pool of ten connections and
4 ms per event (about 2,500 events a second). The model copies the API's batch
route, pool, and behaviour when a client gives up, and nothing else. Measured on
2026-09-15:

| | `maxConcurrentSends` 4 | `maxConcurrentSends` 8 |
| --- | --- | --- |
| Unique events the server stored | 70,558 | 16,175 |
| Server work spent on duplicates | 0 | 10,320 of 26,495 (39%) |
| Replies nobody was waiting for | 0 | 280 |
| Breaker opened, across the fleet | 0 | 40 |
| SDK sent / dropped, of about 140,000 | 70,495 / 69,494 | 12,495 / 127,500 |

At 8, requests queued for a connection past `requestTimeoutMs`, so the SDK
abandoned batches the server went on to store and sent them again. The server
stored more unique events than the fleet counted as sent: an abandoned batch is
counted as dropped even when the server finished it.

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
| `endpoint` | none | required |
| `apiKey` | none | required |
| `serviceName` | none | required |
| `environment` | none | required; must match the API key's environment |
| `captureMode` | `redacted-payload` | or `metadata-only`, `full-payload` |
| `redact` | `[]` | appended to the built-in secret paths; at most 1,000 |
| `propagation` | `journey-and-type` | see [Crossing a process boundary](#crossing-a-process-boundary); experimental |
| `batchSize` | `50` | at most 100, the server's limit |
| `flushIntervalMs` | `1000` | |
| `requestTimeoutMs` | `1500` | |
| `maxBufferedEvents` | `1000` | oldest are dropped past this |
| `maxEventBytes` | `262144` | the byte budget of one whole event; set it to the server's `MAX_EVENT_PAYLOAD_BYTES` |
| `onDiagnostic` | none | does not suppress the four unasked console warnings; `unredacted_secret_name` reaches it as well as the console |
| `logDiagnostics` | `false` | see [Is it sending?](#is-it-sending); `false` does not silence the four unasked warnings, including `unredacted_secret_name` |
| `maxConcurrentSends` | `4` | 1-16; see [Sizing](#sizing-maxconcurrentsends); experimental |
| `journeyIdSecret` | none | at least 32 bytes; see [The same record, the same journey](#the-same-record-the-same-journey); experimental |
| `deployment` | none | `{ gitCommit?, version?, image? }`, sent on every event; see [Which build recorded this](#which-build-recorded-this) |
| `knownSafeNames` | `[]` | key names that look like secrets and are not, at most 1,000; see [Names no rule covers](#names-no-rule-covers) |

The SDK reads no environment variables. A library that changes behaviour based on
ambient state is a library that behaves differently in your tests.

Every optional setting, and every optional property of the options the SDK's
calls take, accepts an explicit `undefined`, so
`journeyIdSecret: process.env.JOURNEY_ID_SECRET` compiles with
`exactOptionalPropertyTypes` on. Every option type has a name you can import:
`RecorderConfig`, `StartJourneyOptions`, `ContinueJourneyOptions`,
`IdentifyOptions`, `WrapOptions`, `RecordInput`, `ErrorInput`, `FailureReason`,
`FailOptions`, `FinishOptions`, `ShutdownOptions`, `Deployment`, and `Entity`
for `{ type, id }`.

### Which build recorded this

A timeline that shows what happened but not which build it happened on leaves
the first question of any incident unanswered. Set `deployment` once, and every
event this recorder sends carries it:

```typescript
const recorder = createRecorder({
  // ...
  deployment: {
    version: process.env.APP_VERSION, // your package's version
    gitCommit: process.env.GIT_SHA,
    image: process.env.IMAGE // registry.example/app:1.4.2
  }
});
```

All three fields are optional, and an explicit `undefined` is fine, so reading
them straight from the environment compiles. The object is read and copied once,
when the recorder is created, so changing it afterwards changes no event, and an
event that carries it costs one property and no per-field work.

A field that is not a string, is empty or only whitespace, or is longer than
the protocol accepts (128 characters for `gitCommit` and `version`, 512 for
`image`), is left off rather than cut or trimmed, because a cut commit names a
build that does not exist; a key the protocol does not have is left off too,
since sending it would have the server refuse every event this process records.
The rest of the deployment is still sent. Each problem is a
`configuration_error`, never quoting a value, under a name that says what was
lost (ADR-060, ADR-062):

| `rejectedSettings` entry | Means |
| --- | --- |
| `deployment.gitCommit`, `deployment.version`, `deployment.image` | that field was given and is not sent |
| `deployment.*` | keys other than those three were given, and are not sent; never the key's own name |
| `deployment` | the setting was given and events carry no deployment: it is not an object, or no field of it could be sent, which includes `{}` and `{ gitCommit: undefined }` from an unset variable |

So `{ gitCommit, version: <too long> }` reports `["deployment.version"]` and
sends the commit, while `{ gitCommit: "" }` reports
`["deployment.gitCommit", "deployment"]` and sends nothing. A consumer that
stops recording on a refused setting can let a field through and still stop on
`rejectedSettings.includes("deployment")` (F-031).

## OpenTelemetry

If OpenTelemetry is installed, the SDK reads the active trace and span IDs onto
each event. It is resolved once, optional, and absent it degrades silently.

The SDK does not write `traceparent`. OpenTelemetry owns that header and has its
own propagator.

## Requirements

Node 22.12 or later.

The package is ESM, with one bundled file and one declaration file. `import`
works on any supported Node, and so does `require()`, because Node 22.12 is the
first 22 release where `require()` of an ES module needs no flag. On 22.12 that
`require()` prints an `ExperimentalWarning` once; Node 24 prints nothing. Node
20 is past its end of life and is not supported.

CI checks this on Node 22.12.0 and 24: it builds the package, runs its unit
tests, and installs the packed tarball into a fresh ESM project and a fresh
CommonJS project, each of which creates a recorder and calls a wrapper
(`scripts/sdk-node-versions.sh`).

## Stability

This is a 0.x release. Before 1.0 a minor release may change the API; a patch
release will not. Most of the API is settled. These parts are **experimental**,
marked `@experimental` in the types, and may change in a minor release:

- **The propagation helpers** (`injectHttpHeaders`, `extractHttpContext`,
  `injectSqsAttributes`, `extractSqsContext`, `injectPayload`,
  `extractPayload`), `PropagationLevel` and the `propagation` option: the
  header, attribute and envelope names and their value grammar wait on the
  propagation specification.
- **`across` and `JourneyGroup`**: the name, the deduplication and label
  rules, and what an empty group does came from one service instrumented with
  them.
- **`captureInput`, `captureOutput` and `metadataFrom`**, for the same reason.
- **`journeyIdFor` and `journeyIdSecret`**: the derivation is fixed by test
  vectors, but what surrounds it, such as rotating the secret, is new.
- **`label`**, the method and the option: it depends on the Journeys page,
  which is new.
- **`maxConcurrentSends`**: adaptive concurrency would make it unnecessary.
- **The `Counters` fields**: new counters may be added.

**Diagnostics.** New diagnostic kinds and new `code` values may be added in any
minor release. Handle the ones you do not know in a `default` branch, as in
[Handling diagnostics in code](#handling-diagnostics-in-code), and do not
assign a diagnostic to `never`. `reason` is text for a person and may change in
any release.

## The specifications behind this

This package is one implementation of a specification that is not about Node.

- **[SDK specification](../../docs/SDK_SPEC.md)**: what a recorder in any
  language must do, as numbered requirements with a source for each. Read it if
  you are writing a recorder, or if you want to know why this one behaves the
  way it does.
- **[Node appendix](../../docs/NODE_SDK_SPEC.md)**: the Node half: the public
  API with its signatures, the context model, the helper names, and the Node
  value renderings.
- **[Ingestion contract](../../docs/INGESTION_CONTRACT.md)**: what the server
  accepts and refuses, which is what this package sends to.

## License

Apache-2.0
