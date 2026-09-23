import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import knex, { type Knex } from "knex";
import pg from "pg";
import type { BackupOptions } from "./archive.js";
import {
  BackupError,
  normalizeBackupConnection,
  prepareToolEnvironment,
  validateRestoreDatabase,
  type BackupConnection,
  type BackupPgConfig
} from "./connection.js";
import { Deadline, resolveTool, runChild } from "./process.js";

/* eslint-disable no-restricted-syntax -- PostgreSQL tool switches, not Wayscribe CLI flags. */
// Empty dbname selects direct restore mode; libpq takes the actual target only from PGDATABASE.
const RESTORE_TOOL_ARGS = [
  "--dbname=",
  "--exit-on-error",
  "--single-transaction",
  "--no-owner",
  "--no-privileges",
  "--no-password"
];
/* eslint-enable no-restricted-syntax */

function config(
  connection: BackupConnection,
  database: string,
  deadline: Deadline
): BackupPgConfig {
  const remaining = deadline.remaining();
  return {
    ...connection.pgConfig,
    database,
    connectionTimeoutMillis: remaining,
    statement_timeout: remaining,
    query_timeout: remaining,
    options: `-c statement_timeout=${String(remaining)}`
  };
}
async function statement(
  connection: BackupConnection,
  sql: string,
  deadline: Deadline,
  shutdowns: Promise<void>[],
  creating?: string
): Promise<void> {
  const client = new pg.Client(config(connection, String(connection.pgConfig.database), deadline));
  client.on("error", () => undefined);
  let submitted = false;
  let closing: Promise<void> | undefined;
  const close = (): void => {
    if (!closing) {
      closing = client.end().catch(() => undefined);
      shutdowns.push(closing);
    }
  };
  try {
    await deadline.wait(client.connect(), close);
    deadline.remaining();
    submitted = true;
    await deadline.wait(client.query(sql), close);
  } catch (error) {
    if (creating && submitted) {
      // Socket codes such as EPIPE also look like SQLSTATEs. Only a pg ErrorResponse
      // with ordinary ERROR severity acknowledges a failed statement.
      if (!(error instanceof pg.DatabaseError) || error.severity !== "ERROR") {
        const uncertain = new BackupError("create_outcome_unknown");
        uncertain.uncertainDatabase = creating;
        throw uncertain;
      }
      if (error.code === "42P04") throw new BackupError("database_exists");
    }
    throw error instanceof BackupError ? error : new BackupError("database_failed");
  } finally {
    close();
  }
}
export async function restoreBackup(
  options: BackupOptions & { input: string; database: string }
): Promise<{ database: string }> {
  await restoreOwned(options);
  return { database: options.database };
}
export async function withRestoredDatabase<T>(
  options: BackupOptions & { input: string },
  inspect: (db: Knex) => Promise<T>
): Promise<T> {
  const database = `wayscribe_restore_check_${randomBytes(12).toString("hex")}`;
  return (await restoreOwned({ ...options, database }, inspect)) as T;
}
/** Ownership starts only at acknowledged CREATE success; no existence check can confer it. */
async function restoreOwned<T>(
  options: BackupOptions & { input: string; database: string },
  inspect?: (db: Knex) => Promise<T>
): Promise<T | undefined> {
  const deadline = new Deadline(options.timeoutMs, options.signal);
  const connection = normalizeBackupConnection(options.databaseUrl, options.env);
  validateRestoreDatabase(options.database, String(connection.pgConfig.database));
  const tool = await resolveTool("pg_restore", connection.toolEnvironment, deadline);
  let file;
  try {
    file = await open(options.input, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    throw new BackupError("archive_invalid");
  }
  let trust: Awaited<ReturnType<typeof prepareToolEnvironment>> | undefined;
  let owned = false;
  let failure: Error | undefined;
  const shutdowns: Promise<void>[] = [];
  let result: T | undefined;
  let db: Knex | undefined;
  const clients = new Set<pg.Client>();
  try {
    if (!(await file.stat()).isFile()) throw new BackupError("archive_invalid");
    const magic = Buffer.alloc(5);
    await file.read(magic, 0, 5, 0);
    if (magic.toString("ascii") !== "PGDMP") throw new BackupError("archive_invalid");
    trust = await prepareToolEnvironment(connection);
    await statement(
      connection,
      `CREATE DATABASE "${options.database}" TEMPLATE template0`,
      deadline,
      shutdowns,
      options.database
    );
    owned = true;
    await runChild(tool, RESTORE_TOOL_ARGS, {
      env: { ...trust.env, PGDATABASE: options.database },
      deadline,
      inputFd: file.fd
    });
    if (inspect) {
      const silent = (): void => undefined;
      db = knex({
        client: "pg",
        connection: config(connection, options.database, deadline),
        acquireConnectionTimeout: deadline.remaining(),
        log: { warn: silent, error: silent, debug: silent, deprecate: silent },
        pool: {
          min: 0,
          max: 1,
          afterCreate: (client: pg.Client, done: (error: null, client: pg.Client) => void) => {
            clients.add(client);
            client.on("error", silent);
            done(null, client);
          }
        }
      });
      result = await deadline.wait(inspect(db), () => {
        for (const client of clients) void client.end().catch(silent);
      });
    }
    deadline.remaining();
  } catch (error) {
    failure = error instanceof Error ? error : new BackupError("database_failed");
  }
  // One grace budget for all shutdown and DROP work, never another operation timeout.
  const cleanup = new Deadline(Math.max(1, Math.min(5000, deadline.expiresAt + 5000 - Date.now())));
  try {
    await cleanup.wait(Promise.all(shutdowns));
    if (db) {
      for (const client of clients) void client.end().catch(() => undefined);
      await cleanup.wait(db.destroy());
    }
    if (owned && (failure !== undefined || inspect !== undefined)) {
      await statement(
        connection,
        `DROP DATABASE "${options.database}" WITH (FORCE)`,
        cleanup,
        shutdowns
      );
      await cleanup.wait(Promise.all(shutdowns));
    }
  } catch {
    if (owned) {
      failure ??= new BackupError("cleanup_failed");
      if (failure instanceof Error) Object.assign(failure, { cleanupDatabase: options.database });
    }
  } finally {
    // Start both finalizers even when one fails; preserve the operation error and ownership metadata.
    try {
      const finalized = await cleanup.wait(
        Promise.allSettled([
          Promise.resolve().then(() => file.close()),
          Promise.resolve().then(() => trust?.close())
        ])
      );
      if (finalized.some((entry) => entry.status === "rejected"))
        failure ??= new BackupError("archive_io");
    } catch {
      failure ??= new BackupError("archive_io");
    }
  }
  if (failure !== undefined) throw failure;
  return result;
}
