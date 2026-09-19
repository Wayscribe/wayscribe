# Per-record timing and context

Architectural change, authorized by Jorge on 2026-09-18: implement the remaining timing scope before the first release, then continue assistant-owned release preparation without unnecessary stops. The roadmap and Leadline F-019/F-027 are the requirements. Deployment display is already built.

## Decision

Keep the existing immutable events and timestamps. Add a documented, optional metadata vocabulary, a bounded projection of it on timeline rows, three journey-list filters, and presentation of the evidence. No new service, dependency, event operation, or protocol version. Do not turn a record investigation into aggregate monitoring.

Alternatives considered: adding a new top-level timing object and storage column would duplicate metadata and complicate mixed-version installs; inferring waits/retry identities from event names alone would confidently associate unrelated work. Optional metadata with explicit evidence is smaller and backward compatible.

## Measurement vocabulary

These optional keys live in `event.metadata`, receive the existing client/server redaction, and remain subject to the existing event budget. Invalid or redacted values are not measurements. Readers preserve the raw metadata view while presenting valid values with labels. An absent, invalid, negative, non-finite or otherwise unmeasurable value is omitted, never replaced with zero. A measured zero remains zero.

| Key | Meaning / valid value |
| --- | --- |
| `queue` | Queue name, nonempty string up to 256 Unicode code points. |
| `queueWaitMs` | Whole milliseconds from the stated queue readiness boundary to this attempt starting; 0 through 2,147,483,647. |
| `queueWaitBasis` | `initial-enqueue` or `retry-ready`. Required before `queueWaitMs` is presented as measured queue wait. |
| `deliveryCount` | Positive safe integer, explicitly reported by the broker/caller. Not inferred from application attempts. |
| `targetHost` | Destination hostname with optional port, up to 256 code points; no URL userinfo, path or query. |
| `httpStatusCode` | Integer 100 through 599. Older arbitrary metadata named `status` is not silently reinterpreted. |
| `retryAfterMs` | Whole milliseconds the remote system requested before another call; 0 through 2,147,483,647. It is a requested delay, not elapsed delay. |
| `attempt` | Existing caller-supplied positive safe integer. Wrapper ownership and operation/status rules remain unchanged. |
| `retryGroup` | Caller-provided identity for repeated attempts at one logical operation, nonempty string up to 256 code points. Grouped only within one journey, service and step name. Use a job ID scoped to its queue or a request ID; it must contain no secrets. |

`initial-enqueue` is meaningful only with recorded attempt 1 and no explicit evidence of redelivery (`deliveryCount` above 1); retry waits require `retry-ready` and an attempt above 1. A stalled broker delivery can restart before any application attempt finishes, so attempt 1 alone does not override an explicitly recorded second delivery. Omit that wait when no supported readiness evidence exists. Do not derive retry readiness from the original enqueue timestamp. Metadata without this evidence can remain visible as raw metadata but is not labelled as measured queue wait.

Add a protocol-owned bounded `TimingContext` projection and parser, exported for server use. It validates each known field independently so one bad field cannot cost other context or the event. Its input is already-redacted stored metadata; it must not recover private data from another source. Timeline reads project only the named keys, not arbitrary metadata. Include bounded `recordedHost` from already-redacted `runtime.hostname` to explain clock uncertainty. No payloads accompany this projection. Event detail uses the same interpretation.

## SDK helpers

Add standalone `queueMetadata(job, options?)` and `httpMetadata(response, options?)` exports, with documented structural input types. They create metadata for existing `record`, wrapper `metadata`, and `metadataFrom` calls, without adopting a broker/client dependency or changing propagation envelopes.

`queueMetadata` understands the BullMQ-shaped fields `queueName`, `id`, `timestamp` (enqueue epoch ms), `processedOn` (current-attempt start epoch ms), `attemptsMade` (completed attempts). It emits an attempt only from a valid nonnegative integer attemptsMade; current attempt is +1. First attempts can measure `processedOn - timestamp` unless the caller explicitly reports a deliveryCount above 1. Retried attempts omit the wait unless options include an explicit `readyAgainAt` epoch ms; then use `processedOn - readyAgainAt` with `retry-ready`. Invalid/missing clocks never fall back to Date.now and negative differences never clamp to zero. Optional deliveryCount is caller supplied. With usable queue/name ID, emit an unambiguous bounded retryGroup; omit if it cannot fit, never truncate identity into a collision.

Wrapper calls must pass the helper's attempt as the wrapper option as well as its metadata: `const metadata = queueMetadata(job); journey.deliver(name, input, fn, { metadata, attempt: metadata.attempt })`. The wrapper owns attempt and defaults to one, so metadata alone cannot change its operation. Document and test this complete usage, including retry-ready waits. A raw `journey.record` consumes the metadata and an explicitly chosen operation. Do not infer wrapper attempt from arbitrary user metadata.

`httpMetadata` understands a response's numeric status and `headers.get("retry-after")`; options supply `targetUrl` and optional observation `now` epoch ms for HTTP-date Retry-After. Strip URL credentials/path/query by parsing only host. Parse nonnegative integer delay-seconds or valid HTTP-date; malformed, past dates and missing values are omitted. Date.now may supply the observation instant for an HTTP-date, not an unknown broker timestamp. Keep a real zero. Accessors, proxies, invalid values and throwing getters must never fail host code. Read independently and preserve the other usable fields. Follow existing SDK reliability/testing patterns; helpers must work from the packed ESM and CJS entry points.

## Journey duration and list filters

The displayed journey duration is `lastEventAt - startedAt`: the span between recorded event starts. It is not the sum of step durations, wall time since creation, or completion latency. A one-event journey has a measured span of zero. Explain that the last step may still have its own duration and timestamps from different clocks can disagree. Existing summary fields suffice; no mutable timing cache or schema migration is needed.

Add API query filters to the existing required-since bounded list:

- `minDurationMs`: select journeys whose recorded first-to-last span is strictly greater than this nonnegative integer threshold.
- `minStepDurationMs`: select journeys with any stored event whose duration_ms is strictly greater than this threshold. Unknown durations do not match. Scope the EXISTS by project and journey. This combines with service as independent journey predicates, matching current list semantics.
- `inactiveBefore`: ISO instant with a time zone; selects only active journeys whose lastEventAt is strictly before the cutoff. Reject contradictory non-active status and invalid/future cutoffs, rather than silently ignoring either filter.

Numeric thresholds accept whole milliseconds 0 through 2,147,483,647, consistently in API and UI. This deliberately matches the existing duration bound and covers waits up to about 24.8 days. Existing since/until, environment/project isolation, cursor order, escaping and pagination remain intact. Measure query plans before adding an index; the time window and existing per-journey event indexes may suffice.

The Journeys GET form offers journey duration, step duration, and active inactivity thresholds with clear units. Serialize them through filters, description, pagination, project changes and return links. Compute an explicit inactivity cutoff once and freeze it across pagination, the same way the existing rolling window is frozen. Explain that active inactivity is a debugging clue, not proof a job is stuck. No polling or alerts.

## Timeline and retry presentation

For consecutive loaded events, compute end-to-next-start only when the previous duration is known and timestamps are valid. Positive values are a recorded gap; zero is zero; negative values mean overlap or clock disagreement and are displayed as such, never as zero idle time. A missing duration means the idle gap is unknown; optionally show the clearly labelled start-to-start interval. Preserve timeline ordering. Gaps must be derived from the unfiltered loaded timeline so hiding a service/operation cannot fabricate adjacency. Do not attach a made-up gap at the first loaded row.

An adjacent published-to-consumed pair gets a `Publish → consume gap` label, explicitly distinguished from broker-measured queue wait. Adjacency alone does not prove matching messages. Valid queue metadata is shown separately with its basis. A cross-host difference, or missing host evidence, has a nearby clock caveat; matching service names alone never prove a shared clock.

Show each recorded attempt and its outcome from `hasError || operation === "failed"`: a terminal failed event can legitimately carry no error object. A successful `retried` event means that attempt worked, not that the journey completed. Build a per-step retry view only for explicit `(service, name, retryGroup)` identities. Without retryGroup, show the individual attempt and explain that attempts cannot be safely linked. Calculate delay only between unambiguous adjacent attempt numbers whose previous duration is known. Duplicate or missing attempt numbers, missing duration, negative delay, and incomplete loaded pages must remain explicit; do not guess a winning attempt from incomplete evidence. An observed successful attempt is labelled individually, not as proof there were no later retries.

Handle old APIs that omit the context gracefully. Keep existing event selection, keyboard navigation, pagination, no-JS links and mobile layout. Never fetch every full event detail merely to render timing.

## Verification and delivery

Meaningful tests cover unknown versus zero; invalid/redacted metadata; retry readiness; hostile SDK inputs; retry identity ambiguity; overlap/cross-host timestamps; loaded/filtered/paginated timeline behavior; filter bounds, strict thresholds, auth scoping and pagination; GET-form/no-JS/mobile behavior; and packed SDK exports. Update ADR-064, contracts and SDK documentation alongside behavior.

Dogfood every timing item in Leadline: queue backlog, retries/rate limits, ordinary and slow steps, active inactivity, missing/corrupt broker timing. Replace Leadline's duplicated zero-defaulting computation with the new semantics and compare its manifest measurements without treating retry enqueue age as queue wait. Preserve unrelated local work. Only mark roadmap items complete after that evidence and code review. Then refresh release tests, docs, claims/assets and deliver reviewed changes, keeping user-owned human validation and public release gates explicit.
