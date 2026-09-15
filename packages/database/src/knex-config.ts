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
export const migrationsDirectory = fileURLToPath(new URL("../migrations", import.meta.url));
/** The extensions knex loads migrations from, and the ones `doctor` counts. */
export const MIGRATION_EXTENSIONS: readonly string[] = [".js"];
const seedsDirectory = fileURLToPath(new URL("../seeds", import.meta.url));

export interface KnexConfigOptions {
  /**
   * `statement_timeout` for every connection the pool opens, in milliseconds.
   * Omitted or 0 leaves the database's own setting alone.
   *
   * The API sets it from DATABASE_STATEMENT_TIMEOUT_MS. The CLI does not: its
   * long commands are operator-started batches whose statements are already
   * bounded by batch size, and a migration building an index concurrently on a
   * large table must not be cancelled part way.
   */
  statementTimeoutMs?: number;
  /** How long to wait for a connection before giving up. knex's default is 60 seconds. */
  acquireConnectionTimeoutMs?: number;
  /**
   * Silence knex's own logger. For `doctor`, which reports a connection
   * failure in its own words and would otherwise print knex's warning above
   * them on stderr.
   */
  quiet?: boolean;
}

const silent = (): void => undefined;

/** A pg connection as the pool hands it to `afterCreate`. */
interface PoolConnection {
  query: (sql: string, callback: (error: Error | null) => void) => void;
}

export function createKnexConfig(
  databaseUrl: string,
  options: KnexConfigOptions = {}
): Knex.Config {
  const timeout = options.statementTimeoutMs ?? 0;
  if (!Number.isSafeInteger(timeout) || timeout < 0) {
    // Inlined into SQL below, because SET takes no bound parameters, so it
    // must be a non-negative integer and never anything else.
    throw new RangeError("statementTimeoutMs must be a non-negative integer.");
  }

  return {
    ...(options.acquireConnectionTimeoutMs === undefined
      ? {}
      : { acquireConnectionTimeout: options.acquireConnectionTimeoutMs }),
    ...(options.quiet === true
      ? { log: { warn: silent, error: silent, deprecate: silent, debug: silent } }
      : {}),
    client: "pg",
    connection: databaseUrl,
    migrations: {
      directory: migrationsDirectory,
      loadExtensions: [...MIGRATION_EXTENSIONS]
    },
    seeds: {
      directory: seedsDirectory,
      loadExtensions: [".js"]
    },
    pool: {
      min: 0,
      max: 10,
      // SET on each new connection rather than a startup parameter: PgBouncer
      // refuses startup parameters it does not know, which would turn this
      // setting into a connection failure. A pooled connection is reused, so
      // the SET runs once per backend, not once per query.
      ...(timeout === 0
        ? {}
        : {
            afterCreate: (
              connection: PoolConnection,
              done: (error: Error | null, connection: PoolConnection) => void
            ): void => {
              connection.query(`SET statement_timeout = ${String(timeout)}`, (error) => {
                done(error, connection);
              });
            }
          })
    }
  };
}
