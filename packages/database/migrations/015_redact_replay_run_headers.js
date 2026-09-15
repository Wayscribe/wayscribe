/**
 * Replace every stored replay request header value with `[REDACTED]`.
 *
 * Until this release a replay copied the headers it sent, including the
 * destination's decrypted configured headers, into `replay_runs.request_headers`
 * as plain jsonb, and `GET /v1/replays/:id` returned them. Destination headers
 * are encrypted at rest because they are credentials, so every run row undid
 * that encryption for its destination. New runs now store destination values
 * as `[REDACTED]`; this rewrites the rows written before.
 *
 * Every value is redacted, not only the destination's. An old row does not
 * record which headers came from the destination and which Flight Recorder set
 * itself, and a destination header can override any name, `content-type`
 * included. The names are kept, which is what history needs: which headers a
 * replay sent.
 *
 * A value that is not a JSON object was never written by `startRun`, which
 * always stores one, so nothing can say what it holds. It becomes SQL null.
 *
 * One transactional UPDATE of every row with headers. `replay_runs` holds one
 * row per manual replay attempt and is swept by retention with its journey, so
 * it stays small next to the event tables, and a batched rewrite would leave a
 * crash half way with some rows still holding values.
 *
 * Number 015, not 014: another change in progress on its own branch takes 014.
 * Knex applies pending migrations in name order whenever they arrive, and the
 * two touch unrelated tables, so either order of arrival is safe.
 *
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function up(knex) {
  await knex.raw(`
    update replay_runs
    set request_headers = case
      when jsonb_typeof(request_headers) = 'object' then (
        select coalesce(jsonb_object_agg(key, to_jsonb('[REDACTED]'::text)), '{}'::jsonb)
        from jsonb_each(request_headers)
      )
      else null
    end
    where request_headers is not null
  `);
}

/**
 * Nothing to undo. The values this migration removed are not recoverable from
 * the database, and restoring them is the defect the migration exists to fix.
 * Rolling back leaves the rows redacted, which the code before this release
 * reads without complaint.
 *
 * @returns {Promise<void>}
 */
export async function down() {
  // Intentionally empty.
}
