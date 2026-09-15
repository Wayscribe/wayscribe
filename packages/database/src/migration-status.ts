import { readdir } from "node:fs/promises";
import type { Knex } from "knex";
import { MIGRATION_EXTENSIONS, migrationsDirectory } from "./knex-config.js";

export interface MigrationStatus {
  /** On disk and not recorded as applied. */
  pending: string[];
  /** Recorded as applied and not on disk: a newer build migrated this database. */
  unknown: string[];
}

/**
 * Pending and unknown migrations, without writing anything.
 *
 * `db.migrate.list()` creates `knex_migrations` and its lock table when they
 * are missing, so it is not used here. The files are listed as knex lists them
 * (the configured extensions, by name), and the applied names are read from
 * the table only when it exists: on a database nobody has migrated, every
 * migration is pending.
 */
export async function migrationStatusReadOnly(db: Knex): Promise<MigrationStatus> {
  const files = (await readdir(migrationsDirectory))
    .filter((name) => MIGRATION_EXTENSIONS.some((extension) => name.endsWith(extension)))
    .sort();

  const present: unknown = await db.raw(
    "select to_regclass('knex_migrations') is not null as present"
  );
  const exists = (present as { rows: { present: boolean }[] }).rows[0]?.present === true;
  const appliedRows: unknown = exists ? await db("knex_migrations").select("name") : [];
  const applied = new Set((appliedRows as { name: string }[]).map((row) => row.name));

  return {
    pending: files.filter((name) => !applied.has(name)),
    unknown: [...applied].filter((name) => !files.includes(name)).sort()
  };
}

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
