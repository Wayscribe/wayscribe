import { fileURLToPath } from "node:url";
import type { Knex } from "knex";

/**
 * Migration and seed directories are resolved one level above this module.
 *
 * That single `../` is load-bearing: this module runs from `src/` under tsx and
 * Vitest, and from `dist/` in a container, and both are exactly one level below
 * the package root. So `../migrations` always resolves to the same directory,
 * and every execution context sees the same migration files under the same
 * names.
 *
 * Migrations are plain `.js` for the same reason — knex records the filename in
 * knex_migrations, so a migration must not be able to have two names. See
 * ADR-027 and packages/database/migrations/001_projects.js.
 */
const migrationsDirectory = fileURLToPath(new URL("../migrations", import.meta.url));
const seedsDirectory = fileURLToPath(new URL("../seeds", import.meta.url));

export function createKnexConfig(databaseUrl: string): Knex.Config {
  return {
    client: "pg",
    connection: databaseUrl,
    migrations: {
      directory: migrationsDirectory,
      loadExtensions: [".js"]
    },
    seeds: {
      directory: seedsDirectory,
      loadExtensions: [".js"]
    },
    pool: { min: 0, max: 10 }
  };
}
