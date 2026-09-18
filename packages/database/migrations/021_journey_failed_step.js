/**
 * The step that failed a journey (ADR-063, F-047).
 *
 * `last_step` follows the event that is last in timeline order, failing or
 * not, so between a failure and the event that settles it every later
 * successful step moved it off the step that failed: a journey failed at
 * `push-hubspot` read `lastStep: "map-hubspot"` while its retry ran.
 * `failed_step` holds the `name` of the failing event that is last in
 * timeline order among the failures applied since the journey last became
 * failed, with the three values that set it, `(timestamp, received at, event
 * id)`, as 018 stores them for the label and the last step. The summary
 * update sets and clears them in the statement that sets the status.
 *
 * Safe on a live database, as 020 is. Nullable columns with no default are a
 * catalogue change: existing rows read null without the table being
 * rewritten, so the exclusive lock the ALTER takes is held for an instant.
 * That lock still has to wait for every transaction already reading or
 * writing `journeys`, and every ingestion that arrives meanwhile queues behind
 * the ALTER, so `lock_timeout` makes it give up after five seconds instead of
 * stalling ingestion. `set local` holds because knex runs this migration in
 * its transaction. A migration that gave up leaves nothing behind; run
 * `migrate` again. No index: the list is not filtered by the failed step.
 *
 * No backfill. Rebuilding the value for every failed journey means reading
 * their events under row locks that ingestion needs, for a value the next
 * failure sets anyway. Journeys written before this migration, and journeys
 * the previous API writes between migrate and deploy, read null, and the
 * reads show the column only while the status is `failed`, so a value a
 * previous-build instance left behind when it cleared a failure is never
 * shown.
 *
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function up(knex) {
  await knex.raw("set local lock_timeout = '5s'");
  await knex.raw(
    `alter table journeys
       add column if not exists failed_step text null,
       add column if not exists failed_step_at timestamptz null,
       add column if not exists failed_step_received_at timestamptz null,
       add column if not exists failed_step_event_id text null`
  );
}

/**
 * Dropping the columns is also a catalogue change, under the same lock and
 * the same timeout. Every failed journey then reads as one whose failure
 * predates the column, which is the state before this migration.
 *
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function down(knex) {
  await knex.raw("set local lock_timeout = '5s'");
  await knex.raw(
    `alter table journeys
       drop column if exists failed_step,
       drop column if exists failed_step_at,
       drop column if exists failed_step_received_at,
       drop column if exists failed_step_event_id`
  );
}
