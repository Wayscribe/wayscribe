import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createKeyring, searchTokens } from "@wayscribe/payload-security";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { cliHelp, commandHelp, COMMANDS, type CommandName } from "./cli-commands.js";
import { insertReturningId } from "./insert.js";
import { createKnexConfig } from "./knex-config.js";
import { issueKey } from "./repositories/key-admin.js";
import { createDestination } from "./repositories/replay.js";

const lines = (text: string): string[] => text.replace(/\n$/, "").split("\n");

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

const HELP_KEY = "cli-help-test-encryption-key-7d3f19a0c2";
const helpKeyring = createKeyring(HELP_KEY);

const tokenFor = (value: string): string => {
  const [current] = searchTokens(helpKeyring, value);
  if (current === undefined) throw new Error("no token");
  return current;
};

/**
 * Every command against a real database, asked for help in the ways pnpm and
 * an operator can combine: nothing may run. Each would change something with
 * the arguments in RUNNABLE, and the controls at the end show that it does,
 * so an unchanged database means the command did not run.
 */
describe("--help against a real database", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let revocablePrefix = "";
  let destinationId = "";

  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

  const cli = (args: string[]): Promise<Run> =>
    new Promise((resolve) => {
      execFile(
        tsx,
        ["src/cli.ts", ...args],
        {
          cwd: packageRoot,
          env: {
            PATH: process.env["PATH"] ?? "",
            NODE_OPTIONS: "--conditions=development",
            DATABASE_URL: container.getConnectionUri(),
            ENCRYPTION_KEY: HELP_KEY,
            DEMO_API_KEY: "wsk_demo0000000000000000000000000000"
          }
        },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
          resolve({ code, stdout, stderr });
        }
      );
    });

  /** Everything a command in the registry can change. */
  const fingerprint = async (): Promise<string> =>
    JSON.stringify({
      projects: await db("projects").orderBy("slug").pluck("slug"),
      environments: await db("environments").orderBy("name").pluck("name"),
      keys: await db("api_keys").orderBy("key_prefix").select("key_prefix", "revoked_at"),
      journeys: await db("journeys").orderBy("id").pluck("id"),
      destinations: await db("replay_destinations").orderBy("id").pluck("id"),
      audit: await db("audit_events").orderBy("created_at").pluck("action"),
      migrations: await db("knex_migrations").orderBy("id").pluck("name"),
      lock: await db("knex_migrations_lock").pluck("is_locked"),
      values: await db("journeys").orderBy("id").pluck("primary_entity_id_hash")
    });

  /** Arguments with which each command would run and change or report something. */
  const runnable = (): Record<CommandName, string[]> => ({
    migrate: [],
    "migrate:unlock": [],
    rollback: [],
    reset: ["--yes"],
    seed: [],
    "seed-demo": [],
    "project:create": ["beta", "Beta"],
    "project:list": [],
    "key:create": ["acme", "staging", "worker"],
    "key:revoke": [revocablePrefix],
    "key:list": [],
    "retention:sweep": [],
    "rotate:reencrypt": [],
    "rotate:status": [],
    "delete:journey": ["acme", "jrn_single"],
    "delete:identifier": ["acme", "customer-42"],
    "delete:range": ["acme", "production", "--before", "2030-01-01"],
    "delete:destination": ["acme", destinationId],
    doctor: []
  });

  beforeAll(async () => {
    container = await new PostgreSqlContainer(inject("postgresImage")).start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();
    const projectId = await insertReturningId(db, "projects", { name: "Acme", slug: "acme" });
    // One day, so the retention sweep has an expired journey to delete.
    const environmentId = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: "production",
      retention_days: 1
    });
    const journey = async (id: string, value: string, at: string): Promise<void> => {
      await db("journeys").insert({
        id,
        project_id: projectId,
        environment_id: environmentId,
        entity_type: "customer",
        primary_entity_id_hash: tokenFor(value),
        status: "active",
        started_at: new Date(at),
        last_event_at: new Date(at),
        event_count: 1
      });
    };
    await journey("jrn_expired", "expired-customer", "2020-01-01T00:00:00Z");
    await journey("jrn_recent", "customer-42", new Date().toISOString());
    await journey("jrn_single", "customer-43", new Date().toISOString());
    // The identifiers a help flag would erase if it were read as a value.
    await journey("jrn_help", "--help", new Date().toISOString());
    await journey("jrn_h", "-h", new Date().toISOString());
    revocablePrefix = (
      await issueKey(db, helpKeyring, {
        projectSlug: "acme",
        environmentName: "production",
        name: "revocable"
      })
    ).keyPrefix;
    destinationId = (
      await createDestination(db, helpKeyring, {
        projectId,
        name: "sandbox",
        baseUrl: "http://localhost:3300",
        environmentType: "development"
      })
    ).id;
    // Set, so migrate:unlock has something to release.
    await db("knex_migrations_lock").update({ is_locked: 1 });
  }, 120_000);

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  it.each(COMMANDS.map((command) => command.name))(
    "prints %s's help and changes nothing, however --help arrives",
    async (name) => {
      const before = await fingerprint();
      const args = runnable()[name];
      for (const form of [
        [name, "--", "--", "--help"],
        [name, "--", ...args, "--help"],
        [name, "--", "--", ...args, "-h"]
      ]) {
        const run = await cli(form);
        expect(run.code, `${form.join(" ")}\n${run.stderr}`).toBe(0);
        expect(lines(run.stdout), form.join(" ")).toEqual(commandHelp(name));
        expect(await fingerprint(), form.join(" ")).toBe(before);
      }
    },
    120_000
  );

  it("refuses --help and -h after delete:identifier's separator, and erases neither", async () => {
    const before = await fingerprint();
    for (const form of [
      ["delete:identifier", "acme", "--", "--help"],
      ["delete:identifier", "--", "acme", "--", "-h"]
    ]) {
      const run = await cli(form);
      expect(run.code, form.join(" ")).toBe(1);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("after -- is refused");
    }
    expect(await fingerprint()).toBe(before);
    expect(await db("journeys").whereIn("id", ["jrn_help", "jrn_h"]).pluck("id")).toHaveLength(2);
  });

  // The controls: the same arguments without --help do run, so the help
  // tests above would have seen a change had any of them run.
  it.each([
    "delete:identifier",
    "delete:journey",
    "delete:destination",
    "retention:sweep",
    "key:revoke",
    "key:create",
    "project:create",
    "migrate:unlock"
  ] as const)("changes the database when %s runs without --help", async (name) => {
    const before = await fingerprint();
    const run = await cli([name, "--", ...runnable()[name]]);
    expect(run.code, run.stderr).toBe(0);
    expect(await fingerprint()).not.toBe(before);
  });
});
