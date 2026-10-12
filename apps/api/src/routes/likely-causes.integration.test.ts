import { createKnexConfig, insertReturningId } from "@wayscribe/database";
import { startPostgres, type TestDatabase } from "@wayscribe/database/testing";
import { createKeyring, issueApiKey } from "@wayscribe/payload-security";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { MAX_JOURNEY_EVENTS_FOR_CAUSES } from "../journeys/likely-cause.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");
const ADMIN_TOKEN = "admin-token-for-tests-0000000000";

/** Set by one test to make the cause computation throw, as a defect in it would. */
const fault = vi.hoisted(() => ({ throwing: false }));
vi.mock("../journeys/journey-causes.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../journeys/journey-causes.js")>();
  return {
    ...original,
    journeyLikelyCauses: (...args: Parameters<typeof original.journeyLikelyCauses>) => {
      if (fault.throwing) throw new Error("a defect in the cause search");
      return original.journeyLikelyCauses(...args);
    }
  };
});

const MINUTE = 60 * 1000;
/** Relative to the real clock, a minute apart, so timeline order is send order. */
const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * MINUTE).toISOString();

const ACCOUNT = {
  Id: "0018Z00002RCL",
  Name: "Acme Field Services",
  Phone: "+1 919 555 1234",
  Status__c: "Active",
  BillingAddress: { street: "100 Main St", city: "Raleigh", state: "NC", postalCode: "27601" }
};
/** The demo's defect: `Phone` read as `Phone__c`, so `phone` arrives null. */
const CUSTOMER = {
  externalId: "0018Z00002RCL",
  name: "Acme Field Services",
  phone: null,
  status: "active",
  address: { street: "100 Main St", city: "Raleigh", state: "NC", postalCode: "27601" }
};
const REJECTED = {
  status: 422,
  body: {
    error: { code: "phone_required", message: "A phone number is required.", fields: ["phone"] }
  }
};

const JOURNEY = "jrn_likely_cause";
const QUIET = "jrn_likely_cause_quiet";
const AT_CAP = "jrn_likely_cause_at_cap";
const OVER_CAP = "jrn_likely_cause_over_cap";
const STAGING = "jrn_likely_cause_staging";

const CAUSE = {
  field: "phone",
  reportedBy: "evt_lc_deliver",
  eventId: "evt_lc_transform",
  step: "transform-salesforce-account",
  change: {
    kind: "renamed-changed",
    lost: true,
    path: "phone",
    from: "Phone",
    before: "+1 919 555 1234",
    after: null
  },
  alsoChangedAt: []
};

/** ADR-072 through the real routes, with events ingested for real. */
describe("likelyCauses on the journey reads", () => {
  let container: TestDatabase;
  let db: Knex;
  let app: FastifyInstance;
  let apiKey: string;
  /** A key for another project: it must learn nothing from `apiKey`'s journeys. */
  let otherKey: string;
  /** A key for `apiKey`'s project in another environment: the same. */
  let stagingKey: string;
  let projectId: string;

  const envelope = (
    journeyId: string,
    id: string,
    timestamp: string,
    operation: string,
    name: string,
    fields: Record<string, unknown> = {},
    environment?: string
  ): Record<string, unknown> => ({
    protocolVersion: "0.1",
    event: {
      id,
      journeyId,
      environment: environment ?? "development",
      service: "demo-integration",
      entity: { type: "customer", id: `customer-${journeyId}` },
      operation,
      name,
      timestamp,
      ...fields
    }
  });

  const sendAs = async (
    key: string,
    journeyId: string,
    id: string,
    minutes: number,
    operation: string,
    name: string,
    fields: Record<string, unknown> = {}
  ): Promise<void> => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${key}` },
      payload: envelope(
        journeyId,
        id,
        minutesAgo(minutes),
        operation,
        name,
        fields,
        key === stagingKey ? "staging" : undefined
      )
    });
    expect(response.statusCode, response.body).toBe(202);
  };

  const send = (
    journeyId: string,
    id: string,
    minutes: number,
    operation: string,
    name: string,
    fields: Record<string, unknown> = {}
  ): Promise<void> => sendAs(apiKey, journeyId, id, minutes, operation, name, fields);

  /**
   * A journey of exactly `size` events: the transform that loses `phone`,
   * fillers with no diff, and last a delivery whose 422 names `phone`.
   */
  const sendLongJourney = async (journeyId: string, size: number): Promise<void> => {
    const start = Date.now() - 60 * MINUTE;
    const at = (index: number): string => new Date(start + index * 10).toISOString();
    const envelopes = [
      envelope(
        journeyId,
        `${journeyId}_transform`,
        at(0),
        "transformed",
        "transform-salesforce-account",
        {
          input: ACCOUNT,
          output: CUSTOMER
        }
      ),
      ...Array.from({ length: size - 2 }, (_, index) =>
        envelope(
          journeyId,
          `${journeyId}_step_${String(index)}`,
          at(index + 1),
          "validated",
          "validate"
        )
      ),
      envelope(
        journeyId,
        `${journeyId}_deliver`,
        at(size - 1),
        "delivered",
        "deliver-customer-to-target",
        {
          input: CUSTOMER,
          error: { message: "The target refused the customer.", fields: ["phone"] }
        }
      )
    ];
    for (let offset = 0; offset < envelopes.length; offset += 100) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/events/batch",
        headers: { authorization: `Bearer ${apiKey}` },
        payload: { events: envelopes.slice(offset, offset + 100) }
      });
      expect(response.statusCode, response.body).toBe(202);
      const results = response.json<{ data: { results: { status: string }[] } }>().data.results;
      expect(
        results.every((result) => result.status === "accepted"),
        response.body
      ).toBe(true);
    }
  };

  const getAs = async (key: string, url: string): Promise<Record<string, unknown>> => {
    const response = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${key}` }
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ data: Record<string, unknown> }>().data;
  };

  const get = (url: string): Promise<Record<string, unknown>> => getAs(apiKey, url);

  const statusAs = async (key: string, url: string): Promise<number> =>
    (
      await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${key}` }
      })
    ).statusCode;

  const rows = (data: Record<string, unknown>): Record<string, unknown>[] =>
    data["items"] as Record<string, unknown>[];

  const keyIn = async (project: string, environment: string): Promise<string> => {
    const environmentId = await insertReturningId(db, "environments", {
      project_id: project,
      name: environment
    });
    const generated = issueApiKey(keyring);
    await db("api_keys").insert({
      project_id: project,
      environment_id: environmentId,
      name: environment,
      key_prefix: generated.keyPrefix,
      key_hash: generated.verifier,
      key_hash_key_id: generated.keyHashKeyId
    });
    return generated.apiKey;
  };

  beforeAll(async () => {
    container = await startPostgres();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();
    projectId = await insertReturningId(db, "projects", { name: "P", slug: "p" });
    apiKey = await keyIn(projectId, "development");
    stagingKey = await keyIn(projectId, "staging");
    otherKey = await keyIn(
      await insertReturningId(db, "projects", { name: "Other", slug: "other" }),
      "development"
    );
    app = buildApp({
      db,
      keyring,
      adminToken: ADMIN_TOKEN,
      logLevel: "silent"
    });

    await send(JOURNEY, "evt_lc_received", 10, "received", "receive-salesforce-webhook", {
      input: ACCOUNT
    });
    await send(JOURNEY, "evt_lc_transform", 9, "transformed", "transform-salesforce-account", {
      input: ACCOUNT,
      output: CUSTOMER
    });
    // A whole-payload replacement: the customer in, its id out.
    await send(JOURNEY, "evt_lc_persist", 8, "persisted", "persist-customer", {
      input: CUSTOMER,
      output: 4711
    });
    await send(JOURNEY, "evt_lc_deliver", 7, "delivered", "deliver-customer-to-target", {
      input: CUSTOMER,
      output: REJECTED,
      error: {
        message: "deliver-customer-to-target reported a failed result.",
        code: "result_failed",
        fields: ["phone"]
      }
    });
    await send(JOURNEY, "evt_lc_dead_letter", 6, "failed", "move-message-to-dead-letter", {
      error: {
        message: "The target refused the customer; the message moved to the dead-letter queue."
      }
    });

    // A failure that names no field: a timeout.
    await send(QUIET, "evt_lcq_transform", 10, "transformed", "transform-salesforce-account", {
      input: ACCOUNT,
      output: CUSTOMER
    });
    await send(QUIET, "evt_lcq_deliver", 9, "delivered", "deliver-customer-to-target", {
      input: CUSTOMER,
      error: { message: "The operation was aborted due to timeout", type: "TimeoutError" }
    });

    // Another project's journey under the same id: its failure names `phone`
    // and nothing in it changed `phone`. Only `apiKey`'s transform did.
    await sendAs(
      otherKey,
      JOURNEY,
      "evt_lco_deliver",
      7,
      "delivered",
      "deliver-customer-to-target",
      {
        input: CUSTOMER,
        error: { message: "The target refused the customer.", fields: ["phone"] }
      }
    );

    // The same project's staging environment: a failure naming `phone` in a
    // journey of its own, where nothing changed `phone`.
    await sendAs(
      stagingKey,
      STAGING,
      "evt_lcs_deliver",
      7,
      "delivered",
      "deliver-customer-to-target",
      {
        input: CUSTOMER,
        error: { message: "The target refused the customer.", fields: ["phone"] }
      }
    );

    await sendLongJourney(AT_CAP, MAX_JOURNEY_EVENTS_FOR_CAUSES);
    await sendLongJourney(OVER_CAP, MAX_JOURNEY_EVENTS_FOR_CAUSES + 1);
  }, 120_000);

  afterEach(() => {
    fault.throwing = false;
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await container.stop();
  });

  it("puts likelyCauses on each failed row of the timeline, and on no other", async () => {
    const data = await get(`/v1/journeys/${JOURNEY}/events?limit=100`);
    expect(rows(data).map((row) => [row["id"], row["likelyCauses"]])).toEqual([
      ["evt_lc_received", undefined],
      ["evt_lc_transform", undefined],
      ["evt_lc_persist", undefined],
      ["evt_lc_deliver", [CAUSE]],
      ["evt_lc_dead_letter", [CAUSE]]
    ]);
    for (const row of rows(data).slice(0, 3)) expect(row).not.toHaveProperty("likelyCauses");
  });

  it("computes them over the whole journey, whatever page is asked for", async () => {
    const first = await get(`/v1/journeys/${JOURNEY}/events?limit=4`);
    const cursor = first["nextCursor"];
    expect(typeof cursor).toBe("string");
    const second = await get(
      `/v1/journeys/${JOURNEY}/events?limit=4&cursor=${encodeURIComponent(String(cursor))}`
    );
    // The transform the cause names is not on this page. (The page may repeat
    // the previous page's last row: the cursor keeps `received_at` to the
    // millisecond and PostgreSQL stores microseconds.)
    expect(rows(second).map((row) => row["id"])).not.toContain("evt_lc_transform");
    expect(
      rows(second).find((row) => row["id"] === "evt_lc_dead_letter")?.["likelyCauses"]
    ).toEqual([CAUSE]);
  });

  it("returns the failed step's likely causes on the journey read", async () => {
    const journey = await get(`/v1/journeys/${JOURNEY}`);
    expect(journey["failedStep"]).toBe("move-message-to-dead-letter");
    expect(journey["likelyCauses"]).toEqual([CAUSE]);
    expect(journey).not.toHaveProperty("failedStepEventId");
  });

  it("returns them on a failed event's read, and leaves them off any other", async () => {
    expect((await get("/v1/events/evt_lc_dead_letter"))["likelyCauses"]).toEqual([CAUSE]);
    expect(await get("/v1/events/evt_lc_transform")).not.toHaveProperty("likelyCauses");
  });

  it("answers an empty list where the failure names no field", async () => {
    expect((await get(`/v1/journeys/${QUIET}`))["likelyCauses"]).toEqual([]);
    const timeline = await get(`/v1/journeys/${QUIET}/events`);
    expect(rows(timeline).map((row) => [row["id"], row["likelyCauses"]])).toEqual([
      ["evt_lcq_transform", undefined],
      ["evt_lcq_deliver", []]
    ]);
    expect((await get("/v1/events/evt_lcq_deliver"))["likelyCauses"]).toEqual([]);
  });

  it("reads only within the caller's scope", async () => {
    // Another project's key sees its own journey of that id, with no cause:
    // the transform that would be one belongs to a project it cannot read.
    const own = await getAs(otherKey, `/v1/journeys/${JOURNEY}`);
    expect(own["eventCount"]).toBe(1);
    expect(own["likelyCauses"]).toEqual([]);
    const timeline = await getAs(otherKey, `/v1/journeys/${JOURNEY}/events`);
    expect(rows(timeline).map((row) => [row["id"], row["likelyCauses"]])).toEqual([
      ["evt_lco_deliver", []]
    ]);
    expect((await getAs(otherKey, "/v1/events/evt_lco_deliver"))["likelyCauses"]).toEqual([]);
    // And the other project's events stay 404 to it, causes and all.
    expect(await statusAs(otherKey, "/v1/events/evt_lc_dead_letter")).toBe(404);
    expect(await statusAs(otherKey, `/v1/journeys/${QUIET}`)).toBe(404);
  });

  it("reads only within the caller's environment", async () => {
    // A journey belongs to one environment (409 otherwise), so the development
    // journey and its events are not found by a staging key, causes and all.
    for (const url of [
      `/v1/journeys/${JOURNEY}`,
      `/v1/journeys/${JOURNEY}/events`,
      "/v1/events/evt_lc_dead_letter"
    ]) {
      expect(await statusAs(stagingKey, url)).toBe(404);
    }
    // Its own failure gets no cause from development's transform.
    expect((await getAs(stagingKey, `/v1/journeys/${STAGING}`))["likelyCauses"]).toEqual([]);
    const timeline = await getAs(stagingKey, `/v1/journeys/${STAGING}/events`);
    expect(rows(timeline).map((row) => [row["id"], row["likelyCauses"]])).toEqual([
      ["evt_lcs_deliver", []]
    ]);
    expect((await getAs(stagingKey, "/v1/events/evt_lcs_deliver"))["likelyCauses"]).toEqual([]);
  });

  it("keeps the cause search in the caller's environment even inside one journey", async () => {
    // Defense in depth: the ingestion rule above is what keeps a journey in
    // one environment, so plant the row it would refuse, a staging copy of a
    // development failure. The staging key can read that event; the search
    // must still see only staging's events, not development's transform.
    const columns = (
      await db("information_schema.columns")
        .where({ table_name: "journey_events" })
        .pluck<string[]>("column_name")
    ).filter((column) => !["id", "environment_id"].includes(column));
    const staging = await db("environments")
      .where({ project_id: projectId, name: "staging" })
      .first<{ id: string }>("id");
    await db.raw(
      `insert into journey_events (id, environment_id, ${columns.map((c) => `"${c}"`).join(", ")})
       select 'evt_lc_planted', ?, ${columns.map((c) => `"${c}"`).join(", ")}
       from journey_events where id = 'evt_lc_deliver'`,
      [staging.id]
    );
    try {
      expect((await getAs(stagingKey, "/v1/events/evt_lc_planted"))["likelyCauses"]).toEqual([]);
    } finally {
      await db("journey_events").where({ id: "evt_lc_planted" }).delete();
    }
  });

  it("gives an admin, who reads every environment, the full cause", async () => {
    const asAdmin = async (url: string): Promise<Record<string, unknown>> => {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "x-wayscribe-project-id": projectId }
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json<{ data: Record<string, unknown> }>().data;
    };
    expect((await asAdmin(`/v1/journeys/${JOURNEY}`))["likelyCauses"]).toEqual([CAUSE]);
    const timeline = await asAdmin(`/v1/journeys/${JOURNEY}/events`);
    expect(
      rows(timeline).find((row) => row["id"] === "evt_lc_dead_letter")?.["likelyCauses"]
    ).toEqual([CAUSE]);
    expect((await asAdmin("/v1/events/evt_lc_dead_letter"))["likelyCauses"]).toEqual([CAUSE]);
  });

  it("answers the read without causes when computing them throws", async () => {
    fault.throwing = true;
    const journey = await get(`/v1/journeys/${JOURNEY}`);
    expect(journey["failedStep"]).toBe("move-message-to-dead-letter");
    expect(journey["likelyCauses"]).toEqual([]);
    const timeline = await get(`/v1/journeys/${JOURNEY}/events?limit=100`);
    expect(rows(timeline).map((row) => [row["id"], row["likelyCauses"]])).toEqual([
      ["evt_lc_received", undefined],
      ["evt_lc_transform", undefined],
      ["evt_lc_persist", undefined],
      ["evt_lc_deliver", []],
      ["evt_lc_dead_letter", []]
    ]);
    const event = await get("/v1/events/evt_lc_dead_letter");
    expect(event["id"]).toBe("evt_lc_dead_letter");
    expect(event["likelyCauses"]).toEqual([]);
  });

  it("still links a journey of exactly the cap", async () => {
    const cause = {
      field: "phone",
      reportedBy: `${AT_CAP}_deliver`,
      eventId: `${AT_CAP}_transform`,
      step: "transform-salesforce-account"
    };
    const journey = await get(`/v1/journeys/${AT_CAP}`);
    expect(journey["eventCount"]).toBe(MAX_JOURNEY_EVENTS_FOR_CAUSES);
    expect(journey["likelyCauses"]).toEqual([expect.objectContaining(cause)]);
    expect((await get(`/v1/events/${AT_CAP}_deliver`))["likelyCauses"]).toEqual([
      expect.objectContaining(cause)
    ]);
  });

  it("answers no causes past the cap, and says nothing about why", async () => {
    const journey = await get(`/v1/journeys/${OVER_CAP}`);
    expect(journey["eventCount"]).toBe(MAX_JOURNEY_EVENTS_FOR_CAUSES + 1);
    expect(journey["failedStep"]).toBe("deliver-customer-to-target");
    expect(journey["likelyCauses"]).toEqual([]);
    expect((await get(`/v1/events/${OVER_CAP}_deliver`))["likelyCauses"]).toEqual([]);
  });
});
