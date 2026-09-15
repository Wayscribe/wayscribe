import { findUnreadableData, pendingMigrationCount } from "@flight-recorder/database";
import type { Keyring } from "@flight-recorder/payload-security";
import type { Knex } from "knex";

/** The one logger method these warnings need; Fastify's logger satisfies it. */
export interface WarnLogger {
  warn: (fields: Record<string, unknown>, message: string) => void;
}

/**
 * A callback for reads that meet a value under a key the keyring lacks.
 *
 * Warns once per key id for the life of the returned function, which the API
 * builds once per process. A removed key shows up on every row it wrote, on
 * every request that reads one, and a line per read would bury everything else
 * in the log. The line carries the key id and nothing from the row: the id is a
 * fingerprint, safe to log, and enough to find the key.
 */
export function unknownKeyWarning(log: WarnLogger): (keyId: string) => void {
  const warned = new Set<string>();
  return (keyId) => {
    if (warned.has(keyId)) return;
    warned.add(keyId);
    log.warn(
      { keyId },
      `Read a value encrypted under key ${keyId}, which is not configured. ` +
        "Set ENCRYPTION_KEY_PREVIOUS to that key if it was removed too early; run rotate:status to see how much data it holds."
    );
  };
}

/**
 * Log one warning at boot when stored data or API keys are under a key this
 * process cannot read.
 *
 * The API still starts. Refusing would stop ingestion over a read problem, and
 * the fix (restoring the previous key) is a restart either way.
 *
 * Skipped while migrations are pending, since the columns it reads may not
 * exist yet, and never throws: a check that failed to run is logged, not a
 * reason to stop.
 */
export async function checkKeysAtBoot(db: Knex, keyring: Keyring, log: WarnLogger): Promise<void> {
  try {
    if ((await pendingMigrationCount(db)) > 0) return;

    const found = await findUnreadableData(db, keyring);
    if (found.total === 0) return;

    const unreadable: Record<string, number> = {};
    for (const table of found.tables) {
      unreadable[table.table] = table.unknownKey + table.malformed + table.legacyUnreadable;
    }
    unreadable["api_keys"] = found.apiKeys;

    const summary = Object.entries(unreadable)
      .map(([name, count]) => `${name} ${String(count)}`)
      .join(", ");
    log.warn(
      { unreadable },
      `Stored data the configured keys cannot read: ${summary}. ` +
        "If ENCRYPTION_KEY_PREVIOUS was removed before rotate:reencrypt finished, restore it and restart. " +
        "Run rotate:status for details."
    );
  } catch (error) {
    log.warn({ err: error }, "The boot check for unreadable data could not run.");
  }
}
