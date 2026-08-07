import type { Knex } from "knex";

/**
 * Number of migrations that exist on disk but have not been applied.
 *
 * `/ready` depends on this: a process serving against a schema older than the
 * one its build expects must not report ready, or a deploy will take traffic
 * against tables that do not exist yet.
 */
export async function pendingMigrationCount(db: Knex): Promise<number> {
  const [, pending] = (await db.migrate.list()) as [unknown[], unknown[]];
  return pending.length;
}
