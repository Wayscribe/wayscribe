import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createKnexConfig, insertReturningId } from "@flight-recorder/database";
import { createKeyring, issueApiKey } from "@flight-recorder/payload-security";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");

// Built by concatenation so a scanner reading this file does not see a
// credential, and so a leak is unmistakable when one is found in a row.
const TUPLE = "Bearer " + "tok" + "_ingest_shape_" + "TUPLE21";
const RAW = "Bearer " + "tok" + "_ingest_shape_" + "RAW22";
const COOKIE = "sid=" + "cookie" + "_ingest_shape_" + "RAW23";
const REQUEST = "Bearer " + "tok" + "_ingest_shape_" + "REQ24";

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
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
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
});
