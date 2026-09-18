import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cliHelp, commandHelp } from "./cli-commands.js";

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The CLI's entry point as a process, with no DATABASE_URL: help, an unknown
 * command and a refused flag are all answered before a database is needed.
 */
describe("the database CLI without a database", () => {
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

  const cli = (args: string[]): Promise<Run> =>
    new Promise((resolve) => {
      execFile(
        tsx,
        ["src/cli.ts", ...args],
        {
          cwd: packageRoot,
          env: { PATH: process.env["PATH"] ?? "", NODE_OPTIONS: "--conditions=development" }
        },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
          resolve({ code, stdout, stderr });
        }
      );
    });

  const lines = (text: string): string[] => text.replace(/\n$/, "").split("\n");

  it("prints the top-level help on stdout for --help, and exits 0", async () => {
    const run = await cli(["--help"]);

    expect(run.code, run.stderr).toBe(0);
    expect(lines(run.stdout)).toEqual(cliHelp());
    expect(run.stderr).toBe("");
  });

  it("prints a command's help, including after the -- pnpm forwards", async () => {
    for (const args of [
      ["key:create", "--help"],
      ["key:create", "--", "--help"]
    ]) {
      const run = await cli(args);
      expect(run.code, `${args.join(" ")}\n${run.stderr}`).toBe(0);
      expect(lines(run.stdout)).toEqual(commandHelp("key:create"));
    }
  });

  it("names an unknown command, prints the help to stderr, and exits 1", async () => {
    const run = await cli(["--jsn"]);

    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(lines(run.stderr)).toEqual(["Unknown command: --jsn", ...cliHelp()]);
  });

  it("refuses a flag on a command that takes none before asking for DATABASE_URL", async () => {
    const run = await cli(["migrate", "--dry-run"]);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("Unknown argument: --dry-run");
    expect(run.stderr).toContain("Usage: migrate");
    expect(run.stderr).not.toContain("DATABASE_URL");
  });

  it("still asks for DATABASE_URL when a command is to run", async () => {
    const run = await cli(["migrate"]);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("DATABASE_URL is not set.");
  });
});
