/**
 * Two columns the original schema omitted.
 *
 * capture_mode permitted 'allowlisted-fields' with nowhere to store the
 * allowlist, so that mode could not be implemented as specified. And
 * SECURITY.md makes server-side redaction authoritative without giving it any
 * configured paths to be authoritative with.
 *
 * Both default to an empty array: an environment that configures neither still
 * receives the built-in secret list, which is applied in code and cannot be
 * disabled.
 *
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function up(knex) {
  await knex.schema.alterTable("environments", (table) => {
    table.jsonb("redaction_paths").notNullable().defaultTo("[]");
    table.jsonb("capture_allowlist").notNullable().defaultTo("[]");
  });
}

/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function down(knex) {
  await knex.schema.alterTable("environments", (table) => {
    table.dropColumn("redaction_paths");
    table.dropColumn("capture_allowlist");
  });
}
