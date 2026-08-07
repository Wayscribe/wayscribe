# Phase 3a: SDK Reliability Core — Design

**Date:** 2026-08-07
**Status:** Approved
**Scope:** `createRecorder`, journey handles, `record`, `identify`, client-side capture,
the bounded queue, transport with retry and circuit breaking, diagnostics, and shutdown.
The wrapper API and OpenTelemetry are Phase 3b.

## 1. Context

Everything before this phase has been ours to get wrong. A bug in ingestion returns a
wrong answer to us. A bug in this package runs inside somebody else's production process.

ADR-007 states the invariant: recorder failure must never break the host application.
This phase builds the machinery that makes that true, and the wrapper API in 3b is built
on top of something already proven not to throw. The reverse order — an ergonomic API
first, safety retrofitted — is how a swallow-everything `catch` ends up wrapped around
code that was never designed to fail.

## 2. Failure isolation

### One boundary, not many

Every public entry point passes through a single `safely()` wrapper. It catches
everything — serialization faults, redaction faults, queue faults, and defects in our own
code — reports through diagnostics, and returns.

Public methods return `void` or the host callback's value. None can propagate a recorder
fault.

A `try`/`catch` per method would work until someone adds a method and forgets one. One
boundary cannot be forgotten.

### `record()` never awaits the network

`record()` captures, redacts, enqueues, and returns synchronously. The only async surface
is `flush()` and `shutdown()`.

### Diagnostics, not logging

Failures go to an optional callback and to counters. Nothing writes to `console` unless
debug is explicitly enabled.

`SECURITY.md` section 12 forbids recursive logging of recorder failures. A recorder that
writes to stderr on every failed flush becomes the incident during an outage.

## 3. Capture

Capture is synchronous: redact, then enqueue.

Deferring redaction to flush time would be cheaper on the caller's path, but the
application may mutate the object in between, and the recorder would store values the
step never saw. For a tool whose value is showing where data changed, recording the wrong
values is worse than recording nothing.

**A size guard bounds the cost.** If a payload exceeds the configured limit, the SDK
stores a marker recording that it was too large rather than walking it. Server-side limits
do not help a host application that has already spent the CPU.

## 4. Queue

Bounded, default 1000 events. When full, **drop oldest**.

Dropping the earliest events sounds destructive but is safe here: Phase 1b's ingestion
creates a journey from whichever event arrives first — `ensureJourney` does not require
the `received` event specifically — so dropping the front orphans nothing. On recovery
from an outage, recent events are the ones still worth having.

Drops are counted and surfaced through diagnostics. A silent drop turns a gap in the
timeline into a mystery.

## 5. Transport

- Batches flush at `batchSize` or `flushIntervalMs`, whichever comes first.
- Short connect and request timeouts.
- Retry with capped exponential backoff plus jitter; never infinite.
- A circuit breaker opens after consecutive failures and closes after a cooldown.

While the breaker is open, events still enqueue and drop-oldest still applies, but no
network attempt is made. The breaker exists to stop a failing recorder from consuming the
host's sockets and event loop.

Retries reuse the same client-generated event IDs, so Phase 1b's idempotency makes a
duplicate delivery harmless.

**Timers and the clock are injected.** Backoff and breaker recovery are then tested
deterministically rather than with sleeps, which is the difference between a fast suite
and a flaky one.

## 6. Package boundary

The SDK needs redaction and size checks, which `AGENTS.md` assigns to
`packages/payload-security`. That package also holds AES encryption, API-key generation,
and HMAC search tokens — all server-side.

Shipping those into every customer's application is bloat and a poor boundary, so
`payload-security` gains a **subpath export**:

```text
@flight-recorder/payload-security/redaction
```

exposing only `redact`, `checkLimits`, `DEFAULT_LIMITS`, and `DEFAULT_SECRET_PATHS`. The
SDK imports that path and never pulls in the crypto.

The root export is unchanged, so the API keeps importing what it already does.

## 7. Public surface for this phase

```typescript
createRecorder(config): Recorder
recorder.startJourney({ entity, aliases? }): Journey
recorder.continueJourney(context): Journey
recorder.flush(): Promise<void>
recorder.shutdown({ timeoutMs }): Promise<ShutdownDiagnostics>

journey.record({ operation, name, input?, output?, error?, metadata? }): void
journey.identify(aliases): void
journey.context(): JourneyContext
```

Wrappers — `transform`, `persist`, `publish`, `consume`, `deliver`, `fail`, `finish` —
are Phase 3b.

## 8. Shutdown

Stops accepting new events, attempts a final flush, respects its timeout, returns
diagnostics, and never hangs. A process that cannot exit because of a telemetry library
is the same failure ADR-007 forbids, arriving later.

## 9. Testing

Failure-injection tests are written first, and each asserts the host callback still
returns its value or throws its own error unchanged:

- serialization throws on a circular value
- redaction throws
- the queue is full
- the transport rejects
- the transport hangs past its timeout
- the endpoint returns 500
- the endpoint returns malformed JSON
- shutdown is called mid-flight
- the recorder is pointed at an address that refuses connections

Behavioural tests cover: events reach a test server in protocol shape; batching triggers
at size and at interval; retries reuse the same event ID; backoff is capped and jittered;
the breaker opens after the threshold and recovers after cooldown; the queue drops oldest
and reports the count; shutdown flushes and respects its timeout; and an oversized payload
stores a marker rather than the payload.

## 10. Acceptance criteria

- No public method throws, under any injected failure.
- A recorder pointed at a dead endpoint does not change host behavior or timing beyond its
  configured timeouts.
- Memory does not grow without bound; drops are counted and reported.
- Retries are idempotent by event ID.
- The breaker opens and recovers on schedule under a fake clock.
- Shutdown always returns and never hangs.
- `pnpm test`, `pnpm test:integration`, and CI pass on a clean clone.

## 11. Not in this phase

The wrapper API, OpenTelemetry trace capture, HTTP and queue context propagation
(Phase 4), and publishing to npm (Phase 7).
