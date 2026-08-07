/**
 * Every replay attempt is recorded, including blocked ones (ADR-008). The
 * composite foreign key to journey_events keeps a run tied to the exact event it
 * replayed, within the same project.
 *
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function up(knex) {
  await knex.schema.createTable("replay_runs", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("project_id").notNullable().references("id").inTable("projects").onDelete("CASCADE");
    table.text("journey_event_id").notNullable();
    table.uuid("destination_id").notNullable().references("id").inTable("replay_destinations");
    table.text("method").notNullable();
    table.text("request_path").notNullable();
    table.jsonb("request_payload").nullable();
    table.jsonb("request_headers").nullable();
    table.integer("response_status").nullable();
    table.jsonb("response_payload").nullable();
    table.integer("duration_ms").nullable();
    table.text("status").notNullable();
    table.jsonb("error").nullable();
    table.text("initiated_by").notNullable();
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("completed_at", { useTz: true }).nullable();

    table
      .foreign(["project_id", "journey_event_id"])
      .references(["project_id", "id"])
      .inTable("journey_events")
      .onDelete("CASCADE");

    table.index(["project_id", "created_at"], "replay_runs_recent_idx");
  });

  await knex.raw(`
    alter table replay_runs
      add constraint replay_runs_status_valid check (
        status in ('queued', 'running', 'completed', 'failed', 'blocked')
      )
  `);
}

/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists("replay_runs");
}
