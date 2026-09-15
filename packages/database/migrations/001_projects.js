/**
 * Migrations are plain ESM JavaScript, not TypeScript, and deliberately so.
 *
 * Knex records the migration *filename* in the knex_migrations table. If the
 * same migration can be named `001_projects.ts` when run from source and
 * `001_projects.js` when run from compiled output, a database migrated in one
 * context is unusable from the other — knex reports the migration directory as
 * corrupt. Keeping migrations as JavaScript means one file with one name in
 * every execution context: tsx, node, Vitest, and Docker.
 *
 * JSDoc supplies the Knex types, so editors still autocomplete.
 *
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function up(knex) {
  // This migration used to begin with `create extension if not exists
  // "pgcrypto"`. Nothing uses pgcrypto: `gen_random_uuid()` below is built into
  // PostgreSQL from 13, and the oldest supported release is 15. The statement
  // needed CREATE on the database, so a role with privileges on its schema
  // alone failed here. Removing it from an applied migration is safe only
  // because it was idempotent and created nothing a later migration relies on:
  // knex does not rerun an applied migration, and a database that already has
  // the extension keeps it unchanged.
  await knex.schema.createTable("projects", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.text("name").notNullable();
    table.text("slug").notNullable().unique();
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists("projects");
}
