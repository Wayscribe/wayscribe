# Phase 3b: SDK Wrapper API — Design

**Date:** 2026-08-07
**Status:** Approved
**Scope:** `transform`, `persist`, `publish`, `deliver`, `consume`, `fail`, `finish`, and
optional OpenTelemetry trace capture. Context propagation is Phase 4.

## 1. Context

Phase 3a built the reliability core: one failure boundary, a bounded queue, a retrying
transport, and a shutdown that cannot hang. This phase adds the surface a developer
actually writes against, on top of something already proven not to throw.

## 2. The wrapper contract

All seven wrappers share one contract, and it is the substance of this phase:

1. Run the callback.
2. Return its value unchanged.
3. Rethrow its error unchanged — the original object, not a wrapped one, so the
   application's own `catch` and `instanceof` continue to work.
4. Record duration, input, output, and outcome around it.
5. Never let a recording failure affect any of the above.

```typescript
journey.transform(name, input, fn, options?)   // transformed
journey.persist(name, input, fn, options?)     // persisted
journey.publish(name, message, fn, options?)   // published
journey.deliver(name, payload, fn, options?)   // delivered
journey.fail(name, error, metadata?)           // failed
journey.finish({ status })                     // completed | failed
recorder.consume({ context?, entityFallback }) // Journey
```

`options` is `{ isFailure?, attempt?, metadata? }`.

## 3. Detecting failure that does not throw

The reference scenario's failure does not throw: the target returns HTTP 422, and an HTTP
client hands that back as an ordinary response.

**Wrappers accept an optional `isFailure` predicate.** The caller states what failure
means for their client, at the call site:

```typescript
await journey.deliver("deliver-customer-to-target", customer, () => client.post(...), {
  isFailure: (response) => response.status >= 400
});
```

Without a predicate, only a thrown error counts as failure.

The alternative — requiring the application to throw on a bad status — would make
instrumentation change the application's control flow, which is exactly what ADR-006 says
explicit instrumentation should avoid. Many HTTP clients deliberately do not throw on 4xx.

Recording the failure on a separate event was also rejected: it splits duration and
payload onto one event and the failure onto another, which is the split ADR-022 already
declined.

## 4. Retry semantics

ADR-022 records a first delivery attempt as `delivered` and subsequent ones as `retried`.

**The caller supplies `attempt`, defaulting to 1.** An attempt of 1 uses the operation's
natural verb; anything higher records `retried`.

The SDK does not track attempt counts itself. In the reference scenario the retries happen
in a worker consuming a redelivered queue message — possibly a different process, or the
same process after a restart. A per-instance counter would report every retry as attempt 1
and the timeline would show three separate first deliveries, which is worse than no
attempt information at all.

## 5. Error recording

When a callback throws, the wrapper records the error, then rethrows **the original
object**. Not a copy, not a wrapped error: application code frequently branches on
`instanceof` or on custom properties, and replacing the error would break handling that
worked before instrumentation was added.

If recording the error itself fails, the callback's error still propagates. The safety
boundary from 3a covers this.

## 6. OpenTelemetry

If `@opentelemetry/api` is installed and a span is active, events carry its `traceId` and
`spanId`. If it is not installed, nothing happens — no error, no warning, no
peer-dependency nag. ADR-010 makes OpenTelemetry optional interoperability, not a
dependency.

**The mechanic matters.** `record()` is synchronous, so an asynchronous dynamic import
cannot be used at record time. The recorder attempts resolution once at construction via
`createRequire`, inside the existing safety boundary, and caches the result. An absent
package, an absent active span, and a throwing OpenTelemetry implementation all degrade
to no trace context.

## 7. Boundary with Phase 4

`consume` accepts an already-extracted context, or an entity fallback when no context was
propagated. The helpers that *produce* a context — `injectHttpHeaders`,
`extractHttpContext`, `toQueueAttributes`, `fromQueueAttributes` — are propagation and
belong to Phase 4.

Drawing the line here keeps this phase to the callback contract.

## 8. Testing

Every wrapper is tested for the same four properties:

- returns the callback's value unchanged
- rethrows the callback's exact error object, verified by identity
- records duration
- does all three while the recorder's transport is dead

Plus:

- `isFailure` marks a non-throwing result as failed and records the error
- `attempt` greater than 1 records `retried` rather than the natural verb
- `finish` records `completed`, and `failed` when told
- `consume` builds a journey from a supplied context, and from an entity fallback when
  none is supplied
- OpenTelemetry absence is a no-op, and a throwing OpenTelemetry implementation does not
  reach the caller

## 9. Acceptance criteria

- No wrapper alters the value or error its callback produced.
- A non-throwing failure is recordable without changing application control flow.
- A retry records as `retried`.
- The SDK works with and without `@opentelemetry/api` installed.
- `pnpm test`, `pnpm test:integration`, and CI pass on a clean clone.

## 10. Not in this phase

Context propagation over HTTP and queues (Phase 4), the demo services (Phase 5), and npm
publishing (Phase 7).
