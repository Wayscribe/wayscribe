import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertReturningId } from "../insert.js";
import { createKnexConfig } from "../knex-config.js";
import { applyJourneyEvent, ensureJourney, findJourney, updateJourneySummary } from "./journeys.js";

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

  describe("a failure that arrives out of order", () => {
    it("still marks the journey failed", async () => {
      // ADR-031 stamps a wrapped event when its callback starts and enqueues it
      // when the callback finishes, so a slow failing step is always stamped
      // earlier than it arrives. A status-less event advancing last_event_at in
      // between used to discard the failure entirely, leaving the journey
      // 'active' with a failed event in its own timeline — which the search
      // list paints in the ordinary colour, so nobody opens it.
      await applyJourneyEvent(db, projectId, {
        ...base,
        journeyId: "jrn_late_failure",
        environmentId,
        eventTimestamp: new Date("2026-08-06T10:00:10Z"),
        operation: "transformed",
        hasError: false
      });

      await applyJourneyEvent(db, projectId, {
        ...base,
        journeyId: "jrn_late_failure",
        environmentId,
        eventTimestamp: new Date("2026-08-06T10:00:05Z"),
        operation: "delivered",
        hasError: true
      });

      expect((await findJourney(db, projectId, "jrn_late_failure"))?.status).toBe("failed");
    });

    it("marks it failed even when the watermark is far ahead", async () => {
      await applyJourneyEvent(db, projectId, {
        ...base,
        journeyId: "jrn_far_ahead",
        environmentId,
        eventTimestamp: new Date("2026-08-07T00:00:00Z"),
        operation: "received",
        hasError: false
      });
      await applyJourneyEvent(db, projectId, {
        ...base,
        journeyId: "jrn_far_ahead",
        environmentId,
        eventTimestamp: new Date("2026-08-06T00:00:00Z"),
        operation: "failed",
        hasError: false
      });

      expect((await findJourney(db, projectId, "jrn_far_ahead"))?.status).toBe("failed");
    });

    it("leaves an ordinary journey active", async () => {
      // The control: a change that marked everything failed would pass both
      // tests above.
      await applyJourneyEvent(db, projectId, {
        ...base,
        journeyId: "jrn_ordinary",
        environmentId,
        eventTimestamp: new Date("2026-08-06T10:00:00Z"),
        operation: "received",
        hasError: false
      });
      await applyJourneyEvent(db, projectId, {
        ...base,
        journeyId: "jrn_ordinary",
        environmentId,
        eventTimestamp: new Date("2026-08-06T10:00:01Z"),
        operation: "transformed",
        hasError: false
      });

      expect((await findJourney(db, projectId, "jrn_ordinary"))?.status).toBe("active");
    });
  });

  describe("the lock ensureJourney holds while an event is stored", () => {
    const facts = (journeyId: string) => ({
      ...base,
      journeyId,
      environmentId,
      eventTimestamp: new Date("2026-08-06T10:00:00Z"),
      operation: "received",
      hasError: false
    });

    /** Run `work` in a transaction that gives up on any lock after 500 ms. */
    const briefly = <T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T> =>
      db.transaction(async (trx) => {
        await trx.raw("set local lock_timeout = '500ms'");
        return work(trx);
      });

    it("lets another event for the same journey through while it is held", async () => {
      // FOR UPDATE serialised every event for one journey behind the first:
      // 16 concurrent streams on one journey went from 22 ms to 31-33 ms.
      // FOR KEY SHARE conflicts with neither another KEY SHARE nor the
      // non-key UPDATE of the summary, so a second event proceeds at once.
      await ensureJourney(db, projectId, facts("jrn_lock_share"));
      const holder = await db.transaction();
      try {
        await ensureJourney(holder, projectId, facts("jrn_lock_share"));
        await briefly(async (trx) => {
          expect(await ensureJourney(trx, projectId, facts("jrn_lock_share"))).toBe(environmentId);
          await updateJourneySummary(trx, projectId, facts("jrn_lock_share"));
        });
      } finally {
        await holder.rollback();
      }
    });

    it("and holds off a deletion until the event is stored", async () => {
      await ensureJourney(db, projectId, facts("jrn_lock_delete"));
      const holder = await db.transaction();
      try {
        await ensureJourney(holder, projectId, facts("jrn_lock_delete"));
        await expect(
          briefly((trx) =>
            trx("journeys").where({ project_id: projectId, id: "jrn_lock_delete" }).delete()
          )
        ).rejects.toMatchObject({ code: "55P03" });
      } finally {
        await holder.rollback();
      }
    });

    it("never deadlocks two events that both update the summary", async () => {
      await ensureJourney(db, projectId, facts("jrn_lock_both"));
      await Promise.all(
        Array.from({ length: 16 }, () =>
          db.transaction(async (trx) => {
            await ensureJourney(trx, projectId, facts("jrn_lock_both"));
            await updateJourneySummary(trx, projectId, facts("jrn_lock_both"));
          })
        )
      );
      expect((await findJourney(db, projectId, "jrn_lock_both"))?.eventCount).toBe(16);
    });
  });
});
