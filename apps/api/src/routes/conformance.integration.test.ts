import { fileURLToPath } from "node:url";
import { createKnexConfig, insertReturningId } from "@flight-recorder/database";
import { createKeyring, issueApiKey } from "@flight-recorder/payload-security";
import {
  compareExpectation,
  expand,
  expectedCaseIds,
  loadConformanceCases,
  type ConformanceCase
} from "@flight-recorder/protocol/conformance";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

/**
 * Every wire conformance case, run twice against a real PostgreSQL: once sent
 * for real and read back through the read routes, and once through the dry run.
 *
 * Both have to equal the same expectation, which is what ties the dry run to
 * reality. If the preview ever stops matching what a real send stores, every
 * case fails at once rather than the two drifting quietly apart.
 *
 * The expectations were written from the documents each case names in `source`
 * before any of them was run. Where a run disagreed with an expectation, the
 * task decided which side was wrong and recorded it; pasting actual output into
 * an expectation is how a suite comes to bless a defect.
 */
const keyring = createKeyring("0123456789abcdef0123456789abcdef");
const wireDirectory = fileURLToPath(
  new URL("../../../../packages/protocol/conformance/wire", import.meta.url)
);

const ENVIRONMENT = "conformance";
const OTHER_ENVIRONMENT = "conformance-other";

interface Provisioned {
  app: FastifyInstance;
  key: string;
  otherKey: string;
  projectId: string;
}

describe("wire conformance cases", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  /** Two apps, because full capture is a process-level setting and not a per-key one. */
  let apps: { plain: FastifyInstance; fullCapture: FastifyInstance };
  let counter = 0;
  /** What each dry run's own project is allowed to hold afterwards. */
  const dryRunProjects: { projectId: string; caseId: string; setupEvents: number }[] = [];

  const cases = loadConformanceCases(wireDirectory);

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();
    const options = { db, keyring, adminToken: "admin-token-for-tests-0000000000" } as const;
    apps = {
      plain: buildApp({ ...options, logLevel: "silent" }),
      fullCapture: buildApp({ ...options, logLevel: "silent", allowFullPayloadCapture: true })
    };
  });

  afterAll(async () => {
    await apps.plain.close();
    await apps.fullCapture.close();
    await db.destroy();
    await container.stop();
  });

  /**
   * A project of its own per run of a case.
   *
   * Each case names its environment in every envelope it sends, so the
   * environment has to carry that exact name, and two cases needing different
   * capture modes cannot share one. A project each is the cheap way to give
   * every case the environment it asks for, and it also keeps the real run and
   * the dry run of one case from seeing each other's rows.
   */
  async function provision(one: ConformanceCase, run: string): Promise<Provisioned> {
    const environment = one.setup?.environment;
    const projectId = await insertReturningId(db, "projects", {
      name: `conformance ${run}`,
      slug: `conformance-${run}`
    });

    const issue = async (name: string): Promise<string> => {
      const environmentId = await insertReturningId(db, "environments", {
        project_id: projectId,
        name,
        capture_mode: environment?.captureMode ?? "redacted-payload",
        redaction_paths: JSON.stringify(environment?.redactionPaths ?? []),
        capture_allowlist: JSON.stringify(environment?.captureAllowlist ?? [])
      });
      const generated = issueApiKey(keyring);
      await db("api_keys").insert({
        project_id: projectId,
        environment_id: environmentId,
        name: `${name}-${run}`,
        key_prefix: generated.keyPrefix,
        key_hash: generated.verifier,
        key_hash_key_id: generated.keyHashKeyId
      });
      return generated.apiKey;
    };

    return {
      app: environment?.allowFullPayload === true ? apps.fullCapture : apps.plain,
      key: await issue(ENVIRONMENT),
      otherKey: await issue(OTHER_ENVIRONMENT),
      projectId
    };
  }

  const post = (app: FastifyInstance, key: string, body: unknown, query = "") =>
    app.inject({
      method: "POST",
      url: `/v1/events/batch${query}`,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      // Sent as bytes rather than as an object, so a `__proto__` key in a case
      // reaches the server the way a real client would send it.
      payload: JSON.stringify(body)
    });

  const get = (app: FastifyInstance, key: string, url: string) =>
    app.inject({ method: "GET", url, headers: { authorization: `Bearer ${key}` } });

  /** Run one case in one mode, and return every way it disagreed with its expectation. */
  async function runCase(one: ConformanceCase, dryRun: boolean): Promise<string[]> {
    counter += 1;
    const run = `${dryRun ? "d" : "r"}${String(counter)}`;
    const { app, key, otherKey, projectId } = await provision(one, run);
    const problems: string[] = [];
    if (dryRun) {
      dryRunProjects.push({
        projectId,
        caseId: one.id,
        setupEvents: (one.setup?.existing ?? []).length + (one.setup?.otherEnvironment ?? []).length
      });
    }

    // The prior rows a duplicate, a conflict or a cross-environment case needs.
    // Ingested for real in both modes: a dry run is about the batch under test,
    // not about its setup.
    for (const [envelopes, withKey] of [
      [one.setup?.existing ?? [], key],
      [one.setup?.otherEnvironment ?? [], otherKey]
    ] as const) {
      for (const envelope of envelopes) {
        const seeded = await post(app, withKey, {
          events: [expand(envelope, { run })]
        });
        const result: { status?: string } = seeded.json().data.results[0];
        if (result.status !== "accepted") {
          problems.push(`setup event was not accepted: ${seeded.body}`);
        }
      }
    }

    const body = expand(one.send, { run }) as { events: unknown };
    const response = await post(app, key, body, dryRun ? "?dryRun=true" : "");

    if (one.expect.request !== undefined) {
      const expected = one.expect.request;
      if (response.statusCode !== expected.status) {
        problems.push(
          `status: expected ${String(expected.status)}, got ${String(response.statusCode)}`
        );
      }
      const actualCode: unknown = response.json().error?.code;
      if (actualCode !== expected.code) {
        problems.push(`error.code: expected ${expected.code}, got ${String(actualCode)}`);
      }
      return problems;
    }

    const expectedResults = one.expect.results ?? [];
    if (response.statusCode !== (dryRun ? 200 : 202)) {
      problems.push(`status: got ${String(response.statusCode)}: ${response.body}`);
      return problems;
    }

    const results: Record<string, unknown>[] = response.json().data.results;
    if (results.length !== expectedResults.length) {
      problems.push(
        `results: expected ${String(expectedResults.length)}, got ${String(results.length)}`
      );
      return problems;
    }

    const sent = Array.isArray(body.events) ? body.events : [];

    for (const [index, expected] of expectedResults.entries()) {
      const actual = results[index] ?? {};
      const at = `results[${String(index)}]`;

      if (actual["status"] !== expected.status) {
        problems.push(`${at}.status: expected ${expected.status}, got ${String(actual["status"])}`);
      }
      if (expected.duplicate !== undefined && actual["duplicate"] !== expected.duplicate) {
        problems.push(
          `${at}.duplicate: expected ${String(expected.duplicate)}, got ${String(actual["duplicate"])}`
        );
      }
      if (expected.eventId !== undefined) {
        problems.push(
          ...compareExpectation(
            { eventId: actual["eventId"] },
            { eventId: expand(expected.eventId, { run }) },
            at
          )
        );
      }
      if (expected.error !== undefined) {
        problems.push(
          ...compareExpectation(
            actual["error"] === undefined
              ? {}
              : {
                  code: (actual["error"] as { code: unknown }).code,
                  httpStatus: (actual["error"] as { httpStatus: unknown }).httpStatus
                },
            expected.error,
            `${at}.error`
          )
        );
      }

      if (expected.stored === undefined) continue;
      const stored = dryRun
        ? (actual["stored"] as { event?: unknown; journey?: unknown } | undefined)
        : await readBack(app, key, sent[index], actual["eventId"], expected);

      if (stored === undefined) {
        problems.push(`${at}.stored: expected a stored preview, got none`);
        continue;
      }
      if (expected.stored.event !== undefined) {
        problems.push(
          ...compareExpectation(
            stored.event,
            expand(expected.stored.event, { run }),
            `${at}.stored.event`
          )
        );
      }
      if (expected.stored.journey !== undefined) {
        problems.push(
          ...compareExpectation(
            stored.journey,
            expand(expected.stored.journey, { run }),
            `${at}.stored.journey`
          )
        );
      }
    }

    return problems;
  }

  /**
   * What a real send stored, read through the routes a client would use.
   *
   * `receivedAt` is dropped so the same expectation covers both modes: the dry
   * run omits it, because it describes a moment about to be rolled away.
   */
  async function readBack(
    app: FastifyInstance,
    key: string,
    sentEnvelope: unknown,
    eventId: unknown,
    expected: { stored?: { event?: unknown; journey?: unknown } | undefined }
  ): Promise<{ event?: unknown; journey?: unknown }> {
    const stored: { event?: unknown; journey?: unknown } = {};

    if (expected.stored?.event !== undefined && typeof eventId === "string") {
      const response = await get(app, key, `/v1/events/${encodeURIComponent(eventId)}`);
      if (response.statusCode === 200) {
        const { receivedAt: _omitted, ...event }: Record<string, unknown> = response.json().data;
        stored.event = event;
      }
    }

    if (expected.stored?.journey !== undefined) {
      const journeyId = (sentEnvelope as { event?: { journeyId?: unknown } } | undefined)?.event
        ?.journeyId;
      if (typeof journeyId === "string") {
        const response = await get(app, key, `/v1/journeys/${encodeURIComponent(journeyId)}`);
        if (response.statusCode === 200) stored.journey = response.json().data;
      }
    }

    return stored;
  }

  it("runs exactly the cases the manifest lists", () => {
    // The suite below is generated from whatever is on disk, so a deleted case
    // file is a smaller run rather than a failure. This once read
    // `toBeGreaterThanOrEqual(31)` against 37 files, and deleting
    // wire/proto-key.json left it green. Compared by id rather than by count,
    // so a missing case fails by name.
    expect(cases.map((one) => one.id)).toEqual(expectedCaseIds(wireDirectory, "wire"));
  });

  describe.each(cases.map((one) => [one.id, one] as const))("%s", (_id, one) => {
    it("sent for real, and read back through the read routes", async () => {
      expect(await runCase(one, false)).toEqual([]);
    });

    it("through the dry run", async () => {
      expect(await runCase(one, true)).toEqual([]);
    });
  });

  it("stored nothing from any dry run beyond that case's own setup", async () => {
    // Each dry run had a project to itself, so the event rows in it can be
    // counted exactly: the setup events, which are ingested for real in both
    // modes, and nothing else. A preview that committed would leave more.
    expect(dryRunProjects.length).toBeGreaterThan(0);

    for (const { projectId, caseId, setupEvents } of dryRunProjects) {
      const row: unknown = await db("journey_events")
        .where({ project_id: projectId })
        .count({ n: "*" })
        .first();
      expect(Number((row as { n: string }).n), `${caseId} stored rows from its dry run`).toBe(
        setupEvents
      );
    }
  });
});
