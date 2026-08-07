import { fileURLToPath } from "node:url";
import type { Knex } from "knex";

/**
 * Migration and seed directories resolve relative to this module, so the same
 * code works in both execution contexts: under tsx from `src/` it finds the
 * TypeScript sources, and from the compiled `dist/` it finds the emitted
 * JavaScript. Nothing needs to know where the repository root is.
 */
const migrationsDirectory = fileURLToPath(new URL("./migrations", import.meta.url));
const seedsDirectory = fileURLToPath(new URL("./seeds", import.meta.url));

export function createKnexConfig(databaseUrl: string): Knex.Config {
  return {
    client: "pg",
    connection: databaseUrl,
    migrations: {
      directory: migrationsDirectory,
      loadExtensions: [".ts", ".js"]
    },
    seeds: {
      directory: seedsDirectory,
      loadExtensions: [".ts", ".js"]
    },
    pool: { min: 0, max: 10 }
  };
}
