import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { createKeyring, encryptValue, searchTokens } from "@flight-recorder/payload-security";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertReturningId } from "./insert.js";
import { createKnexConfig } from "./knex-config.js";
import { issueKey, revokeKey } from "./repositories/key-admin.js";

// Distinctive, so an assertion that output does not contain them cannot pass
// by accident and cannot fail on an ordinary word.
const DB_PASSWORD = "doctor-db-password-5e81c3a9f2";
const WRONG_DB_PASSWORD = "doctor-wrong-password-a7d20e64";
const ENCRYPTION_KEY = "doctor-encryption-key-3b9f7c21e4d8a605";
const OTHER_KEY = "doctor-other-encryption-key-81c4e2f7a9";
const ADMIN_TOKEN = "doctor-admin-token-c52e9a17b3f84d60";
const PUBLISHED_KEY = "replace-for-local-development-0000";
const UNGRANTED_PASSWORD = "doctor-ungranted-pw-6f0a2b";

const keyring = createKeyring(ENCRYPTION_KEY);
const otherKeyring = createKeyring(OTHER_KEY);

interface Run {
  code: number;
  output: string;
}

describe("doctor", () => {
  let container: StartedPostgreSqlContainer;
  let readyServer: Server;
  let readyStatus = 200;
  let readyBody: unknown = { status: "ready" };
  /** The path and query of every request the /ready stub received. */
  const readyRequests: string[] = [];
  let apiUrl = "";

  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

  /** The URL of one database in the container, optionally with another password. */
  const urlFor = (database: string, password = DB_PASSWORD): string => {
    const url = new URL(container.getConnectionUri());
    url.pathname = `/${database}`;
    url.password = password;
    return url.toString();
  };

  const doctor = (
    args: string[],
    env: Record<string, string>,
    database = "installed"
  ): Promise<Run> =>
    new Promise((resolve) => {
      execFile(
        tsx,
        ["src/cli.ts", "doctor", ...args],
        {
          cwd: packageRoot,
          env: {
            PATH: process.env["PATH"] ?? "",
            NODE_OPTIONS: "--conditions=development",
            DATABASE_URL: urlFor(database),
            ENCRYPTION_KEY,
            ADMIN_TOKEN,
            ...env
          }
        },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
          resolve({ code, output: `${stdout}${stderr}` });
        }
      );
    });

  /** The status column for one check, from the printed output. */
  const statusOf = (run: Run, check: string): string | undefined =>
    run.output
      .split("\n")
      .find((line) => line.slice(6).startsWith(check))
      ?.slice(0, 4);

  const lineOf = (run: Run, check: string): string =>
    run.output.split("\n").find((line) => line.slice(6).startsWith(check)) ?? "";

  const expectNoSecrets = (run: Run, apiKey?: string): void => {
    for (const secret of [DB_PASSWORD, WRONG_DB_PASSWORD, ENCRYPTION_KEY, OTHER_KEY, ADMIN_TOKEN]) {
      expect(run.output).not.toContain(secret);
    }
    if (apiKey !== undefined) expect(run.output).not.toContain(apiKey);
  };

  const withDatabase = async (name: string, work: (db: Knex) => Promise<void>): Promise<void> => {
    const admin = knex(createKnexConfig(container.getConnectionUri()));
    await admin.raw(`create database ${name}`);
    await admin.destroy();
    const db = knex(createKnexConfig(urlFor(name)));
    try {
      await work(db);
    } finally {
      await db.destroy();
    }
  };

  let apiKey = "";
  let revokedKey = "";

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine")
      .withPassword(DB_PASSWORD)
      .start();

    readyServer = createServer((request, response) => {
      readyRequests.push(request.url ?? "");
      response.writeHead(readyStatus, { "content-type": "application/json" });
      response.end(JSON.stringify(readyBody));
    });
    await new Promise<void>((resolve) => readyServer.listen(0, "127.0.0.1", resolve));
    apiUrl = `http://127.0.0.1:${String((readyServer.address() as AddressInfo).port)}`;

    // A complete installation: migrated, a project, a key, and a revoked key.
    await withDatabase("installed", async (db) => {
      await db.migrate.latest();
      await db("projects").insert({ name: "Acme", slug: "acme" });
      apiKey = (
        await issueKey(db, keyring, {
          projectSlug: "acme",
          environmentName: "production",
          name: "w"
        })
      ).apiKey;
      const revoked = await issueKey(db, keyring, {
        projectSlug: "acme",
        environmentName: "production",
        name: "old"
      });
      revokedKey = revoked.apiKey;
      await revokeKey(db, revoked.keyPrefix);
    });

    await withDatabase("unmigrated", async () => {
      // Nothing: every migration is pending.
    });

    await withDatabase("empty", async (db) => {
      await db.migrate.latest();
    });

    // A journey written under a key this installation no longer has.
    await withDatabase("unreadable", async (db) => {
      await db.migrate.latest();
      const projectId = await insertReturningId(db, "projects", { name: "P", slug: "p" });
      const environmentId = await insertReturningId(db, "environments", {
        project_id: projectId,
        name: "production"
      });
      await db("journeys").insert({
        id: "jrn_lost",
        project_id: projectId,
        environment_id: environmentId,
        entity_type: "customer",
        primary_entity_id_hash: searchTokens(otherKeyring, "CUST-1")[0],
        encrypted_primary_entity_id: encryptValue(otherKeyring, "CUST-1"),
        status: "active",
        started_at: db.fn.now(),
        last_event_at: db.fn.now(),
        event_count: 1
      });
    });
  });

  /**
   * A journey created by production with events written into it by a
   * development key, as ingestion allowed before ADR-048. Readable under the
   * installation's key, so only the new check can fail.
   */
  const crossedEnvironments = async (db: Knex): Promise<void> => {
    await db.migrate.latest();
    const projectId = await insertReturningId(db, "projects", { name: "X", slug: "x" });
    const environmentIds: Record<string, string> = {};
    for (const name of ["production", "development"]) {
      environmentIds[name] = await insertReturningId(db, "environments", {
        project_id: projectId,
        name
      });
    }
    await issueKey(db, keyring, { projectSlug: "x", environmentName: "production", name: "k" });
    for (const journeyId of ["jrn_crossed_1", "jrn_crossed_2", "jrn_clean"]) {
      await db("journeys").insert({
        id: journeyId,
        project_id: projectId,
        environment_id: environmentIds["production"],
        entity_type: "order",
        primary_entity_id_hash: searchTokens(keyring, journeyId)[0],
        encrypted_primary_entity_id: encryptValue(keyring, journeyId),
        status: "active",
        started_at: db.fn.now(),
        last_event_at: db.fn.now(),
        event_count: 1
      });
    }
    const eventRow = (id: string, journeyId: string, environment: string) => ({
      id,
      project_id: projectId,
      environment_id: environmentIds[environment],
      journey_id: journeyId,
      protocol_version: "0.1",
      content_hash: id,
      operation: "received",
      name: "step",
      service: "svc",
      event_timestamp: db.fn.now()
    });
    await db("journey_events").insert([
      eventRow("evt_owner_1", "jrn_crossed_1", "production"),
      eventRow("evt_intruder_1", "jrn_crossed_1", "development"),
      eventRow("evt_intruder_2", "jrn_crossed_1", "development"),
      eventRow("evt_intruder_3", "jrn_crossed_2", "development"),
      eventRow("evt_clean", "jrn_clean", "production")
    ]);
  };

  afterAll(async () => {
    await new Promise((resolve) => readyServer.close(resolve));
    await container.stop();
  });

  it("passes a complete installation, and prints only the key's prefix", async () => {
    readyStatus = 200;
    readyBody = { status: "ready" };
    const run = await doctor(["--api-url", apiUrl, "--api-key", apiKey], {});

    expect(run.code, run.output).toBe(0);
    for (const check of [
      "Database reachable",
      "PostgreSQL version",
      "Migrations",
      "ENCRYPTION_KEY",
      "ADMIN_TOKEN",
      "Keys readable",
      "Projects and keys",
      "Journey environments",
      "API key",
      "API reachable",
      "Statement timeout"
    ]) {
      expect(statusOf(run, check), `${check}\n${run.output}`).toBe("PASS");
    }
    expect(lineOf(run, "API key")).toContain(apiKey.slice(0, 12));
    expect(lineOf(run, "API key")).toContain("acme/production");
    expect(run.output).toContain("0 failed, 0 warnings, 11 passed.");
    expectNoSecrets(run, apiKey);
  });

  it("fails on the published default secrets, without printing them", async () => {
    const run = await doctor([], {
      ENCRYPTION_KEY: PUBLISHED_KEY,
      ADMIN_TOKEN: "local-admin-token-000000000000000"
    });

    expect(run.code).toBe(1);
    expect(statusOf(run, "ENCRYPTION_KEY")).toBe("FAIL");
    expect(statusOf(run, "ADMIN_TOKEN")).toBe("FAIL");
    expect(run.output).toContain("openssl rand -hex 32");
    expect(run.output).not.toContain(PUBLISHED_KEY);
    expect(run.output).not.toContain("local-admin-token-000000000000000");
  });

  it("fails on pending migrations and skips what depends on the schema", async () => {
    const run = await doctor(["--api-key", apiKey], {}, "unmigrated");

    expect(run.code).toBe(1);
    expect(statusOf(run, "Migrations")).toBe("FAIL");
    expect(lineOf(run, "Migrations")).toMatch(/\d+ migrations are pending/);
    expect(statusOf(run, "Keys readable")).toBe("SKIP");
    expect(statusOf(run, "Projects and keys")).toBe("SKIP");
    expect(statusOf(run, "API key")).toBe("SKIP");
    expectNoSecrets(run, apiKey);
  });

  it("changes nothing: it does not create knex's migrations table on a fresh database", async () => {
    await withDatabase("pristine", async () => {
      // Nothing: a database nobody has migrated.
    });

    const run = await doctor([], {}, "pristine");

    expect(statusOf(run, "Migrations")).toBe("FAIL");
    expect(lineOf(run, "Migrations")).toMatch(/\d+ migrations are pending/);
    const check = knex(createKnexConfig(urlFor("pristine")));
    try {
      const tables: unknown = await check.raw(
        "select to_regclass('knex_migrations') as migrations, to_regclass('knex_migrations_lock') as lock"
      );
      expect((tables as { rows: unknown[] }).rows).toEqual([{ migrations: null, lock: null }]);
    } finally {
      await check.destroy();
    }
  });

  it("reports a check it could not run as FAIL, with its SQLSTATE, and still exits", async () => {
    // A role that can connect and read nothing, as when DATABASE_URL names a
    // role the operator never granted anything to.
    const admin = knex(createKnexConfig(urlFor("installed")));
    try {
      await admin.raw(`create role doctor_ungranted login password '${UNGRANTED_PASSWORD}'`);
    } finally {
      await admin.destroy();
    }
    const url = new URL(urlFor("installed"));
    url.username = "doctor_ungranted";
    url.password = UNGRANTED_PASSWORD;

    const run = await doctor(["--api-key", apiKey], { DATABASE_URL: url.toString() });

    expect(run.code).toBe(1);
    expect(statusOf(run, "Database reachable")).toBe("PASS");
    expect(statusOf(run, "Migrations")).toBe("FAIL");
    expect(lineOf(run, "Migrations")).toContain("42501");
    expect(run.output).toContain("GRANT");
    expect(statusOf(run, "Projects and keys")).toBe("SKIP");
    // Every check still printed, then the summary: no stack trace instead.
    expect(statusOf(run, "Statement timeout")).toBe("PASS");
    expect(run.output).toMatch(/\d+ failed, \d+ warnings?, \d+ passed/);
    expect(run.output).not.toMatch(/^\s+at /m);
    expectNoSecrets(run, apiKey);
    expect(run.output).not.toContain(UNGRANTED_PASSWORD);
  });

  it("fails when stored data is under a key the installation does not have", async () => {
    const run = await doctor([], {}, "unreadable");

    expect(run.code).toBe(1);
    expect(statusOf(run, "Keys readable")).toBe("FAIL");
    expect(lineOf(run, "Keys readable")).toContain("journeys 1");
    expect(run.output).toContain("ENCRYPTION_KEY_PREVIOUS");
    expectNoSecrets(run);
  });

  it("fails when events were written into a journey of another environment", async () => {
    // Ingestion refuses this now (ADR-048); an installation that ran an
    // earlier build may already hold such rows, and nothing else would say so.
    await withDatabase("crossed", crossedEnvironments);

    const run = await doctor([], {}, "crossed");

    expect(run.code, run.output).toBe(1);
    expect(statusOf(run, "Journey environments"), run.output).toBe("FAIL");
    expect(lineOf(run, "Journey environments")).toContain("3 events in 2 journeys");
    expect(run.output).toContain("delete:journey");
    // Counts only: a journey id can carry a business identifier.
    expect(run.output).not.toContain("jrn_crossed");
    expectNoSecrets(run);
  });

  it("warns during a rotation, and passes nonetheless", async () => {
    const run = await doctor([], {
      ENCRYPTION_KEY: OTHER_KEY,
      ENCRYPTION_KEY_PREVIOUS: ENCRYPTION_KEY
    });

    expect(statusOf(run, "Keys readable"), run.output).toBe("WARN");
    expect(run.output).toContain("rotate:reencrypt");
    expect(run.code).toBe(0);
    expectNoSecrets(run);
  });

  it("warns when there is no project, and exits 0", async () => {
    const run = await doctor([], {}, "empty");

    expect(statusOf(run, "Projects and keys")).toBe("WARN");
    expect(run.output).toContain("project:create");
    expect(run.code).toBe(0);
  });

  it("fails a revoked key", async () => {
    const run = await doctor(["--api-key", revokedKey], {});

    expect(run.code).toBe(1);
    expect(statusOf(run, "API key")).toBe("FAIL");
    expect(lineOf(run, "API key")).toContain("was revoked");
    expectNoSecrets(run, revokedKey);
  });

  it("fails a key whose prefix exists but whose rest is wrong", async () => {
    const wrong = `${apiKey.slice(0, 12)}${"x".repeat(apiKey.length - 12)}`;
    const run = await doctor(["--api-key", wrong], {});

    expect(run.code).toBe(1);
    expect(lineOf(run, "API key")).toContain("does not authenticate");
    expectNoSecrets(run, wrong);
  });

  it("fails a valid key presented to an installation with another ENCRYPTION_KEY", async () => {
    const run = await doctor(["--api-key", apiKey], { ENCRYPTION_KEY: OTHER_KEY });

    expect(run.code).toBe(1);
    expect(lineOf(run, "API key")).toContain("does not authenticate");
    expectNoSecrets(run, apiKey);
  });

  it("fails a key this database never issued", async () => {
    const run = await doctor(["--api-key", "fr_neverissued0000000000000000000000"], {});

    expect(run.code).toBe(1);
    expect(lineOf(run, "API key")).toContain("No key with prefix fr_neverissu");
    expect(run.output).not.toContain("fr_neverissued0000000000000000000000");
  });

  it("fails when the API is not ready, with its reason", async () => {
    readyStatus = 503;
    readyBody = { status: "not_ready", reason: "migrations_pending", pendingCount: 1 };
    const run = await doctor(["--api-url", apiUrl], {});

    expect(run.code).toBe(1);
    expect(lineOf(run, "API reachable")).toContain("answered 503 migrations_pending");
    expect(run.output).toContain("Run migrate");
  });

  it("fails when nothing answers at the API URL", async () => {
    // A port that was free a moment ago. Not port 1: fetch refuses it as a
    // "bad port" before connecting, which is not the failure under test.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));

    const run = await doctor(["--api-url", `http://127.0.0.1:${String(port)}`], {});

    expect(run.code).toBe(1);
    expect(lineOf(run, "API reachable")).toContain("ECONNREFUSED");
  });

  it("warns when the statement timeout is disabled", async () => {
    const run = await doctor([], { DATABASE_STATEMENT_TIMEOUT_MS: "0" });

    expect(statusOf(run, "Statement timeout")).toBe("WARN");
    expect(run.code).toBe(0);
  });

  it("fails when PostgreSQL refuses the password, without printing either password", async () => {
    const run = await doctor([], { DATABASE_URL: urlFor("installed", WRONG_DB_PASSWORD) });

    expect(run.code).toBe(1);
    expect(statusOf(run, "Database reachable")).toBe("FAIL");
    expect(lineOf(run, "Database reachable")).toContain("refused the password");
    expect(statusOf(run, "Migrations")).toBe("SKIP");
    expectNoSecrets(run);
  });

  it("fails when nothing listens at the database's address", async () => {
    const run = await doctor([], {
      DATABASE_URL: `postgresql://test:${DB_PASSWORD}@127.0.0.1:1/installed`
    });

    expect(run.code).toBe(1);
    expect(lineOf(run, "Database reachable")).toContain("ECONNREFUSED");
    // knex's own logger stays quiet: doctor's line is the only account of it.
    expect(run.output).not.toContain("Acquire connection error");
    expect(run.output).not.toMatch(/^\s+at /m);
    expectNoSecrets(run);
  });

  it("asks for /ready at the API URL's path, without the URL's query string", async () => {
    readyStatus = 200;
    readyBody = { status: "ready" };
    readyRequests.length = 0;

    const run = await doctor(["--api-url", `${apiUrl}/?token=doctor-query-secret`], {});

    expect(statusOf(run, "API reachable")).toBe("PASS");
    expect(readyRequests).toEqual(["/ready"]);
    expect(run.output).not.toContain("doctor-query-secret");
  });

  it("refuses an unknown argument without echoing it", async () => {
    const run = await doctor([apiKey], {});

    expect(run.code).toBe(1);
    expect(run.output).toContain("Usage: doctor");
    expect(run.output).not.toContain(apiKey);
  });
});
