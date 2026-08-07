# Database Schema

## 1. Goals

The V0 schema must support:

- project and environment isolation
- idempotent ingestion
- journey summaries
- entity alias search
- chronological event retrieval
- structural payload diffs
- development replay
- audit history
- retention cleanup

PostgreSQL is the only required data store.

## 2. General conventions

- UUID or UUID-compatible sortable identifiers
- UTC timestamps using `timestamptz`
- snake_case database names
- `jsonb` for flexible structured payloads
- explicit foreign keys
- project-scoped indexes
- append-only journey events
- migrations for every change

## 3. Tables

### `projects`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `name` | text | Display name |
| `slug` | text | Unique stable slug |
| `created_at` | timestamptz | Required |
| `updated_at` | timestamptz | Required |

Indexes and constraints:

- primary key on `id`
- unique on `slug`

### `environments`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `project_id` | uuid | FK to projects |
| `name` | text | `local`, `development`, `staging`, `production` |
| `retention_days` | integer | Positive |
| `capture_mode` | text | `metadata-only`, `allowlisted-fields`, `redacted-payload`, `full-payload` |
| `created_at` | timestamptz | Required |
| `updated_at` | timestamptz | Required |

Constraints:

- unique `(project_id, name)`
- check `retention_days > 0`
- check capture mode against allowed values

### `api_keys`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `project_id` | uuid | FK |
| `environment_id` | uuid | FK |
| `name` | text | Human-readable |
| `key_prefix` | text | Safe lookup/display prefix |
| `key_hash` | text | Strong password-style hash or HMAC design |
| `last_used_at` | timestamptz | Nullable |
| `revoked_at` | timestamptz | Nullable |
| `created_at` | timestamptz | Required |

Constraints:

- unique `key_prefix`
- environment must belong to the same project, enforced in application logic or composite FK design

### `journeys`

| Column | Type | Notes |
|---|---|---|
| `id` | text | Public journey ID |
| `project_id` | uuid | FK |
| `environment_id` | uuid | FK |
| `entity_type` | text | Example: customer |
| `primary_entity_id_hash` | text | Searchable normalized hash |
| `encrypted_primary_entity_id` | bytea or text | Optional display value |
| `status` | text | active, completed, failed |
| `started_at` | timestamptz | First event timestamp |
| `completed_at` | timestamptz | Nullable |
| `last_event_at` | timestamptz | Latest event timestamp |
| `event_count` | integer | Derived summary |
| `created_at` | timestamptz | Required |
| `updated_at` | timestamptz | Required |

Constraints and indexes:

- composite primary key `(project_id, id)`
- index `(project_id, environment_id, last_event_at desc)`
- index `(project_id, entity_type, primary_entity_id_hash)`
- check event count is nonnegative

### `entity_aliases`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `project_id` | uuid | Denormalized for safe scoping |
| `journey_id` | text | Composite FK `(project_id, journey_id)` to journeys |
| `alias_type` | text | Developer-defined stable name |
| `alias_value_hash` | text | Normalized search hash |
| `encrypted_display_value` | bytea or text | Optional |
| `created_at` | timestamptz | Required |

Constraints and indexes:

- unique `(project_id, journey_id, alias_type, alias_value_hash)`
- index `(project_id, alias_type, alias_value_hash)`
- index `(project_id, alias_value_hash)`

An alias value may intentionally map to more than one journey over time. Do not globally force uniqueness unless the domain requires it.

### `journey_events`

| Column | Type | Notes |
|---|---|---|
| `id` | text | Client-generated public event ID |
| `project_id` | uuid | Required |
| `environment_id` | uuid | Required |
| `journey_id` | text | Required |
| `parent_event_id` | text | Nullable |
| `protocol_version` | text | Required |
| `content_hash` | text | Canonical hash for duplicate-conflict detection |
| `operation` | text | Required |
| `name` | text | Required |
| `service` | text | Required |
| `event_timestamp` | timestamptz | Client timestamp |
| `received_at` | timestamptz | Server timestamp |
| `duration_ms` | integer | Nullable |
| `trace_id` | text | Nullable |
| `span_id` | text | Nullable |
| `message_id` | text | Nullable |
| `correlation_id` | text | Nullable |
| `input_payload` | jsonb | Nullable |
| `output_payload` | jsonb | Nullable |
| `payload_diff` | jsonb | Nullable |
| `error` | jsonb | Nullable |
| `runtime_metadata` | jsonb | Nullable |
| `deployment_metadata` | jsonb | Nullable |
| `custom_metadata` | jsonb | Nullable |
| `created_at` | timestamptz | Required |

Constraints and indexes:

- composite primary key `(project_id, id)`, which provides idempotency
- index `(project_id, journey_id, event_timestamp, received_at, id)`
- index `(project_id, trace_id)` where trace ID is not null
- index `(project_id, message_id)` where message ID is not null
- index `(project_id, correlation_id)` where correlation ID is not null
- optional index `(project_id, operation, event_timestamp desc)`
- check `duration_ms >= 0`

The event row is immutable after insertion.

### `replay_destinations`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `project_id` | uuid | FK |
| `name` | text | Display name |
| `base_url` | text | Validated destination |
| `environment_type` | text | Must be development-like in V0 |
| `encrypted_headers` | bytea or text | Optional |
| `enabled` | boolean | Required |
| `created_at` | timestamptz | Required |
| `updated_at` | timestamptz | Required |

### `replay_runs`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `project_id` | uuid | FK |
| `journey_event_id` | text | Source event |
| `destination_id` | uuid | FK |
| `method` | text | HTTP method |
| `request_path` | text | Relative path |
| `request_payload` | jsonb | Sanitized |
| `request_headers` | jsonb | Sanitized |
| `response_status` | integer | Nullable |
| `response_payload` | jsonb | Sanitized and size-limited |
| `duration_ms` | integer | Nullable |
| `status` | text | queued, running, completed, failed, blocked |
| `error` | jsonb | Nullable |
| `initiated_by` | text | User or local actor |
| `created_at` | timestamptz | Required |
| `completed_at` | timestamptz | Nullable |

### `audit_events`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `project_id` | uuid | FK |
| `actor` | text | User, API key, or system |
| `action` | text | Stable action name |
| `resource_type` | text | Example: replay |
| `resource_id` | text | Nullable |
| `metadata` | jsonb | Sanitized |
| `created_at` | timestamptz | Required |

Indexes:

- `(project_id, created_at desc)`
- `(project_id, action, created_at desc)`

## 4. Search normalization

Exact search values should be normalized before hashing.

Examples:

- trim surrounding whitespace
- normalize UUID case
- normalize email case only where domain semantics allow
- preserve meaningful punctuation for external identifiers
- include alias type in HMAC input when appropriate

Prefer an HMAC-based search token using a server-held key rather than a plain unsalted hash for sensitive low-entropy values.

## 5. Payload encryption

V0 may initially rely on encrypted database storage at the infrastructure layer for local development, but the application design should leave room for field or envelope encryption of display values and payloads.

Encryption keys must not be stored in the database.

## 6. Retention

Retention cleanup should:

1. select expired journeys by environment policy
2. delete replay references safely
3. delete events and aliases
4. delete journey summaries
5. record cleanup metrics
6. operate in bounded batches

Do not run one unbounded deletion transaction.

## 7. Migration order

Recommended initial migrations:

1. projects
2. environments
3. api_keys
4. journeys
5. entity_aliases
6. journey_events
7. replay_destinations
8. replay_runs
9. audit_events
10. indexes and constraints not safely created inline
11. local development seed

## 8. Future storage growth

Do not introduce additional stores in V0.

Possible later split:

- PostgreSQL for configuration and summaries
- S3-compatible storage for encrypted payload blobs
- ClickHouse for high-volume event analytics

Any split must preserve the public protocol and query behavior.
