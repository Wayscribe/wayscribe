// The parts of scripts/measure-storage.mjs that decide what it may touch and
// whether its numbers mean anything, kept apart so tests can reach them
// without a database. The script itself runs only against a live PostgreSQL.

/** Every schema the script creates starts with this, and nothing else may. */
export const MEASUREMENT_SCHEMA_PREFIX = "measure_storage_";

/**
 * A VACUUM naming each measured table, schema-qualified.
 *
 * Never a bare VACUUM: that processes every table in the database, and the
 * script's --force exists to run beside real data. A bare `vacuum full` did
 * exactly that in review, rewriting an installation's journeys and events
 * under exclusive locks that stop ingestion for the length of the rewrite.
 */
export function vacuumStatement(options, schema, tables) {
  if (!schema.startsWith(MEASUREMENT_SCHEMA_PREFIX) || schema === MEASUREMENT_SCHEMA_PREFIX) {
    throw new Error(`${JSON.stringify(schema)} is not a measurement schema.`);
  }
  if (tables.length === 0) {
    throw new Error("A VACUUM without tables would process every table in the database.");
  }
  const list = tables.map(() => "??").join(", ");
  return {
    sql: options.length === 0 ? `vacuum ${list}` : `vacuum (${options.join(", ")}) ${list}`,
    bindings: tables.map((table) => `${schema}.${table}`)
  };
}

/**
 * Throw unless the retention sweep deleted exactly the journeys made to expire.
 *
 * The retention lock is database-wide, so an API sweeping the same database
 * makes this sweep skip or stop part way. Its sizes would then describe data
 * retention never touched, and nothing in the output would say so.
 */
export function expectCompleteSweep(sweep, expected) {
  if (!sweep.ran) {
    throw new Error(
      "The retention sweep did not run: another process holds the retention lock. " +
        "Stop anything sweeping this database and run again."
    );
  }
  if (sweep.stoppedEarly) {
    throw new Error(
      `The retention sweep stopped early after deleting ${sweep.journeysDeleted.toLocaleString("en-US")} journeys.`
    );
  }
  if (sweep.journeysDeleted !== expected) {
    throw new Error(
      `The retention sweep deleted ${sweep.journeysDeleted.toLocaleString("en-US")} journeys; ` +
        `expected ${expected.toLocaleString("en-US")}.`
    );
  }
}
