/**
 * base_url is an origin with an optional base path (ADR-019). The relative path
 * supplied on a replay request is appended to it, so SSRF validation always runs
 * against a fixed origin approved at creation time.
 *
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function up(knex) {
  await knex.schema.createTable("replay_destinations", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("project_id").notNullable().references("id").inTable("projects").onDelete("CASCADE");
    table.text("name").notNullable();
    table.text("base_url").notNullable();
    table.text("environment_type").notNullable();
    table.text("encrypted_headers").nullable();
    table.boolean("enabled").notNullable().defaultTo(true);
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.unique(["project_id", "name"]);
  });

  // V0 replay is development-only (ADR-008). Enforced here so no future code path
  // can create a production destination.
  await knex.raw(`
    alter table replay_destinations
      add constraint replay_destinations_environment_type_valid check (
        environment_type in ('local', 'development', 'test')
      )
  `);
}

/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists("replay_destinations");
}
