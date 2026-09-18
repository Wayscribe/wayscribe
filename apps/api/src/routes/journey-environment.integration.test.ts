import type { AddressInfo } from "node:net";
import { startPostgres, type TestDatabase } from "@wayscribe/database/testing";
import { createKnexConfig, insertReturningId, issueKey } from "@wayscribe/database";
import { createKeyring, searchTokens } from "@wayscribe/payload-security";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

/**
 * The Node SDK, loaded by name at run time.
 *
 * The API does not depend on the SDK (AGENTS.md, package boundaries), so the
 * name is not resolvable to the API's type check; the integration config's
 * alias resolves it for the test run. Only what the test calls is typed.
 */
const SDK_PACKAGE: string = "@wayscribe/node";
interface SdkJourney {
  context(): { journeyId: string; entity: { type: string; id: string } };
  record(input: { operation: string; name: string; input?: unknown }): void;
  identify(aliases: Record<string, string>): void;
  transform<T>(name: string, input: unknown, fn: () => T): T;
}
interface SdkRecorder {
  startJourney(options: { entity: { type: string; id: string } }): SdkJourney;
  continueJourney(options: { journeyId: string; entity: { type: string; id: string } }): SdkJourney;
  shutdown(options?: { timeoutMs?: number }): Promise<{ rejected: number; sent: number }>;
}

const keyring = createKeyring("0123456789abcdef0123456789abcdef");
const ADMIN_TOKEN = "admin-token-for-tests-0000000000";

type Environment = "production" | "development";

function event(environment: Environment, overrides: Record<string, unknown>): unknown {
  return {
    protocolVersion: "0.1",
    event: {
      journeyId: "jrn_default",
      environment,
      service: "svc",
      entity: { type: "order", id: "ord-9" },
      operation: "received",
      name: "step",
      timestamp: "2026-09-15T10:00:00.000Z",
      ...overrides
    }
  };
}

/**
 * A journey belongs to the environment that wrote it first, and nothing written
 * under another environment's key may attach to it.
 *
 * Reads were scoped by environment (ADR-038) and writes were not: events and
 * aliases attached by `(project_id, journey_id)` alone. A development key could
 * mark a production journey failed and inject a searchable alias into it, or
 * create a journey id production would later write into and then read
 * production's aliases through its own journey. Both vectors are tested here in
 * both directions, through the HTTP routes, with the rows read back from
 * PostgreSQL rather than inferred from the response.
 */
describe("a journey cannot span environments", () => {
  let container: TestDatabase;
  let db: Knex;
  let app: FastifyInstance;
  let projectId: string;
  const keys: Record<Environment, string> = { production: "", development: "" };

  beforeAll(async () => {
    container = await startPostgres();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();

    projectId = await insertReturningId(db, "projects", { name: "Acme", slug: "acme" });
    for (const environment of ["production", "development"] as const) {
      keys[environment] = (
        await issueKey(db, keyring, {
          projectSlug: "acme",
          environmentName: environment,
          name: "k"
        })
      ).apiKey;
    }

    app = buildApp({ db, keyring, adminToken: ADMIN_TOKEN, logLevel: "silent" });
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await container.stop();
  });

  const send = (environment: Environment, payload: unknown) =>
    app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${keys[environment]}` },
      payload: payload as object
    });

  const sendBatch = (environment: Environment, events: unknown[]) =>
    app.inject({
      method: "POST",
      url: "/v1/events/batch",
      headers: { authorization: `Bearer ${keys[environment]}` },
      payload: { events } as object
    });

  const other = (environment: Environment): Environment =>
    environment === "production" ? "development" : "production";

  const journeyRow = (journeyId: string) =>
    db("journeys").where({ project_id: projectId, id: journeyId }).first();

  const eventRow = (eventId: string) =>
    db("journey_events").where({ project_id: projectId, id: eventId }).first();

  const aliasRows = (journeyId: string, value: string) =>
    db("entity_aliases").where({
      project_id: projectId,
      journey_id: journeyId,
      alias_value_hash: searchTokens(keyring, value)[0]
    });

  const expectMismatch = (body: { error?: { code?: string; message?: string } }, owner: string) => {
    expect(body.error?.code).toBe("journey_environment_mismatch");
    expect(body.error?.message).toMatch(/cannot span environments/);
    // The refusal says the journey is someone else's. It must not say whose.
    expect(body.error?.message).not.toContain(owner);
  };

  for (const owner of ["production", "development"] as const) {
    const intruder = other(owner);

    it(`refuses a ${intruder} key attaching an event and alias to a ${owner} journey`, async () => {
      const journeyId = `jrn_attach_${owner}`;
      const created = await send(
        owner,
        event(owner, {
          id: `evt_attach_${owner}_1`,
          journeyId,
          operation: "completed",
          timestamp: "2026-09-15T10:00:00.000Z"
        })
      );
      expect(created.statusCode).toBe(202);

      const intrusion = await send(
        intruder,
        event(intruder, {
          id: `evt_attach_${owner}_injected`,
          journeyId,
          service: "attacker-svc",
          operation: "failed",
          timestamp: "2026-09-15T10:05:00.000Z",
          error: { message: "injected" },
          aliases: { email: `victim-${owner}@example.com` },
          input: { forged: true }
        })
      );

      expect(intrusion.statusCode).toBe(409);
      expectMismatch(intrusion.json(), owner);

      expect(await eventRow(`evt_attach_${owner}_injected`)).toBeUndefined();
      expect(await aliasRows(journeyId, `victim-${owner}@example.com`)).toEqual([]);
      const journey = await journeyRow(journeyId);
      expect(journey.status).toBe("completed");
      expect(journey.event_count).toBe(1);
      expect(new Date(journey.last_event_at).toISOString()).toBe("2026-09-15T10:00:00.000Z");
    });

    it(`refuses ${owner} writing into a journey id a ${intruder} key created first`, async () => {
      const journeyId = `jrn_squat_${owner}`;
      const squat = await send(intruder, event(intruder, { id: `evt_squat_${owner}`, journeyId }));
      expect(squat.statusCode).toBe(202);

      const real = await send(
        owner,
        event(owner, {
          id: `evt_real_${owner}`,
          journeyId,
          aliases: { customerEmail: `real-${owner}@example.com` },
          input: { card: "4242" }
        })
      );

      expect(real.statusCode).toBe(409);
      expectMismatch(real.json(), intruder);

      expect(await eventRow(`evt_real_${owner}`)).toBeUndefined();
      expect(await aliasRows(journeyId, `real-${owner}@example.com`)).toEqual([]);
      expect((await journeyRow(journeyId)).event_count).toBe(1);

      // What the squatter reads of its journey holds nothing the owner sent.
      const read = await app.inject({
        method: "GET",
        url: `/v1/journeys/${journeyId}`,
        headers: { authorization: `Bearer ${keys[intruder]}` }
      });
      expect(read.statusCode).toBe(200);
      expect(read.json().data.aliases).toEqual([]);
      expect(read.json().data.eventCount).toBe(1);
    });

    it(`refuses the ${intruder} event in a batch and keeps the rest (${owner} journey)`, async () => {
      const journeyId = `jrn_batch_${owner}`;
      expect(
        (await send(owner, event(owner, { id: `evt_batch_${owner}_owner`, journeyId }))).statusCode
      ).toBe(202);

      const response = await sendBatch(intruder, [
        event(intruder, { id: `evt_batch_${owner}_ok`, journeyId: `jrn_batch_${intruder}_own` }),
        event(intruder, {
          id: `evt_batch_${owner}_intrusion`,
          journeyId,
          operation: "failed",
          aliases: { email: `batch-${owner}@example.com` }
        })
      ]);

      expect(response.statusCode).toBe(202);
      const results = response.json().data.results;
      expect(results[0].status).toBe("accepted");
      expect(results[1].status).toBe("rejected");
      expect(results[1].error.httpStatus).toBe(409);
      expectMismatch(results[1], owner);

      expect(await eventRow(`evt_batch_${owner}_ok`)).toBeDefined();
      expect(await eventRow(`evt_batch_${owner}_intrusion`)).toBeUndefined();
      expect(await aliasRows(journeyId, `batch-${owner}@example.com`)).toEqual([]);
      const journey = await journeyRow(journeyId);
      expect(journey.status).toBe("active");
      expect(journey.event_count).toBe(1);
    });
  }

  it("lets exactly one environment win a journey both create at once", async () => {
    // The check sits in the same transaction as the journey upsert, so a
    // concurrent create cannot slip between them. Repeated, because a race that
    // loses one time in ten passes a single attempt.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const journeyId = `jrn_race_${String(attempt)}`;
      const [production, development] = await Promise.all([
        send(
          "production",
          event("production", {
            id: `evt_race_p_${String(attempt)}`,
            journeyId,
            aliases: { email: `race-p-${String(attempt)}@example.com` }
          })
        ),
        send(
          "development",
          event("development", {
            id: `evt_race_d_${String(attempt)}`,
            journeyId,
            aliases: { email: `race-d-${String(attempt)}@example.com` }
          })
        )
      ]);

      const statuses = [production.statusCode, development.statusCode].sort();
      expect(statuses).toEqual([202, 409]);

      const journey = await journeyRow(journeyId);
      const events: { environment_id: string }[] = await db("journey_events").where({
        project_id: projectId,
        journey_id: journeyId
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.environment_id).toBe(journey.environment_id);
      expect(journey.event_count).toBe(1);
      const aliases = await db("entity_aliases").where({
        project_id: projectId,
        journey_id: journeyId
      });
      expect(aliases).toHaveLength(1);
    }
  });

  it("leaves the SDK's ordinary flow, one environment throughout, unaffected", async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;

    const { createRecorder } = (await import(SDK_PACKAGE)) as {
      createRecorder: (config: Record<string, unknown>) => SdkRecorder;
    };
    const recorder = createRecorder({
      endpoint: `http://127.0.0.1:${String(port)}`,
      apiKey: keys.production,
      serviceName: "billing-api",
      environment: "production"
    });
    const journey = recorder.startJourney({ entity: { type: "customer", id: "CUST-SDK-1" } });
    journey.record({ operation: "received", name: "receive", input: { a: 1 } });
    journey.identify({ internalCustomerId: "sdk-alias-1" });
    journey.transform("map", { a: 1 }, () => ({ b: 1 }));
    journey.record({ operation: "completed", name: "done" });
    const { journeyId } = journey.context();
    const continued = recorder.continueJourney({
      journeyId,
      entity: { type: "customer", id: "CUST-SDK-1" }
    });
    continued.record({ operation: "consumed", name: "worker-picks-up" });
    const counters = await recorder.shutdown({ timeoutMs: 10_000 });

    expect(counters.rejected).toBe(0);
    expect(counters.sent).toBe(5);
    const stored = await journeyRow(journeyId);
    expect(stored).toBeDefined();
    const events: { environment_id: string }[] = await db("journey_events").where({
      project_id: projectId,
      journey_id: journeyId
    });
    expect(events).toHaveLength(5);
    expect(events.every((row) => row.environment_id === stored.environment_id)).toBe(true);
    expect(stored.event_count).toBe(events.length);
    expect(await aliasRows(journeyId, "sdk-alias-1")).toHaveLength(1);
  });
});
