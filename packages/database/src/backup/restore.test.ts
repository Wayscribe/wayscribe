import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const { query, connect, end, serverVersion } = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  end: vi.fn(),
  serverVersion: { num: "180004" }
}));
vi.mock("pg", async (importOriginal) => {
  const actual = await importOriginal<typeof import("pg")>();
  return {
    ...actual,
    default: {
      ...actual.default,
      Client: class {
        // The version probe is answered here so the scripted `query` sees only CREATE/DROP.
        query = (sql: string): unknown =>
          sql === "SHOW server_version_num"
            ? Promise.resolve({ rows: [{ server_version_num: serverVersion.num }] })
            : query(sql);
        connect = connect;
        end = end;
        on(): void {}
      }
    }
  };
});
import pg from "pg";
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>())
}));
import * as files from "node:fs/promises";
import * as connection from "./connection.js";
import { restoreBackup, withRestoredDatabase } from "./restore.js";
let dir: string;
let input: string;
const databaseUrl = "postgresql://alice:password@localhost/source";
beforeEach(async () => {
  query.mockReset();
  connect.mockReset();
  end.mockReset();
  connect.mockResolvedValue(undefined);
  end.mockResolvedValue(undefined);
  query.mockResolvedValue({ rows: [] });
  serverVersion.num = "180004";
  dir = await mkdtemp(join(tmpdir(), "backup-restore-test-"));
  input = join(dir, "archive");
  await writeFile(input, "PGDMPmalformed");
  await writeFile(
    join(dir, "pg_restore"),
    `#!${process.execPath}\nif(process.argv.includes('--version')) {console.log('pg_restore (PostgreSQL) 18.4');process.exit(0)}\nprocess.exit(1)`,
    { mode: 0o700 }
  );
  vi.stubEnv("PATH", dir);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});
it("refuses a server older than 17 before creating any database", async () => {
  for (const num of ["160004", "150010", ""]) {
    serverVersion.num = num;
    await expect(
      restoreBackup({ databaseUrl, input, database: "old_server", timeoutMs: 5000 })
    ).rejects.toMatchObject({ code: "server_version" });
  }
  serverVersion.num = "170000";
  await expect(
    restoreBackup({ databaseUrl, input, database: "new_server", timeoutMs: 5000 })
  ).rejects.toMatchObject({ code: "tool_failed" });
  expect(query.mock.calls.map((call) => call[0] as unknown)).toEqual([
    'CREATE DATABASE "new_server" TEMPLATE template0',
    'DROP DATABASE "new_server" WITH (FORCE)'
  ]);
});
it("never drops an existing database", async () => {
  query.mockRejectedValueOnce(
    Object.assign(new pg.DatabaseError("SECRET", 0, "error"), { code: "42P04", severity: "ERROR" })
  );
  await expect(
    restoreBackup({ databaseUrl, input, database: "existing", timeoutMs: 5000 })
  ).rejects.toMatchObject({ code: "database_exists" });
  expect(query.mock.calls.map((call) => call[0] as unknown)).toEqual([
    'CREATE DATABASE "existing" TEMPLATE template0'
  ]);
});
it("preserves an unknown CREATE outcome without claiming or dropping it", async () => {
  query.mockRejectedValueOnce(new Error("connection lost PASSWORD"));
  await expect(
    restoreBackup({ databaseUrl, input, database: "uncertain", timeoutMs: 5000 })
  ).rejects.toMatchObject({ code: "create_outcome_unknown", uncertainDatabase: "uncertain" });
  expect(query).toHaveBeenCalledTimes(1);
});
it("keeps the original restore failure and identifies owned cleanup failures", async () => {
  query.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(new Error("cleanup SECRET"));
  await expect(
    restoreBackup({ databaseUrl, input, database: "owned_copy", timeoutMs: 5000 })
  ).rejects.toMatchObject({ code: "tool_failed", cleanupDatabase: "owned_copy" });
  expect(query.mock.calls.map((call) => call[0] as unknown)).toEqual([
    'CREATE DATABASE "owned_copy" TEMPLATE template0',
    'DROP DATABASE "owned_copy" WITH (FORCE)'
  ]);
});
it("validates custom format before database creation", async () => {
  await writeFile(input, "plain sql");
  await expect(
    restoreBackup({ databaseUrl, input, database: "copy", timeoutMs: 5000 })
  ).rejects.toMatchObject({ code: "archive_invalid" });
  expect(connect).not.toHaveBeenCalled();
});
it("restores from the opened descriptor even if the input path is replaced", async () => {
  const { rename, readFile } = await import("node:fs/promises");
  const observed = join(dir, "observed");
  await writeFile(
    join(dir, "pg_restore"),
    `#!${process.execPath}\nif(process.argv.includes('--version')) {console.log('pg_restore (PostgreSQL) 18.4');process.exit(0)}\nrequire('fs').writeFileSync(${JSON.stringify(observed)},require('fs').readFileSync(0))`,
    { mode: 0o700 }
  );
  query.mockImplementationOnce(async () => {
    await rename(input, `${input}.old`);
    await writeFile(input, "PGDMPdifferent");
    return { rows: [] };
  });
  await expect(
    restoreBackup({ databaseUrl, input, database: "pinned_copy", timeoutMs: 5000 })
  ).resolves.toEqual({ database: "pinned_copy" });
  expect(await readFile(observed, "utf8")).toBe("PGDMPmalformed");
});
it("bounds an uncertain CREATE query without dropping the requested name", async () => {
  query.mockImplementationOnce(() => new Promise(() => undefined));
  const start = Date.now();
  await expect(
    restoreBackup({ databaseUrl, input, database: "uncertain_copy", timeoutMs: 400 })
  ).rejects.toMatchObject({ code: "create_outcome_unknown", uncertainDatabase: "uncertain_copy" });
  expect(Date.now() - start).toBeLessThan(1500);
  expect(query).toHaveBeenCalledTimes(1);
});
it("shares one bounded cleanup grace across connection shutdown and a stuck DROP", async () => {
  end.mockImplementationOnce(() => new Promise((resolve) => setTimeout(resolve, 3000)));
  query
    .mockResolvedValueOnce({ rows: [] })
    .mockImplementationOnce(() => new Promise(() => undefined));
  const start = Date.now();
  await expect(
    restoreBackup({ databaseUrl, input, database: "cleanup_stuck", timeoutMs: 1000 })
  ).rejects.toMatchObject({ code: "tool_failed", cleanupDatabase: "cleanup_stuck" });
  expect(Date.now() - start).toBeLessThan(6500);
});

it("reports a submitted CREATE EPIPE as uncertain and never drops the target", async () => {
  query.mockRejectedValueOnce(
    Object.assign(new Error("PASSWORD_SOCKET_SENTINEL"), { code: "EPIPE" })
  );
  await expect(
    restoreBackup({ databaseUrl, input, database: "pipe_copy", timeoutMs: 5000 })
  ).rejects.toMatchObject({ code: "create_outcome_unknown", uncertainDatabase: "pipe_copy" });
  expect(query.mock.calls.map((call) => call[0] as unknown)).toEqual([
    'CREATE DATABASE "pipe_copy" TEMPLATE template0'
  ]);
});
it("keeps acknowledged PostgreSQL CREATE refusals distinct from transport failures", async () => {
  query.mockRejectedValueOnce(
    Object.assign(new pg.DatabaseError("SECRET", 0, "error"), { code: "42501", severity: "ERROR" })
  );
  await expect(
    restoreBackup({ databaseUrl, input, database: "denied_copy", timeoutMs: 5000 })
  ).rejects.toMatchObject({ code: "database_failed", uncertainDatabase: undefined });
  expect(query.mock.calls.map((call) => call[0] as unknown)).toEqual([
    'CREATE DATABASE "denied_copy" TEMPLATE template0'
  ]);
});

it("attempts every finalizer without overwriting the original failure and owned cleanup metadata", async () => {
  const realOpen = files.open;
  const trustClose = vi.fn().mockRejectedValue(new Error("SECRET_TRUST"));
  vi.spyOn(connection, "prepareToolEnvironment").mockResolvedValue({
    env: { PATH: dir },
    close: trustClose
  });
  vi.spyOn(files, "open").mockImplementation(async (...args) => {
    const handle = await realOpen(...args);
    const realClose = handle.close.bind(handle);
    handle.close = async () => {
      await realClose();
      throw new Error("SECRET_CLOSE");
    };
    return handle;
  });
  query.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(new Error("DROP_SECRET"));
  await expect(
    restoreBackup({ databaseUrl, input, database: "owned_copy", timeoutMs: 5000 })
  ).rejects.toMatchObject({ code: "tool_failed", cleanupDatabase: "owned_copy" });
  expect(trustClose).toHaveBeenCalledOnce();
});
it("preserves a colliding generated inspection name without DROP", async () => {
  query.mockRejectedValueOnce(
    Object.assign(new pg.DatabaseError("SECRET", 0, "error"), { code: "42P04", severity: "ERROR" })
  );
  const inspector = vi.fn();
  await expect(
    withRestoredDatabase({ databaseUrl, input, timeoutMs: 5000 }, inspector)
  ).rejects.toMatchObject({ code: "database_exists" });
  expect(inspector).not.toHaveBeenCalled();
  expect(query.mock.calls.map((call) => call[0] as unknown)).toEqual([
    expect.stringMatching(
      /^CREATE DATABASE "wayscribe_restore_check_[a-f0-9]{24}" TEMPLATE template0$/
    )
  ]);
});
it("preserves inspector failure identity and metadata when DROP fails", async () => {
  await writeFile(
    join(dir, "pg_restore"),
    `#!${process.execPath}\nif(process.argv.includes('--version')) console.log('pg_restore (PostgreSQL) 18.4');`,
    { mode: 0o700 }
  );
  query.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(new Error("SECRET_DROP"));
  const original = new Error("INSPECT_SECRET");
  await expect(
    withRestoredDatabase({ databaseUrl, input, timeoutMs: 5000 }, () => Promise.reject(original))
  ).rejects.toBe(original);
  expect(original).toHaveProperty(
    "cleanupDatabase",
    expect.stringMatching(/^wayscribe_restore_check_/)
  );
});
