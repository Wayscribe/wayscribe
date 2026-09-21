# Wayscribe Go core (unreleased)

Module `gitlab.com/jojithedev/wayscribe/packages/sdk-go`, package `wayscribe`,
requires Go 1.26. This local development module is **not published**. Its fixed
identity is `wayscribe-go` / `0.1.0-dev`; protocol version remains `0.1`.
The recorder, delivery transport and wrappers are the next implementation task.
This core alone does not send events or run background work.

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
GOTOOLCHAIN=local GOWORK=off go test ./...
GOTOOLCHAIN=local GOWORK=off go test -race ./...
GOTOOLCHAIN=local GOWORK=off go vet ./...
```

These core checks do not claim full SDK conformance, real API ingestion,
publication, or the human pilot gate. The later recorder/conformance tasks own
those checks.
