/**
 * Whether an alias may be shown in full (ADR-053).
 *
 * Alias values are masked when they are read, because a reader may not be
 * entitled to identifiers other than the one they searched for. Instrumenting
 * code can now mark particular aliases as displayable; this column holds that
 * mark per alias row. It is true only while every event that stated the alias
 * marked it, so ingestion lowers it and never raises it.
 *
 * Safe on a live database. A column with a constant default is a catalogue
 * change on PostgreSQL 11 and later (the installation needs 15): existing rows
 * read the default without the table being rewritten, so the exclusive lock
 * the ALTER takes is held for an instant rather than for a copy. That lock
 * still has to wait for every transaction already reading or writing the
 * table, and every ingestion that arrives meanwhile queues behind the ALTER,
 * so `lock_timeout` makes it give up after five seconds instead of stalling
 * ingestion. A migration that gave up leaves nothing behind; run `migrate`
 * again.
 *
 * The previous API, still running between migrate and deploy, inserts without
 * the column and gets `false`: masked, as it always was.
 *
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function up(knex) {
  await knex.raw("set local lock_timeout = '5s'");
  await knex.raw(
    "alter table entity_aliases add column if not exists displayable boolean not null default false"
  );
}

/**
 * Dropping a column is also a catalogue change, under the same lock and the
 * same timeout. Every alias is then masked again, which is the state before
 * this migration.
 *
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function down(knex) {
  await knex.raw("set local lock_timeout = '5s'");
  await knex.raw("alter table entity_aliases drop column if exists displayable");
}
