/**
 * Columns for browsing journeys: a display label and the last step per
 * journey, and a plain-text copy of displayable alias values to search.
 *
 * `journeys.label` is a public display label an event may carry. Events arrive
 * out of order, so the stored label is the one from the event with the latest
 * `(timestamp, event id)`; `label_at` and `label_event_id` hold that pair so an
 * older event arriving later cannot replace a newer label, and the event id
 * breaks a tie between equal timestamps.
 *
 * `journeys.last_step` is the step name of the event with the latest
 * `(timestamp, event id)`, under the same rule, so `last_step_at` and
 * `last_step_event_id` hold that pair and the last step never moves backwards.
 *
 * `entity_aliases.display_value` is a plain-text copy of the alias value that
 * exists only while the alias is displayable (ADR-053): ingestion stores it
 * with the flag and clears it in the same statement that lowers the flag. It
 * lets a search match a displayable value without decrypting every alias.
 *
 * Safe on a live database. A nullable column with no default is a catalogue
 * change: existing rows read null without either table being rewritten, so the
 * exclusive lock each ALTER takes is held for an instant rather than for a
 * copy. That lock still has to wait for every transaction already reading or
 * writing the table, and every ingestion that arrives meanwhile queues behind
 * the ALTER, so `lock_timeout` makes it give up instead of stalling
 * ingestion. The timeout applies to each lock request, not to the migration:
 * the first ALTER can wait up to five seconds for `journeys`, then holds that
 * lock while the second waits up to five more for `entity_aliases`, so in the
 * worst case writes to `journeys` stall for about ten seconds. Ingestion takes
 * its locks in the same order, `journeys` before `entity_aliases`, so a
 * deadlock with it is not expected. The migration runs in one transaction, so
 * one that gave up leaves nothing behind; run `migrate` again.
 *
 * There is no backfill. Journeys and aliases written before this migration
 * read null. A journey's `last_step` fills on its next event; its `label` stays
 * null, which the UI shows as no label, until an event that carries a label
 * arrives. The previous API, still running between migrate and deploy, writes
 * rows without these columns, and they read null the same way.
 *
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function up(knex) {
  await knex.raw("set local lock_timeout = '5s'");
  await knex.raw(
    `alter table journeys
       add column if not exists label text null,
       add column if not exists label_at timestamptz null,
       add column if not exists label_event_id text null,
       add column if not exists last_step text null,
       add column if not exists last_step_at timestamptz null,
       add column if not exists last_step_event_id text null`
  );
  await knex.raw("alter table entity_aliases add column if not exists display_value text null");
}

/**
 * Dropping the columns is also a catalogue change, under the same timeout per
 * lock request. It takes the locks in the same order as `up` and as
 * ingestion, `journeys` then `entity_aliases`, so in the worst case it stalls
 * writes to `journeys` for about ten seconds and a deadlock with ingestion is
 * not expected. Labels, last steps and plain-text copies are then gone, which
 * is the state before this migration.
 *
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function down(knex) {
  await knex.raw("set local lock_timeout = '5s'");
  await knex.raw(
    `alter table journeys
       drop column if exists last_step_event_id,
       drop column if exists last_step_at,
       drop column if exists last_step,
       drop column if exists label_event_id,
       drop column if exists label_at,
       drop column if exists label`
  );
  await knex.raw("alter table entity_aliases drop column if exists display_value");
}
