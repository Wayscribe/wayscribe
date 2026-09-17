import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  createDestination,
  createKnexConfig,
  insertReturningId,
  listAudit,
  startRun
} from "@flight-recorder/database";
import { createKeyring, issueApiKey, searchTokens } from "@flight-recorder/payload-security";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { buildApp } from "../app.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");
const ADMIN_TOKEN = "admin-token-for-tests-0000000000";
const VALUE = "erasure-subject@example.com";

const token = (value: string): string => {
  const [current] = searchTokens(keyring, value);
  if (current === undefined) throw new Error("no token");
  return current;
};

interface ErrorBody {
  error: { code: string; message: string; requestId: string };
}

describe("deletion routes", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let app: FastifyInstance;
  let projectA: string;
  let projectB: string;
  let productionA: string;
  let productionB: string;
  let apiKey: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(inject("postgresImage")).start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();

    projectA = await insertReturningId(db, "projects", { name: "A", slug: "a" });
    projectB = await insertReturningId(db, "projects", { name: "B", slug: "b" });
    productionA = await insertReturningId(db, "environments", {
      project_id: projectA,
      name: "production"
    });
    productionB = await insertReturningId(db, "environments", {
      project_id: projectB,
      name: "production"
    });

    const generated = issueApiKey(keyring);
    apiKey = generated.apiKey;
    await db("api_keys").insert({
      project_id: projectA,
      environment_id: productionA,
      name: "k",
      key_prefix: generated.keyPrefix,
      key_hash: generated.verifier,
      key_hash_key_id: generated.keyHashKeyId
    });

    app = buildApp({ db, keyring, adminToken: ADMIN_TOKEN, logLevel: "silent" });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await container.stop();
  });

  beforeEach(async () => {
    await db("replay_runs").del();
    await db("replay_destinations").del();
    await db("journeys").del();
    await db("audit_events").del();
  });

  const admin = (projectId: string): Record<string, string> => ({
    authorization: `Bearer ${ADMIN_TOKEN}`,
    "x-flight-project-id": projectId
  });

  const journey = async (
    project: string,
    environment: string,
    id: string,
    hash = `hash-${id}`,
    eventCount = 1
  ): Promise<void> => {
    await db("journeys").insert({
      id,
      project_id: project,
      environment_id: environment,
      entity_type: "customer",
      primary_entity_id_hash: hash,
      status: "active",
      started_at: db.fn.now(),
      last_event_at: db.fn.now(),
      event_count: eventCount
    });
  };

  const journeyIds = async (project: string): Promise<string[]> =>
    ((await db("journeys").where({ project_id: project }).pluck("id")) as string[]).sort();

  const destinationWithRun = async (project: string, environment: string): Promise<string> => {
    await journey(project, environment, "jrn_replayed");
    await db("journey_events").insert({
      id: "evt_replayed",
      project_id: project,
      environment_id: environment,
      journey_id: "jrn_replayed",
      service: "svc",
      operation: "received",
      name: "n",
      event_timestamp: db.fn.now(),
      protocol_version: "0.1",
      content_hash: "c"
    });
    const destination = await createDestination(db, keyring, {
      projectId: project,
      name: "local",
      baseUrl: "http://localhost:3300",
      environmentType: "development"
    });
    await startRun(db, {
      projectId: project,
      journeyEventId: "evt_replayed",
      destinationId: destination.id,
      method: "POST",
      requestPath: "/",
      requestPayload: {},
      requestHeaders: {},
      initiatedBy: "admin"
    });
    return destination.id;
  };

  describe("authentication", () => {
    const routes = [
      { method: "DELETE" as const, url: "/v1/journeys/jrn_1" },
      { method: "POST" as const, url: "/v1/erasures", payload: { value: VALUE } },
      {
        method: "DELETE" as const,
        url: "/v1/replay-destinations/00000000-0000-4000-8000-000000000000"
      }
    ];

    it("gives an API key the same 401 as the other admin routes, and deletes nothing", async () => {
      await journey(projectA, productionA, "jrn_1", token(VALUE));
      const replay = await app.inject({
        method: "GET",
        url: "/v1/replay-destinations",
        headers: { authorization: `Bearer ${apiKey}` }
      });
      const { requestId: _replayRequestId, ...expected } = replay.json<ErrorBody>().error;
      expect(replay.statusCode).toBe(401);

      for (const route of routes) {
        const response = await app.inject({
          ...route,
          headers: { authorization: `Bearer ${apiKey}`, "x-flight-project-id": projectA }
        });
        expect(response.statusCode).toBe(401);
        const { requestId: _requestId, ...body } = response.json<ErrorBody>().error;
        expect(body).toEqual(expected);
      }
      expect(await journeyIds(projectA)).toEqual(["jrn_1"]);
      expect(await listAudit(db, projectA)).toHaveLength(0);
    });

    it("answers a project id that is not a uuid with project_not_found, not a server error", async () => {
      for (const route of routes) {
        const response = await app.inject({ ...route, headers: admin("not-a-uuid") });
        expect(response.statusCode).toBe(404);
        expect(response.json<ErrorBody>().error.code).toBe("project_not_found");
      }
    });
  });

  describe("DELETE /v1/journeys/:journeyId", () => {
    it("deletes the journey and records it", async () => {
      await journey(projectA, productionA, "jrn_1", "h", 3);

      const response = await app.inject({
        method: "DELETE",
        url: "/v1/journeys/jrn_1",
        headers: admin(projectA)
      });
      expect(response.statusCode).toBe(204);
      expect(response.body).toBe("");
      expect(await journeyIds(projectA)).toEqual([]);

      const audit = await listAudit(db, projectA);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actor: "admin",
        action: "journey.deleted",
        resourceId: "jrn_1",
        metadata: { environment: "production", eventCount: 3 }
      });
    });

    it("answers 404 for another project's journey and leaves it alone", async () => {
      await journey(projectB, productionB, "jrn_b");

      const response = await app.inject({
        method: "DELETE",
        url: "/v1/journeys/jrn_b",
        headers: admin(projectA)
      });
      expect(response.statusCode).toBe(404);
      expect(response.json<ErrorBody>().error.code).toBe("not_found");
      expect(await journeyIds(projectB)).toEqual(["jrn_b"]);
      expect(await listAudit(db, projectA)).toHaveLength(0);
    });

    it("lets the protocol's longest journey id reach the route, however it is encoded", async () => {
      // Fastify's default maxParamLength of 100 answered these 414 before the
      // route ran. The protocol allows 128 characters, and a character outside
      // ASCII is up to nine in the encoded path.
      for (const id of ["j".repeat(128), "€".repeat(128)]) {
        await journey(projectA, productionA, id);
        const response = await app.inject({
          method: "DELETE",
          url: `/v1/journeys/${encodeURIComponent(id)}`,
          headers: admin(projectA)
        });
        expect(response.statusCode, id.slice(0, 3)).toBe(204);
      }
      expect(await journeyIds(projectA)).toEqual([]);
    });

    it("refuses a journey id longer than the protocol allows", async () => {
      const response = await app.inject({
        method: "DELETE",
        url: `/v1/journeys/${"j".repeat(129)}`,
        headers: admin(projectA)
      });
      expect(response.statusCode).toBe(400);
      expect(response.json<ErrorBody>().error.code).toBe("invalid_request");
    });

    it("refuses a journey id PostgreSQL cannot store", async () => {
      const response = await app.inject({
        method: "DELETE",
        url: "/v1/journeys/jrn%00x",
        headers: admin(projectA)
      });
      expect(response.statusCode).toBe(400);
      expect(response.json<ErrorBody>().error.code).toBe("invalid_request");
    });
  });

  describe("POST /v1/erasures", () => {
    const erase = async (
      payload: unknown,
      projectId = projectA
    ): Promise<Awaited<ReturnType<FastifyInstance["inject"]>>> =>
      app.inject({
        method: "POST",
        url: "/v1/erasures",
        headers: admin(projectId),
        payload: payload as Record<string, unknown>
      });

    it("dry run reports what would be deleted and deletes nothing", async () => {
      await journey(projectA, productionA, "jrn_match", token(VALUE), 4);
      await journey(projectA, productionA, "jrn_other");
      await journey(projectB, productionB, "jrn_b", token(VALUE));

      const response = await erase({ value: VALUE, dryRun: true });
      expect(response.statusCode).toBe(200);
      const body = response.json<{
        data: { journeys: Record<string, unknown>[]; total: number };
      }>();
      expect(body.data.total).toBe(1);
      expect(body.data.journeys).toHaveLength(1);
      expect(body.data.journeys[0]).toEqual({
        id: "jrn_match",
        environment: "production",
        entityType: "customer",
        eventCount: 4,
        lastEventAt: expect.any(String) as unknown
      });

      expect(await journeyIds(projectA)).toEqual(["jrn_match", "jrn_other"]);
      expect(await listAudit(db, projectA)).toHaveLength(0);
    });

    it("real run deletes the matches in this project only and records a value-free audit row", async () => {
      await journey(projectA, productionA, "jrn_match", token(VALUE), 4);
      await journey(projectA, productionA, "jrn_other");
      await journey(projectB, productionB, "jrn_b", token(VALUE));

      const response = await erase({ value: VALUE, environment: "production" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        data: { deletedJourneys: 1, deletedEvents: 4, complete: true }
      });
      expect(await journeyIds(projectA)).toEqual(["jrn_other"]);
      expect(await journeyIds(projectB)).toEqual(["jrn_b"]);

      const audit = await listAudit(db, projectA);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: "erasure.completed",
        metadata: { token: token(VALUE), deletedJourneys: 1, complete: true }
      });
      expect(JSON.stringify(audit)).not.toContain(VALUE);
    });

    it("answers 404 environment_not_found for an environment the project lacks", async () => {
      const response = await erase({ value: VALUE, environment: "staging" });
      expect(response.statusCode).toBe(404);
      expect(response.json<ErrorBody>().error.code).toBe("environment_not_found");
      expect(await listAudit(db, projectA)).toHaveLength(0);
    });

    it("refuses invalid input with 400 invalid_request before touching anything", async () => {
      await journey(projectA, productionA, "jrn_blank", token(""));

      const invalid: unknown[] = [
        {},
        { value: 42 },
        { value: "   " },
        { value: "x".repeat(513) },
        { value: "a\u0000b" },
        { value: VALUE, environment: "prod\u0000" },
        { value: VALUE, environment: "" },
        { value: VALUE, environment: 7 },
        { value: VALUE, dryRun: "yes" }
      ];
      for (const payload of invalid) {
        const response = await erase(payload);
        expect(response.statusCode, JSON.stringify(payload)).toBe(400);
        expect(response.json<ErrorBody>().error.code).toBe("invalid_request");
      }
      expect(await journeyIds(projectA)).toEqual(["jrn_blank"]);
      expect(await listAudit(db, projectA)).toHaveLength(0);
    });

    it("accepts a value at the protocol's identifier maximum", async () => {
      const longest = "x".repeat(512);
      await journey(projectA, productionA, "jrn_long", token(longest));

      const response = await erase({ value: longest });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ data: { deletedJourneys: 1 } });
    });

    it("reports an erasure that stopped part way as incomplete, with what it deleted", async () => {
      // One more than a batch, so the second batch is the one that fails.
      await db("journeys").insert(
        Array.from({ length: 501 }, (_, i) => ({
          id: `jrn_${String(i).padStart(3, "0")}`,
          project_id: projectA,
          environment_id: productionA,
          entity_type: "customer",
          primary_entity_id_hash: token(VALUE),
          status: "active",
          started_at: db.fn.now(),
          last_event_at: db.fn.now(),
          event_count: 1
        }))
      );
      await db.raw(`
        create or replace function fail_audit() returns trigger language plpgsql as $$
        begin raise exception 'audit write refused'; end $$
      `);
      await db.raw(
        "create trigger fail_audit before update on audit_events for each row execute function fail_audit()"
      );
      try {
        const response = await erase({ value: VALUE });
        expect(response.statusCode).toBe(200);
        const body = response.json<{
          data: { deletedJourneys: number; complete: boolean; message: string };
        }>();
        expect(body.data).toMatchObject({
          deletedJourneys: 500,
          deletedEvents: 500,
          complete: false
        });
        expect(body.data.message).toMatch(/run it again/i);
      } finally {
        await db.raw("drop trigger fail_audit on audit_events");
      }
      expect(await journeyIds(projectA)).toHaveLength(1);
      expect((await listAudit(db, projectA))[0]?.metadata).toMatchObject({
        deletedJourneys: 500,
        complete: false
      });
    });
  });

  describe("DELETE /v1/replay-destinations/:destinationId", () => {
    it("deletes the destination with its runs and records it", async () => {
      const destinationId = await destinationWithRun(projectA, productionA);

      const response = await app.inject({
        method: "DELETE",
        url: `/v1/replay-destinations/${destinationId}`,
        headers: admin(projectA)
      });
      expect(response.statusCode).toBe(204);
      expect(await db("replay_destinations").where({ id: destinationId }).first()).toBeUndefined();
      expect(
        await db("replay_runs").where({ destination_id: destinationId }).first()
      ).toBeUndefined();

      const audit = await listAudit(db, projectA);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: "replay_destination.deleted",
        resourceId: destinationId,
        metadata: { name: "local", deletedRuns: 1 }
      });
    });

    it("answers 404 for another project's destination and for an id that is not a uuid", async () => {
      const destinationId = await destinationWithRun(projectB, productionB);

      const expected: [string, number, string][] = [
        ["not-a-uuid", 404, "not_found"],
        ["a%00b", 400, "invalid_request"]
      ];
      for (const [id, status, code] of expected) {
        const response = await app.inject({
          method: "DELETE",
          url: `/v1/replay-destinations/${id}`,
          headers: admin(projectA)
        });
        expect(response.statusCode, id).toBe(status);
        expect(response.json<ErrorBody>().error.code, id).toBe(code);
      }
      const cross = await app.inject({
        method: "DELETE",
        url: `/v1/replay-destinations/${destinationId}`,
        headers: admin(projectA)
      });
      expect(cross.statusCode).toBe(404);
      expect(cross.json<ErrorBody>().error.code).toBe("not_found");
      expect(await db("replay_destinations").where({ id: destinationId }).first()).toBeDefined();
      expect(await listAudit(db, projectA)).toHaveLength(0);
    });
  });
});
