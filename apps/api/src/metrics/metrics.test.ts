import { randomBytes } from "node:crypto";
import { createKeyring } from "@wayscribe/payload-security";
import type { FastifyInstance } from "fastify";
import type { Knex } from "knex";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { serveApi } from "../serve.js";
import { EXPOSITION_CONTENT_TYPE } from "./listener.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");
const ADMIN_TOKEN = "admin-token-for-tests-0000000000";

/** No request in these tests reaches the database. */
const db = {} as Knex;

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function app(): FastifyInstance {
  const built = buildApp({ db, keyring, adminToken: ADMIN_TOKEN, logLevel: "silent" });
  apps.push(built);
  return built;
}

/** Series lines (not HELP or TYPE) for one metric name. */
function seriesOf(text: string, name: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith(`${name}{`) || line.startsWith(`${name} `));
}

/**
 * Listening TCP servers in this process, as Node counts its own handles.
 *
 * A closed server's handle is released a moment after its close callback runs,
 * so the count is read once it has stopped changing.
 */
async function listeningServers(): Promise<number> {
  const count = (): number =>
    process.getActiveResourcesInfo().filter((resource) => resource === "TCPServerWrap").length;
  let previous = -1;
  let current = count();
  while (current !== previous) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    previous = current;
    current = count();
  }
  return current;
}

describe("request metrics", () => {
  it("labels by route pattern, so 1,000 random paths add one series, not 1,000", async () => {
    const api = app();
    const paths: string[] = [];
    for (let i = 0; i < 1000; i += 1) {
      const path = `/${randomBytes(6).toString("hex")}/${randomBytes(4).toString("hex")}`;
      paths.push(path);
      const response = await api.inject({ method: "GET", url: path });
      expect(response.statusCode).toBe(404);
    }

    const text = await api.metrics.render();
    const requests = seriesOf(text, "wayscribe_http_requests_total");
    expect(requests).toEqual([
      'wayscribe_http_requests_total{method="GET",route="unmatched",status="404"} 1000'
    ]);
    // The histogram's lines per series are fixed: 12 buckets, +Inf, _sum, _count.
    const durationLines = text
      .split("\n")
      .filter((line) => line.startsWith("wayscribe_http_request_duration_seconds_"));
    expect(durationLines).toHaveLength(15);
    for (const path of paths.slice(0, 50)) expect(text).not.toContain(path.slice(1, 13));
  });

  it("labels a parameterised route by its pattern, never by the id in the path", async () => {
    const api = app();
    for (const id of ["jrn_secret_one", "jrn_secret_two"]) {
      // No credentials, so the route answers 401 without touching the database.
      const response = await api.inject({ method: "GET", url: `/v1/journeys/${id}` });
      expect(response.statusCode).toBe(401);
    }

    const text = await api.metrics.render();
    expect(seriesOf(text, "wayscribe_http_requests_total")).toEqual([
      'wayscribe_http_requests_total{method="GET",route="/v1/journeys/:journeyId",status="401"} 2'
    ]);
    expect(text).not.toContain("jrn_secret");
  });

  it("folds a method no route uses into one value", async () => {
    const api = app();
    await api.inject({ method: "PROPFIND" as "GET", url: "/anything" });
    expect(await api.metrics.render()).toContain('method="other",route="unmatched"');
  });

  it("exposes every documented series before any traffic", async () => {
    const text = await app().metrics.render();
    for (const name of [
      "wayscribe_http_requests_total",
      "wayscribe_http_request_duration_seconds",
      "wayscribe_events_total",
      "wayscribe_query_timeouts_total",
      "wayscribe_db_pool_connections",
      "wayscribe_retention_sweep_runs_total",
      "wayscribe_retention_journeys_deleted_total",
      "wayscribe_retention_last_success_timestamp_seconds",
      "wayscribe_unreadable_values",
      "process_resident_memory_bytes",
      "nodejs_eventloop_lag_seconds"
    ]) {
      expect(text, name).toContain(`# TYPE ${name} `);
    }
    expect(text).toContain('wayscribe_events_total{result="rejected"} 0');
    expect(text).toContain('wayscribe_retention_sweep_runs_total{outcome="failed"} 0');
    // No pool on a stub database: reported as zeros rather than failing the scrape.
    expect(text).toContain('wayscribe_db_pool_connections{state="pending"} 0');
  });

  it("is not served on the API port", async () => {
    const response = await app().inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(404);
  });

  it("counts a URL the router refuses, in the API's error shape, without echoing it", async () => {
    // Fastify answers these two before any route or hook runs, in its own
    // shape and quoting the path, so they were neither counted nor enveloped.
    const api = app();
    const malformed = await api.inject({ method: "GET", url: "/v1/journeys/%E0%A4%A" });
    const tooLong = await api.inject({
      method: "GET",
      url: `/v1/journeys/${"jrn_long_secret_".repeat(80)}`
    });

    expect(malformed.statusCode).toBe(400);
    expect(malformed.json<{ error: { code: string } }>().error.code).toBe("bad_url");
    expect(malformed.body).not.toContain("%E0%A4%A");
    expect(tooLong.statusCode).toBe(414);
    expect(tooLong.json<{ error: { code: string } }>().error.code).toBe("parameter_too_long");
    expect(tooLong.body).not.toContain("jrn_long_secret_");

    const text = await api.metrics.render();
    expect(text).toContain(
      'wayscribe_http_requests_total{method="GET",route="unmatched",status="400"} 1'
    );
    expect(text).toContain(
      'wayscribe_http_requests_total{method="GET",route="unmatched",status="414"} 1'
    );
    expect(text).not.toContain("jrn_long_secret_");
  });
});

describe("the metrics listener", () => {
  it("does not start when METRICS_PORT is unset", async () => {
    const before = await listeningServers();
    const api = app();
    const serving = await serveApi(api, { port: 0, host: "127.0.0.1", metricsPort: undefined });

    expect(serving.metricsAddress).toBeNull();
    // The API's own server and nothing else.
    expect(await listeningServers()).toBe(before + 1);
    const response = await fetch(`http://127.0.0.1:${String(serving.apiAddress.port)}/metrics`);
    expect(response.status).toBe(404);
  });

  it("serves /metrics on its own port, and closes with the API", async () => {
    const before = await listeningServers();
    const api = app();
    const serving = await serveApi(api, { port: 0, host: "127.0.0.1", metricsPort: 0 });
    expect(await listeningServers()).toBe(before + 2);

    const metricsPort = serving.metricsAddress?.port;
    expect(metricsPort).toBeTypeOf("number");
    const metricsUrl = `http://127.0.0.1:${String(metricsPort)}`;
    const apiUrl = `http://127.0.0.1:${String(serving.apiAddress.port)}`;

    await fetch(`${apiUrl}/health`);
    const scrape = await fetch(`${metricsUrl}/metrics`);
    expect(scrape.status).toBe(200);
    expect(scrape.headers.get("content-type")).toBe(EXPOSITION_CONTENT_TYPE);
    const text = await scrape.text();
    expect(text).toContain(
      'wayscribe_http_requests_total{method="GET",route="/health",status="200"} 1'
    );
    // A scrape is not an API request.
    expect(text).not.toContain('route="/metrics"');

    expect((await fetch(`${apiUrl}/metrics`)).status).toBe(404);
    expect((await fetch(`${metricsUrl}/`)).status).toBe(404);
    expect((await fetch(`${metricsUrl}/v1/events`)).status).toBe(404);
    expect((await fetch(`${metricsUrl}/metrics`, { method: "POST" })).status).toBe(405);

    await api.close();
    apps.splice(apps.indexOf(api), 1);
    expect(await listeningServers()).toBe(before);
    await expect(fetch(`${metricsUrl}/metrics`)).rejects.toThrow();
  });

  it("closes the API again when the metrics port is taken", async () => {
    const holder = app();
    const held = await serveApi(holder, { port: 0, host: "127.0.0.1", metricsPort: undefined });
    const before = await listeningServers();

    const api = app();
    await expect(
      serveApi(api, { port: 0, host: "127.0.0.1", metricsPort: held.apiAddress.port })
    ).rejects.toThrow(/EADDRINUSE/);
    expect(await listeningServers()).toBe(before);
  });
});
