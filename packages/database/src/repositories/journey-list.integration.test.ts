import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertReturningId } from "../insert.js";
import { createKnexConfig } from "../knex-config.js";
import { InvalidCursorError, encodeCursor } from "./cursors.js";
import { listRecentJourneys, type RecentJourneyFilters } from "./journey-list.js";
import type { ReadScope } from "./read-scope.js";

describe("listRecentJourneys", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  /** The admin's view: every environment of the project. */
  let project: ReadScope;
  /** An API key's view: development only. */
  let development: ReadScope;

  const SINCE = new Date("2026-09-15T00:00:00.000Z");

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();

    const projectId = await insertReturningId(db, "projects", { name: "P", slug: "p" });
    const developmentId = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: "development"
    });
    const productionId = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: "production"
    });
    const otherProjectId = await insertReturningId(db, "projects", { name: "O", slug: "o" });
    const otherEnvironmentId = await insertReturningId(db, "environments", {
      project_id: otherProjectId,
      name: "development"
    });

    project = { projectId };
    development = { projectId, environmentId: developmentId };

    const journey = async (
      id: string,
      environmentId: string,
      status: string,
      lastEventAt: string,
      services: readonly string[] = [],
      owner: string = projectId
    ): Promise<void> => {
      await db("journeys").insert({
        id,
        project_id: owner,
        environment_id: environmentId,
        entity_type: "customer",
        primary_entity_id_hash: `hash-${id}`,
        status,
        started_at: lastEventAt,
        last_event_at: lastEventAt,
        event_count: services.length
      });
      for (const [index, service] of services.entries()) {
        await db("journey_events").insert({
          id: `${id}_evt_${String(index)}`,
          project_id: owner,
          environment_id: environmentId,
          journey_id: id,
          protocol_version: "0.1",
          content_hash: "h",
          operation: "received",
          name: "n",
          service,
          event_timestamp: lastEventAt
        });
      }
    };

    await journey("jrn_dev_failed", developmentId, "failed", "2026-09-15T10:00:00Z", [
      "sync-worker",
      "billing"
    ]);
    await journey("jrn_dev_completed", developmentId, "completed", "2026-09-15T11:00:00Z", [
      "billing"
    ]);
    await journey("jrn_dev_active", developmentId, "active", "2026-09-15T12:00:00Z");
    await journey("jrn_prod_failed", productionId, "failed", "2026-09-15T13:00:00Z", [
      "sync-worker"
    ]);
    await journey("jrn_prod_completed", productionId, "completed", "2026-09-15T14:00:00Z", [
      "sync-worker"
    ]);
    // Exactly on the bound, and one millisecond before it.
    await journey("jrn_at_since", developmentId, "failed", "2026-09-15T00:00:00.000Z");
    await journey("jrn_before_since", developmentId, "failed", "2026-09-14T23:59:59.999Z");
    // Another project's failure, newer than everything above.
    await journey(
      "jrn_other_project",
      otherEnvironmentId,
      "failed",
      "2026-09-15T15:00:00Z",
      ["sync-worker"],
      otherProjectId
    );
    // Journey ids are chosen by the client, so another project can reuse one of
    // P's. Its events must not satisfy P's service filter.
    await journey(
      "jrn_dev_active",
      otherEnvironmentId,
      "active",
      "2026-09-15T12:00:00Z",
      ["only-in-other-project"],
      otherProjectId
    );
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  const ids = async (
    scope: ReadScope,
    filters: Partial<RecentJourneyFilters> = {},
    limit = 25
  ): Promise<string[]> => {
    const page = await listRecentJourneys(db, scope, { since: SINCE, ...filters }, limit);
    return page.items.map((item) => item.journeyId);
  };

  it("lists every status in the window, newest activity first", async () => {
    expect(await ids(project)).toEqual([
      "jrn_prod_completed",
      "jrn_prod_failed",
      "jrn_dev_active",
      "jrn_dev_completed",
      "jrn_dev_failed",
      "jrn_at_since"
    ]);
  });

  it("returns the journey summary with its environment name", async () => {
    const page = await listRecentJourneys(db, project, { since: SINCE, service: "billing" }, 1);
    expect(page.items[0]).toEqual({
      journeyId: "jrn_dev_completed",
      entityType: "customer",
      encryptedPrimaryEntityId: null,
      status: "completed",
      eventCount: 1,
      startedAt: new Date("2026-09-15T11:00:00Z"),
      lastEventAt: new Date("2026-09-15T11:00:00Z"),
      environment: "development"
    });
  });

  it("filters by status", async () => {
    expect(await ids(project, { status: "failed" })).toEqual([
      "jrn_prod_failed",
      "jrn_dev_failed",
      "jrn_at_since"
    ]);
    expect(await ids(project, { status: "active" })).toEqual(["jrn_dev_active"]);
  });

  it("filters by environment name", async () => {
    expect(await ids(project, { environment: "production" })).toEqual([
      "jrn_prod_completed",
      "jrn_prod_failed"
    ]);
  });

  it("returns nothing for an environment the project does not have", async () => {
    expect(await ids(project, { environment: "no-such-environment" })).toEqual([]);
  });

  it("filters to journeys with at least one event from the service", async () => {
    expect(await ids(project, { service: "sync-worker" })).toEqual([
      "jrn_prod_completed",
      "jrn_prod_failed",
      "jrn_dev_failed"
    ]);
  });

  it("ignores another project's events on a journey with the same id", async () => {
    expect(await ids(project, { service: "only-in-other-project" })).toEqual([]);
  });

  it("matches the service exactly", async () => {
    expect(await ids(project, { service: "sync" })).toEqual([]);
    expect(await ids(project, { service: "SYNC-WORKER" })).toEqual([]);
  });

  it("combines every filter", async () => {
    expect(
      await ids(project, { status: "failed", environment: "production", service: "sync-worker" })
    ).toEqual(["jrn_prod_failed"]);
    expect(
      await ids(project, { status: "failed", environment: "development", service: "sync-worker" })
    ).toEqual(["jrn_dev_failed"]);
    expect(
      await ids(project, {
        status: "completed",
        environment: "development",
        service: "sync-worker"
      })
    ).toEqual([]);
  });

  it("includes a journey whose last activity is exactly at since", async () => {
    const found = await ids(project, { status: "failed" });
    expect(found).toContain("jrn_at_since");
    expect(found).not.toContain("jrn_before_since");
  });

  it("limits an environment-scoped caller to its own environment", async () => {
    expect(await ids(development)).toEqual([
      "jrn_dev_active",
      "jrn_dev_completed",
      "jrn_dev_failed",
      "jrn_at_since"
    ]);
  });

  it("returns an empty page when a scoped caller asks for another environment", async () => {
    // Search treats scope the same way: outside it, nothing exists.
    expect(await ids(development, { environment: "production" })).toEqual([]);
    // The control: the same filter from the project-wide scope finds rows.
    expect(await ids(project, { environment: "production" })).not.toEqual([]);
  });

  it("never returns another project's journeys", async () => {
    expect(await ids(project, { service: "sync-worker" })).not.toContain("jrn_other_project");
    expect(await ids(project)).not.toContain("jrn_other_project");
  });

  describe("pagination", () => {
    // Before SINCE and in an environment of their own, so these rows never
    // reach the tests above whatever order they run in.
    const TIED_AT = "2026-09-10T09:00:00.000Z";
    const staging = { since: new Date(TIED_AT), environment: "staging" };

    beforeAll(async () => {
      const stagingId = await insertReturningId(db, "environments", {
        project_id: project.projectId,
        name: "staging"
      });
      // Five journeys sharing one last_event_at, so a page boundary falls
      // inside the tie and only the id tiebreaker keeps the order total.
      for (const suffix of ["a", "b", "c", "d", "e"]) {
        await db("journeys").insert({
          id: `jrn_tie_${suffix}`,
          project_id: project.projectId,
          environment_id: stagingId,
          entity_type: "customer",
          primary_entity_id_hash: `hash-tie-${suffix}`,
          status: "active",
          started_at: TIED_AT,
          last_event_at: TIED_AT,
          event_count: 0
        });
      }
    });

    it("walks a tie across page boundaries without skipping or repeating", async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await listRecentJourneys(db, project, staging, 2, cursor);
        seen.push(...page.items.map((item) => item.journeyId));
        cursor = page.nextCursor ?? undefined;
        pages += 1;
      } while (cursor !== undefined && pages < 10);

      expect(seen).toEqual(["jrn_tie_e", "jrn_tie_d", "jrn_tie_c", "jrn_tie_b", "jrn_tie_a"]);
      expect(pages).toBe(3);
    });

    it("returns no cursor when the last page is exactly full", async () => {
      const page = await listRecentJourneys(db, project, staging, 5);
      expect(page.items).toHaveLength(5);
      expect(page.nextCursor).toBeNull();
    });

    it("rejects a malformed cursor rather than silently restarting", async () => {
      await expect(listRecentJourneys(db, project, staging, 2, "not-a-cursor")).rejects.toThrow(
        InvalidCursorError
      );
    });

    it.each(["not-a-date", "1", "March 7", "2026-09-10 09:00:00Z"])(
      "rejects a well-formed cursor whose timestamp is %j",
      async (lastEventAt) => {
        const cursor = encodeCursor({ lastEventAt, id: "jrn_tie_c" });
        await expect(listRecentJourneys(db, project, staging, 2, cursor)).rejects.toThrow(
          InvalidCursorError
        );
      }
    );
  });
});
