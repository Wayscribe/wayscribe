import { connect as connectHttp2, createServer as createHttp2Server } from "node:http2";
import type { AddressInfo } from "node:net";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createKnexConfig, insertReturningId } from "@flight-recorder/database";
import { createKeyring, issueApiKey } from "@flight-recorder/payload-security";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { buildApp } from "../app.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");

// Built by concatenation so a scanner reading this file does not see a
// credential, and so a leak is unmistakable when one is found in a row.
const TUPLE = "Bearer " + "tok" + "_ingest_shape_" + "TUPLE21";
const RAW = "Bearer " + "tok" + "_ingest_shape_" + "RAW22";
const COOKIE = "sid=" + "cookie" + "_ingest_shape_" + "RAW23";
const REQUEST = "Bearer " + "tok" + "_ingest_shape_" + "REQ24";
const H2_BEARER = "Bearer " + "tok" + "_ingest_shape_" + "H2REQ25";
const H2_SET_COOKIE = "sid=" + "cookie" + "_ingest_shape_" + "H2RES26";
const H2_API_KEY = "key" + "_ingest_shape_" + "H2HAR27";
const THIRD_KEY = "Bearer " + "tok" + "_ingest_shape_" + "HAR28";

/** rawHeaders from a real HTTP/2 exchange: the server's request and the client's response. */
async function http2RawHeaders(): Promise<{ request: string[]; response: string[] }> {
  const server = createHttp2Server();
  let received: string[] = [];
  server.on("request", (incoming, outgoing) => {
    received = incoming.rawHeaders;
    outgoing.setHeader("set-cookie", H2_SET_COOKIE);
    outgoing.end("ok");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const client = connectHttp2(`http://127.0.0.1:${String(port)}`);
  const response = await new Promise<string[]>((resolve, reject) => {
    const stream = client.request({ ":path": "/orders", authorization: H2_BEARER });
    stream.on("response", (_headers, _flags, rawHeaders: string[]) => {
      resolve(rawHeaders);
    });
    stream.on("error", reject);
    stream.resume();
    stream.end();
  });
  client.close();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return { request: received, response };
}

/**
 * The security review's reproduction, read back out of PostgreSQL: header
 * credentials filed under array positions or inside an HTTP header block were
 * stored verbatim in the default capture mode. Sent as a client that is not the
 * SDK would send them, so only the server's redaction stands between the body
 * and the row.
 */
describe("header credentials in array and header-block shapes", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let app: FastifyInstance;
  let apiKey: string;
  let projectId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(inject("postgresImage")).start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();

    projectId = await insertReturningId(db, "projects", { name: "P", slug: "p" });
    const environmentId = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: "development"
    });
    const generated = issueApiKey(keyring);
    apiKey = generated.apiKey;
    await db("api_keys").insert({
      project_id: projectId,
      environment_id: environmentId,
      name: "k",
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
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await container.stop();
  });

  it("stores none of them, and keeps the request around them", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        protocolVersion: "0.1",
        event: {
          id: "evt_header_shapes",
          journeyId: "jrn_header_shapes",
          environment: "development",
          service: "customer-integration",
          entity: { type: "customer", id: "0018Z00002ABC" },
          operation: "delivered",
          name: "call-upstream",
          timestamp: "2026-09-15T10:00:00.000Z",
          input: {
            init: {
              headers: [
                ["Authorization", TUPLE],
                ["x-request-id", "req_42"]
              ]
            },
            rawHeaders: ["Host", "api.example.com", "Authorization", RAW, "Cookie", COOKIE],
            request: {
              _header: `POST /oauth/token HTTP/1.1\r\nAuthorization: ${REQUEST}\r\nHost: 127.0.0.1:1\r\n\r\n`
            }
          }
        }
      }
    });
    expect(response.statusCode).toBe(202);

    const row = await db("journey_events")
      .where({ project_id: projectId, id: "evt_header_shapes" })
      .first();
    const stored = JSON.stringify(row.input_payload);

    expect(stored).not.toContain("TUPLE21");
    expect(stored).not.toContain("RAW22");
    expect(stored).not.toContain("RAW23");
    expect(stored).not.toContain("REQ24");
    // Presence beside absence: a row that stored nothing would pass the above.
    expect(row.input_payload.init.headers).toEqual([
      ["Authorization", "[REDACTED]"],
      ["x-request-id", "req_42"]
    ]);
    expect(row.input_payload.rawHeaders).toEqual([
      "Host",
      "api.example.com",
      "Authorization",
      "[REDACTED]",
      "Cookie",
      "[REDACTED]"
    ]);
    expect(row.input_payload.request._header).toBe(
      "POST /oauth/token HTTP/1.1\r\nAuthorization: [REDACTED]\r\nHost: 127.0.0.1:1\r\n\r\n"
    );
  });

  it("stores no credential from HTTP/2 rawHeaders or a HAR headers array", async () => {
    const exchange = await http2RawHeaders();
    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        protocolVersion: "0.1",
        event: {
          id: "evt_http2_shapes",
          journeyId: "jrn_http2_shapes",
          environment: "development",
          service: "customer-integration",
          entity: { type: "customer", id: "0018Z00002ABC" },
          operation: "delivered",
          name: "call-upstream-h2",
          timestamp: "2026-09-15T10:00:00.000Z",
          input: {
            request: { rawHeaders: exchange.request },
            har: [
              { name: "x-api-key", value: H2_API_KEY },
              { name: "accept", value: "application/json" }
            ]
          },
          output: { response: { rawHeaders: exchange.response } }
        }
      }
    });
    expect(response.statusCode).toBe(202);

    const row = await db("journey_events")
      .where({ project_id: projectId, id: "evt_http2_shapes" })
      .first();
    const stored = JSON.stringify([row.input_payload, row.output_payload, row.payload_diff]);

    expect(stored).not.toContain("H2REQ25");
    expect(stored).not.toContain("H2RES26");
    expect(stored).not.toContain("H2HAR27");
    const requestHeaders = row.input_payload.request.rawHeaders as string[];
    expect(requestHeaders.slice(0, 2)).toEqual([":path", "/orders"]);
    expect(requestHeaders[requestHeaders.indexOf("authorization") + 1]).toBe("[REDACTED]");
    const responseHeaders = row.output_payload.response.rawHeaders as string[];
    expect(responseHeaders.slice(0, 2)).toEqual([":status", "200"]);
    expect(responseHeaders[responseHeaders.indexOf("set-cookie") + 1]).toBe("[REDACTED]");
    expect(row.input_payload.har).toEqual([
      { name: "x-api-key", value: "[REDACTED]" },
      { name: "accept", value: "application/json" }
    ]);
  });

  /**
   * The shape a third key used to exempt, read back out of PostgreSQL.
   *
   * `namedValueKey` required exactly `name` and `value`, so a HAR entry carrying
   * its own `comment` was an ordinary object: nothing on it is named a secret and
   * the credential reached `jsonb` in the clear. Asserted on the row rather than
   * on the function's return value, because the two disagreed once before.
   */
  describe("a name and value entry carrying other fields", () => {
    it("stores the value redacted and every other field intact", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        payload: JSON.stringify({
          protocolVersion: "0.1",
          event: {
            id: "evt_third_key",
            journeyId: "jrn_third_key",
            environment: "development",
            service: "customer-integration",
            entity: { type: "customer", id: "0018Z00002ABC" },
            operation: "delivered",
            name: "call-upstream-har",
            timestamp: "2026-09-15T10:00:00.000Z",
            input: {
              har: [
                { name: "authorization", value: THIRD_KEY, comment: "from the HAR" },
                { name: "accept", value: "application/json", comment: "kept" }
              ],
              // A `__proto__` beside the pair goes through the branch that
              // replaces the value, which rebuilds the object key by key.
              // Inside an array, because that is the only place the pair rules
              // apply: written bare the first time, this assertion said so.
              withProto: JSON.parse(
                `[{"name":"cookie","value":"sid=${THIRD_KEY}","__proto__":"kept"}]`
              ) as unknown,
              // The false positive the rule has always protected against: a list
              // of header names is configuration, not headers.
              notHeaders: [{ name: "authorization", value: "Content-Type", position: 1 }]
            }
          }
        })
      });
      expect(response.statusCode, response.body).toBe(202);

      const row = await db("journey_events")
        .where({ project_id: projectId, id: "evt_third_key" })
        .first();
      const stored = JSON.stringify(row.input_payload);

      expect(stored).not.toContain("HAR28");
      expect(row.input_payload.har).toEqual([
        { name: "authorization", value: "[REDACTED]", comment: "from the HAR" },
        { name: "accept", value: "application/json", comment: "kept" }
      ]);
      expect(row.input_payload.withProto[0].value).toBe("[REDACTED]");
      expect(stored).toContain('"__proto__":"kept"');
      expect(row.input_payload.notHeaders).toEqual([
        { name: "authorization", value: "Content-Type", position: 1 }
      ]);
      // The control: the whole entry was not dropped, which would satisfy every
      // "does not contain the secret" assertion above on its own.
      expect(row.input_payload.har[0].name).toBe("authorization");
    });
  });
});
