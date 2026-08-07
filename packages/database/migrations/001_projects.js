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
  await knex.raw('create extension if not exists "pgcrypto"');

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
