# Wayscribe Go SDK (unreleased)

Module `gitlab.com/jojithedev/wayscribe/packages/sdk-go`, package `wayscribe`,
requires Go 1.26. This local development module is **not published**. Its fixed
identity is `wayscribe-go` / `0.1.0-dev`; protocol version remains `0.1`.
Recording captures immediately and sends asynchronously through the batch route.
Runtime and tests use only the Go standard library.

The controlled
[`examples/mixed-language`](../../examples/mixed-language/README.md) workflow
builds a separate consumer module with a local `replace` and completes one real
journey received from Node through Python.

Configuration is explicit: endpoint, API key, service and environment are
required. No SDK environment variables or ambient trace/host metadata are read.
Optional numeric settings use zero to select their defaults; negatives are
reported and replaced. Defaults are redacted payload capture, journey-and-type
propagation, batches of 50, a 1s flush interval, 1.5s request timeout, 1,000
buffered events, 262,144 envelope bytes, four concurrent sends (maximum 16),
three HTTP attempts, 100ms–2s backoff, a breaker at five failures for 30s, and
per-event refusal budgets of 30s or ten logical sends. Required configuration
problems disable recording without breaking startup; optional problems leave
usable settings intact.

`Value{}` means absent. `Payload(nil)` means a present JSON null. `Payload(v)`
marks presence only; capture happens synchronously when recording. `Value.Get()`
returns the supplied value and a presence flag. Nil timing pointers mean unknown;
a pointer to zero is a measured zero. A zero event timestamp means record time,
and a zero attempt means absent/default first attempt.

Capture copies reflected maps, slices, arrays and exported struct fields with
JSON field names, `-`, `omitempty` and `omitzero` tags. It does not call custom
`MarshalJSON`, `MarshalText`, `String`, or `IsZero` methods, nor automatically
flatten embedded structs. Project a custom type explicitly when its application
JSON representation matters. Explicit standard-library representations cover
`time.Time`, `[]byte` (`{"type":"bytes","base64":"..."}`), `json.Number`, and
`math/big.Int`. Integers outside ±(2^53−1) become decimal strings; an integer too
large to retain its digits is omitted. Unsupported values become
`[UNCAPTURABLE]`, cycles become `[CIRCULAR]`, and independent shared references
are expanded. Explicit host-error handling may call `Error()` under panic
isolation; payload discovery never does.

**Caller maps and slices must remain stable during synchronous capture.** Go
cannot safely read a map while the caller mutates it. After capture, caller
mutation cannot alter the serialized event. SDK-owned bookkeeping is synchronized;
diagnostic callbacks run outside its locks and are panic-isolated.

Built-in secret names are always redacted, even in explicit full payload mode.
Operator rules support folded key spelling, dotted paths, `*`, `[*]` and `**.name`;
full mode ignores additional operator rules. Redaction precedes UTF-16 string
truncation. Protocol short fields use Unicode code points. Capture bounds depth,
width, cumulative work and repaired representations, and final fitting omits the
larger payload first, then the other, then metadata. A truncated payload later
omitted counts only as omitted. `KnownSafeNames` suppresses heuristic warnings,
never redaction. Metadata-only capture omits input and output.

Journey labels and displayable aliases are public text: they are stored, shown
and searchable in full. Do not put personal data or credentials in them. A
statement of an alias must list it as displayable every time; an unlisted alias
is masked when read. Heuristic email/phone warnings cannot detect every form of
personal data. Error messages are masked for credential shapes, not personal data.
Printed diagnostics exclude caller-written names, paths, values, credentials and
endpoints. Required-setting, missing derivation-secret, uncovered secret-name and
public-personal-data warnings have bounded process/recorder deduplication scopes.
Other output is opt-in with `LogDiagnostics`.

Propagation copies carrier maps and keeps unrelated fields, including existing
`traceparent`; it never writes trace context or aliases. The default propagates
journey ID and entity type. `Full` also emits a carrier-valid entity ID.

```go
ctx := wayscribe.Context{
    JourneyID: "jrn_123",
    Entity: &wayscribe.Entity{Type: "order", ID: "ORD-42"},
}
headers := wayscribe.InjectHTTPHeaders(ctx, nil, wayscribe.JourneyAndType)
for name, value := range headers {
    if s, ok := value.(string); ok {
        request.Header.Set(name, s)
    }
}
```

`ExtractHTTPContext` accepts `map[string]any`, `map[string]string` and
`http.Header`; `ExtractSQSContext` accepts raw attribute maps. `ExtractPayload`
preserves missing envelope data versus explicit nil. `HasJourney` is only a
structural guard; use extraction to validate the frozen carrier grammar.
Carrier-valid IDs may be 256 characters; event IDs are limited to 128.

`QueueMetadata` uses known readiness and processing clocks, never now. Retries
require `ReadyAgainAtMS`; redelivery suppresses initial-enqueue timing.
`HTTPMetadata` retains only the destination host and an optional non-default
port. Delay-seconds `Retry-After` needs no clock; HTTP dates require an explicit
`ObservedAt`. Invalid fields are independently omitted. Helpers do not control
application retries. Pass the returned attempt separately to wrapper options.

Local checks:

```sh
pnpm test:go
pnpm test:go:conformance
pnpm test:go:integration
pnpm test:go:consumer
GOTOOLCHAIN=local GOWORK=off go -C packages/sdk-go test -race ./...
GOTOOLCHAIN=local GOWORK=off go -C packages/sdk-go vet ./...
```

The public fixture driver executes all 35 universal SDK cases and reports the two
throwing-property cases as named Node-only skips. The integration gate replays
the exact request bytes captured from the public recorder through the real API's
dry-run route and runs the external module in `examples/go-worker` against a real
test database. The local module remains unpublished; use a local `replace`
directive, as the example does, rather than a public `go get` command.


## Recording and wrappers

```go
recorder := wayscribe.New(wayscribe.Config{
    Endpoint: "http://localhost:3001",
    APIKey: "explicit-ingestion-key",
    Service: "orders",
    Environment: "development",
})
defer recorder.Shutdown(context.Background())

journey := recorder.Journey(wayscribe.Entity{Type: "order", ID: "ORD-42"},
    wayscribe.JourneyOptions{Label: "Order fulfillment"})
journey.Record(wayscribe.Event{
    Operation: wayscribe.Received, Name: "receive", Input: wayscribe.Payload(order),
})
result, err := wayscribe.Transform(ctx, journey, "normalize", order,
    func(ctx context.Context) (Order, error) { return normalize(ctx, order) })
journey.Identify(map[string]string{"externalOrderId": "EXT-42"},
    wayscribe.IdentifyOptions{DisplayableAliases: []string{"externalOrderId"}})
journey.Complete("") // name defaults to "complete"
```

The callback's exact value and error are returned, including a value accompanied
by an error. A callback panic is recorded and re-panicked unchanged; a callback's
`runtime.Goexit` is not turned into a successful event or a replacement panic.
Cancellation is passed through unchanged to the callback. SDK instrumentation
and diagnostic/projection panics are isolated. Callbacks should return promptly;
Go cannot cancel arbitrary application code that blocks or calls `Goexit`.

`Transform`, `Persist`, `Publish`, `Consume`, `Deliver`, and `Validate` share this
signature (and their natural protocol operations):

```go
func Transform[I, T any](context.Context, Target, string, I,
    func(context.Context) (T, error), ...Options[I, T]) (T, error)
```

`Target` is implemented by `*Journey` and `*Group`. A nil/disabled target or empty
group still runs the host callback once. `recorder.Across(j1, j2, ...)` accepts
only that recorder's journeys, deduplicates journey IDs, and executes one callback
for the group. Events have distinct IDs with shared start time and duration.
Groups also expose `Record`, `Fail`, and `Complete`. Recorders and journeys must
not be copied after use; their SDK-owned state supports concurrent calls.

`Options[I,T]` accepts `Attempt`, `Metadata`, `Aliases`, `DisplayableAliases`,
`CaptureInput func(I, Context) any`, `CaptureOutput func(T, Context) any`,
`MetadataFrom func(T, Context) map[string]any`, and
`IsFailure func(T) *FailureReason`. Input projections run before host work;
output/metadata projections run per journey on the result. Projection contexts
are detached. Metadata projections override static keys; explicit `Attempt`
wins over metadata. An attempt above one records `retried` with that attempt's
own error. `IsFailure` runs once for a successful callback; a non-nil reason
populates `error` with its `Message`/`Code` without changing the host return.
Callback errors, panics and classified failures retain the attempt's natural
operation; attempts above one still use `retried`. Use `Journey.Fail` or
`Group.Fail` for an explicit terminal `failed` event.
A projection panic captures `[UNCAPTURABLE]`; a metadata projection panic keeps
static metadata, and a classifier panic preserves normal result interpretation.
Metadata-only mode skips payload projections. Optional variadic options accept
one object; additional objects are safely diagnosed and ignored.

`Journey(Entity, ...JourneyOptions)` creates a random ID unless `JourneyID` is
supplied. Invalid explicit IDs are refused when recording. `Resume(Context,
Entity)` uses the explicitly supplied entity and a usable carried ID; an invalid
ID, including one above the event limit of 128 characters, is diagnosed and
replaced with a fresh ID. Standalone carrier parsing still accepts 256.
`ForEntity(Entity, ...LabelOptions)` uses the configured `JourneyIDSecret` for
keyed derivation and deliberately offers no ID override. `Context()` returns a
detached carrier; `Label(string)` changes later events without recording one;
`Fail(string, error)` records a terminal failure.

`WithJourney(context.Context, *Journey)` and `JourneyFromContext(context.Context)`
carry a journey under a private key while preserving cancellation and deadlines.
No context value becomes an event field automatically. Nil receivers and zero
recorders/journeys are safe; zero recorders are disabled.

## Delivery and lifecycle

`Flush(ctx) bool` waits for the work admitted before that call to reach terminal
accounting. A canceled flush creates no waiter goroutine and leaves the recorder
available. `Shutdown(ctx) bool` closes admission, drains until empty or a send
makes no progress, then cancels active requests/backoff and finalizes remaining
events exactly once. An expired context finalizes immediately. A context without
a deadline, including nil, receives a five-second upper bound. Repeated shutdown
returns its first result. True means terminal accounting completed during the
drain, not that all events were stored; use `Counters()` for delivery outcomes.
Valid events recorded after shutdown count as `recorded` plus `after_shutdown`.
Invalid envelopes and disabled recorders never enter delivery accounting.

The pending queue drops its oldest event at capacity. Each of the fixed
`MaxConcurrentSends` workers additionally owns at most one batch of `BatchSize`
events (maximum 100). Retries retain byte-identical envelopes and original queue
age. A logical send contains at most `MaxAttempts` HTTP attempts, with capped
full-jitter backoff. Following the first transient refusal, every nonempty logical
send counts toward `EventRetryMaxSends`, including a send whose later attempts
fail at the HTTP layer. The monotonic `EventRetryBudget` is checked again after
backoff and breaker waits. Whole-request 4xx is permanent; 5xx/network failures
retry. Positional verdicts alone determine ownership. Missing/malformed 2xx
verdicts drop with `no_verdict` and are never silently counted as stored.

A dedicated `net/http` client uses no ambient proxy, never follows redirects,
verifies TLS, bounds connection ownership and request phases, caps response
bodies at 1 MiB, and closes bodies/idle connections. Shutdown cannot retract
bytes already sent or prevent a server from storing an earlier request. Late
responses cannot change finalized accounting.

`Counters()` and `RejectedSettings()` return detached snapshots. After shutdown,
`Recorded == Sent + Rejected + Dropped`, and all five dropped causes are present.
Capture/configuration diagnostics are synchronous and run outside SDK locks.
Transport diagnostics use one dispatcher with a 64-entry bounded report channel;
excess/undelivered reports may be skipped, while counters remain exact. The
callback may reenter lifecycle methods without waiting on a sender or on itself.
Shutdown cancels SDK-owned work; it does not wait for arbitrary blocking user
diagnostic code. The dispatcher exits when such a callback returns. Diagnostic
callbacks may run concurrently with synchronous capture diagnostics and should
synchronize their own state.
