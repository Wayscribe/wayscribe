import { startPostgres, type TestDatabase } from "@wayscribe/database/testing";
import { createKnexConfig, insertReturningId, issueKey } from "@wayscribe/database";
import { createKeyring } from "@wayscribe/payload-security";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");
const ADMIN_TOKEN = "admin-token-for-tests-0000000000";
const READ_TOKEN = "read-token-for-tests-000000000000";
const JOURNEY = "jrn_reader_0001";
const ACCOUNT = "0018Z00005RDR01";
const PHONE = "+1 555 0100";

/** Every table a write could leave a row in, audit_events included. */
const TABLES = [
  "projects",
  "environments",
  "api_keys",
  "journeys",
  "entity_aliases",
  "journey_events",
  "replay_destinations",
  "replay_runs",
  "audit_events"
] as const;

describe("a reader against a real database", () => {
  let container: TestDatabase;
  let db: Knex;
  let app: FastifyInstance;
  let apiKey: string;

  beforeAll(async () => {
    container = await startPostgres();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();
    await insertReturningId(db, "projects", { name: "Demo", slug: "demo" });
    apiKey = (
      await issueKey(db, keyring, {
        projectSlug: "demo",
        environmentName: "development",
        name: "demo"
      })
    ).apiKey;
    app = buildApp({
      db,
      keyring,
      adminToken: ADMIN_TOKEN,
      readToken: READ_TOKEN,
      logLevel: "silent",
      otlpLogsEnabled: true,
      replayAllowedHosts: ["localhost"]
    });

    await ingest(JOURNEY, "evt_reader");
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await container.stop();
  });

  const ingest = async (journeyId: string, prefix: string): Promise<void> => {
    const event = (id: string, operation: string, name: string, extra: object) => ({
      protocolVersion: "0.1",
      event: {
        id,
        journeyId,
        environment: "development",
        service: "demo-integration",
        entity: { type: "customer", id: ACCOUNT },
        operation,
        name,
        timestamp: new Date().toISOString(),
        ...extra
      }
    });
    const ingested = await app.inject({
      method: "POST",
      url: "/v1/events/batch",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        events: [
          event(`${prefix}_1`, "transformed", "transform-salesforce-account", {
            input: { Id: ACCOUNT, Phone: PHONE },
            output: { externalId: ACCOUNT, phone: null }
          }),
          event(`${prefix}_2`, "identified", "identify", { aliases: { phone: PHONE } })
        ]
      }
    });
    expect(ingested.statusCode, ingested.body).toBeLessThan(300);
  };

  const asReader = (method: string, url: string, payload?: object) =>
    app.inject({
      method: method as "GET",
      url,
      headers: { authorization: `Bearer ${READ_TOKEN}` },
      ...(payload === undefined ? {} : { payload })
    });

  const counts = async (): Promise<Record<string, number>> => {
    const result: Record<string, number> = {};
    for (const table of TABLES) {
      const row: unknown = await db(table).count({ n: "*" }).first();
      result[table] = Number((row as { n: string }).n);
    }
    return result;
  };

  it("reads projects, search, the journey, its events and an event with its diff", async () => {
    expect((await asReader("GET", "/v1/projects")).statusCode).toBe(200);

    const search = await asReader("GET", `/v1/search?q=${encodeURIComponent(PHONE)}`);
    expect(search.statusCode, search.body).toBe(200);
    expect(
      search.json<{ data: { items: { journeyId: string }[] } }>().data.items.map((i) => i.journeyId)
    ).toContain(JOURNEY);

    const since = encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString());
    expect((await asReader("GET", `/v1/journeys?since=${since}`)).statusCode).toBe(200);
    expect((await asReader("GET", `/v1/journeys/${JOURNEY}`)).statusCode).toBe(200);
    expect((await asReader("GET", `/v1/journeys/${JOURNEY}/events`)).statusCode).toBe(200);

    const detail = await asReader("GET", "/v1/events/evt_reader_1");
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json<{ data: { payloadDiff: unknown } }>().data.payloadDiff).not.toBeNull();
  });

  it("is refused ingestion, OTLP, replay, deletion and erasure, and they leave no row anywhere", async () => {
    const before = await counts();

    const attempts: [string, string, object | undefined][] = [
      ["POST", "/v1/events", { protocolVersion: "0.1", event: {} }],
      ["POST", "/v1/events/batch", { events: [] }],
      ["POST", "/v1/logs", { resourceLogs: [] }],
      ["POST", "/v1/replay-destinations", { name: "x", baseUrl: "http://localhost:9" }],
      ["GET", "/v1/replay-destinations", undefined],
      [
        "POST",
        "/v1/replays",
        { eventId: "evt_reader_1", destinationId: "x", path: "/", method: "POST" }
      ],
      ["GET", "/v1/replays/x", undefined],
      ["DELETE", `/v1/journeys/${JOURNEY}`, undefined],
      ["POST", "/v1/erasures", { value: PHONE }],
      ["DELETE", "/v1/replay-destinations/x", undefined]
    ];
    for (const [method, url, payload] of attempts) {
      const response = await asReader(method, url, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }

    expect(await counts()).toEqual(before);
  });

  it("counts would have caught a write: an admin deletion adds an audit row", async () => {
    const control = "jrn_reader_control";
    await ingest(control, "evt_control");
    const before = await counts();
    const deleted = await app.inject({
      method: "DELETE",
      url: `/v1/journeys/${control}`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
    });
    expect(deleted.statusCode, deleted.body).toBe(204);
    const after = await counts();
    expect(after["audit_events"]).toBeGreaterThan(before["audit_events"] ?? 0);
    expect(after["journeys"]).toBeLessThan(before["journeys"] ?? 0);
  });
});
