# Browsing journeys: labels, partial match, and a Journeys page

Date: 2026-09-16. Status: approved by the owner in a brainstorming session.

## Why

Dogfooding job-radar showed that the UI only answers two questions: "show me
the journey for this identifier" (Search, exact match) and "what failed
recently" (the Recent page). The owner could not browse what happened in a
period, or find a record from something they half-remembered, such as a company
name or part of a URL.

Two goals, chosen by the owner:

- **Browse what happened** in a chosen period, without knowing any identifier.
- **Find by partial text** that the owner remembers.

## Constraint

Entity identifiers and alias values are encrypted at rest and matched through
keyed search tokens (ADR-044), so the server can only match them exactly.
Masked values must stay that way. Two kinds of value are declared public by the
instrumenting code and can be matched by partial text without new exposure:

- aliases marked displayable (ADR-053), and
- the new journey label (below).

Payload search was considered and deferred: it needs an index over every
payload and reaches data nobody declared searchable.

## Design

### 1. Recording

- A journey gets an optional **label**: public display text of at most 200
  characters (Unicode code points, as the API counts), set by instrumenting
  code, for example `journey.label("Mirantis · Senior SWE, AI Infra")`.
- On the wire it is one new optional event field, `journeyLabel`. An event
  without it leaves the stored label unchanged.
- **Conflicts:** the label carried by the event with the latest `timestamp`
  (operation start, ADR-031) wins; ties are broken by the larger event id. A
  label is declared public, so an out-of-order or replayed event can at worst
  show a stale label, never expose anything.
- An empty string is refused per event (`invalid_event`), so a label cannot be
  "cleared" by accident; a host that wants no label sends none. The SDK never
  sends an empty label: it drops one with a diagnostic, so the event is not
  lost.
- The SDK applies the limit before sending, as it does for other capped strings
  (ADR-051): a longer label is cut, reported, and the event is still sent.
- Redaction does not run over the label: it is text the host wrote on purpose,
  like a displayable alias. The SDK documentation says plainly not to put
  personal data in it.

### 2. Storage

- `journeys.label text null`, `journeys.label_at timestamptz null` and
  `journeys.label_event_id text null` (for the conflict rule).
- `journeys.last_step text null` and `journeys.last_step_at timestamptz null`:
  the step name of the event with the latest `timestamp`, same tie rule, so an
  out-of-order event does not move it backwards.
- `entity_aliases.display_value text null`: a plain-text copy of the alias value,
  present only while `displayable` is true. The upsert that lowers the flag
  (ADR-053) sets it to null in the same statement. Key rotation leaves it alone
  (it is not ciphertext) and the duplicate folding keeps the survivor's value
  only if the folded flag stays true.
- All columns are nullable with no default: catalogue-only changes, no table
  rewrite. Each migration sets `lock_timeout = '5s'` and is retriable, as
  migration 017 does.
- Deletion, erasure, range deletion and retention remove the rows, so the
  label, last step and plain-text copies go with them. No new deletion code is
  needed; tests prove it.
- **No backfill.** Journeys recorded before this change show no label and no
  last step until their next event; plain-text copies exist only for aliases
  stated displayable after the upgrade. This is documented.

### 3. API

`GET /v1/journeys` gains:

| Parameter | Meaning |
| --- | --- |
| `until` | Optional ISO 8601 instant with a time zone; journeys whose last activity is before it. Must be after `since`. |
| `entityType` | Optional exact entity type. |
| `q` | Optional text, 2 to 200 characters. Case-insensitive "contains" match over the journey label and the plain-text values of displayable aliases. |

- `q` never matches masked aliases or entity identifiers; those stay exact-match
  through Search. The documentation says so where `q` is described.
- Matching uses plain PostgreSQL (`ILIKE` with `%`, `_` and `\` escaped, or an
  equivalent); no extension is required. It is always bounded by `since`
  (and `until`), so it scans a window, not the whole table.
- **Measured before shipping:** list latency with and without `q` at 120,000
  journeys (the size search was measured at), recorded in OPERATIONS sizing.
  If `q` is too slow at that size, add an index that needs no extension
  (for example on `lower(label)`) and measure again.
- Each row gains `label` (or null), `displayableAliases` (type and value pairs,
  only displayable ones) and `lastStep` (or null).
- Scope rules are unchanged: an API key reads its own environment only.
- Unknown query keys are refused (the route used to ignore them; this change
  makes it refuse them, which is a documented behaviour change), repeated keys
  stay refused, and every new parameter is validated like the existing ones
  (NUL bytes, lengths).

### 4. The Journeys page

- The Recent page becomes **Journeys** (`/journeys`), and `/recent` redirects to
  it keeping its query string.
- Layout: the dense table the owner chose, one line per journey. Columns: last
  activity, status, entity type, "Shown as", last step, event count. Long values
  are cut with an ellipsis and never widen the page (the 400 px rule from the
  dogfood fixes applies).
- **Shown as:** the label; if none, the displayable alias values joined with
  " · " in alias-type order, cut short; if none, the entity type and the masked
  identifier as today.
- Filter bar: a "contains" text box (`q`), time presets (last hour, 24 hours,
  7 days, 30 days) plus a custom range (`since`, `until`), status, entity type,
  environment and service. It stays a plain GET form, as the Recent page is.
- **Defaults:** any status, last 24 hours. A **Failures** shortcut link sets
  status to failed, so "what failed" stays one click. The navigation link reads
  "Journeys".
- An empty result explains which filters are set and that partial text only
  matches labels and displayable aliases.

### 5. Documentation and checks

- `docs/INGESTION_CONTRACT.md`, `docs/EVENT_PROTOCOL.md`, `docs/SDK_SPEC.md`,
  `docs/API_SPEC.md`, `docs/SECURITY.md` (what is stored in plain text, and
  why), `docs/DATABASE_SCHEMA.md`, `docs/OPERATIONS.md` (sizing, upgrade note),
  the SDK README, and the CHANGELOG.
- An ADR for journey labels and partial matching on public values (next free
  number).
- Regenerated JSON Schema and conformance manifest; new wire and SDK conformance
  cases for the label (set, conflict order, too long, empty refused) and for a
  displayable alias's plain-text copy appearing and disappearing.
- Docs-truth checks stay green.

## Follow-up (not in this change)

- job-radar sets a label from company and job title once the SDK is repacked.
- Payload search (approach C) if partial matching on public values proves too
  narrow.
- A backfill command for labels or last steps, if old journeys matter.

## Testing

- **Unit:** label cutting and conflict rule, `q` escaping, row fallback order,
  filter parsing, redirect.
- **Integration (PostgreSQL):** label and last step under out-of-order events;
  plain-text copy set when displayable and cleared when the flag falls in the
  same statement, including under concurrent ingestion; `q` matches label and
  displayable values, never masked values or entity ids, across environments
  only within the caller's scope; `%`, `_` and `\` in `q` are literal; `until`,
  `entityType`; deletion, erasure and retention remove the new data; migrations
  do not rewrite tables and give up behind a held lock.
- **Performance:** the 120,000-journey measurement above.
- **Browser:** the Journeys page with a label, with the fallback, with a
  "contains" filter, at 400 px with long values; `/recent` redirect; the
  Failures shortcut.
- **Upgrade test:** passes, and journeys from the previous build list with a
  null label and last step.
