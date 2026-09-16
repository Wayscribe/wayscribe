import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createKnexConfig, insertReturningId } from "@flight-recorder/database";
import { createKeyring, issueApiKey } from "@flight-recorder/payload-security";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");

/** The value the forced violation's failing row holds. */
const ROW_VALUE = "row-value-" + "that-must-not-be-logged";

/**
 * A database error's `detail` prints the failing row. A constraint violation
 * during ingestion is logged with the error, so without redaction the value
 * the row held reached the log: the previous build masking an alias under
 * migration 018's check logged the value it was masking.
 */
describe("a storage error in the log", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let apiKey: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();
    const projectId = await insertReturningId(db, "projects", { name: "P", slug: "p" });
    const environmentId = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: "development"
    });
    const generated = issueApiKey(keyring);
    apiKey = generated.apiKey;
    await db("api_keys").insert({
      project_id: projectId,
      environment_id: environmentId,
      name: "development",
      key_prefix: generated.keyPrefix,
      key_hash: generated.verifier,
      key_hash_key_id: generated.keyHashKeyId
    });
    // A rule the row ingestion writes breaks, so the failure is PostgreSQL's
    // own constraint violation with the row in its detail.
    await db.raw(
      `alter table entity_aliases add constraint test_refuse_value
         check (display_value is distinct from '${ROW_VALUE}')`
    );
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  it.each([
    ["/v1/events", "request failed", "internal_error"],
    ["/v1/events/batch", "event rejected by storage", "storage_error"]
  ])("names the constraint and does not log the row's values (%s)", async (url, message, code) => {
    const lines: string[] = [];
    const app = buildApp({
      db,
      keyring,
      adminToken: "admin-token-for-tests-0000000000",
      logLevel: "info",
      logStream: { write: (line: string) => lines.push(line) }
    });
    const event = {
      id: `evt_forced_${String(url.length)}`,
      journeyId: "jrn_forced",
      environment: "development",
      service: "svc",
      entity: { type: "customer", id: "C-1" },
      operation: "received",
      name: "receive",
      timestamp: new Date().toISOString(),
      aliases: { company: ROW_VALUE },
      displayableAliases: ["company"]
    };
    try {
      const response = await app.inject({
        method: "POST",
        url,
        headers: { authorization: `Bearer ${apiKey}` },
        payload: url.endsWith("batch")
          ? { events: [{ protocolVersion: "0.1", event }] }
          : { protocolVersion: "0.1", event }
      });
      expect(response.body).toContain(code);

      const logged = lines
        .map((line) => JSON.parse(line) as { msg?: string; err?: Record<string, unknown> })
        .find((line) => line.msg === message);
      expect(logged?.err).toMatchObject({
        code: "23514",
        constraint: "test_refuse_value",
        table: "entity_aliases",
        detail: "[REDACTED]"
      });
      expect(lines.join("\n")).not.toContain(ROW_VALUE);
    } finally {
      await app.close();
    }
  });
});
