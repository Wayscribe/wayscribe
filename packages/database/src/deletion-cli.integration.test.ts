import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createKeyring, searchTokens } from "@flight-recorder/payload-security";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { insertReturningId } from "./insert.js";
import { createKnexConfig } from "./knex-config.js";
import { createDestination } from "./repositories/replay.js";

const KEY = "0123456789abcdef0123456789abcdef";
const keyring = createKeyring(KEY);
const VALUE = "cli-erasure-subject@example.com";

const token = (value: string): string => {
  const [current] = searchTokens(keyring, value);
  if (current === undefined) throw new Error("no token");
  return current;
};

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

describe("deletion CLI", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let projectId: string;
  let productionId: string;

  const packageRoot = fileURLToPath(new URL("../", import.meta.url));
  const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

  const cli = (
    args: string[],
    env: Record<string, string> = { ENCRYPTION_KEY: KEY }
  ): Promise<Run> =>
    new Promise((resolve) => {
      execFile(
        tsx,
        ["src/cli.ts", ...args],
        {
          cwd: packageRoot,
          env: {
            PATH: process.env["PATH"] ?? "",
            // Workspace packages resolve to their TypeScript source, as under
            // the package scripts, so this runs from an unbuilt checkout.
            NODE_OPTIONS: "--conditions=development",
            DATABASE_URL: container.getConnectionUri(),
            ...env
          }
        },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
          resolve({ code, stdout, stderr });
        }
      );
    });

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();
    projectId = await insertReturningId(db, "projects", { name: "Acme", slug: "acme" });
    productionId = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: "production"
    });
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  beforeEach(async () => {
    await db("replay_runs").del();
    await db("replay_destinations").del();
    await db("journeys").del();
    await db("audit_events").del();
  });

  const journey = async (
    id: string,
    options: { hash?: string; lastEventAt?: Date; eventCount?: number } = {}
  ): Promise<void> => {
    const at = options.lastEventAt ?? new Date("2026-09-01T00:00:00Z");
    await db("journeys").insert({
      id,
      project_id: projectId,
      environment_id: productionId,
      entity_type: "customer",
      primary_entity_id_hash: options.hash ?? `hash-${id}`,
      status: "active",
      started_at: at,
      last_event_at: at,
      event_count: options.eventCount ?? 1
    });
  };

  const journeyIds = async (): Promise<string[]> =>
    ((await db("journeys").pluck("id")) as string[]).sort();

  const auditActions = async (): Promise<string[]> =>
    (await db("audit_events").orderBy("created_at").pluck("action")) as string[];

  describe("delete:journey", () => {
    it("deletes the journey and says what went", async () => {
      await journey("jrn_1", { eventCount: 3 });
      await journey("jrn_2");

      const run = await cli(["delete:journey", "acme", "jrn_1"]);
      expect(run.stderr).toBe("");
      expect(run.code).toBe(0);
      expect(run.stdout).toContain("Deleted journey jrn_1 (production, 3 events)");
      expect(await journeyIds()).toEqual(["jrn_2"]);
      expect(await auditActions()).toEqual(["journey.deleted"]);
    }, 60_000);

    it("exits 1 for an unknown project, an unknown journey, and missing arguments", async () => {
      await journey("jrn_1");

      const project = await cli(["delete:journey", "nope", "jrn_1"]);
      expect(project.code).toBe(1);
      expect(project.stderr).toContain('No project with slug "nope". Existing projects: acme');

      const missing = await cli(["delete:journey", "acme", "jrn_missing"]);
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain("No journey jrn_missing in project acme.");

      const usage = await cli(["delete:journey", "acme"]);
      expect(usage.code).toBe(1);
      expect(usage.stderr).toContain("Usage: delete:journey <project-slug> <journey-id>");

      expect(await journeyIds()).toEqual(["jrn_1"]);
      expect(await auditActions()).toEqual([]);
    }, 60_000);
  });

  describe("delete:identifier", () => {
    it("prints a dry-run table, then deletes exactly those journeys without printing the value", async () => {
      await journey("jrn_match", { hash: token(VALUE), eventCount: 4 });
      await journey("jrn_other");

      const dryRun = await cli(["delete:identifier", "acme", VALUE, "--dry-run"]);
      expect(dryRun.stderr).toBe("");
      expect(dryRun.code).toBe(0);
      expect(dryRun.stdout).toMatch(/^ID\s+ENVIRONMENT\s+ENTITY TYPE\s+EVENTS\s+LAST ACTIVITY$/m);
      expect(dryRun.stdout).toMatch(
        /^jrn_match\s+production\s+customer\s+4\s+2026-09-01 00:00:00$/m
      );
      expect(dryRun.stdout).toContain("Nothing was deleted");
      expect(await journeyIds()).toEqual(["jrn_match", "jrn_other"]);
      expect(await auditActions()).toEqual([]);

      const run = await cli(["delete:identifier", "acme", VALUE, "--environment", "production"]);
      expect(run.stderr).toBe("");
      expect(run.code).toBe(0);
      expect(run.stdout).toContain("Deleted 1 journey and 4 events in acme (production)");
      expect(run.stdout).not.toContain(VALUE);
      expect(await journeyIds()).toEqual(["jrn_other"]);
      expect(await auditActions()).toEqual(["erasure.completed"]);
    }, 60_000);

    it("takes a value beginning with a dash after --, including the -- pnpm forwards", async () => {
      await journey("jrn_dash", { hash: token("-A1") });
      await journey("jrn_other");

      const dryRun = await cli(["delete:identifier", "acme", "--dry-run", "--", "-A1"]);
      expect(dryRun.stderr).toBe("");
      expect(dryRun.code).toBe(0);
      expect(dryRun.stdout).toMatch(/^jrn_dash\s+production/m);

      const unmarked = await cli(["delete:identifier", "acme", "-A1"]);
      expect(unmarked.code).toBe(1);
      expect(unmarked.stderr).toContain("delete:identifier acme -- -A1");

      // What `pnpm delete:identifier acme -- -A1` runs: pnpm puts its own --
      // before the arguments, and only that one may be dropped.
      const forwarded = await cli(["delete:identifier", "--", "acme", "--", "-A1"]);
      expect(forwarded.stderr).toBe("");
      expect(forwarded.code).toBe(0);
      expect(forwarded.stdout).toContain("Deleted 1 journey and 1 event");
      expect(await journeyIds()).toEqual(["jrn_other"]);

      await journey("-jrn_dash_id");
      const byId = await cli(["delete:journey", "--", "acme", "--", "-jrn_dash_id"]);
      expect(byId.stderr).toBe("");
      expect(byId.code).toBe(0);
      expect(await journeyIds()).toEqual(["jrn_other"]);
    }, 60_000);

    it("exits 1 for an unknown environment, an empty value, and a missing key", async () => {
      await journey("jrn_match", { hash: token(VALUE) });

      const environment = await cli([
        "delete:identifier",
        "acme",
        VALUE,
        "--environment",
        "staging"
      ]);
      expect(environment.code).toBe(1);
      expect(environment.stderr).toContain('No environment "staging" in project acme.');

      const empty = await cli(["delete:identifier", "acme", "   "]);
      expect(empty.code).toBe(1);
      expect(empty.stderr).toContain("empty");

      const noKey = await cli(["delete:identifier", "acme", VALUE], {});
      expect(noKey.code).toBe(1);
      expect(noKey.stderr).toContain("ENCRYPTION_KEY");

      expect(await journeyIds()).toEqual(["jrn_match"]);
      expect(await auditActions()).toEqual([]);
    }, 60_000);
  });

  describe("delete:range", () => {
    const seed = async (): Promise<void> => {
      await journey("jrn_july", { lastEventAt: new Date("2026-07-15T00:00:00Z") });
      await journey("jrn_august", { lastEventAt: new Date("2026-08-15T00:00:00Z") });
      await journey("jrn_boundary", { lastEventAt: new Date("2026-09-01T00:00:00Z") });
    };

    it("prints a dry-run table, then deletes the half-open window", async () => {
      await seed();
      const args = [
        "delete:range",
        "acme",
        "production",
        "--after",
        "2026-08-01",
        "--before",
        "2026-09-01"
      ];

      const dryRun = await cli([...args, "--dry-run"]);
      expect(dryRun.stderr).toBe("");
      expect(dryRun.code).toBe(0);
      expect(dryRun.stdout).toMatch(/^jrn_august\s+production/m);
      expect(dryRun.stdout).not.toContain("jrn_boundary");
      expect(await journeyIds()).toHaveLength(3);

      const run = await cli(args);
      expect(run.stderr).toBe("");
      expect(run.code).toBe(0);
      expect(run.stdout).toContain("Deleted 1 journey and 1 event in acme (production)");
      expect(await journeyIds()).toEqual(["jrn_boundary", "jrn_july"]);
      expect(await auditActions()).toEqual(["range.deleted"]);
    }, 60_000);

    it("exits 1 for invalid or inverted dates, an unknown environment, and a held lock", async () => {
      await seed();

      const invalid = await cli(["delete:range", "acme", "production", "--before", "yesterday"]);
      expect(invalid.code).toBe(1);
      expect(invalid.stderr).toContain("--before is not an ISO-8601 date or timestamp");

      const inverted = await cli([
        "delete:range",
        "acme",
        "production",
        "--before",
        "2026-08-01",
        "--after",
        "2026-09-01"
      ]);
      expect(inverted.code).toBe(1);
      expect(inverted.stderr).toContain("must be earlier than --before");

      const environment = await cli(["delete:range", "acme", "staging", "--before", "2026-09-01"]);
      expect(environment.code).toBe(1);
      expect(environment.stderr).toContain('No environment "staging" in project acme.');

      const other = knex(createKnexConfig(container.getConnectionUri()));
      try {
        await other.raw("select pg_advisory_lock(4919072026)");
        const held = await cli(["delete:range", "acme", "production", "--before", "2026-09-01"]);
        expect(held.code).toBe(1);
        expect(held.stderr).toContain("holds the retention lock");
      } finally {
        await other.raw("select pg_advisory_unlock(4919072026)");
        await other.destroy();
      }

      expect(await journeyIds()).toHaveLength(3);
      expect(await auditActions()).toEqual([]);
    }, 60_000);
  });

  describe("delete:destination", () => {
    it("deletes the destination and exits 1 for one that does not exist", async () => {
      const destination = await createDestination(db, keyring, {
        projectId,
        name: "local sandbox",
        baseUrl: "http://localhost:3300",
        environmentType: "development"
      });

      const run = await cli(["delete:destination", "acme", destination.id]);
      expect(run.stderr).toBe("");
      expect(run.code).toBe(0);
      expect(run.stdout).toContain('Deleted replay destination "local sandbox" and 0 replay runs.');
      expect(await auditActions()).toEqual(["replay_destination.deleted"]);

      const again = await cli(["delete:destination", "acme", destination.id]);
      expect(again.code).toBe(1);
      expect(again.stderr).toContain(`No replay destination ${destination.id} in project acme.`);
    }, 60_000);
  });
});
