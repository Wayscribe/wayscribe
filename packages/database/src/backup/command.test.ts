import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>())
}));
import * as files from "node:fs/promises";
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("pg", async (importOriginal) => {
  const actual = await importOriginal<typeof import("pg")>();
  return {
    ...actual,
    default: {
      ...actual.default,
      Client: class {
        query = query;
        connect(): Promise<void> {
          return Promise.resolve();
        }
        end(): Promise<void> {
          return Promise.resolve();
        }
        on(): void {}
      }
    }
  };
});
import { runBackupCommand } from "./command.js";
it("handles help before reading connection or environment", async () => {
  const stdout: string[] = [];
  expect(
    await runBackupCommand("backup:create", ["--help"], {
      get databaseUrl(): string {
        throw new Error("read URL");
      },
      get env(): NodeJS.ProcessEnv {
        throw new Error("read env");
      },
      stdout: (line) => stdout.push(line),
      stderr: () => undefined
    })
  ).toBe(0);
  expect(stdout.join("\n")).toContain("--output");
});
it("emits safe fixed errors without argument, URL, key or payload values", async () => {
  const lines: string[] = [];
  const options = {
    databaseUrl: "PASSWORD_SENTINEL",
    env: { ENCRYPTION_KEY: "KEY_SENTINEL" },
    stdout: (line: string) => lines.push(line),
    stderr: (line: string) => lines.push(line)
  };
  expect(await runBackupCommand("backup:create", ["--PAYLOAD_SENTINEL"], options)).toBe(1);
  expect(await runBackupCommand("backup:create", ["--output", "x"], options)).toBe(1);
  expect(lines.join("\n")).toBe(
    "backup_failed invalid_arguments\nbackup_failed connection_unsupported"
  );
});

it("prints a safe manual-inspection instruction after submitted CREATE fails with EPIPE", async () => {
  const dir = await mkdtemp(join(tmpdir(), "backup-epipe-command-"));
  const input = join(dir, "archive");
  const stdout: string[] = [];
  const stderr: string[] = [];
  query.mockReset();
  query.mockRejectedValueOnce(
    Object.assign(new Error("PASSWORD_SOCKET_SENTINEL"), { code: "EPIPE" })
  );
  try {
    await writeFile(input, "PGDMPsynthetic");
    await writeFile(
      join(dir, "pg_restore"),
      `#!${process.execPath}\nconsole.log('pg_restore (PostgreSQL) 18.4')`,
      { mode: 0o700 }
    );
    expect(
      await runBackupCommand("backup:restore", ["--input", input, "--database", "pipe_copy"], {
        databaseUrl: "postgresql://alice:PASSWORD_SENTINEL@localhost/source",
        env: { PATH: dir },
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line)
      })
    ).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "backup_failed create_outcome_unknown",
      "Inspect database pipe_copy manually; creation outcome is unknown. It was not dropped."
    ]);
    expect(query.mock.calls.map((call) => call[0] as unknown)).toEqual([
      'CREATE DATABASE "pipe_copy" TEMPLATE template0'
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("reports a published backup as created and warns when temporary cleanup fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "backup-cleanup-command-"));
  const stdout: string[] = [];
  const stderr: string[] = [];
  try {
    await writeFile(
      join(dir, "pg_dump"),
      `#!${process.execPath}\nif(process.argv.includes('--version')) {console.log('pg_dump (PostgreSQL) 18.4');process.exit(0)}\nprocess.stdout.write('PGDMPsynthetic')`,
      { mode: 0o700 }
    );
    const unlink = vi.spyOn(files, "unlink").mockRejectedValueOnce(new Error("SECRET_UNLINK"));
    expect(
      await runBackupCommand("backup:create", ["--output", join(dir, "backup.dump")], {
        databaseUrl: "postgresql://alice:PASSWORD_SENTINEL@localhost/source",
        env: { PATH: dir },
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line)
      })
    ).toBe(0);
    unlink.mockRestore();
    expect(stdout).toEqual(["backup_created bytes=14"]);
    expect(stderr).toEqual([
      "backup_cleanup_incomplete Remove leftover hidden .tmp files beside the backup and wayscribe-backup-trust-* directories in the system temp directory."
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
