/**
 * Event rows are immutable after insert. The composite primary key
 * (project_id, id) provides ingestion idempotency (ADR-020), and content_hash
 * lets ingestion tell an identical resubmission from a genuine ID collision
 * (ADR-021).
 *
 * Technical-identifier indexes are partial: these columns are null on most
 * events, and a full index would be mostly empty pages.
 *
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function up(knex) {
  await knex.schema.createTable("journey_events", (table) => {
    table.text("id").notNullable();
    table.uuid("project_id").notNullable();
    table.uuid("environment_id").notNullable();
    table.text("journey_id").notNullable();
    table.text("parent_event_id").nullable();
    table.text("protocol_version").notNullable();
    table.text("content_hash").notNullable();
    table.text("operation").notNullable();
    table.text("name").notNullable();
    table.text("service").notNullable();
    table.timestamp("event_timestamp", { useTz: true }).notNullable();
    table.timestamp("received_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.integer("duration_ms").nullable();
    table.text("trace_id").nullable();
    table.text("span_id").nullable();
    table.text("message_id").nullable();
    table.text("correlation_id").nullable();
    table.jsonb("input_payload").nullable();
    table.jsonb("output_payload").nullable();
    table.jsonb("payload_diff").nullable();
    table.jsonb("error").nullable();
    table.jsonb("runtime_metadata").nullable();
    table.jsonb("deployment_metadata").nullable();
    table.jsonb("custom_metadata").nullable();
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.primary(["project_id", "id"]);
    table
      .foreign(["project_id", "journey_id"])
      .references(["project_id", "id"])
      .inTable("journeys")
      .onDelete("CASCADE");

    table.index(
      ["project_id", "journey_id", "event_timestamp", "received_at", "id"],
      "journey_events_timeline_idx"
    );
  });

  await knex.raw(`
    alter table journey_events
      add constraint journey_events_duration_nonnegative
      check (duration_ms is null or duration_ms >= 0)
  `);

  await knex.raw(`
    create index journey_events_trace_idx on journey_events (project_id, trace_id)
      where trace_id is not null
  `);
  await knex.raw(`
    create index journey_events_message_idx on journey_events (project_id, message_id)
      where message_id is not null
  `);
  await knex.raw(`
    create index journey_events_correlation_idx on journey_events (project_id, correlation_id)
      where correlation_id is not null
  `);
}

/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists("journey_events");
}
