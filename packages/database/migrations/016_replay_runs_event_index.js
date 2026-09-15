/**
 * An index on replay_runs (project_id, journey_event_id), the foreign key to
 * journey_events.
 *
 * Deleting a journey cascades to its events, and every deleted event cascades
 * to replay_runs through this pair. PostgreSQL does not index the referencing
 * side of a foreign key, and 008 indexed replay_runs only by
 * (project_id, created_at), so each deleted event scanned the project's replay
 * runs. A retention batch of 1,000 journeys with 200 events each is 200,000 of
 * those scans. On a seeded database that batch ran past the API's 15-second
 * statement timeout, the sweep failed on the same batch every hour, and no
 * environment after it was ever swept.
 *
 * Numbered 016 because 014 and 015 are taken by branches in progress when this
 * was written. knex applies pending migrations by name, so 014 and 015 run when
 * they arrive even on a database that has already applied this one.
 *
 * Built concurrently, outside a transaction, for the reasons 013 gives: the
 * migrate step runs while the previous API is still recording replays, and a
 * cancelled concurrent build leaves an invalid index that `if not exists` would
 * accept, so one is dropped first.
 */
export const config = { transaction: false };

const NAME = "replay_runs_journey_event_idx";

/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function up(knex) {
  const invalid = await knex.raw(
    `select 1 from pg_index i
     join pg_class c on c.oid = i.indexrelid
     join pg_namespace n on n.oid = c.relnamespace
     where c.relname = ? and n.nspname = current_schema() and not i.indisvalid`,
    [NAME]
  );
  if (invalid.rows.length > 0) {
    await knex.raw(`drop index concurrently if exists ??`, [NAME]);
  }
  await knex.raw(
    `create index concurrently if not exists ?? on replay_runs (project_id, journey_event_id)`,
    [NAME]
  );
}

/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function down(knex) {
  await knex.raw(`drop index concurrently if exists ??`, [NAME]);
}
