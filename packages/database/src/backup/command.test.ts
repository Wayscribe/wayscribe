import { expect, it } from "vitest";
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
