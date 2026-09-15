import type {
  ApiKeyNotCurrent,
  ReencryptMode,
  ReencryptProgress,
  RotationStatus,
  TableReencryption
} from "./repositories/rotation.js";

/**
 * What the rotation commands print.
 *
 * Kept apart from the CLI so the wording and the column layout are tested
 * without a database. Each table is one line beginning with the table's name
 * and followed by counts in a fixed column order, so a script can match a line
 * with a regular expression and an operator can read it at a terminal.
 */

const TABLE_WIDTH = 20;

export const LOCK_HELD_MESSAGE =
  "Another rotate:reencrypt holds the rotation lock, so this run changed nothing. " +
  "Let that one finish, then run rotate:status.";

export const LOCK_LOST_MESSAGE =
  "rotate:reencrypt lost the rotation lock: the database connection holding it ended, " +
  "for example through idle_in_transaction_session_timeout. It stopped after the batch in progress. " +
  "Everything it rewrote is safe, because every rewrite is conditional on the value it read; " +
  "run rotate:reencrypt again to finish.";

export function formatReencryptStart(currentKeyId: string, previousKeyId: string | null): string {
  return previousKeyId === null
    ? `Upgrading legacy values under key ${currentKeyId}. ENCRYPTION_KEY_PREVIOUS is not set, so nothing is rotated.`
    : `Re-encrypting under key ${currentKeyId}, reading values under ${previousKeyId} and legacy values.`;
}

export function formatReencryptProgress(progress: ReencryptProgress): string {
  return (
    `  ${progress.table.padEnd(TABLE_WIDTH)} batch ${String(progress.batch)}: ` +
    `${String(progress.examined)} examined, ${String(progress.rewrittenSoFar)} rewritten so far`
  );
}

export function formatReencryption(
  mode: ReencryptMode,
  tables: readonly TableReencryption[]
): string[] {
  const header = [
    "TABLE".padEnd(TABLE_WIDTH),
    "REWRITTEN".padStart(9),
    "ALREADY CURRENT".padStart(15),
    "UNRECOVERABLE".padStart(13),
    "NO VALUE".padStart(8),
    "DUPLICATES REMOVED".padStart(18)
  ].join("  ");

  const rows = tables.map((table) =>
    [
      table.table.padEnd(TABLE_WIDTH),
      count(table.rewritten, 9),
      count(table.alreadyCurrent, 15),
      count(table.unrecoverable, 13),
      count(table.noValue, 8),
      // Only aliases have a uniqueness constraint that a rewrite can collide with.
      (table.table === "entity_aliases" ? String(table.duplicatesRemoved) : "-").padStart(18)
    ].join("  ")
  );

  const total = (field: keyof Omit<TableReencryption, "table">): number =>
    tables.reduce((sum, table) => sum + table[field], 0);
  const rewritten = total("rewritten");
  const unrecoverable = total("unrecoverable");
  const changed = total("changedDuringRun");
  const duplicates = total("duplicatesRemoved");

  const lines = ["", header, ...rows, ""];
  lines.push(
    rewritten === 0 && duplicates === 0
      ? mode === "upgrade"
        ? "Nothing to upgrade: no legacy value the current key can read was left."
        : "Nothing to rewrite: every readable value was already under the current key."
      : `Rewrote ${plural(rewritten, "value")}${duplicates === 0 ? "" : ` and removed ${plural(duplicates, "duplicate alias row")}`}.`
  );
  if (changed > 0) {
    lines.push(
      `${plural(changed, "row")} changed while this ran and ${changed === 1 ? "was" : "were"} left alone. Run rotate:reencrypt again.`
    );
  }
  if (unrecoverable > 0) {
    lines.push(
      `${plural(unrecoverable, "value")} could not be read and ${unrecoverable === 1 ? "was" : "were"} left as ${unrecoverable === 1 ? "it was" : "they were"}. ` +
        "rotate:status shows the key ids involved."
    );
  }
  lines.push("Next: run rotate:status.");
  return lines;
}

export function formatRotationStatus(status: RotationStatus): string[] {
  const lines = [
    `Current key:  ${status.currentKeyId}`,
    `Previous key: ${status.previousKeyId ?? "not set"}`,
    "",
    [
      "TABLE".padEnd(TABLE_WIDTH),
      "CURRENT".padStart(9),
      "PREVIOUS".padStart(9),
      "LEGACY".padStart(9),
      "UNKNOWN KEY".padStart(11),
      "MALFORMED".padStart(9),
      "NO VALUE".padStart(8)
    ].join("  ")
  ];

  for (const table of status.tables) {
    lines.push(
      [
        table.table.padEnd(TABLE_WIDTH),
        count(table.current, 9),
        count(table.previous, 9),
        count(table.legacy, 9),
        count(table.unknownKey, 11),
        count(table.malformed, 9),
        count(table.noValue, 8)
      ].join("  ")
    );
  }

  const unknown = status.tables.filter((table) => table.unknownKeyIds.length > 0);
  if (unknown.length > 0) {
    lines.push("");
    for (const table of unknown) {
      lines.push(
        `${table.table} has rows under ${table.unknownKeyIds.join(", ")}, ` +
          (table.unknownKeyIds.length === 1
            ? "which is not configured. Set ENCRYPTION_KEY_PREVIOUS to that key to read them."
            : "which are not configured. Only one previous key can be set at a time.")
      );
    }
  }

  const rotating = status.previousKeyId !== null;
  const keys = status.apiKeys.notCurrent;
  const notRecorded = status.apiKeys.notRecorded;

  lines.push("", `API keys under the current key: ${String(status.apiKeys.current)}`);
  lines.push(`API keys not yet under the current key: ${String(keys.length)}`);
  if (keys.length > 0) {
    lines.push(...keyTable(keys));
    lines.push(
      "Each moves to the current key the next time it authenticates. A key that will not be used again",
      "can be replaced: issue a new one with key:create and revoke the old one with key:revoke."
    );
  }
  if (notRecorded.length > 0) {
    lines.push(
      `API keys with key id not recorded yet; recorded on next use: ${String(notRecorded.length)}`,
      ...keyTable(notRecorded)
    );
  }
  const unknownKeys = status.apiKeys.unknownKey;
  if (unknownKeys.length > 0) {
    // These answer 401 until the key they name is configured again, so they
    // get no promise that use will move them.
    lines.push(
      `API keys under a key that is not configured: ${String(unknownKeys.length)}`,
      ...keyTable(unknownKeys)
    );
    for (const keyId of new Set(unknownKeys.map((key) => key.keyHashKeyId))) {
      lines.push(
        `These are under ${keyId ?? ""}, which is not configured. Set ENCRYPTION_KEY_PREVIOUS to that key to let them authenticate.`
      );
    }
    lines.push("A key that will not be needed again can be revoked with key:revoke instead.");
  }

  if (rotating) {
    // Search tokens are recomputed from the decrypted value, so a row with no
    // value keeps the token it was written with.
    for (const table of status.tables) {
      if (table.table === "replay_destinations" || table.noValue === 0) continue;
      lines.push(
        "",
        `${table.table} has ${plural(table.noValue, "row")} with no stored value. Their search tokens stay under the previous key, ` +
          "so they will stop matching search once ENCRYPTION_KEY_PREVIOUS is removed."
      );
    }
  }

  lines.push("");
  if (status.complete) {
    lines.push(
      rotating
        ? // Recreate, not restart: `docker compose restart` keeps the environment
          // the container was created with, so the previous key would stay.
          "Complete: every row and API key is under the current key. Remove ENCRYPTION_KEY_PREVIOUS and recreate the API containers (docs/OPERATIONS.md §6)."
        : "Complete: every row and API key is under the current key."
    );
  } else {
    lines.push(
      `Not complete: ${plural(status.rowsRemaining, "row")} and ${plural(keys.length + unknownKeys.length, "API key")} are not under the current key.`
    );
  }
  return lines;
}

function keyTable(keys: readonly ApiKeyNotCurrent[]): string[] {
  const lines = [
    `${"PREFIX".padEnd(12)}  ${"PROJECT/ENVIRONMENT".padEnd(30)}  ${"NAME".padEnd(20)}  ${"KEY ID".padEnd(12)}  LAST USED`
  ];
  for (const key of keys) {
    const scope = `${key.projectSlug}/${key.environmentName}`;
    const used = key.lastUsedAt?.toISOString().slice(0, 19).replace("T", " ") ?? "never";
    lines.push(
      `${key.keyPrefix.padEnd(12)}  ${scope.padEnd(30)}  ${key.name.padEnd(20)}  ${(key.keyHashKeyId ?? "not recorded").padEnd(12)}  ${used}`
    );
  }
  return lines;
}

function count(value: number, width: number): string {
  return String(value).padStart(width);
}

function plural(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? "" : "s"}`;
}
