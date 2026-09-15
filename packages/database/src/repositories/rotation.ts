import {
  decryptValue,
  encryptValue,
  parseEncryptedValue,
  searchTokens,
  type Keyring
} from "@flight-recorder/payload-security";
import type { Knex } from "knex";
import { lockHolderAlive } from "./advisory-lock.js";
import { isAliasUniqueViolation } from "./aliases.js";

/**
 * An arbitrary but fixed 64-bit key for the rotation's advisory lock.
 *
 * Distinct from the retention sweep's, so a re-encryption and a sweep can run
 * together. Exported so a test can hold the lock the way another run would.
 */
export const ROTATION_LOCK_KEY = 4_919_072_044;

/** Rows per transaction. Bounds how long one batch holds its row locks. */
const DEFAULT_BATCH_SIZE = 500;

/**
 * A stored value in the envelope format with a well-formed key id and payload.
 *
 * The SQL twin of `parseEncryptedValue`: `fr1.`, twelve lowercase hex
 * characters, a dot, and a non-empty payload containing no further dot. Used
 * where counting in the database is the point, so status and the boot check do
 * not pull every ciphertext into the process.
 */
const ENVELOPE_PATTERN = "^fr1\\.[0-9a-f]{12}\\.[^.]+$";

export type EncryptedTable = "journeys" | "entity_aliases" | "replay_destinations";

interface TableSpec {
  table: EncryptedTable;
  column: string;
  /** The primary key, in the order batches are walked. */
  key: readonly string[];
}

/**
 * Every column holding a value `encryptValue` wrote.
 *
 * Journeys and aliases also carry a search token computed from the same
 * plaintext; each is rewritten in the same statement as its ciphertext, so the
 * ciphertext's key id marks progress for both.
 */
const ENCRYPTED_TABLES: readonly TableSpec[] = [
  { table: "journeys", column: "encrypted_primary_entity_id", key: ["project_id", "id"] },
  { table: "entity_aliases", column: "encrypted_display_value", key: ["id"] },
  { table: "replay_destinations", column: "encrypted_headers", key: ["id"] }
];

export interface TableReencryption {
  table: EncryptedTable;
  /** Rows moved onto the current key by this run. */
  rewritten: number;
  /** Rows already under the current key when this run reached the table. */
  alreadyCurrent: number;
  /** Malformed, under a key the keyring lacks, or failing to decrypt. Left as they are. */
  unrecoverable: number;
  /** Rows with no stored value. Nothing to rewrite, and no plaintext to recompute a token from. */
  noValue: number;
  /** Alias rows under an old token deleted because the same alias already had a row under the current one. */
  duplicatesRemoved: number;
  /** Rows that another writer changed between this run reading and rewriting them. The next run looks again. */
  changedDuringRun: number;
  batches: number;
}

export interface ReencryptProgress {
  table: EncryptedTable;
  batch: number;
  examined: number;
  rewrittenSoFar: number;
}

export interface ReencryptOptions {
  batchSize?: number;
  /** Called once the lock is held, before any table is examined. Not called when the lock is not acquired. */
  onLocked?: () => void;
  /** Called after each committed batch, while the lock is still held. */
  onBatch?: (progress: ReencryptProgress) => void | Promise<void>;
}

/**
 * `rotate` moves data from the previous key onto the current one, tokens
 * included. `upgrade` runs with no previous key: it wraps legacy values the
 * current key opens in the envelope, and leaves their tokens alone, since the
 * same key gives the same token.
 */
export type ReencryptMode = "rotate" | "upgrade";

export type ReencryptResult =
  | { ran: false; reason: "lock_held" }
  | {
      ran: true;
      mode: ReencryptMode;
      /** Tables reached before the run ended; all three unless the lock was lost. */
      tables: TableReencryption[];
      /**
       * The connection holding the lock ended mid-run, for example by
       * `idle_in_transaction_session_timeout`. The run stopped after the batch
       * in progress. Every rewrite it made is conditional and stands; another
       * run finishes the work.
       */
      lockLost: boolean;
    };

/**
 * Rewrite every encrypted value and search token under the keyring's current key.
 *
 * Walks each table by primary key in batches, one transaction per batch, so an
 * interrupted run keeps everything it committed and a re-run starts over
 * cheaply: rows already under the current key are filtered out in SQL.
 *
 * Every row is classified with `parseEncryptedValue` and decrypted inside a
 * catch. A bad row is counted and passed over; a throw would abort its batch,
 * and every resume would stop on the same row.
 *
 * With no previous key there is nothing to rotate from, but an install from
 * before key ids still holds legacy values. Those the current key opens are
 * upgraded into the envelope under it; anything else is unrecoverable, as it
 * would be in a rotation. This is how such an install reaches a clean
 * `rotate:status` without ever rotating.
 *
 * API keys are not touched. An HMAC verifier cannot be recomputed without the
 * plaintext key, so they move when they next authenticate.
 */
export async function reencryptValues(
  db: Knex,
  keyring: Keyring,
  options: ReencryptOptions = {}
): Promise<ReencryptResult> {
  const mode: ReencryptMode = keyring.previous === null ? "upgrade" : "rotate";

  // A transaction-scoped lock on a connection held for the whole run. A
  // session lock taken through the pool could be released on a different
  // connection than the one that took it, and the lock would outlive the run.
  // Committing the holder releases it; a process that dies drops the
  // connection, and PostgreSQL releases it then.
  const holder = await db.transaction();
  try {
    // The key is inlined rather than bound. A bound parameter sends the query
    // through an unnamed portal that stays open, with its snapshot, until the
    // transaction ends; the holder's backend_xmin would then stay set for the
    // whole run and keep VACUUM everywhere from removing dead rows. It is a
    // fixed integer constant, never input.
    const acquired: unknown = await holder.raw(
      `select pg_try_advisory_xact_lock(${String(ROTATION_LOCK_KEY)}) as locked`
    );
    const locked = (acquired as { rows: { locked: boolean }[] }).rows[0]?.locked === true;
    if (!locked) return { ran: false, reason: "lock_held" };
    options.onLocked?.();

    const tables: TableReencryption[] = [];
    for (const spec of ENCRYPTED_TABLES) {
      const { result, lockLost } = await reencryptTable(db, holder, keyring, mode, spec, options);
      tables.push(result);
      if (lockLost) return { ran: true, mode, tables, lockLost: true };
    }
    return { ran: true, mode, tables, lockLost: false };
  } finally {
    // Nothing was written through the holder. If its connection has already
    // gone, so has the lock, and a failure here must not hide the run's own
    // error.
    await holder.commit().catch(() => undefined);
  }
}

type Row = Record<string, unknown>;

async function reencryptTable(
  db: Knex,
  holder: Knex.Transaction,
  keyring: Keyring,
  mode: ReencryptMode,
  spec: TableSpec,
  options: ReencryptOptions
): Promise<{ result: TableReencryption; lockLost: boolean }> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const currentPattern = `^fr1\\.${keyring.current.id}\\.[^.]+$`;

  const counted: unknown = await db(spec.table)
    .whereRaw("?? ~ ?", [spec.column, currentPattern])
    .count({ n: "*" });
  const result: TableReencryption = {
    table: spec.table,
    rewritten: 0,
    alreadyCurrent: Number((counted as { n: string | number }[])[0]?.n ?? 0),
    unrecoverable: 0,
    noValue: 0,
    duplicatesRemoved: 0,
    changedDuringRun: 0,
    batches: 0
  };

  let cursor: Knex.Value[] | null = null;
  for (;;) {
    // Checked before every batch, so a lost lock stops the run after the batch
    // that was in progress rather than letting it carry on unguarded.
    if (!(await lockHolderAlive(holder))) return { result, lockLost: true };
    const after = cursor;
    const rows = await db.transaction(async (trx) => {
      const query = trx(spec.table)
        .select([...spec.key, `${spec.column} as value`])
        .where((needsWork) => {
          void needsWork
            .whereNull(spec.column)
            .orWhereRaw("?? !~ ?", [spec.column, currentPattern]);
        })
        .orderBy([...spec.key])
        .limit(batchSize);
      if (after !== null) {
        const columns = spec.key.map(() => "??").join(", ");
        const values = spec.key.map(() => "?").join(", ");
        void query.whereRaw(`(${columns}) > (${values})`, [...spec.key, ...after]);
      }
      if (spec.table === "entity_aliases") {
        void query.select(
          "project_id as projectId",
          "journey_id as journeyId",
          "alias_type as aliasType"
        );
      }

      const batch = (await query) as Row[];
      for (const row of batch) await reencryptRow(trx, keyring, mode, spec, row, result);
      return batch;
    });

    const last = rows.at(-1);
    if (last === undefined) break;
    result.batches += 1;
    cursor = spec.key.map((column) => last[column] as Knex.Value);
    await options.onBatch?.({
      table: spec.table,
      batch: result.batches,
      examined: rows.length,
      rewrittenSoFar: result.rewritten
    });
    if (rows.length < batchSize) break;
  }

  return { result, lockLost: false };
}

async function reencryptRow(
  trx: Knex.Transaction,
  keyring: Keyring,
  mode: ReencryptMode,
  spec: TableSpec,
  row: Row,
  result: TableReencryption
): Promise<void> {
  const value = row["value"];
  if (typeof value !== "string") {
    result.noValue += 1;
    return;
  }

  const parsed = parseEncryptedValue(value);
  if (parsed.kind === "malformed") {
    result.unrecoverable += 1;
    return;
  }
  if (parsed.kind === "envelope" && parsed.keyId === keyring.current.id) {
    // Written by ingestion after the count and before this batch read it.
    return;
  }

  let plaintext: string;
  try {
    plaintext = decryptValue(keyring, value);
  } catch {
    // An unknown key id, a legacy value no configured key opens, or a tampered
    // one. With no previous key, a value under any other key is among these.
    result.unrecoverable += 1;
    return;
  }

  const next = encryptValue(keyring, plaintext);
  // Conditional on the value just read, so a row another writer has changed
  // since is left for that writer's version rather than overwritten.
  const unchanged = {
    ...Object.fromEntries(spec.key.map((column) => [column, row[column]])),
    [spec.column]: value
  };

  let updated: number;
  switch (spec.table) {
    case "journeys":
      updated = await trx("journeys")
        .where(unchanged)
        .update({
          [spec.column]: next,
          // An upgrade stays under the key that wrote the token.
          ...(mode === "rotate" ? { primary_entity_id_hash: currentToken(keyring, plaintext) } : {})
        });
      break;
    case "replay_destinations":
      updated = await trx("replay_destinations")
        .where(unchanged)
        .update({ [spec.column]: next });
      break;
    case "entity_aliases": {
      if (mode === "upgrade") {
        // The token is unchanged, so no other row can collide with this one.
        updated = await trx("entity_aliases")
          .where(unchanged)
          .update({ [spec.column]: next });
        break;
      }
      const outcome = await reencryptAlias(trx, keyring, row, unchanged, next, plaintext);
      if (outcome === "duplicate_removed") {
        result.duplicatesRemoved += 1;
        return;
      }
      updated = outcome === "rewritten" ? 1 : 0;
      break;
    }
  }

  if (updated > 0) result.rewritten += 1;
  else result.changedDuringRun += 1;
}

/**
 * Move one alias row onto the current key, or delete it as a stale duplicate.
 *
 * A row for the same `(project_id, journey_id, alias_type)` can already exist
 * under the current token: the previous key was removed early, the alias
 * stored again under the new token, and the key restored. Rewriting the old
 * row would violate the unique constraint, and the current row already says
 * everything it did, so the old one is deleted.
 *
 * The existence check reads a snapshot, so a row under the current token that
 * ingestion inserts concurrently is invisible to it; the update then fails on
 * the unique constraint. The savepoint keeps that failure from aborting the
 * batch, and the row is a duplicate after all.
 */
async function reencryptAlias(
  trx: Knex.Transaction,
  keyring: Keyring,
  row: Row,
  unchanged: Row,
  next: string,
  plaintext: string
): Promise<"rewritten" | "duplicate_removed" | "changed"> {
  const token = currentToken(keyring, plaintext);
  const removeStale = async (): Promise<"duplicate_removed" | "changed"> => {
    const deleted = await trx("entity_aliases").where(unchanged).del();
    return deleted > 0 ? "duplicate_removed" : "changed";
  };

  const existing: unknown = await trx("entity_aliases")
    .where({
      project_id: row["projectId"],
      journey_id: row["journeyId"],
      alias_type: row["aliasType"],
      alias_value_hash: token
    })
    .whereNot({ id: row["id"] })
    .first("id");
  if (existing !== undefined) return removeStale();

  try {
    const updated = await trx.transaction(
      async (savepoint): Promise<number> =>
        await savepoint("entity_aliases")
          .where(unchanged)
          .update({ encrypted_display_value: next, alias_value_hash: token })
    );
    return updated > 0 ? "rewritten" : "changed";
  } catch (error) {
    if (!isAliasUniqueViolation(error)) throw error;
    return removeStale();
  }
}

function currentToken(keyring: Keyring, plaintext: string): string {
  const [token] = searchTokens(keyring, plaintext);
  // searchTokens always returns the current key's token first; the check exists
  // for the type, which cannot know that.
  if (token === undefined) throw new Error("searchTokens returned no current token.");
  return token;
}

export interface TableKeyStatus {
  table: EncryptedTable;
  current: number;
  previous: number;
  /** Written before values carried a key id. Readable or not, they need rewriting. */
  legacy: number;
  /** Under a key id the keyring holds in neither slot. */
  unknownKey: number;
  malformed: number;
  noValue: number;
  /** The key ids behind `unknownKey`, so an operator can tell which key was removed. */
  unknownKeyIds: string[];
}

export interface ApiKeyNotCurrent {
  keyPrefix: string;
  name: string;
  projectSlug: string;
  environmentName: string;
  /** Null for a key issued before key ids were recorded and not used since. */
  keyHashKeyId: string | null;
  lastUsedAt: Date | null;
}

export interface RotationStatus {
  currentKeyId: string;
  previousKeyId: string | null;
  tables: TableKeyStatus[];
  apiKeys: {
    current: number;
    /**
     * Unrevoked keys whose verifier is not recorded as under the current key.
     * During a rotation this includes keys with no recorded id, which may be
     * under either key.
     */
    notCurrent: ApiKeyNotCurrent[];
    /**
     * With no previous key configured, unrevoked keys with no recorded id. They
     * verify under the current key or not at all, so they leave no rotation
     * unfinished, and each records its id the next time it authenticates.
     */
    notRecorded: ApiKeyNotCurrent[];
  };
  /** Rows under the previous key, an unknown key, a legacy format, or malformed. */
  rowsRemaining: number;
  /** True when no row and no unrevoked API key remains under another key. `notRecorded` keys do not count. */
  complete: boolean;
}

/**
 * Where the stored data stands against the keyring. Read-only.
 *
 * Revoked API keys are left out: they never authenticate again, so they can
 * never migrate, and listing them would hold a rotation open forever. Rows with
 * no value are reported but do not hold it open either; there is nothing in
 * them to rewrite.
 */
export async function rotationStatus(db: Knex, keyring: Keyring): Promise<RotationStatus> {
  const previousKeyId = keyring.previous?.id ?? null;
  const tables: TableKeyStatus[] = [];

  for (const spec of ENCRYPTED_TABLES) {
    const grouped: unknown = await db.raw(
      `select case
                when ?? is null then 'none'
                when ?? ~ ? then substr(??, 5, 12)
                when left(??, 4) = 'fr1.' then 'malformed'
                else 'legacy'
              end as kind,
              count(*)::int as n
         from ??
        group by 1
        order by 1`,
      [spec.column, spec.column, ENVELOPE_PATTERN, spec.column, spec.column, spec.table]
    );

    const status: TableKeyStatus = {
      table: spec.table,
      current: 0,
      previous: 0,
      legacy: 0,
      unknownKey: 0,
      malformed: 0,
      noValue: 0,
      unknownKeyIds: []
    };
    for (const { kind, n } of (grouped as { rows: { kind: string; n: number }[] }).rows) {
      if (kind === "none") status.noValue += n;
      else if (kind === "legacy") status.legacy += n;
      else if (kind === "malformed") status.malformed += n;
      else if (kind === keyring.current.id) status.current += n;
      else if (kind === previousKeyId) status.previous += n;
      else {
        status.unknownKey += n;
        status.unknownKeyIds.push(kind);
      }
    }
    tables.push(status);
  }

  const keyRows: unknown = await db("api_keys")
    .join("projects", "api_keys.project_id", "projects.id")
    .join("environments", "api_keys.environment_id", "environments.id")
    .whereNull("api_keys.revoked_at")
    .orderBy([{ column: "projects.slug" }, { column: "api_keys.created_at" }])
    .select(
      "api_keys.key_prefix as keyPrefix",
      "api_keys.name as name",
      "projects.slug as projectSlug",
      "environments.name as environmentName",
      "api_keys.key_hash_key_id as keyHashKeyId",
      "api_keys.last_used_at as lastUsedAt"
    );
  const keys = keyRows as ApiKeyNotCurrent[];
  const notRecorded = previousKeyId === null ? keys.filter((key) => key.keyHashKeyId === null) : [];
  const notCurrent = keys.filter(
    (key) => key.keyHashKeyId !== keyring.current.id && !notRecorded.includes(key)
  );

  const rowsRemaining = tables.reduce(
    (sum, table) => sum + table.previous + table.legacy + table.unknownKey + table.malformed,
    0
  );

  return {
    currentKeyId: keyring.current.id,
    previousKeyId,
    tables,
    apiKeys: {
      current: keys.length - notCurrent.length - notRecorded.length,
      notCurrent,
      notRecorded
    },
    rowsRemaining,
    complete: rowsRemaining === 0 && notCurrent.length === 0
  };
}

export interface UnreadableTable {
  table: EncryptedTable;
  /** Under a key id the keyring holds in neither slot. */
  unknownKey: number;
  malformed: number;
  /** Every legacy row, when the first one fails to decrypt under either key. */
  legacyUnreadable: number;
}

export interface UnreadableData {
  tables: UnreadableTable[];
  /** Unrevoked API keys recorded under a key the keyring holds in neither slot. */
  apiKeys: number;
  total: number;
}

/**
 * What this keyring can no longer read, for the API's boot check.
 *
 * Counted in SQL, except for legacy rows: they name no key, so the first and
 * the last by primary key in each table are decrypted as a sample, and when
 * either fails the table's whole legacy count is reported. Legacy rows were
 * written before key ids existed, usually under a single key, but nothing
 * guarantees it, so this is a heuristic: it can miss an unreadable stretch in
 * the middle. `rotate:reencrypt` examines every row and reports the exact number.
 *
 * API keys with no recorded id are not counted. Whether one still verifies
 * cannot be known without the plaintext key.
 */
export async function findUnreadableData(db: Knex, keyring: Keyring): Promise<UnreadableData> {
  const known = [keyring.current.id, ...(keyring.previous === null ? [] : [keyring.previous.id])];
  const knownList = known.map(() => "?").join(", ");
  const tables: UnreadableTable[] = [];

  for (const spec of ENCRYPTED_TABLES) {
    const counted: unknown = await db.raw(
      `select count(*) filter (where ?? ~ ? and substr(??, 5, 12) not in (${knownList}))::int as unknown_key,
              count(*) filter (where left(??, 4) = 'fr1.' and ?? !~ ?)::int as malformed,
              count(*) filter (where left(??, 4) <> 'fr1.')::int as legacy
         from ??`,
      [
        spec.column,
        ENVELOPE_PATTERN,
        spec.column,
        ...known,
        spec.column,
        spec.column,
        ENVELOPE_PATTERN,
        spec.column,
        spec.table
      ]
    );
    const row = (counted as { rows: { unknown_key: number; malformed: number; legacy: number }[] })
      .rows[0];
    const legacy = row?.legacy ?? 0;

    let legacyUnreadable = 0;
    if (legacy > 0) {
      for (const order of ["asc", "desc"] as const) {
        const sample: unknown = await db(spec.table)
          .whereNotNull(spec.column)
          .whereRaw("left(??, 4) <> 'fr1.'", [spec.column])
          .orderBy(spec.key.map((column) => ({ column, order })))
          .first(`${spec.column} as value`);
        const value = (sample as { value: string } | undefined)?.value;
        if (value !== undefined && !decrypts(keyring, value)) legacyUnreadable = legacy;
      }
    }

    tables.push({
      table: spec.table,
      unknownKey: row?.unknown_key ?? 0,
      malformed: row?.malformed ?? 0,
      legacyUnreadable
    });
  }

  const keyCount: unknown = await db("api_keys")
    .whereNull("revoked_at")
    .whereNotNull("key_hash_key_id")
    .whereNotIn("key_hash_key_id", known)
    .count({ n: "*" });
  const apiKeys = Number((keyCount as { n: string | number }[])[0]?.n ?? 0);

  const total = tables.reduce(
    (sum, table) => sum + table.unknownKey + table.malformed + table.legacyUnreadable,
    apiKeys
  );
  return { tables, apiKeys, total };
}

function decrypts(keyring: Keyring, value: string): boolean {
  try {
    decryptValue(keyring, value);
    return true;
  } catch {
    return false;
  }
}
