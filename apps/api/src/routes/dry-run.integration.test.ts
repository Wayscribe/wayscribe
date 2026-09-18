import { createKnexConfig, insertReturningId } from "@wayscribe/database";
import { createKeyring, issueApiKey } from "@wayscribe/payload-security";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { buildApp } from "../app.js";
import { DRY_RUN_EVENT_LOCK, DRY_RUN_JOURNEY_LOCK, dryRunLockKey, dryRunLocks } from "./events.js";
import { createApiMetrics, type ApiMetrics } from "../metrics/api-metrics.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");
const NUL = "\u0000";

/**
 * Every table the schema has, so "nothing is stored" is a statement about the
 * database rather than about the four tables somebody remembered.
 *
 * Read from the catalogue rather than listed, so a migration that adds a table
 * is covered the day it lands.
 */
async function rowCounts(db: Knex): Promise<Record<string, number>> {
  const tables: { table_name: string }[] = await db("information_schema.tables")
    .where({ table_schema: "public" })
    .andWhere({ table_type: "BASE TABLE" })
    .select("table_name");

  const counts: Record<string, number> = {};
  for (const { table_name: name } of tables) {
    const row: unknown = await db(name).count({ n: "*" }).first();
    counts[name] = Number((row as { n: string }).n);
  }
  return counts;
}

function envelope(overrides: Record<string, unknown> = {}): unknown {
  return {
    protocolVersion: "0.1",
    event: {
      id: "evt_dry_1",
      journeyId: "jrn_dry_1",
      environment: "development",
      service: "customer-integration",
      entity: { type: "customer", id: "0018Z00002ABC" },
      operation: "transformed",
      name: "transform-salesforce-account",
      timestamp: "2026-08-06T18:31:04.120Z",
      aliases: { salesforceAccountId: "0018Z00002ABC" },
      input: { phone: "+1 919 555 1234", authorization: "Bearer secret" },
      output: { phone: null, authorization: "Bearer secret" },
      ...overrides
    }
  };
}

describe("dry-run validation", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let app: FastifyInstance;
  let metrics: ApiMetrics;
  let apiKey: string;
  let otherKey: string;
  let projectId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(inject("postgresImage")).start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();

    projectId = await insertReturningId(db, "projects", { name: "P", slug: "p" });
    const developmentId = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: "development"
    });
    const stagingId = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: "staging"
    });

    for (const [name, environmentId] of [
      ["development", developmentId],
      ["staging", stagingId]
    ] as const) {
      const generated = issueApiKey(keyring);
      if (name === "development") apiKey = generated.apiKey;
      else otherKey = generated.apiKey;
      await db("api_keys").insert({
        project_id: projectId,
        environment_id: environmentId,
        name,
        key_prefix: generated.keyPrefix,
        key_hash: generated.verifier,
        key_hash_key_id: generated.keyHashKeyId
      });
    }

    metrics = createApiMetrics(db);
    app = buildApp({
      db,
      keyring,
      metrics,
      adminToken: "admin-token-for-tests-0000000000",
      logLevel: "silent"
    });
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await container.stop();
  });

  const batch = (events: unknown[], query = "?dryRun=true", key = apiKey) =>
    app.inject({
      method: "POST",
      url: `/v1/events/batch${query}`,
      headers: { authorization: `Bearer ${key}` },
      payload: { events } as object
    });

  describe("nothing is written", () => {
    it("leaves every table's row count unchanged, audit_events included", async () => {
      // A batch that exercises every path the dry run can take, including the
      // two that throw: an unstorable payload, and a statement the database
      // cancels. A rollback that worked for the happy path and not for a throw
      // would be worse than no rollback at all, because it would be invisible.
      const before = await rowCounts(db);
      expect(Object.keys(before)).toContain("audit_events");
      expect(Object.keys(before).length).toBeGreaterThan(5);

      const response = await batch([
        envelope({ id: "evt_nothing_1", journeyId: "jrn_nothing" }),
        envelope({ id: "evt_nothing_2", journeyId: "jrn_nothing", input: { name: `X${NUL}` } }),
        { protocolVersion: "0.1", event: { id: "evt_nothing_bad" } }
      ]);
      expect(response.statusCode, response.body).toBe(200);

      const after = await rowCounts(db);
      expect(after).toEqual(before);
    });

    it("rolls back when an event throws past the loop, and answers for the rest", async () => {
      const before = await rowCounts(db);
      const response = await batch([
        envelope({ id: "evt_throw_1", journeyId: "jrn_throw", input: { name: `X${NUL}` } }),
        envelope({ id: "evt_throw_2", journeyId: "jrn_throw" })
      ]);
      const results = response.json().data.results;
      // The savepoint rolled back that event alone: the outer transaction was
      // still usable, so the second event got a real verdict.
      expect(results[0].error.code).toBe("unstorable_payload");
      expect(results[1].status).toBe("accepted");
      expect(await rowCounts(db)).toEqual(before);
    });

    it("stores nothing for POST /v1/events?dryRun=true, which it refuses", async () => {
      const before = await rowCounts(db);
      const response = await app.inject({
        method: "POST",
        url: "/v1/events?dryRun=true",
        headers: { authorization: `Bearer ${apiKey}` },
        payload: envelope({ id: "evt_wrong_route", journeyId: "jrn_wrong_route" }) as object
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error.code).toBe("invalid_query");
      expect(await rowCounts(db)).toEqual(before);
    });
  });

  describe("the dryRun parameter", () => {
    it.each([
      ["repeated", "?dryRun=true&dryRun=false"],
      ["written as 1", "?dryRun=1"],
      ["empty", "?dryRun="],
      ["capitalized value", "?dryRun=True"]
    ])("%s is a 400 invalid_query", async (_name, query) => {
      const response = await batch([], query);
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error.code).toBe("invalid_query");
    });

    /**
     * A misspelled parameter used to be ignored, and the batch stored.
     *
     * That is the exact failure the single-event route refuses the parameter to
     * avoid: a client believing it had validated a batch it had in fact
     * written. Reading it case-insensitively would have fixed `dryrun` and not
     * `dryRum`, so the route refuses any query key it does not know instead.
     * Nothing legitimate adds a query parameter to ingestion.
     */
    it.each([
      ["lower case", "?dryrun=true"],
      ["upper case", "?DRYRUN=true"],
      ["a typo", "?dryRum=true"],
      ["a trailing space", "?dryRun%20=true"],
      ["an unrelated parameter", "?dryRun=true&utm_source=docs"]
    ])("%s is a 400 invalid_query, and stores nothing", async (_name, query) => {
      const before = await rowCounts(db);
      const response = await batch(
        [envelope({ id: `evt_typo_${String(query.length)}`, journeyId: "jrn_typo" })],
        query
      );
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error.code).toBe("invalid_query");
      expect(await rowCounts(db)).toEqual(before);
    });

    it("refuses an unknown query key on the single-event route too", async () => {
      const before = await rowCounts(db);
      const response = await app.inject({
        method: "POST",
        url: "/v1/events?dryrun=true",
        headers: { authorization: `Bearer ${apiKey}` },
        payload: envelope({ id: "evt_typo_single", journeyId: "jrn_typo" }) as object
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error.code).toBe("invalid_query");
      expect(await rowCounts(db)).toEqual(before);
    });

    it("still accepts a request with no query at all", async () => {
      // The control: refusing unknown keys must not refuse the ordinary send.
      const response = await batch(
        [envelope({ id: "evt_no_query", journeyId: "jrn_no_query" })],
        ""
      );
      expect(response.statusCode, response.body).toBe(202);
    });

    it("dryRun=false is an ordinary send", async () => {
      const response = await batch(
        [envelope({ id: "evt_false", journeyId: "jrn_false" })],
        "?dryRun=false"
      );
      expect(response.statusCode, response.body).toBe(202);
      expect(response.json().data.dryRun).toBeUndefined();
      const stored = await db("journey_events")
        .where({ project_id: projectId, id: "evt_false" })
        .first();
      expect(stored).toBeDefined();
    });

    it("is refused before the credential is checked, so a bad key cannot hide it", async () => {
      const response = await batch([], "?dryRun=maybe", "wsk_not_a_key");
      expect(response.statusCode).toBe(400);
    });

    it("refuses an admin token as a real send does", async () => {
      const response = await batch([], "?dryRun=true", "admin-token-for-tests-0000000000");
      expect(response.statusCode).toBe(401);
    });
  });

  describe("the results equal the same batch sent for real", () => {
    /**
     * The comparison that matters, and the only honest way to make it: the same
     * events, once validated and once stored, compared event by event. A list
     * of expected results written by hand would be a second implementation of
     * the rules, and it would agree with the code that was written beside it
     * rather than with the code that runs.
     */
    const suffix = (n: string) => `_same_${n}`;
    const CROSS_JOURNEY = "jrn_cross_environment";

    const mixedBatch = (run: string): unknown[] => [
      // An accept.
      envelope({ id: `evt${suffix(run)}_a`, journeyId: `jrn${suffix(run)}` }),
      // A duplicate of the event two lines up, inside the same request.
      envelope({ id: `evt${suffix(run)}_a`, journeyId: `jrn${suffix(run)}` }),
      // A conflict: the same id with one field changed.
      envelope({ id: `evt${suffix(run)}_a`, journeyId: `jrn${suffix(run)}`, name: "changed" }),
      // Refused by the key's environment.
      envelope({
        id: `evt${suffix(run)}_env`,
        journeyId: `jrn${suffix(run)}_env`,
        environment: "staging"
      }),
      // Refused by validation.
      { protocolVersion: "0.1", event: { id: `evt${suffix(run)}_bad` } },
      // Refused by the size limit. Ten strings each under the per-string cap,
      // so this is the envelope's serialized size and not max_string_length.
      envelope({
        id: `evt${suffix(run)}_big`,
        journeyId: `jrn${suffix(run)}_big`,
        input: { padding: Array.from({ length: 10 }, () => "x".repeat(60_000)) }
      }),
      // Refused by PostgreSQL.
      envelope({
        id: `evt${suffix(run)}_nul`,
        journeyId: `jrn${suffix(run)}_nul`,
        input: { name: `Dana${NUL}` }
      }),
      // Refused because the journey belongs to another environment, which the
      // staging key created for real before the comparison ran.
      envelope({ id: `evt${suffix(run)}_cross`, journeyId: CROSS_JOURNEY })
    ];

    it("matches, event by event, for accepts, duplicates, conflicts and every refusal", async () => {
      // The prior row the cross-environment case needs. Stored for real, by the
      // other environment's key, which is the only way that journey exists.
      const seeded = await batch(
        [
          envelope({
            id: "evt_cross_seed",
            journeyId: CROSS_JOURNEY,
            environment: "staging"
          })
        ],
        "?dryRun=false",
        otherKey
      );
      expect(seeded.json().data.results[0].status, seeded.body).toBe("accepted");

      const previewed = await batch(mixedBatch("x"), "?dryRun=true");
      expect(previewed.statusCode, previewed.body).toBe(200);
      const real = await batch(mixedBatch("x"), "?dryRun=false");
      expect(real.statusCode, real.body).toBe(202);

      const previewedResults = previewed.json().data.results as Record<string, unknown>[];
      const realResults = real.json().data.results as Record<string, unknown>[];

      expect(previewedResults.length).toBe(realResults.length);
      for (const [index, previewedOne] of previewedResults.entries()) {
        // `stored` is the dry run's own addition and has no counterpart in a
        // real send, so it is set aside and asserted separately below.
        const { stored: _preview, ...verdict } = previewedOne;
        expect(verdict, `result ${String(index)}`).toEqual(realResults[index]);
      }

      // The control: a batch of eight identical accepts would satisfy the loop
      // above. These are the eight distinct outcomes it is meant to cover.
      expect(previewedResults.map((one) => one["status"])).toEqual([
        "accepted",
        "accepted",
        "rejected",
        "rejected",
        "rejected",
        "rejected",
        "rejected",
        "rejected"
      ]);
      expect(previewedResults[1]?.["duplicate"]).toBe(true);
      expect(codesOf(previewedResults)).toEqual([
        "event_id_conflict",
        "unauthorized_environment",
        "invalid_event",
        "payload_too_large",
        "unstorable_payload",
        "journey_environment_mismatch"
      ]);
    });

    it("previews the stored event and journey the reads return, minus receivedAt", async () => {
      const events = [envelope({ id: "evt_preview", journeyId: "jrn_preview" })];
      const previewed = await batch(events, "?dryRun=true");
      const stored = previewed.json().data.results[0].stored;
      expect(stored).toBeDefined();

      const real = await batch(events, "?dryRun=false");
      expect(real.statusCode, real.body).toBe(202);

      const readEvent = await app.inject({
        method: "GET",
        url: "/v1/events/evt_preview",
        headers: { authorization: `Bearer ${apiKey}` }
      });
      const readJourney = await app.inject({
        method: "GET",
        url: "/v1/journeys/jrn_preview",
        headers: { authorization: `Bearer ${apiKey}` }
      });
      expect(readEvent.statusCode, readEvent.body).toBe(200);
      expect(readJourney.statusCode, readJourney.body).toBe(200);

      const { receivedAt, ...expectedEvent } = readEvent.json().data as Record<string, unknown>;
      expect(receivedAt, "the read still returns receivedAt").toBeTypeOf("string");
      expect(stored.event).toEqual(expectedEvent);
      expect(stored.event.receivedAt).toBeUndefined();
      expect(stored.journey).toEqual(readJourney.json().data);
      // Not vacuous: the preview really did carry the redacted payload and the
      // diff, which is the whole reason a conformance case can assert on it.
      expect(stored.event.inputPayload.authorization).toBe("[REDACTED]");
      expect(stored.event.payloadDiff.changes.length).toBeGreaterThan(0);
      expect(stored.journey.aliases.length).toBe(1);
    });

    it("omits stored for a duplicate and for a rejection", async () => {
      const first = envelope({ id: "evt_omit", journeyId: "jrn_omit" });
      await batch([first], "?dryRun=false");
      const response = await batch([first, { protocolVersion: "0.1", event: {} }], "?dryRun=true");
      const results = response.json().data.results;
      expect(results[0].duplicate).toBe(true);
      expect(results[0].stored).toBeUndefined();
      expect(results[1].stored).toBeUndefined();
    });
  });

  describe("dry runs that share journeys (ADR-063)", () => {
    /** Every statement the pool runs while `work` does, in order. */
    async function statementsDuring(work: () => Promise<unknown>): Promise<string[]> {
      const seen: string[] = [];
      const listener = (query: { sql: string }): void => {
        seen.push(query.sql);
      };
      db.on("query", listener);
      try {
        await work();
      } finally {
        db.off("query", listener);
      }
      return seen;
    }

    const LOCK = /pg_advisory_xact_lock\((-?\d+), (-?\d+)\)/;
    const locksIn = (statements: string[]): [number, number][] =>
      statements.flatMap((sql) => {
        const match = LOCK.exec(sql);
        return match === null ? [] : [[Number(match[1]), Number(match[2])] as [number, number]];
      });

    it("never deadlocks two dry runs over two journeys in opposite orders (the reviewer's reproduction, 50 runs)", async () => {
      // Each dry run creates and locks its journeys in the order sent and holds
      // them to its rollback, so without the up-front locks the two wait on
      // each other, PostgreSQL cancels one, and a preview answered
      // storage_error for events a real send would store.
      const a = (id: string) => envelope({ id, journeyId: "jrn_lock_a" });
      const b = (id: string) => envelope({ id, journeyId: "jrn_lock_b" });
      const failures: string[] = [];
      for (let run = 0; run < 50; run += 1) {
        const [first, second] = await Promise.all([
          batch([a("evt_lock_1a"), b("evt_lock_1b")]),
          batch([b("evt_lock_2b"), a("evt_lock_2a")])
        ]);
        for (const response of [first, second]) {
          if (response.statusCode !== 200) {
            failures.push(`run ${String(run)}: ${String(response.statusCode)} ${response.body}`);
            continue;
          }
          const codes = codesOf(response.json().data.results);
          if (codes.length > 0) failures.push(`run ${String(run)}: ${codes.join(", ")}`);
        }
      }
      expect(failures).toEqual([]);
    }, 120_000);

    it("never deadlocks two dry runs sending the same event ids under different journeys in opposite orders (20 runs)", async () => {
      // Event ids are unique per project whatever the journey, so the second
      // insert of an id waits on the first's uncommitted row. With journey
      // locks alone the two dry runs share no key, each holds one event id
      // and waits for the other, and one is cancelled as storage_error.
      const x = (journeyId: string) => envelope({ id: "evt_shared_x", journeyId });
      const y = (journeyId: string) => envelope({ id: "evt_shared_y", journeyId });
      const failures: string[] = [];
      for (let run = 0; run < 20; run += 1) {
        const [first, second] = await Promise.all([
          batch([x("jrn_shared_p"), y("jrn_shared_q")]),
          batch([y("jrn_shared_r"), x("jrn_shared_s")])
        ]);
        for (const response of [first, second]) {
          if (response.statusCode !== 200) {
            failures.push(`run ${String(run)}: ${String(response.statusCode)} ${response.body}`);
            continue;
          }
          const codes = codesOf(response.json().data.results);
          if (codes.length > 0) failures.push(`run ${String(run)}: ${codes.join(", ")}`);
        }
      }
      expect(failures).toEqual([]);
    }, 120_000);

    it("takes one lock per distinct journey and event id, one statement each, in ascending order, before any event", async () => {
      const events = [
        envelope({ id: "evt_keys_1", journeyId: "jrn_keys_c" }),
        envelope({ id: "evt_keys_2", journeyId: "jrn_keys_a" }),
        envelope({ id: "evt_keys_3", journeyId: "jrn_keys_c" }),
        // Elements with no journey id or event id to read add no lock.
        { protocolVersion: "0.1", event: {} },
        { protocolVersion: "0.1", event: { journeyId: 42 } },
        { protocolVersion: "0.1" },
        "not an object",
        null,
        envelope({ id: "evt_keys_4", journeyId: "jrn_keys_b" })
      ];
      let response: Awaited<ReturnType<typeof batch>> | undefined;
      const statements = await statementsDuring(async () => {
        response = await batch(events);
      });
      expect(response?.statusCode, response?.body).toBe(200);
      const results = response?.json().data.results as Record<string, unknown>[];
      expect(results.map((one) => one["status"])).toEqual([
        "accepted",
        "accepted",
        "accepted",
        "rejected",
        "rejected",
        "rejected",
        "rejected",
        "rejected",
        "accepted"
      ]);

      const ascending = (ids: string[]): number[] =>
        ids.map((id) => dryRunLockKey(projectId, id)).sort((x, y) => x - y);
      const expected = [
        ...ascending(["jrn_keys_a", "jrn_keys_b", "jrn_keys_c"]).map((key) => [
          DRY_RUN_JOURNEY_LOCK,
          key
        ]),
        ...ascending(["evt_keys_1", "evt_keys_2", "evt_keys_3", "evt_keys_4"]).map((key) => [
          DRY_RUN_EVENT_LOCK,
          key
        ])
      ];
      const locks = locksIn(statements);
      expect(locks).toEqual(expected);
      expect(dryRunLocks(projectId, events)).toEqual(expected);
      // Every lock statement comes before the first write of the batch.
      const lastLock = statements.findLastIndex((sql) => LOCK.test(sql));
      const firstWrite = statements.findIndex((sql) => /insert into "journeys"/.test(sql));
      expect(firstWrite).toBeGreaterThan(lastLock);
    });

    it("takes no lock for a batch sent for real, however many journeys it names", async () => {
      const statements = await statementsDuring(async () => {
        const response = await batch(
          [
            envelope({ id: "evt_live_lock_1", journeyId: "jrn_live_lock_a" }),
            envelope({ id: "evt_live_lock_2", journeyId: "jrn_live_lock_b" })
          ],
          "?dryRun=false"
        );
        expect(response.statusCode, response.body).toBe(202);
      });
      // Not vacuous: the listener saw the batch's own statements.
      expect(statements.some((sql) => /insert into "journey_events"/.test(sql))).toBe(true);
      expect(statements.filter((sql) => /advisory/.test(sql))).toEqual([]);
    });

    it("answers 503 query_timeout when another dry run holds a journey past the statement timeout", async () => {
      const timed = knex(
        createKnexConfig(container.getConnectionUri(), { statementTimeoutMs: 500 })
      );
      const timedApp = buildApp({
        db: timed,
        keyring,
        adminToken: "admin-token-for-tests-0000000000",
        logLevel: "silent"
      });
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let holding: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        holding = resolve;
      });
      const holder = db.transaction(async (trx) => {
        await trx.raw(
          `select pg_advisory_xact_lock(${String(DRY_RUN_JOURNEY_LOCK)}, ${String(
            dryRunLockKey(projectId, "jrn_lock_held")
          )})`
        );
        holding();
        await released;
      });
      try {
        await held;
        const response = await timedApp.inject({
          method: "POST",
          url: "/v1/events/batch?dryRun=true",
          headers: { authorization: `Bearer ${apiKey}` },
          payload: {
            events: [envelope({ id: "evt_lock_held", journeyId: "jrn_lock_held" })]
          } as object
        });
        expect(response.statusCode, response.body).toBe(503);
        expect(response.json().error.code).toBe("query_timeout");
      } finally {
        release();
        await holder;
        await timedApp.close();
        await timed.destroy();
      }
    });
  });

  describe("bookkeeping", () => {
    /**
     * A key nothing has presented yet, with `last_used_at` never set.
     *
     * `touch` is throttled to once a minute per key in a map that lives as long
     * as the process, so a key any earlier test has used would be skipped here
     * and this test would prove nothing while passing.
     */
    async function freshKey(issueUnder = keyring): Promise<{ apiKey: string; keyPrefix: string }> {
      const environment: { id: string } = await db("environments")
        .where({ project_id: projectId, name: "development" })
        .first("id");
      const generated = issueApiKey(issueUnder);
      await db("api_keys").insert({
        project_id: projectId,
        environment_id: environment.id,
        name: `fresh-${generated.keyPrefix}`,
        key_prefix: generated.keyPrefix,
        key_hash: generated.verifier,
        key_hash_key_id: generated.keyHashKeyId,
        last_used_at: null
      });
      return { apiKey: generated.apiKey, keyPrefix: generated.keyPrefix };
    }

    const keyRow = async (keyPrefix: string): Promise<Record<string, unknown>> =>
      (await db("api_keys").where({ key_prefix: keyPrefix }).first()) as Record<string, unknown>;

    it("moves last_used_at, because a key a conformance job uses is a key in use", async () => {
      // Left stale, an operator reads the key CI depends on as abandoned and
      // revokes it.
      const key = await freshKey();
      expect((await keyRow(key.keyPrefix))["last_used_at"]).toBeNull();

      const response = await batch(
        [envelope({ id: "evt_touch", journeyId: "jrn_touch" })],
        "?dryRun=true",
        key.apiKey
      );
      expect(response.statusCode, response.body).toBe(200);

      // The write is deliberately not awaited by the route, so the reply can go
      // out without it. Polled rather than slept on a fixed number.
      await waitFor(async () => (await keyRow(key.keyPrefix))["last_used_at"] !== null);
    });

    it("migrates a verifier written under the previous key, as a real send does", async () => {
      // Skipping the migration would leave a key used only by a conformance job
      // failing the moment the rotation's grace period ended.
      const older = createKeyring("fedcba9876543210fedcba9876543210");
      const rotated = createKeyring(
        "0123456789abcdef0123456789abcdef",
        "fedcba9876543210fedcba9876543210"
      );
      const key = await freshKey(older);
      expect((await keyRow(key.keyPrefix))["key_hash_key_id"]).toBe(older.current.id);

      const rotatedApp = buildApp({
        db,
        keyring: rotated,
        adminToken: "admin-token-for-tests-0000000000",
        logLevel: "silent"
      });
      const response = await rotatedApp.inject({
        method: "POST",
        url: "/v1/events/batch?dryRun=true",
        headers: { authorization: `Bearer ${key.apiKey}` },
        payload: { events: [envelope({ id: "evt_rotate", journeyId: "jrn_rotate" })] } as object
      });
      expect(response.statusCode, response.body).toBe(200);
      await rotatedApp.close();

      await waitFor(
        async () => (await keyRow(key.keyPrefix))["key_hash_key_id"] === rotated.current.id
      );
    });

    it("does not count a dry run in the ingested-events metric", async () => {
      // An operator alerting on rejected events must not be paged by a suite
      // that sends refusals on purpose.
      const before = await metricsText(metrics);
      await batch([
        envelope({ id: "evt_metric_ok", journeyId: "jrn_metric" }),
        { protocolVersion: "0.1", event: {} }
      ]);
      expect(await metricsText(metrics)).toBe(before);

      // The control: the same batch sent for real does move it.
      await batch(
        [
          envelope({ id: "evt_metric_ok", journeyId: "jrn_metric" }),
          { protocolVersion: "0.1", event: {} }
        ],
        "?dryRun=false"
      );
      expect(await metricsText(metrics)).not.toBe(before);
    });
  });
});

function codesOf(results: Record<string, unknown>[]): unknown[] {
  return results
    .filter((one) => one["status"] === "rejected")
    .map((one) => (one["error"] as { code: unknown }).code);
}

/** Only the ingested-events series, so an unrelated counter cannot mask a change. */
async function metricsText(metrics: ApiMetrics): Promise<string> {
  const text = await metrics.render();
  return text
    .split("\n")
    .filter((line) => line.includes("events_total"))
    .join("\n");
}

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the condition never became true");
}
