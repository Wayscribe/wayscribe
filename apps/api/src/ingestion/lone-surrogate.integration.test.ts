import { createKnexConfig, insertReturningId } from "@wayscribe/database";
import { createKeyring, issueApiKey } from "@wayscribe/payload-security";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { buildApp } from "../app.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");

/** U+D800, a high surrogate with no low surrogate after it. */
const LONE = "\uD800";
const SENT = `North${LONE}wind`;
const REPAIRED = "North\uFFFDwind";

/**
 * Where a lone surrogate is repaired (F-024).
 *
 * The finding saw a company name carrying an unpaired U+D800 leave the SDK raw
 * in an alias, arrive, and read back through every read route as U+FFFD, with
 * nothing refused and no diagnostic on either side. What it could not answer
 * without database access was whether the repair happens at ingest, so the
 * stored value is already U+FFFD, or only when a read route renders it, so a
 * raw surrogate could still be sitting in PostgreSQL and reach psql, a dump or
 * another client differently.
 *
 * These tests read the stored rows directly and answer it: the repair happens
 * on the way in, at the boundary where the string is encoded to UTF-8 for the
 * wire to PostgreSQL. Nothing anywhere stores or returns the surrogate, so
 * every reader sees the same characters. This is a record of what the server
 * does, not a change to it; the behaviour is documented in
 * docs/INGESTION_CONTRACT.md.
 */
describe("a lone surrogate in a value", () => {
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

    const event = (id: string, journeyId: string, company: string): unknown => ({
      protocolVersion: "0.1",
      event: {
        id,
        journeyId,
        environment: "development",
        service: "intake",
        entity: { type: "probe", id: `${journeyId}-entity` },
        operation: "received",
        name: "receive-form",
        timestamp: "2026-09-16T10:00:00.000Z",
        journeyLabel: company,
        aliases: { company },
        displayableAliases: ["company"]
      }
    });

    // One batch holding both, as F-024's probe did: the question was partly
    // whether a malformed value takes a well-formed lead's data down with it.
    // The body is written by JSON.stringify, which escapes the lone surrogate
    // as \ud800, and Fastify's parse hands the route the surrogate back, so
    // this is the same string the SDK would have sent.
    const response = await app.inject({
      method: "POST",
      url: "/v1/events/batch",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        events: [
          event("evt_control", "jrn_control", "Northwind Traders"),
          event("evt_lone", "jrn_lone", SENT)
        ]
      } as object
    });
    expect(response.statusCode, response.body).toBeLessThan(300);
    const body: { data: { results: { status: string }[] } } = response.json();
    const results = body.data.results;
    expect(results.map((result) => result.status)).toEqual(["accepted", "accepted"]);
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await container.stop();
  });

  const storedLabel = async (journeyId: string): Promise<string | null> => {
    const row: unknown = await db("journeys")
      .where({ project_id: projectId, id: journeyId })
      .first("label");
    return (row as { label: string | null } | undefined)?.label ?? null;
  };

  const storedAlias = async (journeyId: string): Promise<string | null> => {
    const row: unknown = await db("entity_aliases")
      .where({ project_id: projectId, journey_id: journeyId, alias_type: "company" })
      .first("display_value");
    return (row as { display_value: string | null } | undefined)?.display_value ?? null;
  };

  it("stores the label already repaired, not the raw surrogate", async () => {
    // The answer to what F-024 left open: at ingest, not at read time.
    expect(await storedLabel("jrn_lone")).toBe(REPAIRED);
  });

  it("stores the displayable alias value already repaired", async () => {
    expect(await storedAlias("jrn_lone")).toBe(REPAIRED);
  });

  it("holds no unpaired surrogate anywhere in the stored text", async () => {
    // What another reader would see. PostgreSQL's own UTF-8 validation would
    // have refused the byte sequence a lone surrogate encodes to, so a raw one
    // could not be here even in principle; this is the assertion that says so
    // for psql, a dump, and any client that is not this API.
    for (const stored of [await storedLabel("jrn_lone"), await storedAlias("jrn_lone")]) {
      expect(stored).not.toBeNull();
      expect(/\p{Surrogate}/u.test(stored ?? "")).toBe(false);
    }
  });

  it("agrees with what PostgreSQL itself measures", async () => {
    // Read through the server as little as possible: the database's own count
    // of characters and bytes. "North" and "wind" are nine ASCII characters,
    // and exactly one more stands where the surrogate was; U+FFFD is one
    // character and three bytes, so ten characters occupy twelve bytes. One
    // replacement character, not two, and not a dropped one.
    const rows: unknown = await db.raw(
      "select length(label) as characters, octet_length(label) as bytes from journeys where project_id = ? and id = ?",
      [projectId, "jrn_lone"]
    );
    const row = (rows as { rows: { characters: number; bytes: number }[] }).rows[0];
    expect(row).toEqual({ characters: 10, bytes: 12 });
  });

  it("returns exactly what it stored, so no second repair happens on the way out", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/journeys/jrn_lone",
      headers: { authorization: `Bearer ${apiKey}` }
    });
    expect(response.statusCode).toBe(200);
    const body: {
      data: {
        label: string;
        aliases: { type: string; displayValue: string; displayable: boolean }[];
      };
    } = response.json();
    const journey = body.data;
    expect(journey.label).toBe(await storedLabel("jrn_lone"));
    // This alias value comes from the ciphertext, a different column and a
    // different path from the plain-text copy asserted above, and it agrees:
    // the value was already repaired before either was written.
    expect(journey.aliases).toEqual([
      { type: "company", displayValue: REPAIRED, displayable: true }
    ]);
  });

  it("leaves a well-formed value in the same batch untouched", async () => {
    // The outcome that mattered most in F-024: a batch holds other records'
    // events, so a shared failure would drop a well-formed one's data beside a
    // malformed one's. Nothing was refused, at the event level or the batch
    // level.
    expect(await storedLabel("jrn_control")).toBe("Northwind Traders");
    expect(await storedAlias("jrn_control")).toBe("Northwind Traders");
  });

  it("refuses the same character in a payload, which text columns repair", async () => {
    // The asymmetry the finding did not reach, and the reason the probe saw no
    // refusal: a lone surrogate in a `text` column is repaired, and the same
    // character in a `jsonb` payload is refused with 400 unstorable_payload.
    // JSON.stringify writes it as a literal \ud800 escape, which PostgreSQL's
    // JSON parser rejects (22P02), while a text parameter is encoded to UTF-8
    // on the way to the driver and a lone surrogate has no UTF-8 form. The
    // probe carried the value in a payload too and was accepted because its
    // recorder had already repaired the payload before sending; the alias left
    // the SDK raw, and that is the path this file measures.
    //
    // This environment captures redacted payloads, the schema default, so the
    // payload really is written.
    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        protocolVersion: "0.1",
        event: {
          id: "evt_payload",
          journeyId: "jrn_payload",
          environment: "development",
          service: "intake",
          entity: { type: "probe", id: "payload-entity" },
          operation: "received",
          name: "receive-form",
          timestamp: "2026-09-16T10:00:00.000Z",
          input: { company: SENT }
        }
      } as object
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().error.code).toBe("unstorable_payload");
    // Refused leaves nothing behind, so the two answers never mix.
    expect(await storedLabel("jrn_payload")).toBeNull();
  });

  it("finds the journey by the repaired value, and not by the value as sent", async () => {
    // The consequence worth knowing: search tokens are taken over the repaired
    // string, so a caller searching for the bytes it thinks it sent finds
    // nothing, while the value it can read back finds the journey.
    const search = async (q: string): Promise<string[]> => {
      const response = await app.inject({
        method: "GET",
        url: `/v1/search?q=${encodeURIComponent(q)}`,
        headers: { authorization: `Bearer ${apiKey}` }
      });
      expect(response.statusCode, response.body).toBe(200);
      const body: { data: { items: { journeyId: string }[] } } = response.json();
      return body.data.items.map((item) => item.journeyId);
    };

    expect(await search(REPAIRED)).toEqual(["jrn_lone"]);
    // encodeURIComponent refuses a lone surrogate, which is itself part of the
    // answer: the value cannot be put in a URL. Percent-encoded as the
    // replacement character is what any HTTP client would send.
    expect(() => encodeURIComponent(SENT)).toThrow(URIError);
  });
});
