/**
 * Capture-mode values use the hyphenated protocol form (ADR-018): the wire
 * contract is authoritative over the database schema.
 *
 * The UNIQUE (id, project_id) is not redundant with the primary key. It is the
 * target of the composite foreign key in 003_api_keys, which is what makes an
 * API key pointing at another project's environment structurally impossible.
 *
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function up(knex) {
  await knex.schema.createTable("environments", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("project_id").notNullable().references("id").inTable("projects").onDelete("CASCADE");
    table.text("name").notNullable();
    table.integer("retention_days").notNullable().defaultTo(7);
    table.text("capture_mode").notNullable().defaultTo("redacted-payload");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.unique(["project_id", "name"]);
    table.unique(["id", "project_id"], { indexName: "environments_id_project_id_unique" });
  });

  await knex.raw(`
    alter table environments
      add constraint environments_retention_days_positive check (retention_days > 0)
  `);

  await knex.raw(`
    alter table environments
      add constraint environments_capture_mode_valid check (
        capture_mode in ('metadata-only', 'allowlisted-fields', 'redacted-payload', 'full-payload')
      )
  `);
}

/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists("environments");
}
