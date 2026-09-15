/**
 * Indexes for listing recent journeys (GET /v1/journeys).
 *
 * journeys_status_recent_idx serves the default view: failed journeys in every
 * environment, newest first. The existing journeys_recent_idx leads with the
 * environment, so without this index that query was a parallel sequential scan
 * of every journey in the table. `id` is the last column so the index returns
 * rows already in the list's `(last_event_at desc, id desc)` order, and the
 * query stops after one page instead of sorting the whole window.
 *
 * journey_events_service_idx serves the service filter. The timeline index
 * answers "does this journey have an event from service X" by reading every
 * event of the journey, which is fine when the planner walks a few candidate
 * journeys. When it expects the service to be rare it instead hashes every
 * event carrying that service name, and without this index that meant a
 * sequential scan of journey_events.
 *
 * Measured on PostgreSQL 17 with 180,000 journeys over 14 days (150,000 in the
 * measured project across four environments; 5% failed, 10% active) and
 * 375,000 events, EXPLAIN (ANALYZE, BUFFERS), page of 25:
 *
 * - failed, all environments, 24 hours: was a parallel seq scan, 13 ms and
 *   5,800 buffers; now a backward scan of this index, 26 rows read, 0.15 ms.
 * - failed, one environment holding 5% of journeys, 24 hours: 511 index rows
 *   read to find 26, 0.7 ms. An API key's own environment, any status, uses
 *   journeys_recent_idx with an incremental sort: 27 rows, 0.1 ms.
 * - failed, service present on about 1 in 5 journeys, 24 hours: 133 candidate
 *   journeys, one index-only probe each, 0.9 ms.
 * - any status, a service on 0.1% of events, 7 days: was a parallel seq scan
 *   of journey_events, 13.7 ms and 13,000 buffers; now an index-only scan of
 *   353 entries, 5 ms.
 *
 * Not served by an index: any status in every environment. No index leads
 * with (project_id, last_event_at), so that view scans the project's journeys
 * (18 ms at this size for 7 days). One more index on last_event_at would fix
 * it at the cost of another index write on every event's journey update; the
 * page defaults to failed, so it is left for when a real install shows it.
 *
 * Write cost: journey_events_service_idx adds one index write to every event
 * insert, on the table that grows fastest. journeys_status_recent_idx adds one
 * to every journey summary update, which already could not be a HOT update
 * because journeys_recent_idx covers last_event_at.
 *
 * Built concurrently, outside a transaction. A plain CREATE INDEX holds a lock
 * that blocks inserts for the whole build, and the migrate step (the Helm Job,
 * or `migrate` before a Compose deploy) runs while the previous API is still
 * ingesting. On a large journey_events table that would stall ingestion for
 * the length of the build. CONCURRENTLY cannot run inside a transaction, hence
 * `config.transaction = false`.
 *
 * A cancelled or failed concurrent build leaves an index of that name behind,
 * marked invalid: PostgreSQL maintains it on writes but never reads from it.
 * `if not exists` would accept that index, so a retried Job would record this
 * migration as applied with an index that does nothing. An invalid index of
 * either name is dropped before its build.
 */
export const config = { transaction: false };

/** @type {readonly { name: string; definition: string }[]} */
const INDEXES = [
  {
    name: "journeys_status_recent_idx",
    definition: "journeys (project_id, status, last_event_at, id)"
  },
  {
    name: "journey_events_service_idx",
    definition: "journey_events (project_id, service, journey_id)"
  }
];

/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function up(knex) {
  for (const index of INDEXES) {
    const invalid = await knex.raw(
      `select 1 from pg_index i
       join pg_class c on c.oid = i.indexrelid
       join pg_namespace n on n.oid = c.relnamespace
       where c.relname = ? and n.nspname = current_schema() and not i.indisvalid`,
      [index.name]
    );
    if (invalid.rows.length > 0) {
      await knex.raw(`drop index concurrently if exists ??`, [index.name]);
    }
    await knex.raw(`create index concurrently if not exists ?? on ${index.definition}`, [
      index.name
    ]);
  }
}

/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function down(knex) {
  for (const index of [...INDEXES].reverse()) {
    await knex.raw(`drop index concurrently if exists ??`, [index.name]);
  }
}
