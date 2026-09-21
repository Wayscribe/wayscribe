import { everyFlagRead, parseCommandArgs } from "../cli-commands.js";
import { validateRestoreDatabase } from "./connection.js";
export type BackupCommand = "backup:create" | "backup:restore";
export type BackupArgs =
  | { ok: true; command: "backup:create"; output: string; timeoutMs: number }
  | { ok: true; command: "backup:restore"; input: string; database: string; timeoutMs: number }
  | { ok: false; message: string };
export const DEFAULT_TIMEOUT_MS = 600_000;
export const MAX_TIMEOUT_MS = 3_600_000;
export function parseBackupArgs(command: BackupCommand, args: readonly string[]): BackupArgs {
  const parsed = parseCommandArgs(command, args);
  if (!parsed.ok)
    return {
      ok: false,
      message: parsed.code === "unknown" ? "Unknown backup argument." : "Invalid backup arguments."
    };
  if (new Set(parsed.given).size !== parsed.given.length)
    return { ok: false, message: "Duplicate backup argument." };
  const { output, input, database, "timeout-ms": timeout, ...unread } = parsed.values;
  everyFlagRead(unread);
  const timeoutMs = timeout === undefined ? DEFAULT_TIMEOUT_MS : Number(timeout);
  if (
    (timeout !== undefined && !/^\d+$/.test(timeout)) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  )
    return { ok: false, message: "Invalid backup timeout." };
  if (command === "backup:create" && output) return { ok: true, command, output, timeoutMs };
  if (command === "backup:restore" && input && database) {
    try {
      validateRestoreDatabase(database);
    } catch {
      return { ok: false, message: "Invalid restore database." };
    }
    return { ok: true, command, input, database, timeoutMs };
  }
  return { ok: false, message: "Missing backup arguments." };
}
