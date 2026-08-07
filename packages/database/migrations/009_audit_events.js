/**
 * Audit metadata is itself sanitized before insert (SECURITY.md section 13):
 * an audit trail that records the secret it was auditing is a liability, not a
 * control.
 *
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function up(knex) {
  await knex.schema.createTable("audit_events", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("project_id").notNullable().references("id").inTable("projects").onDelete("CASCADE");
    table.text("actor").notNullable();
    table.text("action").notNullable();
    table.text("resource_type").notNullable();
    table.text("resource_id").nullable();
    table.jsonb("metadata").nullable();
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(["project_id", "created_at"], "audit_events_recent_idx");
    table.index(["project_id", "action", "created_at"], "audit_events_action_idx");
  });
}

/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists("audit_events");
}
