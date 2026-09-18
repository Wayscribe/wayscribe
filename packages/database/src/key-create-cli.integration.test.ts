import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startPostgres, type TestDatabase } from "./testing/postgres.js";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKnexConfig } from "./knex-config.js";

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

const ENCRYPTION_KEY = "key-create-test-encryption-key-4a71c0f8e2";

describe("the key:create command", () => {
  let container: TestDatabase;
  let db: Knex;

  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

  const cli = (args: string[]): Promise<Run> =>
    new Promise((resolve) => {
      execFile(
        tsx,
        ["src/cli.ts", "key:create", ...args],
        {
          cwd: packageRoot,
          env: {
            PATH: process.env["PATH"] ?? "",
            NODE_OPTIONS: "--conditions=development",
            DATABASE_URL: container.getConnectionUri(),
            ENCRYPTION_KEY
          }
        },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
          resolve({ code, stdout, stderr });
        }
      );
    });

  beforeAll(async () => {
    container = await startPostgres();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();
    await db("projects").insert({ name: "Acme Payments", slug: "acme" });
  }, 120_000);

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  it("prints one JSON object on stdout and nothing else with --json", async () => {
    const run = await cli(["acme", "production", "json-worker", "--json"]);

    expect(run.code, run.stderr).toBe(0);
    const lines = run.stdout.split("\n").filter((line) => line !== "");
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    expect(parsed).toEqual({
      apiKey: expect.stringMatching(/^wsk_/) as unknown,
      keyPrefix: expect.any(String) as unknown,
      projectSlug: "acme",
      environmentName: "production"
    });
    expect(String(parsed["apiKey"])).toContain(String(parsed["keyPrefix"]));

    const row: unknown = await db("api_keys").where({ key_prefix: parsed["keyPrefix"] }).first();
    expect(row).toBeDefined();
  });

  it("prints the human form, unchanged, without the flag", async () => {
    const run = await cli(["acme", "staging", "human-worker"]);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("Key issued for acme/staging.");
    expect(run.stdout).toContain("API key (shown once, not recoverable):");
    expect(run.stdout).toContain("  prefix: wsk_");
    // The whole output is prose, not an object a script could parse.
    expect(() => {
      JSON.parse(run.stdout.split("\n")[0] ?? "");
    }).toThrow();
  });

  it("refuses an unknown flag rather than naming a key after it", async () => {
    const run = await cli(["acme", "production", "--jsonl"]);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("--jsonl");
    expect(await db("api_keys").where({ name: "--jsonl" }).first()).toBeUndefined();
  });
});
