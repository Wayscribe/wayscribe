/**
 * The composite foreign key on (environment_id, project_id) is the point of this
 * table's design: it makes an API key whose environment belongs to a different
 * project unrepresentable, rather than relying on an application check that a
 * future query might forget.
 *
 * key_hash stores an HMAC verifier, never the key itself.
 *
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function up(knex) {
  await knex.schema.createTable("api_keys", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("project_id").notNullable().references("id").inTable("projects").onDelete("CASCADE");
    table.uuid("environment_id").notNullable();
    table.text("name").notNullable();
    table.text("key_prefix").notNullable().unique();
    table.text("key_hash").notNullable();
    table.timestamp("last_used_at", { useTz: true }).nullable();
    table.timestamp("revoked_at", { useTz: true }).nullable();
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table
      .foreign(["environment_id", "project_id"])
      .references(["id", "project_id"])
      .inTable("environments")
      .onDelete("CASCADE");
  });
}

/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists("api_keys");
}
