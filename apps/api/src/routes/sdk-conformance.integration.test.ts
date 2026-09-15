import { fileURLToPath } from "node:url";
import { createKnexConfig, insertReturningId } from "@flight-recorder/database";
import { captureCase, type CapturedCase } from "@flight-recorder/node/conformance-harness";
import { createKeyring, issueApiKey } from "@flight-recorder/payload-security";
import {
  appliesTo,
  compareExpectation,
  expand,
  loadConformanceCases
} from "@flight-recorder/protocol/conformance";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

/**
 * The SDK's captured bytes, sent to the dry run.
 *
 * This is the procedure any implementation in any language follows: record,
 * capture what your SDK put on the wire, send those exact bytes to
 * `POST /v1/events/batch?dryRun=true`, and compare `stored` with the case's
 * expectation. The SDK never calls the dry run itself, and nothing here builds
 * a request body of its own: the bytes come from the recorder's own transport,
 * captured by the unit harness in `packages/sdk-node`.
 */
const keyring = createKeyring("0123456789abcdef0123456789abcdef");
const sdkDirectory = fileURLToPath(
  new URL("../../../../packages/protocol/conformance/sdk", import.meta.url)
);
const LANGUAGE = "node";
const ENVIRONMENT = "conformance";

describe("sdk conformance cases through the dry run", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let app: FastifyInstance;
  let apiKey: string;
  let projectId: string;

  const cases = loadConformanceCases(sdkDirectory).filter((one) => appliesTo(one, LANGUAGE));
  const captured = new Map<string, CapturedCase>();

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();

    projectId = await insertReturningId(db, "projects", { name: "sdk", slug: "sdk" });
    const environmentId = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: ENVIRONMENT
    });
    const generated = issueApiKey(keyring);
    apiKey = generated.apiKey;
    await db("api_keys").insert({
      project_id: projectId,
      environment_id: environmentId,
      name: "sdk",
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

    for (const one of cases) captured.set(one.id, await captureCase(one, "fixture"));
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await container.stop();
  });

  /**
   * Send what the recorder sent, in batches of at most the ceiling.
   *
   * The envelope is rebuilt around each captured event rather than replayed as
   * a whole request, because the recorder's own batching is the SDK unit test's
   * subject; here the question is only what the server would store.
   */
  async function dryRun(events: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
    const results: Record<string, unknown>[] = [];
    for (let start = 0; start < events.length; start += 100) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/events/batch?dryRun=true",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        payload: JSON.stringify({
          events: events
            .slice(start, start + 100)
            .map((event) => ({ protocolVersion: "0.1", event }))
        })
      });
      expect(response.statusCode, response.body).toBe(200);
      results.push(...(response.json().data.results as Record<string, unknown>[]));
    }
    return results;
  }

  it("has cases to run", () => {
    expect(cases.length).toBeGreaterThanOrEqual(19);
  });

  describe.each(cases.map((one) => [one.id, one] as const))("%s", (id, one) => {
    it("is accepted, and stores what the case expects", async () => {
      const capture = captured.get(id);
      expect(capture, "the case was never captured").toBeDefined();
      if (capture === undefined) return;

      const expected = one.expect.results ?? [];
      const results = await dryRun(capture.events);
      expect(results.length, "one result per recorded event").toBe(expected.length);

      const problems: string[] = [];
      for (const [index, want] of expected.entries()) {
        const actual = results[index] ?? {};
        const at = `results[${String(index)}]`;
        if (actual["status"] !== want.status) {
          problems.push(
            `${at}.status: expected ${want.status}, got ${String(actual["status"])} ${JSON.stringify(actual["error"])}`
          );
        }
        if (want.stored === undefined) continue;

        const stored = actual["stored"] as { event?: unknown; journey?: unknown } | undefined;
        if (stored === undefined) {
          problems.push(`${at}.stored: expected a preview, got none`);
          continue;
        }
        if (want.stored.event !== undefined) {
          problems.push(
            ...compareExpectation(
              stored.event,
              expand(want.stored.event, { run: "fixture" }),
              `${at}.stored.event`
            )
          );
        }
        if (want.stored.journey !== undefined) {
          problems.push(
            ...compareExpectation(
              stored.journey,
              expand(want.stored.journey, { run: "fixture" }),
              `${at}.stored.journey`
            )
          );
        }
      }
      expect(problems).toEqual([]);
    });
  });

  it("stored nothing, across every case it just validated", async () => {
    // The whole point of sending an SDK's bytes to the dry run rather than for
    // real: a conformance suite leaves no trail in the database it probed.
    for (const table of ["journey_events", "journeys", "entity_aliases"]) {
      const row: unknown = await db(table)
        .where({ project_id: projectId })
        .count({ n: "*" })
        .first();
      expect(Number((row as { n: string }).n), `${table} holds rows`).toBe(0);
    }
  });

  it("shows the server accepting what a wire sender is refused for", async () => {
    // The pair that documents both halves: wire/nul-byte-in-payload and
    // wire/lone-surrogate-in-payload are 400 unstorable_payload, and these are
    // the same values after the SDK repaired them.
    for (const id of ["sdk/nul-byte", "sdk/lone-surrogate"]) {
      const capture = captured.get(id);
      expect(capture, id).toBeDefined();
      const results = await dryRun(capture?.events ?? []);
      expect(results[0]?.["status"], id).toBe("accepted");
    }
  });
});
