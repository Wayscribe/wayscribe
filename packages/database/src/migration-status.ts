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
 * The migrations table exists, in a schema the connected role has no USAGE on.
 *
 * PostgreSQL leaves such a schema out when it resolves an unqualified name, so
 * `to_regclass('knex_migrations')` answers null exactly as on a database nobody
 * has migrated. Reported as pending, it sent operators to run migrate against a
 * schema that was already current, when the fix was a GRANT.
 */
export class SchemaUsageError extends Error {
  constructor(
    readonly schema: string,
    readonly role: string
  ) {
    super(`The role ${role} has no USAGE on schema ${schema}, where knex_migrations is.`);
    this.name = "SchemaUsageError";
  }
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
  if (!exists) await refuseUnusableSchema(db);
  const appliedRows: unknown = exists ? await db("knex_migrations").select("name") : [];
  const applied = new Set((appliedRows as { name: string }[]).map((row) => row.name));

  return {
    pending: files.filter((name) => !applied.has(name)),
    unknown: [...applied].filter((name) => !files.includes(name)).sort()
  };
}

/**
 * Throw `SchemaUsageError` when knex_migrations is in a schema on the search
 * path that the role cannot use.
 *
 * Read from `pg_catalog`, which every role can read whatever its privileges on
 * the schemas it describes. `$user` in the search path stands for the role's
 * own name, as PostgreSQL resolves it. Both names come back quoted where SQL
 * needs it, so the GRANT doctor prints can be pasted.
 */
async function refuseUnusableSchema(db: Knex): Promise<void> {
  const found: unknown = await db.raw(`
    select quote_ident(n.nspname) as schema, quote_ident(current_user) as role
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where c.relname = 'knex_migrations'
      and c.relkind in ('r', 'p')
      and not has_schema_privilege(n.oid, 'USAGE')
      and n.nspname in (
        select case when entry = '$user' then current_user::text else entry end
        from (
          select btrim(btrim(part), '"') as entry
          from unnest(string_to_array(current_setting('search_path'), ',')) as part
        ) as path
      )
    order by n.nspname
    limit 1
  `);
  const row = (found as { rows: { schema: string; role: string }[] }).rows[0];
  if (row !== undefined) throw new SchemaUsageError(row.schema, row.role);
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
