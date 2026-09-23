import { keyringFromEnvironment } from "../keyring-env.js";
import { verifyBackup } from "./verify.js";
import { preflight } from "../cli-commands.js";
import { parseBackupArgs, type BackupCommand } from "./args.js";
import { createBackup } from "./archive.js";
import { BackupError } from "./connection.js";
import { restoreBackup } from "./restore.js";
export async function runBackupCommand(
  command: BackupCommand,
  args: readonly string[],
  options: {
    databaseUrl: string;
    env: NodeJS.ProcessEnv;
    stdout: (line: string) => void;
    stderr: (line: string) => void;
  }
): Promise<number> {
  const early = preflight(command, args);
  if (!early.run && early.code === 0) {
    early.stdout.forEach(options.stdout);
    return 0;
  }
  const parsed = parseBackupArgs(command, early.run ? early.args : args);
  if (!parsed.ok) {
    options.stderr("backup_failed invalid_arguments");
    return 1;
  }
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort();
  };
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const shared = {
      databaseUrl: options.databaseUrl,
      timeoutMs: parsed.timeoutMs,
      env: options.env,
      signal: controller.signal
    };
    if (parsed.command === "backup:create") {
      const result = await createBackup({ ...shared, output: parsed.output });
      options.stdout(`backup_created bytes=${String(result.bytes)}`);
      if (result.cleanupIncomplete)
        options.stderr(
          "backup_cleanup_incomplete Remove leftover hidden .tmp files beside the backup and wayscribe-backup-trust-* directories in the system temp directory."
        );
    } else if (parsed.command === "backup:verify") {
      let keyring;
      try {
        keyring = keyringFromEnvironment(options.env);
      } catch {
        throw new BackupError("keys_required");
      }
      const result = await verifyBackup({ ...shared, input: parsed.input, keyring });
      options.stdout(
        `${result.ok ? "backup_verified" : "backup_verification_failed"} ${JSON.stringify(result)}`
      );
      return result.ok ? 0 : 1;
    } else {
      const result = await restoreBackup({
        ...shared,
        input: parsed.input,
        database: parsed.database
      });
      options.stdout(`backup_restored database=${result.database}`);
    }
    return 0;
  } catch (error) {
    options.stderr(
      `backup_failed ${error instanceof BackupError ? error.code : "operation_failed"}`
    );
    if (error instanceof BackupError && error.uncertainDatabase)
      options.stderr(
        `Inspect database ${error.uncertainDatabase} manually; creation outcome is unknown. It was not dropped.`
      );
    if (error instanceof BackupError && error.cleanupDatabase)
      options.stderr(`Owned database ${error.cleanupDatabase} needs manual cleanup.`);
    if (error instanceof BackupError && error.code === "tool_unavailable")
      options.stderr("Install PostgreSQL 18+ client tools and put pg_dump/pg_restore on PATH.");
    return 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}
