import { decryptValue, searchTokens, type Keyring } from "@wayscribe/payload-security";
import type { Knex } from "knex";
import { ENCRYPTED_TABLES } from "../encrypted-columns.js";
import { migrationStatusReadOnly } from "../migration-status.js";
import type { BackupOptions } from "./archive.js";
import { BackupError, validateRestoreDatabase } from "./connection.js";
import { withRestoredDatabase } from "./restore.js";

/** Update this inventory when an approved migration adds an application table. */
const TABLES = [
  "projects",
  "environments",
  "api_keys",
  "journeys",
  "entity_aliases",
  "journey_events",
  "replay_destinations",
  "replay_runs",
  "audit_events"
] as const;
export type VerificationFailure =
  "schema_mismatch" | "integrity_failed" | "encrypted_values_unreadable" | "search_tokens_mismatch";
export interface BackupVerification {
  ok: boolean;
  migrations: { pending: number; unknown: number };
  tables: { table: (typeof TABLES)[number]; rows: number }[];
  encryptedValuesExamined: number;
  failures: VerificationFailure[];
}

function requireKeys(keyring: Keyring): void {
  const valid = (key: Keyring["current"] | undefined): boolean =>
    !!key &&
    /^[a-f0-9]{12}$/.test(key.id) &&
    Buffer.isBuffer(key.fieldEncryption) &&
    key.fieldEncryption.length === 32;
  // Callers outside the type system can pass nothing at all.
  const ring = keyring as Keyring | undefined;
  if (!ring || !valid(ring.current) || (ring.previous !== null && !valid(ring.previous)))
    throw new BackupError("keys_required");
}
/** Never expose raw database/crypto messages; retain only safe lifecycle metadata. */
function safeFailure(error: unknown): BackupError {
  const safe = new BackupError(error instanceof BackupError ? error.code : "inspection_failed");
  if (error instanceof Error) {
    for (const field of ["cleanupDatabase", "uncertainDatabase"] as const) {
      const value: unknown = (error as Error & Record<string, unknown>)[field];
      if (typeof value !== "string") continue;
      try {
        validateRestoreDatabase(value);
        safe[field] = value;
      } catch {
        /* Untrusted diagnostics are omitted. */
      }
    }
  }
  return safe;
}
export async function verifyBackup(
  options: BackupOptions & { input: string; keyring: Keyring }
): Promise<BackupVerification> {
  requireKeys(options.keyring);
  try {
    return await withRestoredDatabase(options, (db) => verifyRestoredDatabase(db, options.keyring));
  } catch (error) {
    throw safeFailure(error);
  }
}

/** All declared references plus the project/environment scopes required by repository reads. */
const REFERENCES: readonly (readonly [string, string, readonly (readonly [string, string])[]])[] = [
  ["environments", "projects", [["project_id", "id"]]],
  ["api_keys", "projects", [["project_id", "id"]]],
  [
    "api_keys",
    "environments",
    [
      ["environment_id", "id"],
      ["project_id", "project_id"]
    ]
  ],
  ["journeys", "projects", [["project_id", "id"]]],
  [
    "journeys",
    "environments",
    [
      ["environment_id", "id"],
      ["project_id", "project_id"]
    ]
  ],
  [
    "entity_aliases",
    "journeys",
    [
      ["project_id", "project_id"],
      ["journey_id", "id"]
    ]
  ],
  [
    "journey_events",
    "journeys",
    [
      ["project_id", "project_id"],
      ["journey_id", "id"],
      ["environment_id", "environment_id"]
    ]
  ],
  ["replay_destinations", "projects", [["project_id", "id"]]],
  ["replay_runs", "projects", [["project_id", "id"]]],
  [
    "replay_runs",
    "journey_events",
    [
      ["project_id", "project_id"],
      ["journey_event_id", "id"]
    ]
  ],
  [
    "replay_runs",
    "replay_destinations",
    [
      ["project_id", "project_id"],
      ["destination_id", "id"]
    ]
  ],
  ["audit_events", "projects", [["project_id", "id"]]]
];

export async function verifyRestoredDatabase(
  db: Knex,
  keyring: Keyring
): Promise<BackupVerification> {
  requireKeys(keyring);
  try {
    return await db.transaction(
      async (tx) => {
        // Standalone inspections are finite too. Never increase the lifecycle's existing timeout.
        await tx.raw(
          "select set_config('statement_timeout', least(coalesce(nullif((select setting::bigint from pg_settings where name = 'statement_timeout'), 0), 600000), 600000)::text, true)"
        );
        const migrations = await migrationStatusReadOnly(tx);
        const result: BackupVerification = {
          ok: true,
          migrations: { pending: migrations.pending.length, unknown: migrations.unknown.length },
          tables: [],
          encryptedValuesExamined: 0,
          failures: []
        };
        if (result.migrations.pending || result.migrations.unknown) {
          result.ok = false;
          result.failures.push("schema_mismatch");
          return result;
        }
        for (const table of TABLES) {
          const count = await tx(table).count<{ count: string }[]>("*");
          result.tables.push({ table, rows: Number(count[0]?.count ?? 0) });
        }
        let brokenReference = false;
        for (const [child, parent, columns] of REFERENCES) {
          const parentQuery = tx(`${parent} as parent`).select(tx.raw("1"));
          for (const [childColumn, parentColumn] of columns)
            void parentQuery.whereRaw("?? = ??", [
              `parent.${parentColumn}`,
              `child.${childColumn}`
            ]);
          const orphan: unknown = await tx(`${child} as child`)
            .select(tx.raw("1"))
            .whereNotExists(parentQuery)
            .first();
          if (orphan) brokenReference = true;
        }
        // Null and empty arrays record valid older/no-alias events; any actual member must share the journey.
        const aliases = await tx.raw<{ rows: { invalid: boolean }[] }>(`select exists (
        select 1 from journey_events e cross join lateral unnest(e.stated_alias_ids) stated(id)
        where not exists (select 1 from entity_aliases a where a.id = stated.id and a.project_id = e.project_id and a.journey_id = e.journey_id)
      ) as invalid`);
        if (brokenReference || aliases.rows[0]?.invalid) result.failures.push("integrity_failed");
        let unreadable = false;
        let tokenMismatch = false;
        for (const { table, column, key, searchToken } of ENCRYPTED_TABLES) {
          let cursor: string[] | undefined;
          for (;;) {
            const query = tx(table)
              .select([...key, column, ...(searchToken ? [searchToken] : [])])
              .whereNotNull(column)
              .orderBy(key.map((column) => ({ column, order: "asc" as const })))
              .limit(500);
            if (cursor)
              query.whereRaw(
                `(${key.map(() => "??").join(",")}) > (${key.map(() => "?").join(",")})`,
                [...key, ...cursor]
              );
            const rows = (await query) as Record<string, string>[];
            for (const row of rows) {
              result.encryptedValuesExamined += 1;
              let plaintext: string;
              try {
                plaintext = decryptValue(keyring, row[column] ?? "");
              } catch {
                unreadable = true;
                continue;
              }
              // Search writes the current or, until rotation rewrites it, the previous key's token.
              if (searchToken && !searchTokens(keyring, plaintext).includes(row[searchToken] ?? ""))
                tokenMismatch = true;
            }
            const last = rows.at(-1);
            if (!last || rows.length < 500) break;
            cursor = key.map((column) => last[column] ?? "");
          }
        }
        if (unreadable) result.failures.push("encrypted_values_unreadable");
        if (tokenMismatch) result.failures.push("search_tokens_mismatch");
        result.ok = result.failures.length === 0;
        return result;
      },
      { readOnly: true, isolationLevel: "repeatable read" }
    );
  } catch (error) {
    throw safeFailure(error);
  }
}
