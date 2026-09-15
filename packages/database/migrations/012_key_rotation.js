/**
 * Which key's pepper produced each API key verifier.
 *
 * Every other encrypted value carries its key id inside the value itself. An
 * HMAC verifier has no room for one, and cannot be rewritten without the
 * plaintext key, so rotation needs to know which rows are still under the old
 * pepper in order to verify them and to report what has not migrated.
 *
 * Nullable with no backfill: a null id means "written before this column
 * existed". Authentication tries the current key and then the previous one for
 * such a row, and records the id the first time the key is presented.
 *
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function up(knex) {
  await knex.schema.alterTable("api_keys", (table) => {
    table.text("key_hash_key_id").nullable();
  });
}

/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function down(knex) {
  await knex.schema.alterTable("api_keys", (table) => {
    table.dropColumn("key_hash_key_id");
  });
}
