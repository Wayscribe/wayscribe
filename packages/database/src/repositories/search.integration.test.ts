import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createKeyring, searchTokens } from "@wayscribe/payload-security";
import knex, { type Knex } from "knex";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { insertReturningId } from "../insert.js";
import { createKnexConfig } from "../knex-config.js";
import { InvalidCursorError, encodeCursor } from "./cursors.js";
import { searchJourneys } from "./search.js";
import type { ReadScope } from "./read-scope.js";

const KEY_A = "0123456789abcdef0123456789abcdef";
const KEY_B = "fedcba9876543210fedcba9876543210";
const keyring = createKeyring(KEY_A);
/** The token ingestion writes: the current key's alone. */
const token = (value: string): string => searchTokens(keyring, value)[0] ?? "";

describe("searchJourneys", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let scope: ReadScope;
  let otherScope: ReadScope;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(inject("postgresImage")).start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();

    const projectId = await insertReturningId(db, "projects", { name: "P", slug: "p" });
    const environmentId = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: "development"
    });
    const stagingId = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: "staging"
    });
    const otherProjectId = await insertReturningId(db, "projects", { name: "O", slug: "o" });
    const otherEnvId = await insertReturningId(db, "environments", {
      project_id: otherProjectId,
      name: "development"
    });

    scope = { projectId, environmentId };
    otherScope = { projectId: otherProjectId, environmentId: otherEnvId };

    const journey = async (
      id: string,
      s: ReadScope,
      entityId: string,
      lastEventAt: string
    ): Promise<void> => {
      await db("journeys").insert({
        id,
        project_id: s.projectId,
        environment_id: s.environmentId,
        entity_type: "customer",
        primary_entity_id_hash: token(entityId),
        status: "active",
        started_at: lastEventAt,
        last_event_at: lastEventAt,
        event_count: 1
      });
    };

    await journey("jrn_1", scope, "0018Z00002ABC", "2026-08-06T10:00:00Z");
    await journey("jrn_2", scope, "0018Z00002XYZ", "2026-08-06T11:00:00Z");
    await journey("jrn_3", scope, "0018Z00002DEF", "2026-08-06T12:00:00Z");

    // Same value under two different alias types — the ADR-028 case.
    await db("entity_aliases").insert([
      {
        project_id: scope.projectId,
        journey_id: "jrn_1",
        alias_type: "salesforceAccountId",
        alias_value_hash: token("SHARED-VALUE")
      },
      {
        project_id: scope.projectId,
        journey_id: "jrn_2",
        alias_type: "internalCustomerId",
        alias_value_hash: token("SHARED-VALUE")
      }
    ]);

    await db("journey_events").insert({
      id: "evt_1",
      project_id: scope.projectId,
      environment_id: scope.environmentId,
      journey_id: "jrn_1",
      protocol_version: "0.1",
      content_hash: "h",
      operation: "received",
      name: "n",
      service: "s",
      event_timestamp: "2026-08-06T10:00:00Z",
      trace_id: "trace-abc",
      span_id: "span-abc",
      message_id: "msg-abc",
      correlation_id: "cor-abc"
    });

    // Another environment in the same project must not be visible.
    await journey(
      "jrn_staging",
      { projectId, environmentId: stagingId },
      "0018Z00002ABC",
      "2026-08-06T13:00:00Z"
    );
    await journey("jrn_other", otherScope, "0018Z00002ABC", "2026-08-06T14:00:00Z");
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  const find = (q: string, limit = 25, cursor?: string) =>
    searchJourneys(db, scope, q, searchTokens(keyring, q), {}, limit, cursor);

  it("finds a journey by primary entity id", async () => {
    const page = await find("0018Z00002ABC");
    expect(page.items.map((i) => i.journeyId)).toContain("jrn_1");
  });

  it("finds a journey by journey id", async () => {
    const page = await find("jrn_3");
    expect(page.items.map((i) => i.journeyId)).toEqual(["jrn_3"]);
  });

  it("finds journeys by alias value without knowing the alias type", async () => {
    // ADR-028: one value-only search returns both journeys, even though the
    // value was stored under two different alias types.
    const page = await find("SHARED-VALUE");
    expect(page.items.map((i) => i.journeyId).sort()).toEqual(["jrn_1", "jrn_2"]);
  });

  it.each(["trace-abc", "span-abc", "msg-abc", "cor-abc"])(
    "finds a journey by technical identifier %s",
    async (identifier) => {
      const page = await find(identifier);
      expect(page.items.map((i) => i.journeyId)).toEqual(["jrn_1"]);
    }
  );

  it("returns nothing for an unknown query", async () => {
    expect((await find("no-such-identifier")).items).toEqual([]);
  });

  it("excludes another project's journeys", async () => {
    const page = await find("0018Z00002ABC");
    expect(page.items.map((i) => i.journeyId)).not.toContain("jrn_other");
  });

  it("excludes another environment's journeys", async () => {
    const page = await find("0018Z00002ABC");
    expect(page.items.map((i) => i.journeyId)).not.toContain("jrn_staging");
  });

  it("orders by most recent activity", async () => {
    const page = await find("SHARED-VALUE");
    expect(page.items[0]?.journeyId).toBe("jrn_2");
  });

  it("paginates with a stable keyset cursor", async () => {
    const first = await find("SHARED-VALUE", 1);
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();

    const second = await find("SHARED-VALUE", 1, first.nextCursor ?? undefined);
    expect(second.items.map((i) => i.journeyId)).toEqual(["jrn_1"]);
    expect(second.nextCursor).toBeNull();
  });

  describe("during a rotation", () => {
    // Rows written under A keep A's tokens until they are re-encrypted. After
    // the switch to B, a search has to match either token or those rows vanish.
    const rotated = createKeyring(KEY_B, KEY_A);
    const underB = (q: string) => searchJourneys(db, scope, q, searchTokens(rotated, q), {}, 25);
    const bOnly = createKeyring(KEY_B);

    // In afterEach rather than at the end of a test body, so a failing assertion
    // cannot leave the row behind for the tests after it.
    afterEach(async () => {
      await db("journeys").where({ id: "jrn_new" }).delete();
    });

    it("finds a journey whose entity token is the previous key's", async () => {
      expect((await underB("0018Z00002XYZ")).items.map((i) => i.journeyId)).toEqual(["jrn_2"]);
    });

    it("finds journeys whose alias token is the previous key's", async () => {
      const page = await underB("SHARED-VALUE");
      expect(page.items.map((i) => i.journeyId).sort()).toEqual(["jrn_1", "jrn_2"]);
    });

    it("finds a journey written under the new key alongside the old ones", async () => {
      await db("journeys").insert({
        id: "jrn_new",
        project_id: scope.projectId,
        environment_id: scope.environmentId,
        entity_type: "customer",
        primary_entity_id_hash: searchTokens(bOnly, "0018Z00002XYZ")[0] ?? "",
        status: "active",
        started_at: "2026-08-06T09:00:00Z",
        last_event_at: "2026-08-06T09:00:00Z",
        event_count: 1
      });
      const page = await underB("0018Z00002XYZ");
      expect(page.items.map((i) => i.journeyId).sort()).toEqual(["jrn_2", "jrn_new"]);
    });

    it("stops finding old rows once the previous key is gone", async () => {
      // The control: without it, the tests above could pass because the tokens
      // happen to match under any key.
      const page = await searchJourneys(
        db,
        scope,
        "0018Z00002XYZ",
        searchTokens(bOnly, "0018Z00002XYZ"),
        {},
        25
      );
      expect(page.items).toEqual([]);
    });
  });

  it("rejects a malformed cursor rather than silently restarting", async () => {
    await expect(find("SHARED-VALUE", 1, "not-a-cursor")).rejects.toThrow(InvalidCursorError);
  });

  // Each decoded fine and then failed in PostgreSQL's timestamptz cast, as a
  // 500. "1" and "March 7" are ones Date.parse understands and PostgreSQL does
  // not, so only the canonical form this API writes is accepted.
  it.each(["not-a-date", "1", "March 7", "2026-08-06 11:00:00Z"])(
    "rejects a well-formed cursor whose timestamp is %j",
    async (lastEventAt) => {
      const cursor = encodeCursor({ lastEventAt, id: "jrn_2" });
      await expect(find("SHARED-VALUE", 1, cursor)).rejects.toThrow(InvalidCursorError);
    }
  );

  it("accepts a cursor issued before the UNION rewrite", async () => {
    // A literal, not encodeCursor: a client may hold a cursor from a page it
    // fetched before an upgrade, so the bytes on the wire are the contract.
    // Issued by the pre-rewrite query for the page ending at jrn_2.
    const issuedBefore =
      "eyJsYXN0RXZlbnRBdCI6IjIwMjYtMDgtMDZUMTE6MDA6MDAuMDAwWiIsImlkIjoianJuXzIifQ";
    const first = await find("SHARED-VALUE", 1);
    expect(first.nextCursor).toBe(issuedBefore);
    expect((await find("SHARED-VALUE", 1, issuedBefore)).items.map((i) => i.journeyId)).toEqual([
      "jrn_1"
    ]);
  });

  it("accepts the cursor timestamp it wrote", async () => {
    const cursor = encodeCursor({ lastEventAt: "2026-08-06T11:00:00.000Z", id: "jrn_2" });
    expect((await find("SHARED-VALUE", 1, cursor)).items.map((i) => i.journeyId)).toEqual([
      "jrn_1"
    ]);
  });
});
