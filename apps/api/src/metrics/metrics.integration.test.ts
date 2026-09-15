import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createKnexConfig, insertReturningId } from "@flight-recorder/database";
import { createKeyring, issueApiKey } from "@flight-recorder/payload-security";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { checkKeysAtBoot } from "../key-warnings.js";
import { startRetentionJob } from "../retention-job.js";
import { serveApi } from "../serve.js";
import { HTTP_DURATION_BUCKETS } from "./api-metrics.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");
const ADMIN_TOKEN = "admin-token-for-tests-0000000000";

// Values that reach the API in requests. None may appear in a label.
const ENTITY_ID = "METRICS-ENTITY-5521";
const ALIAS_VALUE = "METRICS-ALIAS-8810";
const JOURNEY_ID = "jrn_metrics_journey_0042";
// One timestamp for every event, so sending one twice is a duplicate, not a conflict.
const SENT_AT = new Date().toISOString();

describe("metrics, scraped from METRICS_PORT after real traffic", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let app: FastifyInstance;
  let apiKey: string;
  let keyPrefix: string;
  let projectId: string;
  let apiUrl: string;
  let metricsUrl: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = knex(createKnexConfig(container.getConnectionUri(), { statementTimeoutMs: 15_000 }));
    await db.migrate.latest();

    projectId = await insertReturningId(db, "projects", { name: "P", slug: "p" });
    const environmentId = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: "development",
      retention_days: 1
    });
    const generated = issueApiKey(keyring);
    apiKey = generated.apiKey;
    keyPrefix = generated.keyPrefix;
    await db("api_keys").insert({
      project_id: projectId,
      environment_id: environmentId,
      name: "k",
      key_prefix: generated.keyPrefix,
      key_hash: generated.verifier,
      key_hash_key_id: generated.keyHashKeyId
    });

    app = buildApp({ db, keyring, adminToken: ADMIN_TOKEN, logLevel: "silent" });
    const serving = await serveApi(app, { port: 0, host: "127.0.0.1", metricsPort: 0 });
    apiUrl = `http://127.0.0.1:${String(serving.apiAddress.port)}`;
    metricsUrl = `http://127.0.0.1:${String(serving.metricsAddress?.port)}/metrics`;
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await container.stop();
  });

  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${apiUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body)
    });

  const envelope = (id: string, environment = "development"): unknown => ({
    protocolVersion: "0.1",
    event: {
      id,
      journeyId: JOURNEY_ID,
      environment,
      service: "svc",
      entity: { type: "customer", id: ENTITY_ID },
      aliases: { lookup: ALIAS_VALUE },
      operation: "received",
      name: "receive",
      timestamp: SENT_AT
    }
  });

  /** Every `name{labels} value` sample, parsed. */
  const samples = (
    text: string
  ): { name: string; labels: Record<string, string>; value: number }[] =>
    text
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => {
        const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? (\S+)$/.exec(line);
        if (match === null) throw new Error(`Not an exposition line: ${line}`);
        const labels: Record<string, string> = {};
        for (const pair of (match[2] ?? "").matchAll(/([a-zA-Z_]+)="((?:[^"\\]|\\.)*)"/g)) {
          labels[pair[1] ?? ""] = pair[2] ?? "";
        }
        return { name: match[1] ?? "", labels, value: Number(match[3]) };
      });

  const valueOf = (text: string, name: string, labels: Record<string, string> = {}): number => {
    const found = samples(text).find(
      (sample) =>
        sample.name === name &&
        Object.entries(labels).every(([key, value]) => sample.labels[key] === value)
    );
    if (found === undefined) throw new Error(`No sample ${name} ${JSON.stringify(labels)}`);
    return found.value;
  };

  it("moves the counters for ingestion, search, a sweep, and the boot check", async () => {
    // Accepted, then the same event again (a duplicate), then one for an
    // environment the key does not cover (rejected), through both routes.
    expect((await post("/v1/events", envelope("evt_m1"))).status).toBe(202);
    expect((await post("/v1/events", envelope("evt_m1"))).status).toBe(202);
    expect((await post("/v1/events", envelope("evt_m2", "production"))).status).toBe(403);
    const batch = await post("/v1/events/batch", {
      events: [envelope("evt_m3"), envelope("evt_m4", "production")]
    });
    expect(batch.status).toBe(202);

    const searched = await fetch(`${apiUrl}/v1/search?q=${ALIAS_VALUE}`, {
      headers: { authorization: `Bearer ${apiKey}` }
    });
    expect(searched.status).toBe(200);
    const read = await fetch(`${apiUrl}/v1/journeys/${JOURNEY_ID}`, {
      headers: { authorization: `Bearer ${apiKey}` }
    });
    expect(read.status).toBe(200);

    // Age the journey past its one-day retention, then sweep.
    await db("journeys")
      .where({ id: JOURNEY_ID })
      .update({ last_event_at: db.raw("now() - interval '3 days'") });
    const retention = startRetentionJob(app, { intervalMs: 3_600_000 });
    await retention.runOnce();
    retention.stop();

    await checkKeysAtBoot(db, keyring, app.log, app.metrics);

    const response = await fetch(metricsUrl);
    expect(response.status).toBe(200);
    const text = await response.text();

    expect(valueOf(text, "flight_recorder_events_total", { result: "accepted" })).toBe(2);
    expect(valueOf(text, "flight_recorder_events_total", { result: "duplicate" })).toBe(1);
    expect(valueOf(text, "flight_recorder_events_total", { result: "rejected" })).toBe(2);

    const requests = { name: "flight_recorder_http_requests_total" };
    expect(
      valueOf(text, requests.name, { method: "POST", route: "/v1/events", status: "202" })
    ).toBe(2);
    expect(
      valueOf(text, requests.name, { method: "POST", route: "/v1/events", status: "403" })
    ).toBe(1);
    expect(
      valueOf(text, requests.name, { method: "GET", route: "/v1/search", status: "200" })
    ).toBe(1);
    expect(
      valueOf(text, requests.name, {
        method: "GET",
        route: "/v1/journeys/:journeyId",
        status: "200"
      })
    ).toBe(1);
    expect(
      valueOf(text, "flight_recorder_http_request_duration_seconds_count", {
        method: "POST",
        route: "/v1/events"
      })
    ).toBe(3);
    const buckets = samples(text).filter(
      (sample) =>
        sample.name === "flight_recorder_http_request_duration_seconds_bucket" &&
        sample.labels["route"] === "/v1/search"
    );
    expect(buckets.map((sample) => sample.labels["le"])).toEqual([
      ...HTTP_DURATION_BUCKETS.map(String),
      "+Inf"
    ]);

    expect(
      valueOf(text, "flight_recorder_retention_sweep_runs_total", { outcome: "completed" })
    ).toBe(1);
    expect(valueOf(text, "flight_recorder_retention_journeys_deleted_total")).toBe(1);
    const lastSuccess = valueOf(text, "flight_recorder_retention_last_success_timestamp_seconds");
    expect(Math.abs(lastSuccess - Date.now() / 1000)).toBeLessThan(60);

    for (const table of ["journeys", "entity_aliases", "replay_destinations", "api_keys"]) {
      expect(valueOf(text, "flight_recorder_unreadable_values", { table })).toBe(0);
    }

    // The pool served every query above and is idle now.
    const used = valueOf(text, "flight_recorder_db_pool_connections", { state: "used" });
    const free = valueOf(text, "flight_recorder_db_pool_connections", { state: "free" });
    expect(used + free).toBeGreaterThan(0);
    expect(valueOf(text, "flight_recorder_db_pool_connections", { state: "pending" })).toBe(0);
    expect(valueOf(text, "process_resident_memory_bytes")).toBeGreaterThan(1_000_000);
    expect(valueOf(text, "nodejs_eventloop_lag_seconds")).toBeGreaterThanOrEqual(0);
  });

  it("carries no request value, project id, or key prefix in any label", async () => {
    const text = await (await fetch(metricsUrl)).text();
    const forbidden = [ENTITY_ID, ALIAS_VALUE, JOURNEY_ID, projectId, keyPrefix, apiKey, "evt_m"];

    const allowed: Record<string, (value: string) => boolean> = {
      method: (value) =>
        ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "other"].includes(value),
      // A route pattern from the router's table, or the one fallback.
      route: (value) =>
        value === "unmatched" ||
        app.hasRoute({ method: "GET", url: value }) ||
        app.hasRoute({ method: "POST", url: value }),
      status: (value) => /^[1-5]\d\d$/.test(value),
      le: (value) => value === "+Inf" || HTTP_DURATION_BUCKETS.map(String).includes(value),
      result: (value) => ["accepted", "duplicate", "rejected"].includes(value),
      outcome: (value) => ["completed", "locked", "stopped_early", "failed"].includes(value),
      state: (value) => ["used", "free", "pending"].includes(value),
      table: (value) =>
        ["journeys", "entity_aliases", "replay_destinations", "api_keys"].includes(value)
    };

    for (const sample of samples(text)) {
      for (const [label, value] of Object.entries(sample.labels)) {
        const check = allowed[label];
        expect(check, `unexpected label ${label}`).toBeDefined();
        expect(check?.(value), `${sample.name} ${label}="${value}"`).toBe(true);
        for (const secret of forbidden) expect(value).not.toContain(secret);
      }
    }
  });
});
