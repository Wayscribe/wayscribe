import { checkServerIdentity } from "node:tls";
import { X509Certificate } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientConfig } from "pg";
import type { Knex } from "knex";

export type BackupErrorCode =
  | "invalid_arguments"
  | "connection_unsupported"
  | "invalid_database"
  | "tool_unavailable"
  | "tool_version"
  | "output_exists"
  | "archive_invalid"
  | "archive_io"
  | "tool_failed"
  | "timeout"
  | "aborted"
  | "database_exists"
  | "database_failed"
  | "create_outcome_unknown"
  | "cleanup_failed";
export class BackupError extends Error {
  cleanupDatabase?: string;
  uncertainDatabase?: string;
  constructor(public readonly code: BackupErrorCode) {
    super(code);
    this.name = "BackupError";
  }
}
// pg supports these startup/client fields; its published typings omit replication and binary.
export type BackupPgConfig = ClientConfig &
  Knex.PgConnectionConfig & { replication: "false"; binary: boolean };
export interface BackupConnection {
  pgConfig: BackupPgConfig;
  toolEnvironment: NodeJS.ProcessEnv;
  ca?: Buffer;
}
export function validateRestoreDatabase(database: string, source?: string): void {
  if (
    !/^[a-z][a-z0-9_]{0,62}$/.test(database) ||
    [source, "postgres", "template0", "template1"].includes(database)
  )
    throw new BackupError("invalid_database");
}
export function normalizeBackupConnection(
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env
): BackupConnection {
  try {
    const url = new URL(databaseUrl);
    const seen = new Set<string>();
    for (const [key] of url.searchParams) {
      if (!["sslmode", "sslrootcert"].includes(key) || seen.has(key)) throw new Error();
      seen.add(key);
    }
    const mode = url.searchParams.get("sslmode") ?? "disable";
    const root = url.searchParams.get("sslrootcert");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const user = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    const database = decodeURIComponent(url.pathname.slice(1));
    const port = Number(url.port || "5432");
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      url.hash ||
      !host ||
      /[,/%\s]/.test(host) ||
      !user ||
      !password ||
      !database ||
      /[\0\r\n]/.test(user + password + database) ||
      database.includes("/") ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    )
      throw new Error();
    if (mode !== "disable" && mode !== "verify-full") throw new Error();
    if (mode === "disable" && root !== null) throw new Error();
    let ca: Buffer | undefined;
    if (mode === "verify-full") {
      if (!root || root === "system") throw new Error();
      const fd = openSync(root, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size < 1 || stat.size > 1024 * 1024) throw new Error();
        ca = Buffer.alloc(stat.size);
        if (readSync(fd, ca, 0, ca.length, 0) !== ca.length) throw new Error();
        const certs = ca
          .toString("utf8")
          .match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
        if (!certs?.length) throw new Error();
        for (const cert of certs) new X509Certificate(cert);
      } finally {
        closeSync(fd);
      }
    }
    const toolEnvironment = Object.fromEntries(
      Object.entries(env).filter(([key]) => !key.toUpperCase().startsWith("PG"))
    );
    Object.assign(toolEnvironment, {
      PGHOST: host,
      PGPORT: String(port),
      PGUSER: user,
      PGPASSWORD: password,
      PGDATABASE: database,
      PGSSLMODE: mode,
      PGGSSENCMODE: "disable",
      PGSSLCERTMODE: "disable",
      PGSSLMINPROTOCOLVERSION: "TLSv1.2",
      PGSSLNEGOTIATION: "postgres",
      PGCLIENTENCODING: "UTF8",
      PGAPPNAME: "wayscribe_backup",
      PGOPTIONS: "-c statement_timeout=0"
    });
    return {
      pgConfig: {
        host,
        port,
        user,
        password: () => password,
        database,
        ssl: ca
          ? {
              ca,
              rejectUnauthorized: true,
              // pg omits SNI for IP hosts; bind Node verification to our host, not its localhost fallback.
              checkServerIdentity: (_hostname, certificate) =>
                checkServerIdentity(host, certificate),
              minVersion: "TLSv1.2"
            }
          : false,
        sslnegotiation: "postgres",
        client_encoding: "UTF8",
        application_name: "wayscribe_backup",
        options: "-c statement_timeout=0",
        replication: "false",
        binary: false,
        connectionTimeoutMillis: 10_000
      },
      toolEnvironment,
      ...(ca ? { ca } : {})
    };
  } catch {
    throw new BackupError("connection_unsupported");
  }
}
/** Snapshot trust bytes so both consumers use the same CA even if the source changes. */
export async function prepareToolEnvironment(
  connection: BackupConnection
): Promise<{ env: NodeJS.ProcessEnv; close: () => Promise<void> }> {
  if (!connection.ca)
    return { env: { ...connection.toolEnvironment }, close: () => Promise.resolve() };
  const directory = await mkdtemp(join(tmpdir(), "wayscribe-backup-trust-"));
  try {
    const root = join(directory, "root.crt");
    // A real empty CRL directory enables CRL_CHECK and rejects every chain. A missing
    // explicit file suppresses implicit root.crl discovery without enabling that check.
    const absentCrl = join(directory, "absent.crl");
    await writeFile(root, connection.ca, { flag: "wx", mode: 0o600 });
    return {
      env: { ...connection.toolEnvironment, PGSSLROOTCERT: root, PGSSLCRL: absentCrl },
      close: () => rm(directory, { recursive: true, force: true })
    };
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw new BackupError("archive_io");
  }
}
