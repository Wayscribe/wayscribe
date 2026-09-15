/**
 * Index for search by span id.
 *
 * Search resolves a pasted value as a union of index lookups, one per kind of
 * identifier (see `searchJourneys`). Migration 006 indexed trace, message, and
 * correlation ids but not span ids, because search then reached events only
 * through each journey's timeline index. As its own branch, span id without an
 * index is a sequential scan of journey_events, the largest table.
 *
 * Partial, like 006's: span_id is null on events recorded without tracing.
 *
 * Measured on PostgreSQL 17 with 120,000 journeys and 360,000 events, half of
 * them carrying a span id: the rewritten search without this index took 24 ms
 * for any value, nearly all of it a parallel sequential scan of journey_events
 * for the span id branch; with it, 0.08 ms. At 1,000,000 journeys and
 * 3,000,000 events the index is 84 MB, built in 3 seconds, and search takes
 * 0.1 ms. The full before-and-after is on `searchJourneys`.
 *
 * Built concurrently, outside a transaction, for the reason 013 gives: the
 * migrate step runs while the previous API is still ingesting, and a plain
 * CREATE INDEX on journey_events blocks every insert for the whole build.
 * An invalid index a cancelled build left behind is dropped before building,
 * because `if not exists` would accept it and record the migration as applied
 * with an index PostgreSQL never reads.
 */
export const config = { transaction: false };

/** @type {readonly { name: string; definition: string }[]} */
const INDEXES = [
  {
    name: "journey_events_span_idx",
    definition: "journey_events (project_id, span_id) where span_id is not null"
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
