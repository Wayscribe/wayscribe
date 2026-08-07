/**
 * Index for value-only entity search (ADR-028).
 *
 * The existing journeys_entity_idx covers (project_id, entity_type,
 * primary_entity_id_hash), which requires knowing the entity type before you can
 * look anything up. A developer pasting an identifier from a log line does not
 * know its entity type, so search needs an index that does not demand one.
 *
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function up(knex) {
  await knex.schema.alterTable("journeys", (table) => {
    table.index(["project_id", "primary_entity_id_hash"], "journeys_entity_value_idx");
  });
}

/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function down(knex) {
  await knex.schema.alterTable("journeys", (table) => {
    table.dropIndex(["project_id", "primary_entity_id_hash"], "journeys_entity_value_idx");
  });
}
