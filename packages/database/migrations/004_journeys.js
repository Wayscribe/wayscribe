/**
 * Composite primary key (project_id, id) per ADR-020: it provides idempotency
 * without a redundant surrogate index, and makes an accidental cross-project
 * join structurally impossible.
 *
 * The primary entity identifier is stored twice by design — as an HMAC for
 * search, and encrypted for display — because SECURITY.md section 6 forbids
 * storing plaintext searchable low-entropy identifiers.
 *
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function up(knex) {
  await knex.schema.createTable("journeys", (table) => {
    table.text("id").notNullable();
    table.uuid("project_id").notNullable().references("id").inTable("projects").onDelete("CASCADE");
    table.uuid("environment_id").notNullable();
    table.text("entity_type").notNullable();
    table.text("primary_entity_id_hash").notNullable();
    table.text("encrypted_primary_entity_id").nullable();
    table.text("status").notNullable().defaultTo("active");
    table.timestamp("started_at", { useTz: true }).notNullable();
    table.timestamp("completed_at", { useTz: true }).nullable();
    table.timestamp("last_event_at", { useTz: true }).notNullable();
    table.integer("event_count").notNullable().defaultTo(0);
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.primary(["project_id", "id"]);
    table
      .foreign(["environment_id", "project_id"])
      .references(["id", "project_id"])
      .inTable("environments")
      .onDelete("CASCADE");

    table.index(["project_id", "environment_id", "last_event_at"], "journeys_recent_idx");
    table.index(["project_id", "entity_type", "primary_entity_id_hash"], "journeys_entity_idx");
  });

  await knex.raw(`
    alter table journeys
      add constraint journeys_event_count_nonnegative check (event_count >= 0)
  `);

  await knex.raw(`
    alter table journeys
      add constraint journeys_status_valid check (status in ('active', 'completed', 'failed'))
  `);
}

/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists("journeys");
}
