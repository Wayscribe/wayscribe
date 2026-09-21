import { randomBytes } from "node:crypto";
import { link, lstat, open, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { BackupError, normalizeBackupConnection, prepareToolEnvironment } from "./connection.js";
import { Deadline, resolveTool, runChild } from "./process.js";
export interface BackupOptions {
  databaseUrl: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}
export async function createBackup(
  options: BackupOptions & { output: string }
): Promise<{ bytes: number }> {
  const deadline = new Deadline(options.timeoutMs, options.signal);
  const connection = normalizeBackupConnection(options.databaseUrl, options.env);
  const tool = await resolveTool("pg_dump", connection.toolEnvironment, deadline);
  const destination = resolve(options.output);
  try {
    await lstat(destination);
    throw new BackupError("output_exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const trust = await prepareToolEnvironment(connection);
  const temporary = join(
    dirname(destination),
    `.${basename(destination)}.${randomBytes(12).toString("hex")}.tmp`
  );
  let owned = false;
  try {
    deadline.remaining();
    const file = await open(temporary, "wx", 0o600);
    owned = true;
    let bytes: number;
    try {
      // eslint-disable-next-line no-restricted-syntax -- PostgreSQL tool switches, not Wayscribe CLI flags.
      await runChild(tool, ["--format=custom", "--no-password"], {
        env: trust.env,
        deadline,
        outputFd: file.fd
      });
      bytes = (await file.stat()).size;
    } finally {
      await file.close();
    }
    deadline.remaining();
    try {
      await link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new BackupError("output_exists");
      throw error;
    }
    return { bytes };
  } catch (error) {
    throw error instanceof BackupError ? error : new BackupError("archive_io");
  } finally {
    if (owned) await unlink(temporary);
    await trust.close();
  }
}
