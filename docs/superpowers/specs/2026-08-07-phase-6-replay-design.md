# Phase 6: Replay — Design

**Date:** 2026-08-07
**Status:** Approved
**Scope:** Development-only replay of a recorded input, with the safety machinery that
makes sending an outbound request from a debugging tool defensible.

## 1. What this is for

Phases 1 through 5 answer "where did this value change?". Replay answers the question a
developer asks immediately afterwards: **"if I fix the mapping, does the record come out
right?"**

Without it the loop ends at diagnosis. With it, the recorded input becomes a test case
against corrected code, which is the second half of `README.md`'s definition of done.

## 2. Three decisions the specification leaves open

### Replay is admin-only

`apps/api/src/principal.ts` resolves exactly two principals. An API key ingests; an admin
reads a named project. Replay is a third capability, and it belongs to the admin.

An API key lives in application configuration on servers that a great many people can
reach. It exists to write events. Letting it also make Flight Recorder send arbitrary
requests to configured destinations turns a leaked telemetry key into a request-forgery
primitive against the operator's own development network.

The admin token is already an operator credential. This is the mirror of ADR-029, which
refuses admin tokens at ingestion for the same kind of reason.

### V0 sends the payload as recorded, with no editor

`REPLAY_SPEC.md` section 3 lists "allow payload review and editing" as a V0 goal, and
`IMPLEMENTATION_PLAN.md` line 268 keeps the editor. **The editor is deferred to V1.**

Review stays: the prepare screen shows exactly what will be sent, which is what makes
section 13's "avoid one-click replay" meaningful. What is dropped is the ability to change
it before sending.

The reason is that an editable payload is a JSON editor with validation, error states, and
a diff between recorded and edited — a substantial interface — and it is not needed for
the loop this phase exists to close. Fix the code, replay the *original* input, compare.
Editing the input tests a different thing from the recorded failure.

This narrows a documented V0 goal, so it is recorded as an ADR rather than done quietly.

### A payload that was never captured cannot be replayed

Ingestion applies capture policy *before* storing, so `metadata-only` environments store
`undefined` and redacted fields store `[REDACTED]`.

Replay refuses when there is no stored input, and says why. It **does not** refuse when
the payload contains redaction markers: sending `[REDACTED]` to a development endpoint is
often still useful for reproducing a shape or a failure, and the prepare screen shows the
payload, so nobody sends one unknowingly.

The comparison view carries a matching caveat, because two `[REDACTED]` values compare as
unchanged — a replay diff cannot prove a redacted field was fixed.

## 3. The safety module is the phase

Everything else here is conventional work against existing patterns. This part is not, and
it is where the risk lives.

`apps/api` has **no outbound HTTP client at all** today. Adding one to a tool whose whole
job is to be pointed at internal services means adding a server-side request forgery
surface to something sitting inside a development network.

### Checks, in order

1. **Scheme.** `http` and `https` only.
2. **Path join.** The destination supplies an origin; the request supplies a path
   (ADR-019). Reject absolute URLs, protocol-relative URLs, and traversal.
3. **Host allowlist.** The resolved host must appear in `REPLAY_ALLOWED_HOSTS`.
4. **DNS resolution.** Resolve the host to addresses before connecting.
5. **Address check.** Reject addresses outside what the allowlist implies, including
   IPv4-mapped IPv6 forms of the same address.
6. **Connect to the resolved address.** Not to the name.
7. **No redirects.** `redirect: "manual"`; a 3xx is a result, not a hop.
8. **Timeouts and a response cap.**

Step 6 is the one that cannot be skipped. Checking a hostname and then handing the same
name to a client re-resolves it, and a name that answered with an allowed address the
first time may answer differently the second. That is DNS rebinding, and it is why bare
`fetch` is not sufficient: it offers no hook between resolution and connection.

The implementation uses `undici` with a custom `connect`, which is the smallest thing that
gives that hook.

**Private ranges are allowed, deliberately.** `REPLAY_SPEC.md` section 10 says to consider
blocking them, and this design does not: every destination this feature exists for —
`localhost`, `host.docker.internal`, a Compose service name — resolves to one. The
allowlist is the control, and it is explicit configuration rather than a heuristic.

### The header blocklist is its own list

Not `DEFAULT_SECRET_PATHS`. That is a redaction *path* list for payloads, and it is
missing three of the eight headers `SECURITY.md` section 8 requires blocked. A separate
list, matched case-insensitively, with the destination's own configured headers layered on
afterwards.

## 4. What gets stored

A `replay_runs` row is written **before** the request is sent, so an attempt that is
refused still leaves a record. A blocked attempt stores `status: "blocked"` and the reason
rather than erroring with nothing persisted.

Every attempt also writes an `audit_events` row — the table has had no writer since it was
created. Metadata goes through `redact()` first.

## 5. Comparison

The recorded output against the replay response, through the existing
`packages/payload-diff`. Both sides genuinely share a shape here, which is what makes this
diff the one ADR-030 said the transformation diff could not be.

## 6. Surface

```text
POST   /v1/replay-destinations     admin
GET    /v1/replay-destinations     admin
POST   /v1/replays                 admin
GET    /v1/replays/:id             admin
```

Plus `replayable: boolean` on the event detail, so the interface can offer the action only
where there is an input to send.

## 7. Interface

A prepare screen at `/journeys/:id/replay?event=…` showing destination, method, path, the
exact payload, and the headers that will be sent — then a confirm button. No action on the
timeline itself (section 13).

## 8. Testing

- Every safety check refuses, individually, with the reason recorded.
- A host that resolves to an allowed address and then to a disallowed one is refused at
  connect. This is the rebinding case and the reason the module exists.
- Each of the eight blocked headers is stripped case-insensitively.
- A 3xx is recorded as a result, not followed.
- An oversize response truncates; a slow destination times out and records `failed`.
- A blocked attempt writes both a `replay_runs` row and an `audit_events` row.
- Cross-project isolation for all three new tables.
- The demo's corrected endpoint returns the phone number, and the comparison shows it.

## 9. Acceptance criteria

- A recorded input can be replayed to a development destination and compared.
- `DEMO_SCENARIO.md` steps 10 through 12 pass.
- An API key cannot replay.
- SSRF, rebinding, and redirect cases are refused and recorded.
- `pnpm test`, `pnpm test:integration`, and CI pass on a clean clone.

## 10. Not in this phase

The payload editor, production replay, bulk or scheduled replay, and queue reinsertion.
