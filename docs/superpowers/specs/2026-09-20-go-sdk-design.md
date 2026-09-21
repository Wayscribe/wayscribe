# Native Go module

## Sequence and scope

This is deliverable 3 of `2026-09-20-sdk-expansion-design.md`: implement it after
the Python recorder passes its local conformance gate, before optional OTLP.
Jorge explicitly selected this sequence. Go records protocol 0.1 events directly
to the existing API. `SDK_SPEC.md`, `INGESTION_CONTRACT.md` and
`PROPAGATION_SPEC.md` remain authoritative; native Go never requires OTel.

Package `wayscribe` lives in `packages/sdk-go`, module path
`gitlab.com/jojithedev/wayscribe/packages/sdk-go`, `go 1.26`. Use only the Go
standard library at runtime. Tests run on the locally installed 1.26 toolchain;
an additional supported toolchain can be checked without replacing the host's
installation. The current Go release policy supports two major release lines
(https://go.dev/doc/devel/release, checked September 20). Module publication and
tagging are deferred. Embed a fixed development SDK version; never report the
host application's build info as the recorder's identity.

## API and host behavior

Use exported typed configuration, `Entity`, `Event`, `Context`, `Options`,
`Counters`, `Recorder` and `Journey` values. `New(Config) *Recorder` always
returns a usable recorder; invalid configuration is diagnosed, not a startup
error. Runtime wrong types are largely prevented by Go's type system, but
zero/invalid values and nil pointers remain guarded. Configuration supplies
endpoint/key/service/environment explicitly; do not read ambient SDK variables.

Recorder methods create/resume/derive journeys, group them, return detached
counters/rejected-settings, flush and shut down under `context.Context`.
Recording captures/redacts immediately and enqueues without network I/O.
Typed package-level generic wrappers are appropriate where Go methods cannot
express a result type parameter; they preserve the exact returned value and
error. Callback panics are recorded and re-panicked with the same value; a
recorder panic is isolated. Cancellation belongs to the host callback/context
and cannot be converted to a successful operation by instrumentation.

Support the full journey surface: raw events, aliases/displayable aliases,
labels, terminal failure/completion, transform/persist/publish/consume/deliver
wrappers, projections, explicit retry attempts and one callback over several
deduplicated journeys. Propagation helpers accept typed Go carrier maps and
also decode the shared JSON fixture shapes. Preserve the exact released
carrier grammar, privacy defaults, stripping and context extraction semantics.
Provide context.WithValue helpers with an unexported key type for a caller who
wants to carry a journey through Go functions; context cancellation remains
unchanged. This process-local convenience does not invent wire metadata.

## Capture and delivery

Capture follows all SDK_SPEC redaction and repair rules, including positional
header forms, Unicode units, arbitrary/large numbers, cycle versus shared
references, error masking, omission order and bounded diagnostics. Use JSON
field/tag conventions for structs where supported; a panic in custom marshal
code must not escape. Do not invoke arbitrary application methods just to
discover fields. Input must be stable during the synchronous capture call;
after the call it can be mutated without affecting the recorded snapshot.
Document that Go cannot safely read a map the caller is mutating concurrently.
Race tests must cover SDK-owned state and concurrent independent caller inputs.
Apply limits to the actual repaired representation: base64/large-integer strings
and synthesized wrapper objects must still fit string and depth ceilings.
Snapshot required entity fields before diagnostics can invoke host code. Header
objects with a non-string name and usable key must still redact their value.
Process-warning deduplication uses the SDK_SPEC folded-name/field-shape scopes.

A bounded queue and worker goroutine(s), managed by cancellation, use net/http
with a dedicated bounded client. No implicit cross-origin redirects. Bound
response reads, request time and concurrent sends. Stable serialized envelope
bytes survive retries. Implement permanent/transient/missing verdict semantics,
per-event budgets and the circuit breaker exactly as the SDK specification
states. Oldest queued events drop when full. Shutdown stops admission, cancels
inflight requests/backoff within the caller's deadline and reconciles counters
once; late responses cannot mutate finalized state. No goroutine leak remains
after a canceled flush or shutdown.

## Organization and evidence

Keep independent files for configuration, diagnostics, capture, error masking,
event construction, propagation, timing, transport, recorder/journey/wrappers
and version identity. Use table-driven Go tests with literal expectations and
httptest servers for real request capture, including blocking/canceled I/O.
Use the actual cross-language fixture manifest. Where the DSL describes an
absent value, preserve omission separately from explicit nil. All universal
fixtures run; Node-only cases remain named skips with Go-specific hostile-value
tests. Shared HMAC and propagation vectors must not be rewritten.

Expose a test-only command under `internal/conformance` or `cmd/conformance`
which drives the real recorder and returns raw captured request bodies. The
TypeScript API integration suite replays those unchanged bytes to the real
database-backed dry run and checks the same stored expectations as Python.
Run `go test ./...`, `go test -race ./...`, `go vet ./...`, local actual-ingest
workflow checks and a clean external-consumer module using a local replace.
The consumer proves exported APIs and package boundaries without publishing.
Documentation distinguishes local implementation from an available public tag.

The detailed Go task plan is written after Python integration exposes any
remaining language-neutral contract ambiguities; it may refine API signatures
within these approved boundaries before implementation.
