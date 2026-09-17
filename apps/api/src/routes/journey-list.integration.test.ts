import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createKnexConfig, insertReturningId } from "@wayscribe/database";
import { createKeyring, issueApiKey } from "@wayscribe/payload-security";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { buildApp } from "../app.js";

const KEY_A = "0123456789abcdef0123456789abcdef";
const KEY_B = "fedcba9876543210fedcba9876543210";
const ADMIN_TOKEN = "admin-token-for-tests-0000000000";
const keyring = createKeyring(KEY_A);

const HOUR = 60 * 60 * 1000;
/** Relative to the real clock, because since may not be in the future. */
const hoursAgo = (hours: number): string => new Date(Date.now() - hours * HOUR).toISOString();

interface ListItem {
  journeyId: string;
  environment: string;
  status: string;
  entity: { type: string; id: string | null };
}

describe("GET /v1/journeys", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let app: FastifyInstance;
  let projectId: string;
  let developmentKey: string;
  let productionKey: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(inject("postgresImage")).start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();

    projectId = await insertReturningId(db, "projects", { name: "P", slug: "p" });
    const storeKey = async (environment: string): Promise<string> => {
      const environmentId = await insertReturningId(db, "environments", {
        project_id: projectId,
        name: environment
      });
      const generated = issueApiKey(keyring);
      await db("api_keys").insert({
        project_id: projectId,
        environment_id: environmentId,
        name: environment,
        key_prefix: generated.keyPrefix,
        key_hash: generated.verifier,
        key_hash_key_id: generated.keyHashKeyId
      });
      return generated.apiKey;
    };
    developmentKey = await storeKey("development");
    productionKey = await storeKey("production");

    app = buildApp({ db, keyring, adminToken: ADMIN_TOKEN, logLevel: "silent" });

    // Through the real write path, so status and the entity ciphertext are what
    // ingestion produces rather than hand-inserted values.
    const ingest = async (
      key: string,
      environment: string,
      event: Record<string, unknown>
    ): Promise<void> => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { authorization: `Bearer ${key}` },
        payload: {
          protocolVersion: "0.1",
          event: {
            environment,
            entity: { type: "customer", id: `ENTITY-${String(event["journeyId"])}` },
            name: "step",
            ...event
          }
        } as object
      });
      expect(response.statusCode).toBe(202);
    };

    await ingest(developmentKey, "development", {
      id: "evt_dev_1",
      journeyId: "jrn_dev_failed",
      service: "sync-worker",
      operation: "failed",
      timestamp: hoursAgo(3)
    });
    await ingest(developmentKey, "development", {
      id: "evt_dev_2",
      journeyId: "jrn_dev_active",
      service: "billing",
      operation: "received",
      timestamp: hoursAgo(2)
    });
    await ingest(productionKey, "production", {
      id: "evt_prod_1",
      journeyId: "jrn_prod_failed",
      service: "sync-worker",
      operation: "failed",
      timestamp: hoursAgo(1)
    });
    // Outside a one-day window.
    await ingest(productionKey, "production", {
      id: "evt_prod_old",
      journeyId: "jrn_prod_old",
      service: "sync-worker",
      operation: "failed",
      timestamp: hoursAgo(30)
    });
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await container.stop();
  });

  const get = (
    url: string,
    token: string = developmentKey,
    target: FastifyInstance = app
  ): Promise<LightMyRequestResponse> =>
    target.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

  const dayAgo = (): string => encodeURIComponent(hoursAgo(24));
  const ids = (response: LightMyRequestResponse): string[] =>
    response.json<{ data: { items: ListItem[] } }>().data.items.map((item) => item.journeyId);

  it("requires authentication", async () => {
    const response = await app.inject({ method: "GET", url: `/v1/journeys?since=${dayAgo()}` });
    expect(response.statusCode).toBe(401);
  });

  it("returns the summary shape with the entity id decrypted and the environment", async () => {
    const response = await get(`/v1/journeys?since=${dayAgo()}&status=failed`);
    expect(response.statusCode).toBe(200);
    const body = response.json<{ data: { items: unknown[]; nextCursor: unknown } }>();
    expect(body.data.nextCursor).toBeNull();
    expect(body.data.items).toEqual([
      {
        journeyId: "jrn_dev_failed",
        entity: { type: "customer", id: "ENTITY-jrn_dev_failed" },
        status: "failed",
        eventCount: 1,
        startedAt: expect.any(String),
        lastEventAt: expect.any(String),
        label: null,
        lastStep: "step",
        displayableAliases: [],
        environment: "development"
      }
    ]);
  });

  it("limits an API key to its own environment", async () => {
    expect(ids(await get(`/v1/journeys?since=${dayAgo()}`))).toEqual([
      "jrn_dev_active",
      "jrn_dev_failed"
    ]);
  });

  it("returns an empty page, not an error, when a key asks for another environment", async () => {
    const response = await get(`/v1/journeys?since=${dayAgo()}&environment=production`);
    expect(response.statusCode).toBe(200);
    expect(ids(response)).toEqual([]);
    // The control: the production key sees the same filter's rows.
    expect(
      ids(await get(`/v1/journeys?since=${dayAgo()}&environment=production`, productionKey))
    ).toEqual(["jrn_prod_failed"]);
  });

  it("lets the admin token read every environment of the project", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/journeys?since=${dayAgo()}&status=failed`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "x-wayscribe-project-id": projectId }
    });
    expect(response.statusCode).toBe(200);
    expect(
      response
        .json<{ data: { items: ListItem[] } }>()
        .data.items.map((item) => [item.journeyId, item.environment])
    ).toEqual([
      ["jrn_prod_failed", "production"],
      ["jrn_dev_failed", "development"]
    ]);
  });

  it("passes status, environment and service through to the query", async () => {
    const url = (service: string): string =>
      `/v1/journeys?since=${dayAgo()}&status=failed&environment=production&service=${service}`;
    expect(ids(await get(url("sync-worker"), ADMIN_TOKEN))).toEqual(["jrn_prod_failed"]);
    expect(ids(await get(url("billing"), ADMIN_TOKEN))).toEqual([]);
  });

  it("bounds the list by since", async () => {
    const twoDays = encodeURIComponent(hoursAgo(48));
    expect(ids(await get(`/v1/journeys?since=${twoDays}&status=failed`, ADMIN_TOKEN))).toEqual([
      "jrn_prod_failed",
      "jrn_dev_failed",
      "jrn_prod_old"
    ]);
  });

  it("pages with the cursor it returns", async () => {
    const first = await get(`/v1/journeys?since=${dayAgo()}&limit=2`, ADMIN_TOKEN);
    expect(ids(first)).toEqual(["jrn_prod_failed", "jrn_dev_active"]);
    const cursor = first.json<{ data: { nextCursor: string } }>().data.nextCursor;
    expect(cursor).toEqual(expect.any(String));

    const second = await get(
      `/v1/journeys?since=${dayAgo()}&limit=2&cursor=${encodeURIComponent(cursor)}`,
      ADMIN_TOKEN
    );
    expect(ids(second)).toEqual(["jrn_dev_failed"]);
    expect(second.json<{ data: { nextCursor: unknown } }>().data.nextCursor).toBeNull();
  });

  it.each([
    [
      "",
      "since is required: the earliest last activity to list, as an ISO-8601 instant with a time zone, such as 2026-08-06T18:00:00Z."
    ],
    [
      "since=yesterday",
      "since must be an ISO-8601 instant with a time zone, such as 2026-08-06T18:00:00Z."
    ],
    [
      `since=${encodeURIComponent(new Date(Date.now() + HOUR).toISOString())}`,
      "since must not be in the future."
    ],
    ["since=2026-01-01T00:00:00Z&status=broken", "status must be one of active, completed, failed."]
  ])("rejects %j with the error envelope", async (query, message) => {
    const response = await get(`/v1/journeys?${query}`);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: "invalid_query", message, requestId: expect.any(String) }
    });
  });

  it("rejects a malformed cursor", async () => {
    const response = await get(`/v1/journeys?since=${dayAgo()}&cursor=garbage`);
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("invalid_cursor");
  });

  it("degrades an entity id under a missing key to null and warns once", async () => {
    const lines: { level: number; keyId?: string }[] = [];
    const withoutA = buildApp({
      db,
      keyring: createKeyring(KEY_B),
      adminToken: ADMIN_TOKEN,
      logLevel: "info",
      logStream: {
        write: (line: string) => lines.push(JSON.parse(line) as { level: number; keyId?: string })
      }
    });
    try {
      const url = `/v1/journeys?since=${dayAgo()}`;
      const response = await get(url, ADMIN_TOKEN, withoutA);
      expect(response.statusCode).toBe(200);
      const items = response.json<{ data: { items: ListItem[] } }>().data.items;
      expect(items).toHaveLength(3);
      expect(items.every((item) => item.entity.id === null)).toBe(true);

      await get(url, ADMIN_TOKEN, withoutA);
      const warnings = lines.filter((line) => line.level === 40 && line.keyId !== undefined);
      expect(warnings).toEqual([expect.objectContaining({ keyId: keyring.current.id })]);
    } finally {
      await withoutA.close();
    }
  });
});
