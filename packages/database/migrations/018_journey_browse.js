/** Refuses a masked alias row that holds a plain value. */
const CONSTRAINT = "entity_aliases_display_value_only_when_displayable";

/** The trigger, and the function it runs, that clear the copy of a masked row. */
const TRIGGER = "entity_aliases_clear_masked_display_value";

/** Every column this migration adds, as `[table, column]`. */
const ADDED = [
  ["journeys", "label"],
  ["journeys", "label_at"],
  ["journeys", "label_received_at"],
  ["journeys", "label_event_id"],
  ["journeys", "last_step"],
  ["journeys", "last_step_at"],
  ["journeys", "last_step_received_at"],
  ["journeys", "last_step_event_id"],
  ["entity_aliases", "display_value"]
];

/**
 * Columns for browsing journeys: a display label and the last step per
 * journey, and a plain-text copy of displayable alias values to search.
 *
 * `journeys.label` is a public display label an event may carry. Events arrive
 * out of order, so the stored label is the one from the event that comes last
 * in the journey's timeline order, `(timestamp, received at, event id)`;
 * `label_at`, `label_received_at` and `label_event_id` hold that event's three
 * so an older event arriving later cannot replace a newer label. Timestamps
 * are stored to the millisecond and the Node SDK stamps whole milliseconds,
 * so a quick journey's events tie on it; the time the server received each
 * event breaks that tie as the timeline does, and the event id breaks a tie
 * on both.
 *
 * `journeys.last_step` is the step name of the event that comes last in the
 * same order, so `last_step_at`, `last_step_received_at` and
 * `last_step_event_id` hold that event's three, the last step never moves
 * backwards, and it is the step the timeline shows last.
 *
 * `entity_aliases.display_value` is a plain-text copy of the alias value that
 * exists only while the alias is displayable (ADR-053): ingestion stores it
 * with the flag and clears it in the same statement that lowers the flag. It
 * lets a search match a displayable value without decrypting every alias.
 *
 * `entity_aliases_display_value_only_when_displayable` makes that rule the
 * database's: a row that is masked and holds a plain value is refused, whatever
 * code wrote it.
 *
 * `entity_aliases_clear_masked_display_value`, a BEFORE INSERT OR UPDATE row
 * trigger, clears the copy of any row about to be written masked, before the
 * check sees it. It exists for the previous API, which keeps ingesting between
 * migrate and deploy and during a rolling upgrade. That build lowers the flag
 * without knowing the copy exists (`merge({ displayable: false })`), and its
 * key rotation folds the same way, so without the trigger its masking
 * statement would violate the check: the event would fail with a 500, and the
 * database error, whose detail prints the row, would carry the value being
 * masked into the log. With the trigger the old statement succeeds and the
 * copy goes with the flag. The current build clears the copy itself, so for it
 * the trigger finds nothing to do, and a call per alias row written measured
 * no difference in ingestion. The condition is in the function rather than a
 * WHEN clause, because a WHEN clause would make `displayable` a column the
 * trigger depends on, and 017's `down` could no longer drop it. The check stays: a
 * write that skips triggers (a disabled trigger, `session_replication_role =
 * replica`) is still refused a masked row with a copy. The function is
 * plpgsql, which every PostgreSQL has; no extension is needed.
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
 * deadlock with it is not expected.
 *
 * The check constraint is added `not valid` in the same transaction, which is
 * a catalogue change too: new rows are checked from then on, existing ones are
 * not read. It is validated afterwards in a transaction of its own. VALIDATE
 * reads every row but takes only SHARE UPDATE EXCLUSIVE, which does not block
 * reads or writes, and the column is null in every row just after it is
 * added, so the check always passes. Validating inside the first transaction
 * would scan the table while still holding the exclusive lock the ALTERs
 * took, which blocks ingestion for the length of the scan; that is why this
 * migration runs outside knex's transaction (`config.transaction = false`)
 * and opens its own two.
 *
 * Retriable. The first transaction is all or nothing, so one that gave up
 * leaves nothing behind. If validation gives up, the columns, the trigger and
 * the unvalidated constraint stay, the migration is not recorded as run, and
 * the next `migrate` skips the first transaction (so it takes no exclusive
 * lock again) and validates. Validating a constraint that is already valid
 * does nothing. A database missing any of those pieces runs the first
 * transaction again, and every statement in it adds only what is missing.
 *
 * There is no backfill. Journeys and aliases written before this migration
 * read null. A journey's `last_step` fills on its next event; its `label` stays
 * null, which the UI shows as no label, until an event that carries a label
 * arrives. The previous API, still running between migrate and deploy, writes
 * rows without these columns, and they read null the same way, which the
 * constraint allows. When it masks an alias the current build has already
 * given a copy, the trigger clears the copy; without the trigger that
 * statement would be refused.
 *
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function up(knex) {
  if (!(await complete(knex))) {
    await knex.transaction(async (trx) => {
      await trx.raw("set local lock_timeout = '5s'");
      await trx.raw(
        `alter table journeys
           add column if not exists label text null,
           add column if not exists label_at timestamptz null,
           add column if not exists label_received_at timestamptz null,
           add column if not exists label_event_id text null,
           add column if not exists last_step text null,
           add column if not exists last_step_at timestamptz null,
           add column if not exists last_step_received_at timestamptz null,
           add column if not exists last_step_event_id text null`
      );
      await trx.raw("alter table entity_aliases add column if not exists display_value text null");
      // Checked after the ALTER, under its lock, so no other migration run can
      // add the constraint in between. PostgreSQL has no ADD CONSTRAINT IF NOT
      // EXISTS.
      if (!(await hasConstraint(trx))) {
        await trx.raw(
          `alter table entity_aliases
             add constraint ${CONSTRAINT} check (displayable or display_value is null) not valid`
        );
      }
      // The table is already locked by the ALTER above, so creating the
      // trigger waits for nothing more.
      await trx.raw(
        `create or replace function ${TRIGGER}() returns trigger
           language plpgsql as $$
         begin
           if not new.displayable then
             new.display_value := null;
           end if;
           return new;
         end
         $$`
      );
      await trx.raw(
        `create or replace trigger ${TRIGGER}
           before insert or update on entity_aliases
           for each row
           execute function ${TRIGGER}()`
      );
    });
  }

  await knex.transaction(async (trx) => {
    await trx.raw("set local lock_timeout = '5s'");
    await trx.raw(`alter table entity_aliases validate constraint ${CONSTRAINT}`);
  });
}

/**
 * Dropping the columns and the constraint is also a catalogue change, under the
 * same timeout per lock request. It takes the locks in the same order as `up`
 * and as ingestion, `journeys` then `entity_aliases`, so in the worst case it
 * stalls writes to `journeys` for about ten seconds and a deadlock with
 * ingestion is not expected. The trigger and the constraint go before the
 * column they read, and the function after the trigger that runs it.
 * Labels, last steps and plain-text copies are then gone, which is the state
 * before this migration.
 *
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function down(knex) {
  await knex.transaction(async (trx) => {
    await trx.raw("set local lock_timeout = '5s'");
    await trx.raw(
      `alter table journeys
         drop column if exists last_step_event_id,
         drop column if exists last_step_received_at,
         drop column if exists last_step_at,
         drop column if exists last_step,
         drop column if exists label_event_id,
         drop column if exists label_received_at,
         drop column if exists label_at,
         drop column if exists label`
    );
    await trx.raw(`drop trigger if exists ${TRIGGER} on entity_aliases`);
    await trx.raw(
      `alter table entity_aliases
         drop constraint if exists ${CONSTRAINT},
         drop column if exists display_value`
    );
    await trx.raw(`drop function if exists ${TRIGGER}()`);
  });
}

export const config = { transaction: false };

/**
 * Whether every column, the constraint and the trigger are already there, as
 * a run whose validation gave up leaves them. Read from the catalogue without
 * locking either table.
 *
 * @param {import("knex").Knex} knex
 * @returns {Promise<boolean>}
 */
async function complete(knex) {
  const found = await knex.raw(
    `select count(*)::int as n from information_schema.columns
      where table_schema = current_schema()
        and (table_name, column_name) in (${ADDED.map(() => "(?, ?)").join(", ")})`,
    ADDED.flat()
  );
  return (
    found.rows[0].n === ADDED.length && (await hasConstraint(knex)) && (await hasTrigger(knex))
  );
}

/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<boolean>}
 */
async function hasTrigger(knex) {
  const found = await knex.raw(
    "select 1 from pg_trigger where tgrelid = 'entity_aliases'::regclass and tgname = ?",
    [TRIGGER]
  );
  return found.rows.length > 0;
}

/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<boolean>}
 */
async function hasConstraint(knex) {
  const found = await knex.raw(
    "select 1 from pg_constraint where conrelid = 'entity_aliases'::regclass and conname = ?",
    [CONSTRAINT]
  );
  return found.rows.length > 0;
}
