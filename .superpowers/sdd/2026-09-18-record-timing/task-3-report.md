# Task 3 report — journey and timeline timing UI

## Outcome

Implemented the timing investigation UI on branch `timing`. The worktree began from
`33bb9e9` and also contains the controller's design clarification `ce2f4ef` about
redeliveries. The web still has no runtime dependency on a workspace package, no
service or protocol version changed, and older API responses remain usable.

The Journeys list now shows the recorded first-to-last event span and accepts strict
journey-span, known-step-duration, and active-inactivity filters. Timing values are
canonical whole milliseconds from 0 through 2,147,483,647. Invalid or repeated values
produce notes and clear pagination rather than silently widening a cursor query. The
UI turns the inactivity threshold into a single `inactiveBefore` instant, freezes it
through pagination, project selection, and detail return links, and continues to bind
the result by the chosen activity window. Its hint says inactivity is a debugging clue,
not proof that a job is stuck.

Journey detail now shows:

- recorded span, with wording that it is first event start to last event start rather
  than a sum or completion duration;
- gaps derived from the full loaded, unfiltered event sequence, including true zero,
  overlap/clock disagreement, unknown previous duration, and publish-to-consume wording;
- host uncertainty beside each applicable comparison;
- explicit retry groups keyed by service, step name, and retry identity, with each
  attempt's own outcome, unambiguous observed delay, skipped/duplicate/missing evidence,
  unlinked attempts, and loaded-page limitations;
- labelled operational context for queue, measured wait and basis, delivery count,
  attempt/outcome, retry identity, target, HTTP status, requested Retry-After, and
  recorded host, while retaining the existing arbitrary metadata display.

An event is failed when it has an error or its operation is `failed`. A successful
`retried` event describes that attempt only. Requested Retry-After is not presented as
observed delay. Initial-enqueue waits are accepted only for attempt 1 without an
explicit delivery count above 1; retry-ready waits require an attempt above 1. The
contradictory redelivery pair is suppressed while attempt and delivery count stay
visible. Unknown evidence is omitted or labelled unknown; measured zero stays zero.

## TDD evidence

The meaningful presentation work was driven from focused failures:

- RED: timing presentation import/stubs left 9 of 10 focused cases failing for spans,
  true zero, missing duration, overlaps, clock evidence, filtered adjacency, retry
  grouping, duplicate/skipped attempts, negative/missing delays, and partial pages.
  GREEN: `pnpm exec vitest run --project node apps/web/src/lib/timing-presentation.test.ts`
  passed all 10 cases after the pure helpers were implemented.
- RED: event-display contract tests had three failures before the additive fields and
  defensive local parser existed. The broker clarification added one focused failing
  case for attempt 1 plus `deliveryCount: 2`. GREEN: the parser projects valid fields,
  preserves zero, defaults old rows to `{}`/`null`, and suppresses that wait pair.
- RED: journey-filter tests failed for bounds, strict API serialization, contradictory
  statuses, cutoff freezing, descriptions, and state propagation. GREEN: the final
  focused node group passed 183 tests across event display, timing presentation,
  timeline filtering, and journey filters.
- RED: component cases failed before span cells/summary, operational context, attempts,
  gaps, and labels were rendered. GREEN: the final focused web group passed 104 tests
  across seven component files.
- Browser RED: the new span column clipped `Recorded span` at 400 and 1280 px, and
  squeezed `Shown as` at 400 px. The existing layout assertion reproduced the exact
  clipped headers. Browser GREEN: responsive full/short labels and measured widths made
  both cases pass without horizontal overflow.

## Verification

All commands used Node 24.19.0 from
`/Users/jorgepolanco/.nvm/versions/node/v24.19.0/bin`.

- `pnpm test` — 188 files, 3,406 tests passed.
- focused node timing/display/filter/timeline tests — 4 files, 183 tests passed.
- focused web component tests — 7 files, 104 tests passed.
- `pnpm --filter @wayscribe/web typecheck` — passed.
- scoped ESLint over web app, source, and changed browser specs — passed with no output.
- Prettier check over README and relevant web files/specs — passed.
- `pnpm --filter @wayscribe/web build` — production build and Next type validation
  passed. Next emitted the existing multiple-lockfile workspace-root warning.
- final browser matrix through the private test environment — 43 tests passed in 42.6s:
  new timing flows, existing journey keyboard/selection and failure filtering, journeys
  list/back/security behavior, 400/1280 responsive layout, JavaScript-disabled forms,
  and loading behavior.

The new browser spec specifically proves:

- desktop strict span filtering, span display, gaps, cross-host caveat, queue wait basis,
  explicit retry identity, attempt outcome, observed delay, requested Retry-After, and
  arbitrary metadata coexistence;
- active inactivity cutoff survives a detail link and return;
- 400 px timing detail has no horizontal overflow;
- the first 100-event page says later attempts may exist, loading event 101 removes the
  loaded-page warning and load-more control;
- with JavaScript disabled, recorded span/gaps render, event anchors navigate, and the
  measured queue context remains available;
- the established keyboard test walks selection, applies Failures only without a
  document reload, and now includes an operation-failed event without an error object.

Synthetic fixture screenshots contain no credentials or customer data:

- desktop retry/operational context: `/tmp/wayscribe-timing-desktop.png`
- mobile gap/clock presentation: `/tmp/wayscribe-timing-mobile.png`

The mobile screenshot and browser probe measured zero horizontal overflow. The desktop
fixture visibly separates two retry identities, shows missing attempt 3, unlinked
attempts, requested Retry-After, observed delay, and raw metadata.

## Files

Core contracts and helpers:

- `apps/web/src/lib/api.ts`
- `apps/web/src/lib/event-display.ts` and `event-display.test.ts`
- `apps/web/src/lib/timing-context.ts`
- `apps/web/src/lib/timing-presentation.ts` and `timing-presentation.test.ts`
- `apps/web/src/lib/journey-filters.ts` and `journey-filters.test.ts`
- `apps/web/src/lib/timeline.ts` and `timeline.test.ts`

Pages and components:

- journey list/detail pages under `apps/web/app/(authenticated)/journeys/`
- `JourneyFilterBar`, `JourneyRow`, `JourneyTable`, `JourneyTimingSummary`,
  `JourneyTimeline`, `TimelineList`, `EventDetail`, `OperationalContext`, and
  `RetrySummary`, with focused component tests
- `apps/web/app/globals.css`

Browser/docs:

- new `apps/web/e2e/timing.spec.ts`
- updated `journey.spec.ts`, `journeys.spec.ts`, `layout.spec.ts`, and
  `no-javascript.spec.ts`
- `README.md`

## Self-review

Reviewed all changed TSX against the React best-practices checklist. Derivations remain
in render or memoized from stable inputs; no effect duplicates derived state; retry and
timing maps are memoized; direct imports avoid barrel growth; server fetches remain in
their existing parallel path. The existing SSR/client split, Live polling, selection,
filtered adjacency, keyboard listbox behavior, and no-JavaScript anchors remain intact.

Reviewed the contract boundary separately. The local parser reads only own properties,
catches hostile getters, bounds text/code points and numeric fields, rejects markers and
invalid hosts, and validates fields independently. The page never invents a duration,
host, retry identity, queue wait, winner, or completion. Raw custom metadata remains on
detail. No dependency, service, schema, protocol-version, or unrelated restructuring was
introduced.

The API remains running on port 18080 under controller ownership. The task's Next dev
process was stopped before the production build and restarted afterward on
127.0.0.1:13000 as exec session `69387`; it is ready and left running for review.

## Scoped review fix round 1

The five Important findings in `task-3-review.md` and the hook-order observation are
fixed without widening the feature scope:

- Missing attempt evidence is now derived from sorted loaded attempt numbers and emitted
  as one bounded range per observed gap. It includes missing leading attempts and remains
  constant-size for `1` followed by `Number.MAX_SAFE_INTEGER`; no loop walks the numeric
  range. Events with an explicit retry identity but no valid attempt number remain visible
  as `Attempt number unknown` with a separate evidence issue.
- Every displayed observed retry delay now gets its own host comparison. Different hosts
  or missing host evidence place a clock caveat beside that delay, even when unrelated
  timeline events occur between the attempts.
- Retry-attempt anchors retain the detail page's full server query. Ordinary primary
  clicks call the established in-place selection path, which preserves loaded pagination,
  filters, keyboard/list state, and the return target. Modifier, non-primary, and no-JS
  navigation use the same real context-bearing href.
- Positive, unknown, and overlap publish-to-consume gaps keep the
  `Publish → consume gap` label and state that adjacency does not prove a matching
  message or broker-measured queue wait.
- `OperationalContext` now calls `useId` unconditionally. Its rerender regression covers
  absent → present → absent operational evidence.

### Fix-round TDD and verification evidence

Focused regressions were written for the reviewed behaviors before the corresponding
helpers/components were changed. Per the review instruction, the MAX_SAFE_INTEGER case
was not executed against the old integer-by-integer implementation; the reviewed
unbounded loop was the RED evidence and the new bounded assertion ran only after the
algorithm was replaced. The first component run exposed two assertion problems in the
new tests (the intentional overlap label and an ambiguous heading locator); correcting
those assertions produced the final GREEN runs below.

All commands used Node 24.19.0 from
`/Users/jorgepolanco/.nvm/versions/node/v24.19.0/bin`.

- `pnpm exec vitest run --project node apps/web/src/lib/timing-presentation.test.ts`
  — 1 file, 14 tests passed in 177 ms.
- `pnpm exec vitest run --project web apps/web/app/components/JourneyTimeline.test.tsx apps/web/app/components/EventDetail.test.tsx apps/web/app/components/TimelineList.test.tsx`
  — 3 files, 68 tests passed in 1.27 s.
- `node /tmp/wayscribe-timing-run.mjs pnpm --filter @wayscribe/web exec playwright test e2e/timing.spec.ts`
  — 6 tests passed in 7.1 s. This covers desktop/mobile timing, in-place retry selection
  after loading 101 events, JavaScript-disabled timing links, and a no-JS retry/back path
  retaining service and duration filters.
- `pnpm --filter @wayscribe/web typecheck` — passed with no TypeScript diagnostics.
- `pnpm --filter @wayscribe/web exec eslint <11 scoped timing source/test files>` — passed
  with no output.
- `pnpm exec prettier --check <11 scoped timing source/test files>` — all matched files
  use Prettier code style.
- `pnpm --filter @wayscribe/web build` — compiled successfully, Next type validation
  passed, 11/11 static pages generated. It emitted only the previously triaged
  multiple-lockfile workspace-root warning.

The production build and an initial typecheck were mistakenly launched concurrently;
that typecheck reported TS6053 for transient `.next/types` files while the build replaced
that directory. The build's own type validation passed, and the required sequential
`pnpm --filter @wayscribe/web typecheck` rerun above passed cleanly.

Controller-owned independent acceptance against the rebuilt dev server also passed. It
rendered the safe-integer sparse history as the single range
`Attempts 2–9007199254740990`, qualified a cross-host non-adjacent retry delay, exposed
unknown and leading attempt evidence, qualified a publish/consume overlap, retained all
101 loaded events after retry selection, and preserved the no-JS duration-filter return
at 400 px with zero overflow. Machine-readable evidence is in
`/tmp/wayscribe-timing-ui-review-acceptance-result.json`; visually inspected screenshots
are `/tmp/wayscribe-timing-review-desktop.png` and
`/tmp/wayscribe-timing-review-mobile-nojs.png`.

The controller-owned API remains on port 18080. The rebuilt Next dev server is ready on
127.0.0.1:13000 as exec session `96944`. The only remaining concern is the existing Next
workspace-root warning described above.
