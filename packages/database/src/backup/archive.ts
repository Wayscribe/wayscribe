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
): Promise<{ bytes: number; cleanupIncomplete?: true }> {
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
  const directory = dirname(destination);
  const temporary = join(
    directory,
    `.${basename(destination)}.${randomBytes(12).toString("hex")}.tmp`
  );
  let owned = false;
  let result: { bytes: number } | undefined;
  let failure: BackupError | undefined;
  try {
    deadline.remaining();
    const file = await open(temporary, "wx+", 0o600);
    owned = true;
    let bytes: number;
    try {
      // eslint-disable-next-line no-restricted-syntax -- PostgreSQL tool switches, not Wayscribe CLI flags.
      await runChild(tool, ["--format=custom", "--no-password"], {
        env: trust.env,
        deadline,
        outputFd: file.fd
      });
      const magic = Buffer.alloc(5);
      await file.read(magic, 0, magic.length, 0);
      if (magic.toString("ascii") !== "PGDMP") throw new BackupError("archive_invalid");
      await file.sync();
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
    // Persist the new directory entry before reporting backup_created.
    const parent = await open(directory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    result = { bytes };
  } catch (error) {
    failure = error instanceof BackupError ? error : new BackupError("archive_io");
  }
  // Start both finalizers even when one fails. A published archive stays a success; a
  // failed operation keeps its own code rather than the cleanup error's.
  const finalized = await Promise.allSettled([
    owned ? unlink(temporary) : Promise.resolve(),
    Promise.resolve().then(() => trust.close())
  ]);
  if (failure !== undefined) throw failure;
  if (result === undefined) throw new BackupError("archive_io");
  return finalized.some((entry) => entry.status === "rejected")
    ? { ...result, cleanupIncomplete: true }
    : result;
}
