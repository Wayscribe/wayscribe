import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { deriveSubkeys, searchToken } from "@flight-recorder/payload-security";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertReturningId } from "../insert.js";
import { createKnexConfig } from "../knex-config.js";
import { InvalidCursorError } from "./cursors.js";
import { searchJourneys } from "./search.js";
import type { ReadScope } from "./read-scope.js";

const subkeys = deriveSubkeys("0123456789abcdef0123456789abcdef");
const token = (value: string): string => searchToken(subkeys.searchToken, value);

describe("searchJourneys", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let scope: ReadScope;
  let otherScope: ReadScope;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
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
    searchJourneys(db, scope, q, token(q), limit, cursor);

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

  it("rejects a malformed cursor rather than silently restarting", async () => {
    await expect(find("SHARED-VALUE", 1, "not-a-cursor")).rejects.toThrow(InvalidCursorError);
  });
});
