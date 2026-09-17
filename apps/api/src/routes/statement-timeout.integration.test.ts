import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createKnexConfig, insertReturningId } from "@flight-recorder/database";
import { createKeyring, issueApiKey } from "@flight-recorder/payload-security";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { buildApp } from "../app.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");
const ENTITY_ID = "TIMEOUT-ENTITY-7731";
const SEARCH_VALUE = "TIMEOUT-SEARCH-VALUE-4402";

interface LogLine {
  level: number;
  msg: string;
  [field: string]: unknown;
}

const WARN = 40;

describe("DATABASE_STATEMENT_TIMEOUT_MS through a route", () => {
  let container: StartedPostgreSqlContainer;
  /** Migrations and fixtures, with no timeout. */
  let db: Knex;
  let apiKey: string;
  const opened: { app: FastifyInstance; pool: Knex }[] = [];

  beforeAll(async () => {
    container = await new PostgreSqlContainer(inject("postgresImage")).start();
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
      name: "k",
      key_prefix: generated.keyPrefix,
      key_hash: generated.verifier,
      key_hash_key_id: generated.keyHashKeyId
    });

    // The container's user is a superuser, and a superuser bypasses row-level
    // security, so the API connects as an ordinary role, as it would in
    // production (docs/OPERATIONS.md §1).
    await db.raw("create role flight_app login password 'flight_app'");
    await db.raw(
      "grant select, insert, update, delete on all tables in schema public to flight_app"
    );

    const { app } = boot(0);
    const stored = await ingest(app, "evt_before");
    expect(stored.statusCode).toBe(202);
  });

  afterEach(async () => {
    await db.raw("drop policy if exists slow_reads on journeys");
    await db.raw("alter table journeys disable row level security");
    await Promise.all(
      opened.splice(0).map(async ({ app, pool }) => {
        await app.close();
        await pool.destroy();
      })
    );
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  /** An API whose pool applies `timeoutMs`, as server.ts builds it, with its log captured. */
  function boot(timeoutMs: number): { app: FastifyInstance; lines: string[] } {
    const url = new URL(container.getConnectionUri());
    url.username = "flight_app";
    url.password = "flight_app";
    const pool = knex(createKnexConfig(url.toString(), { statementTimeoutMs: timeoutMs }));
    const lines: string[] = [];
    const app = buildApp({
      db: pool,
      keyring,
      adminToken: "admin-token-for-tests-0000000000",
      logLevel: "info",
      logStream: { write: (line: string) => lines.push(line) }
    });
    opened.push({ app, pool });
    return { app, lines };
  }

  /**
   * Make every statement that touches `journeys` run pg_sleep first.
   *
   * A row-level security policy is evaluated inside the statement the route
   * sends, so the query that times out is the route's own query, unchanged,
   * with no test-only path through the application.
   */
  async function slowJourneys(seconds: number): Promise<void> {
    await db.raw("alter table journeys enable row level security");
    await db.raw(
      `create policy slow_reads on journeys
         using ((select true from pg_sleep(${String(seconds)})))
         with check ((select true from pg_sleep(${String(seconds)})))`
    );
  }

  const ingest = (app: FastifyInstance, id: string, url = "/v1/events") =>
    app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${apiKey}` },
      payload: (url.endsWith("batch")
        ? { events: [envelope(id)] }
        : envelope(id)) as unknown as object
    });

  function envelope(id: string): { protocolVersion: string; event: Record<string, unknown> } {
    return {
      protocolVersion: "0.1",
      event: {
        id,
        journeyId: `jrn_${id}`,
        environment: "development",
        service: "svc",
        entity: { type: "customer", id: ENTITY_ID },
        aliases: { lookup: SEARCH_VALUE },
        operation: "received",
        name: "receive",
        timestamp: "2026-09-15T10:00:00.000Z"
      }
    };
  }

  const search = (app: FastifyInstance) =>
    app.inject({
      method: "GET",
      url: `/v1/search?q=${SEARCH_VALUE}`,
      headers: { authorization: `Bearer ${apiKey}` }
    });

  it("answers 503 query_timeout when the search runs past the timeout", async () => {
    const { app, lines } = boot(100);
    await slowJourneys(1);

    const response = await search(app);

    expect(response.statusCode).toBe(503);
    const body = response.json<{ error: { code: string; message: string; requestId: string } }>();
    expect(body.error.code).toBe("query_timeout");
    expect(body.error.requestId).toBe(response.headers["request-id"] ?? body.error.requestId);
    expect(body.error.requestId).toBeTypeOf("string");
    for (const leak of [SEARCH_VALUE, ENTITY_ID, "select", "journeys", "57014", "$1"]) {
      expect(response.body.toLowerCase()).not.toContain(leak.toLowerCase());
    }

    const warnings = lines
      .map((line) => JSON.parse(line) as LogLine)
      .filter((l) => l.level === WARN);
    const timeoutLine = warnings.find((line) => line.msg.includes("DATABASE_STATEMENT_TIMEOUT_MS"));
    expect(timeoutLine).toMatchObject({ route: "/v1/search", requestId: body.error.requestId });
    const logged = JSON.stringify(timeoutLine);
    for (const leak of [SEARCH_VALUE, ENTITY_ID, "select", "from", "pg_sleep", "$1"]) {
      expect(logged.toLowerCase()).not.toContain(leak.toLowerCase());
    }
    // Nothing else in the log carries the SQL either: the driver's error, which
    // does, is never logged for a timeout.
    for (const line of lines) {
      expect(line.toLowerCase()).not.toContain("pg_sleep");
      expect(line).not.toMatch(/\bselect\b/i);
    }

    const metrics = await app.metrics.render();
    expect(metrics).toContain('flight_recorder_query_timeouts_total{route="/v1/search"} 1');
    expect(metrics).toContain(
      'flight_recorder_http_requests_total{method="GET",route="/v1/search",status="503"} 1'
    );
  });

  it("answers the same search normally when the timeout is 0", async () => {
    const { app } = boot(0);
    await slowJourneys(0.3);

    const response = await search(app);

    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: { items: unknown[] } }>().data.items).toHaveLength(1);
  });

  it("refuses one event in a batch as a 503 query_timeout, not a storage error", async () => {
    const { app, lines } = boot(100);
    await slowJourneys(1);

    const response = await ingest(app, "evt_slow_batch", "/v1/events/batch");

    expect(response.statusCode).toBe(202);
    const [result] = response.json<{
      data: { results: { status: string; error?: { code: string; httpStatus: number } }[] };
    }>().data.results;
    expect(result).toMatchObject({
      status: "rejected",
      error: { code: "query_timeout", httpStatus: 503 }
    });
    for (const line of lines) expect(line.toLowerCase()).not.toContain("pg_sleep");

    const metrics = await app.metrics.render();
    expect(metrics).toContain('flight_recorder_query_timeouts_total{route="/v1/events/batch"} 1');
    expect(metrics).toContain('flight_recorder_events_total{result="rejected"} 1');
  });

  it("applies the timeout to each connection the pool opens", async () => {
    const pool = knex(createKnexConfig(container.getConnectionUri(), { statementTimeoutMs: 1234 }));
    try {
      // More than one connection, so the setting is not a property of the first.
      const settings = await Promise.all(
        [1, 2, 3].map(async () => {
          const result: unknown = await pool.raw(
            "select current_setting('statement_timeout') as value, pg_sleep(0.05)"
          );
          return (result as { rows: { value: string }[] }).rows[0]?.value;
        })
      );
      expect(settings).toEqual(["1234ms", "1234ms", "1234ms"]);
      await expect(pool.raw("select pg_sleep(2)")).rejects.toMatchObject({ code: "57014" });
    } finally {
      await pool.destroy();
    }
  });
});
