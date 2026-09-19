/**
 * Indexes for browsing journeys (GET /v1/journeys) across environments and by
 * text.
 *
 * journeys_project_recent_idx, `journeys (project_id, last_event_at, id)`,
 * serves the list in every environment with any status, which is what an
 * admin sees by default. journeys_recent_idx has the environment second and
 * journeys_status_recent_idx the status, so without this index that list read
 * every journey in the window through journeys_recent_idx and sorted them.
 * Without `q` the sort was cheap; with `q` every journey in the window had its
 * label and aliases tested before the sort, so a `q` matching many journeys
 * cost as much as one matching none. With this index the list walks it
 * backwards, already in `(last_event_at desc, id desc)` order, and stops after
 * a page. The columns are ascending, like 013's: a backward scan serves the
 * descending order as well, and the cursor's `(last_event_at, id) < (...)`
 * row comparison is an index condition on the two adjacent columns.
 *
 * entity_aliases_displayable_idx, `entity_aliases (project_id, journey_id)
 * include (display_value) where displayable`, serves the `q` test of a
 * journey's aliases. The unique index on (project_id, journey_id, alias_type,
 * alias_value_hash) finds the rows but has to read each one from the table to
 * see `displayable` and `display_value`; this one holds only displayable rows
 * and carries the value, so each probe is an index-only scan. A `q` that
 * matches nothing still tests every journey in the window, and this is what
 * makes each test cheap.
 *
 * Measured with scripts/measure-journey-list.mjs on PostgreSQL 17 (default
 * configuration) on an Apple M3 Pro, 120,000 journeys over 40 days in four
 * environments, 89,860 in a 30-day window, p95 through the API, page of 25:
 *
 * - any status, admin, 30 days: 32 ms before, 3.4 ms after.
 * - `q` matching 11,136 labels, admin, 30 days: 845 ms before, 5.4 ms after,
 *   and the same for its second page.
 * - `q` matching none, 30 days: 843 ms before, 316 ms after for an admin;
 *   538 ms before, 214 ms after for an API key. The journeys index alone left
 *   these at 731 and 614 ms: the alias index is what makes each test cheap.
 * - `q` with an entity type, admin, 30 days: 117 ms before, 5.4 ms after.
 *
 * On ingestion, a batch of 100 events and a single event measured the same
 * with both indexes, with the journeys index alone, and with neither, within
 * the run-to-run noise (under a millisecond at p95 for a single event).
 *
 * docs/OPERATIONS.md (Sizing, Listing journeys) has every case and the
 * ingestion figures.
 *
 * Built concurrently, outside a transaction, for the reasons 013 gives: the
 * migrate step runs while the previous API is still ingesting, and a plain
 * CREATE INDEX blocks every write to the table for the length of the build.
 * An invalid index a cancelled build left behind is dropped first, because
 * `if not exists` would accept it and record this migration as applied with
 * an index PostgreSQL never reads.
 *
 * A concurrent build does not block ingestion, but it waits: for its SHARE
 * UPDATE EXCLUSIVE lock, which another index build, a VACUUM or an ALTER may
 * hold, then for transactions writing the table, and then for every
 * transaction in the database that started before the build: a long
 * retention batch, an admin deletion, a nightly pg_dump. Waiting costs
 * nothing but time, so `lock_timeout` is long, LOCK_TIMEOUT per wait: long
 * enough to outlast an ordinary backup or batch, and still a bound, so a
 * migration held up by a forgotten idle-in-transaction session eventually
 * fails with a lock timeout rather than hanging the Helm Job or the Compose
 * migrate step for ever. Running `migrate` again repairs what the failure
 * left: the invalid index is dropped and rebuilt.
 *
 * The setting has to be on the connection that runs the build, and a
 * concurrent build cannot share a transaction with `SET LOCAL`, so each index
 * is built on a connection of its own: a `pg.Client` opened from the same
 * connection settings as knex's pool, named APPLICATION_NAME, and closed when
 * the build ends, whether it succeeded or not. The setting ends with the
 * session, so nothing has to be reset and no pooled connection ever carries
 * it. `migrate` must still reach PostgreSQL directly rather than through a
 * PgBouncer in transaction pooling mode, which could run the SET and the build
 * on different server connections (docs/OPERATIONS.md section 10).
 */
import pg from "pg";

export const config = { transaction: false };

/** How the build's own session shows in `pg_stat_activity`. */
export const APPLICATION_NAME = "flight-recorder migration 019";

/** How long each statement may wait for a lock or for older transactions to end. */
export const LOCK_TIMEOUT = "10min";

/** @type {readonly { name: string; definition: string }[]} */
export const INDEXES = [
  {
    name: "journeys_project_recent_idx",
    definition: "journeys (project_id, last_event_at, id)"
  },
  {
    name: "entity_aliases_displayable_idx",
    definition: "entity_aliases (project_id, journey_id) include (display_value) where displayable"
  }
];

/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function up(knex) {
  await buildIndexes(knex, LOCK_TIMEOUT);
}

/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function down(knex) {
  for (const index of [...INDEXES].reverse()) {
    await onOneConnection(knex, LOCK_TIMEOUT, (query) =>
      query(`drop index concurrently if exists ${index.name}`)
    );
  }
}

/**
 * What `up` does, with the lock timeout as a parameter so a test can see it
 * give up in seconds rather than in LOCK_TIMEOUT.
 *
 * @param {import("knex").Knex} knex
 * @param {string} lockTimeout
 * @returns {Promise<void>}
 */
export async function buildIndexes(knex, lockTimeout) {
  for (const index of INDEXES) {
    await onOneConnection(knex, lockTimeout, async (query) => {
      const invalid = await query(
        `select 1 from pg_index i
         join pg_class c on c.oid = i.indexrelid
         join pg_namespace n on n.oid = c.relnamespace
         where c.relname = $1 and n.nspname = current_schema() and not i.indisvalid`,
        [index.name]
      );
      if (invalid.rows.length > 0) {
        await query(`drop index concurrently if exists ${index.name}`);
      }
      await query(`create index concurrently if not exists ${index.name} on ${index.definition}`);
    });
  }
}

/**
 * Run `work` on a connection of its own with `lock_timeout` set, and close
 * the connection afterwards. Index names are the constants above, never
 * input, which is why they are written into the SQL; the timeout is checked
 * against PostgreSQL's duration syntax before it is.
 *
 * If `work` fails, its error is the one thrown. Closing the connection cannot
 * replace it: a close that fails leaves a connection that is already broken,
 * and the server ends that session, and its setting, when the socket goes.
 *
 * @param {import("knex").Knex} knex
 * @param {string} lockTimeout
 * @param {(query: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>) => Promise<unknown>} work
 * @returns {Promise<void>}
 */
async function onOneConnection(knex, lockTimeout, work) {
  if (!/^\d+(ms|s|min)$/.test(lockTimeout)) {
    throw new Error(`Not a lock timeout: ${JSON.stringify(lockTimeout)}`);
  }
  const result = /** @type {{ rows: { search_path: string }[] }} */ (
    await knex.raw("show search_path")
  );
  const searchPath = result.rows[0].search_path;
  const client = new pg.Client(await clientConfig(knex));
  try {
    await client.connect();
    /** @type {(sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>} */
    const query = (sql, bindings = []) => client.query(sql, bindings);
    await query("select set_config('search_path', $1, false)", [searchPath]);
    await query(`set lock_timeout = '${lockTimeout}'`);
    await work(query);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * The settings knex's pool connects with, as `pg.Client` takes them: the
 * connection string or object from the knex configuration, resolved first if
 * it is a function, with this migration's application name added.
 *
 * @param {import("knex").Knex} knex
 * @returns {Promise<import("pg").ClientConfig>}
 */
async function clientConfig(knex) {
  /** @type {unknown} */
  let connection = knex.client.config.connection;
  if (typeof connection === "function") connection = await connection();
  if (typeof connection === "string") {
    return { connectionString: connection, application_name: APPLICATION_NAME };
  }
  if (connection !== null && typeof connection === "object") {
    // knex parses a connection string into an object and makes its password
    // non-enumerable, so that logging the configuration does not print it. A
    // spread would drop it, so it is copied by name.
    const settings = /** @type {import("pg").ClientConfig} */ (connection);
    return { ...settings, password: settings.password, application_name: APPLICATION_NAME };
  }
  throw new Error("Migration 019 needs the database connection settings knex was configured with.");
}
