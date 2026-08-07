import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertReturningId } from "../insert.js";
import { createKnexConfig } from "../knex-config.js";
import { applyJourneyEvent, findJourney } from "./journeys.js";

describe("journey summary", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let projectId: string;
  let environmentId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();
    projectId = await insertReturningId(db, "projects", { name: "P", slug: "p" });
    environmentId = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: "development"
    });
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  const base = {
    entityType: "customer",
    primaryEntityIdHash: "hash",
    encryptedPrimaryEntityId: "cipher"
  };

  it("creates a journey on first event", async () => {
    await applyJourneyEvent(db, projectId, {
      ...base,
      journeyId: "jrn_a",
      environmentId,
      eventTimestamp: new Date("2026-08-06T10:00:00Z"),
      operation: "received",
      hasError: false
    });

    const journey = await findJourney(db, projectId, "jrn_a");
    expect(journey?.eventCount).toBe(1);
    expect(journey?.status).toBe("active");
  });

  it("uses the minimum timestamp for startedAt and the maximum for lastEventAt", async () => {
    await applyJourneyEvent(db, projectId, {
      ...base,
      journeyId: "jrn_a",
      environmentId,
      eventTimestamp: new Date("2026-08-06T12:00:00Z"),
      operation: "transformed",
      hasError: false
    });
    // Arrives later but happened earlier.
    await applyJourneyEvent(db, projectId, {
      ...base,
      journeyId: "jrn_a",
      environmentId,
      eventTimestamp: new Date("2026-08-06T08:00:00Z"),
      operation: "received",
      hasError: false
    });

    const journey = await findJourney(db, projectId, "jrn_a");
    expect(journey?.startedAt.toISOString()).toBe("2026-08-06T08:00:00.000Z");
    expect(journey?.lastEventAt.toISOString()).toBe("2026-08-06T12:00:00.000Z");
    expect(journey?.eventCount).toBe(3);
  });

  it("marks the journey failed when an event carries an error", async () => {
    await applyJourneyEvent(db, projectId, {
      ...base,
      journeyId: "jrn_a",
      environmentId,
      eventTimestamp: new Date("2026-08-06T13:00:00Z"),
      operation: "delivered",
      hasError: true
    });
    expect((await findJourney(db, projectId, "jrn_a"))?.status).toBe("failed");
  });

  it("does not let a late-arriving older event change status", async () => {
    await applyJourneyEvent(db, projectId, {
      ...base,
      journeyId: "jrn_a",
      environmentId,
      eventTimestamp: new Date("2026-08-06T09:00:00Z"),
      operation: "completed",
      hasError: false
    });
    // Older than lastEventAt, so it must not override the newer failure.
    expect((await findJourney(db, projectId, "jrn_a"))?.status).toBe("failed");
  });

  it("marks completed when the newest event is a completion", async () => {
    await applyJourneyEvent(db, projectId, {
      ...base,
      journeyId: "jrn_a",
      environmentId,
      eventTimestamp: new Date("2026-08-06T14:00:00Z"),
      operation: "completed",
      hasError: false
    });
    expect((await findJourney(db, projectId, "jrn_a"))?.status).toBe("completed");
  });

  it("scopes lookups to the project", async () => {
    const other = await insertReturningId(db, "projects", { name: "O", slug: "o" });
    expect(await findJourney(db, other, "jrn_a")).toBeUndefined();
  });
});
