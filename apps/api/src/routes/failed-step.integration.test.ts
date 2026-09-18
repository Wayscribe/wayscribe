import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createKnexConfig, insertReturningId } from "@wayscribe/database";
import { createKeyring, issueApiKey } from "@wayscribe/payload-security";
import { buildJsonSchemas } from "@wayscribe/protocol";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { buildApp } from "../app.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");

const MINUTE = 60 * 1000;
/** Relative to the real clock, so the list's window holds every event. */
const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * MINUTE).toISOString();

interface Read {
  status: string;
  lastStep: string | null;
  failedStep?: string | null;
}

/**
 * `failedStep` (ADR-063, F-047) through the real routes: the journey read, both
 * list rows and a dry run's `stored.journey`, with events ingested for real.
 */
describe("failedStep on the journey reads", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let app: FastifyInstance;
  let apiKey: string;
  let since: string;

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
      name: "development",
      key_prefix: generated.keyPrefix,
      key_hash: generated.verifier,
      key_hash_key_id: generated.keyHashKeyId
    });
    app = buildApp({
      db,
      keyring,
      adminToken: "admin-token-for-tests-0000000000",
      logLevel: "silent"
    });
    since = minutesAgo(24 * 60);
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await container.stop();
  });

  const envelope = (
    journeyId: string,
    id: string,
    minutes: number,
    name: string,
    fields: Record<string, unknown> = {}
  ): unknown => ({
    protocolVersion: "0.1",
    event: {
      id,
      journeyId,
      environment: "development",
      service: "hubspot-sync",
      entity: { type: "lead", id: `lead-${journeyId}` },
      operation: "transformed",
      name,
      timestamp: minutesAgo(minutes),
      ...fields
    }
  });

  const send = async (body: unknown): Promise<{ duplicate: boolean }> => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: body as object
    });
    expect(response.statusCode, response.body).toBe(202);
    return response.json().data as { duplicate: boolean };
  };

  const get = async (url: string): Promise<unknown> => {
    const response = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${apiKey}` }
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().data;
  };

  /** The journey as the read, the recent list and search each show it. */
  const reads = async (journeyId: string): Promise<Record<string, Read>> => {
    const detail = (await get(`/v1/journeys/${journeyId}`)) as Read;
    const listed = (await get(`/v1/journeys?since=${encodeURIComponent(since)}&limit=100`)) as {
      items: (Read & { journeyId: string })[];
    };
    const searched = (await get(`/v1/search?q=${encodeURIComponent(`lead-${journeyId}`)}`)) as {
      items: (Read & { journeyId: string })[];
    };
    const row = (items: (Read & { journeyId: string })[], where: string): Read => {
      const found = items.find((item) => item.journeyId === journeyId);
      if (found === undefined) throw new Error(`${journeyId} is not in ${where}`);
      return found;
    };
    return {
      read: detail,
      list: row(listed.items, "GET /v1/journeys"),
      search: row(searched.items, "GET /v1/search")
    };
  };

  /** Every read shows the same status and failed step, and carries the key. */
  const expectEverywhere = async (
    journeyId: string,
    expected: { status: string; lastStep?: string; failedStep: string | null }
  ): Promise<void> => {
    for (const [where, shown] of Object.entries(await reads(journeyId))) {
      expect(shown, where).toHaveProperty("failedStep");
      expect(shown, where).toMatchObject(expected);
    }
  };

  // F-047 exactly: attempt 1's push failed, and attempt 2's take-job and
  // map-hubspot were recorded before its push.
  const f047 = (journeyId: string): unknown[] => [
    envelope(journeyId, `${journeyId}_1`, 10, "take-job", { operation: "received" }),
    envelope(journeyId, `${journeyId}_2`, 9, "map-hubspot"),
    envelope(journeyId, `${journeyId}_3`, 8, "push-hubspot", {
      operation: "delivered",
      error: { message: "429 Too Many Requests" }
    }),
    envelope(journeyId, `${journeyId}_4`, 7, "take-job", { operation: "received" }),
    envelope(journeyId, `${journeyId}_5`, 6, "map-hubspot")
  ];

  it("reads F-047's journey, before the retried push, as failed at push-hubspot everywhere", async () => {
    for (const body of f047("jrn_f047")) await send(body);
    await expectEverywhere("jrn_f047", {
      status: "failed",
      lastStep: "map-hubspot",
      failedStep: "push-hubspot"
    });
    expect(((await get("/v1/journeys/jrn_f047")) as { eventCount: number }).eventCount).toBe(5);
  });

  it("reads null everywhere once the retried push clears the failure (ADR-061)", async () => {
    for (const body of f047("jrn_f047_retry")) await send(body);
    await send(
      envelope("jrn_f047_retry", "jrn_f047_retry_6", 5, "push-hubspot", { operation: "retried" })
    );
    await expectEverywhere("jrn_f047_retry", {
      status: "active",
      lastStep: "push-hubspot",
      failedStep: null
    });
  });

  it("reads null everywhere on a journey that never failed, and on a completed one", async () => {
    await send(envelope("jrn_never", "jrn_never_1", 4, "take-job"));
    await expectEverywhere("jrn_never", { status: "active", failedStep: null });
    for (const body of f047("jrn_done")) await send(body);
    await send(envelope("jrn_done", "jrn_done_6", 3, "finish", { operation: "completed" }));
    await expectEverywhere("jrn_done", { status: "completed", failedStep: null });
  });

  it("leaves duplicates out of it: a resent failure neither re-fails nor renames", async () => {
    const journeyId = "jrn_dup";
    const events = f047(journeyId);
    for (const body of events) await send(body);
    await send(envelope(journeyId, `${journeyId}_6`, 5, "push-hubspot", { operation: "retried" }));
    // The failure again, byte for byte: a duplicate, which never reaches the
    // summary, so the cleared journey stays cleared.
    const [, , failed] = events;
    expect((await send(failed)).duplicate).toBe(true);
    await expectEverywhere(journeyId, { status: "active", failedStep: null });
  });

  it("never shows a value a previous build left on a journey that is not failed", async () => {
    // What the previous API leaves when it clears a failure during a rollout:
    // the status moves and failed_step does not, because it knows no such
    // column. The reads show the column only while the status is failed.
    const journeyId = "jrn_stale";
    for (const body of f047(journeyId)) await send(body);
    for (const status of ["active", "completed"]) {
      await db("journeys").where({ id: journeyId }).update({ status });
      await expectEverywhere(journeyId, { status, failedStep: null });
    }
    // And the next failure replaces it, although the stale one is stamped
    // later.
    await db("journeys")
      .where({ id: journeyId })
      .update({ status: "active", failed_step_at: new Date(Date.now() + 60 * MINUTE) });
    await send(
      envelope(journeyId, `${journeyId}_late`, 30, "validate", {
        error: { message: "invalid email" }
      })
    );
    await expectEverywhere(journeyId, { status: "failed", failedStep: "validate" });
  });

  it("previews failedStep in a dry run's stored.journey, as the stored-journey schema requires", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/events/batch?dryRun=true",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { events: f047("jrn_dry_f047") } as object
    });
    expect(response.statusCode, response.body).toBe(200);
    const journeys = response
      .json<{ data: { results: { stored: { journey: Read } }[] } }>()
      .data.results.map((result) => result.stored.journey);
    expect(journeys.map((journey) => [journey.status, journey.failedStep])).toEqual([
      ["active", null],
      ["active", null],
      ["failed", "push-hubspot"],
      ["failed", "push-hubspot"],
      ["failed", "push-hubspot"]
    ]);

    const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: false });
    const schemas = buildJsonSchemas();
    ajv.addSchema(schemas["stored-event"] ?? {});
    const storedJourney = ajv.compile(schemas["stored-journey"] ?? {});
    const last = journeys.at(-1);
    expect(storedJourney(last), ajv.errorsText(storedJourney.errors)).toBe(true);
    // The schema requires it: a journey without the field does not validate.
    const { failedStep: _dropped, ...without } = last ?? { status: "", lastStep: null };
    expect(storedJourney(without)).toBe(false);
  });
});
