/**
 * Which aliases each event stated (F-042).
 *
 * Aliases are stored per journey, one row per alias in `entity_aliases`,
 * deduplicated across every event that states the same one, and nothing
 * recorded which event stated which. So `GET /v1/events/:eventId` for an
 * `identified` event could not say what it identified. `stated_alias_ids`
 * holds the ids of the `entity_aliases` rows this event stated, written with
 * the event's own insert, so ingestion still writes an event row once and
 * never updates it. Reads join through the ids and present each row as the
 * journey read does, so masking is the journey's, and a later statement that
 * masks an alias masks it on every event that stated it (ADR-053). The one
 * later write is key rotation's: when it deletes a stale duplicate alias row
 * it points the ids that named it at the row that stays, which says the same.
 *
 * An array on the event rather than a table of links: a link table would need
 * foreign keys to both tables, which every retention and deletion batch would
 * then check row by row, and a row per event to tell an event that stated
 * nothing from one stored before this migration. Null here says "not
 * recorded"; an empty array says "stated none".
 *
 * Safe on a live database. A nullable column with no default is a catalogue
 * change: existing rows read null without the table being rewritten, so the
 * exclusive lock the ALTER takes is held for an instant rather than for a
 * copy. That lock still has to wait for every transaction already reading or
 * writing `journey_events`, and every ingestion that arrives meanwhile queues
 * behind the ALTER, so `lock_timeout` makes it give up after five seconds
 * instead of stalling ingestion, as 017 and 018 do. A migration that gave up
 * leaves nothing behind; run `migrate` again. No index is added: a read goes
 * from the event to its ids and then to `entity_aliases` by primary key.
 *
 * There is no backfill, because nothing recorded the link before. Events
 * written before this migration, and events the previous API writes between
 * migrate and deploy, read null, which the API returns as `aliases: null`.
 *
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function up(knex) {
  await knex.raw("set local lock_timeout = '5s'");
  await knex.raw(
    "alter table journey_events add column if not exists stated_alias_ids uuid[] null"
  );
}

/**
 * Dropping the column is also a catalogue change, under the same lock and the
 * same timeout. Every event then reads as one whose aliases were not
 * recorded, which is the state before this migration.
 *
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function down(knex) {
  await knex.raw("set local lock_timeout = '5s'");
  await knex.raw("alter table journey_events drop column if exists stated_alias_ids");
}
