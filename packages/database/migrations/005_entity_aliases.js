/**
 * An alias value may legitimately map to more than one journey over time — the
 * same customer appears in many workflows — so there is no global uniqueness on
 * the value. Uniqueness is per journey and alias type only.
 *
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function up(knex) {
  await knex.schema.createTable("entity_aliases", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("project_id").notNullable();
    table.text("journey_id").notNullable();
    table.text("alias_type").notNullable();
    table.text("alias_value_hash").notNullable();
    table.text("encrypted_display_value").nullable();
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table
      .foreign(["project_id", "journey_id"])
      .references(["project_id", "id"])
      .inTable("journeys")
      .onDelete("CASCADE");

    table.unique(["project_id", "journey_id", "alias_type", "alias_value_hash"]);
    table.index(["project_id", "alias_type", "alias_value_hash"], "entity_aliases_typed_idx");
    table.index(["project_id", "alias_value_hash"], "entity_aliases_value_idx");
  });
}

/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists("entity_aliases");
}
