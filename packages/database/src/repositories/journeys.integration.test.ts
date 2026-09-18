import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { insertReturningId } from "../insert.js";
import { createKnexConfig } from "../knex-config.js";
import { applyJourneyEvent, ensureJourney, findJourney, updateJourneySummary } from "./journeys.js";

describe("journey summary", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let projectId: string;
  let environmentId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(inject("postgresImage")).start();
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
    encryptedPrimaryEntityId: "cipher",
    eventId: "evt_base",
    stepName: "step",
    label: null
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

  describe("a retried step that succeeds (ADR-061)", () => {
    const completedAt = async (journeyId: string): Promise<Date | null> => {
      const row: unknown = await db("journeys")
        .where({ project_id: projectId, id: journeyId })
        .first("completed_at as completedAt");
      return (row as { completedAt: Date | null } | undefined)?.completedAt ?? null;
    };

    it("clears an earlier failure back to active, without waiting for finish()", async () => {
      // ADR-022 renames a wrapped call's operation to 'retried' whenever the
      // caller passes an attempt greater than 1, whichever way the call comes
      // out. So the success of a step that failed on attempt 1 arrives as
      // 'retried' with no error, and before ADR-061 it could not undo the
      // earlier failure by itself: only finish() could.
      await applyJourneyEvent(db, projectId, {
        ...base,
        journeyId: "jrn_retry_wins",
        environmentId,
        eventTimestamp: new Date("2026-08-06T10:00:00Z"),
        operation: "delivered",
        hasError: true
      });
      await applyJourneyEvent(db, projectId, {
        ...base,
        journeyId: "jrn_retry_wins",
        environmentId,
        eventTimestamp: new Date("2026-08-06T10:00:05Z"),
        operation: "retried",
        hasError: false
      });

      // Active, not completed: the journey is running again, and it has not
      // said it finished. A falsely reassuring status is worse than a stale
      // alarming one.
      expect((await findJourney(db, projectId, "jrn_retry_wins"))?.status).toBe("active");
      expect(await completedAt("jrn_retry_wins")).toBeNull();
    });

    it("reads completed once finish() lands", async () => {
      await applyJourneyEvent(db, projectId, {
        ...base,
        journeyId: "jrn_retry_wins",
        environmentId,
        eventTimestamp: new Date("2026-08-06T10:00:06Z"),
        operation: "completed",
        hasError: false
      });

      expect((await findJourney(db, projectId, "jrn_retry_wins"))?.status).toBe("completed");
      expect((await completedAt("jrn_retry_wins"))?.toISOString()).toBe("2026-08-06T10:00:06.000Z");
    });

    it("leaves a journey whose only event is a successful retry active", async () => {
      // The control: clearing a failure is all this rule does. A 'retried'
      // event never marks a journey completed on its own.
      await applyJourneyEvent(db, projectId, {
        ...base,
        journeyId: "jrn_retry_only",
        environmentId,
        eventTimestamp: new Date("2026-08-06T10:00:00Z"),
        operation: "retried",
        hasError: false
      });

      expect((await findJourney(db, projectId, "jrn_retry_only"))?.status).toBe("active");
      expect(await completedAt("jrn_retry_only")).toBeNull();
    });

    it("never knocks a completed journey back to active", async () => {
      await applyJourneyEvent(db, projectId, {
        ...base,
        journeyId: "jrn_retry_after_finish",
        environmentId,
        eventTimestamp: new Date("2026-08-06T10:00:00Z"),
        operation: "completed",
        hasError: false
      });
      await applyJourneyEvent(db, projectId, {
        ...base,
        journeyId: "jrn_retry_after_finish",
        environmentId,
        eventTimestamp: new Date("2026-08-06T10:00:05Z"),
        operation: "retried",
        hasError: false
      });

      expect((await findJourney(db, projectId, "jrn_retry_after_finish"))?.status).toBe(
        "completed"
      );
    });

    it("stays failed when the retry fails too", async () => {
      await applyJourneyEvent(db, projectId, {
        ...base,
        journeyId: "jrn_retry_fails",
        environmentId,
        eventTimestamp: new Date("2026-08-06T10:00:00Z"),
        operation: "delivered",
        hasError: true
      });
      await applyJourneyEvent(db, projectId, {
        ...base,
        journeyId: "jrn_retry_fails",
        environmentId,
        eventTimestamp: new Date("2026-08-06T10:00:05Z"),
        operation: "retried",
        hasError: true
      });

      expect((await findJourney(db, projectId, "jrn_retry_fails"))?.status).toBe("failed");
      expect(await completedAt("jrn_retry_fails")).toBeNull();
    });

    it("does not let an older successful retry clear a newer failure", async () => {
      // ADR-061 changes what a successful 'retried' event means for status, not
      // the ordering rules: a failure still registers whatever its timestamp
      // says, and the clearing carries the same watermark test a completion
      // does, so an event stamped before the newest one cannot undo it.
      await applyJourneyEvent(db, projectId, {
        ...base,
        journeyId: "jrn_retry_older",
        environmentId,
        eventTimestamp: new Date("2026-08-06T10:00:10Z"),
        operation: "delivered",
        hasError: true
      });
      await applyJourneyEvent(db, projectId, {
        ...base,
        journeyId: "jrn_retry_older",
        environmentId,
        eventTimestamp: new Date("2026-08-06T10:00:05Z"),
        operation: "retried",
        hasError: false
      });

      expect((await findJourney(db, projectId, "jrn_retry_older"))?.status).toBe("failed");
    });
  });

  describe("the label and the last step", () => {
    interface Shown {
      label: string | null;
      labelAt: Date | null;
      labelEventId: string | null;
      lastStep: string | null;
      lastStepAt: Date | null;
      lastStepEventId: string | null;
    }

    const shown = async (journeyId: string): Promise<Shown> => {
      const row: unknown = await db("journeys")
        .where({ project_id: projectId, id: journeyId })
        .first(
          "label",
          "label_at as labelAt",
          "label_event_id as labelEventId",
          "last_step as lastStep",
          "last_step_at as lastStepAt",
          "last_step_event_id as lastStepEventId"
        );
      if (row === undefined) throw new Error(`no journey ${journeyId}`);
      return row as Shown;
    };

    const apply = async (
      journeyId: string,
      eventId: string,
      at: string,
      stepName: string,
      label: string | null,
      connection: Knex = db
    ): Promise<void> => {
      await applyJourneyEvent(connection, projectId, {
        ...base,
        journeyId,
        environmentId,
        eventId,
        stepName,
        label,
        eventTimestamp: new Date(at),
        operation: "transformed",
        hasError: false
      });
    };

    it("keeps the newer label when an older event carrying one arrives last", async () => {
      await apply("jrn_label_order", "evt_2", "2026-08-06T10:00:02Z", "second", "Newer");
      await apply("jrn_label_order", "evt_1", "2026-08-06T10:00:01Z", "first", "Older");
      expect(await shown("jrn_label_order")).toMatchObject({
        label: "Newer",
        labelAt: new Date("2026-08-06T10:00:02Z"),
        labelEventId: "evt_2"
      });
    });

    it("takes a newer label that arrives after an older one", async () => {
      await apply("jrn_label_newer", "evt_1", "2026-08-06T10:00:01Z", "first", "Older");
      await apply("jrn_label_newer", "evt_2", "2026-08-06T10:00:02Z", "second", "Newer");
      expect((await shown("jrn_label_newer")).label).toBe("Newer");
    });

    it("breaks a tie on the timestamp by the order events were received, whatever their ids", async () => {
      // Each apply is its own transaction, so each is received later than the
      // one before, as the timeline orders them (received_at is the
      // transaction's start).
      const at = "2026-08-06T10:00:00Z";
      await apply("jrn_label_tie_1", "evt_b", at, "b", "From b");
      await apply("jrn_label_tie_1", "evt_a", at, "a", "From a");
      await apply("jrn_label_tie_2", "evt_a", at, "a", "From a");
      await apply("jrn_label_tie_2", "evt_b", at, "b", "From b");
      expect(await shown("jrn_label_tie_1")).toMatchObject({
        label: "From a",
        labelEventId: "evt_a",
        lastStep: "a",
        lastStepEventId: "evt_a"
      });
      expect(await shown("jrn_label_tie_2")).toMatchObject({
        label: "From b",
        labelEventId: "evt_b",
        lastStep: "b",
        lastStepEventId: "evt_b"
      });
    });

    it("breaks a tie on the timestamp and the arrival by the larger event id", async () => {
      // Events stored in one transaction were received at the same instant.
      const at = "2026-08-06T10:00:00Z";
      await db.transaction(async (trx) => {
        await apply("jrn_label_tie_3", "evt_b", at, "b", "From b", trx);
        await apply("jrn_label_tie_3", "evt_a", at, "a", "From a", trx);
      });
      await db.transaction(async (trx) => {
        await apply("jrn_label_tie_4", "evt_a", at, "a", "From a", trx);
        await apply("jrn_label_tie_4", "evt_b", at, "b", "From b", trx);
      });
      for (const journeyId of ["jrn_label_tie_3", "jrn_label_tie_4"]) {
        expect(await shown(journeyId), journeyId).toMatchObject({
          label: "From b",
          labelEventId: "evt_b",
          lastStep: "b",
          lastStepEventId: "evt_b"
        });
      }
    });

    it("never lets a later timestamp lose to a later arrival", async () => {
      await apply("jrn_label_tie_5", "evt_z", "2026-08-06T10:00:00.002Z", "newest", "Newest");
      await apply("jrn_label_tie_5", "evt_a", "2026-08-06T10:00:00.001Z", "older", "Older");
      expect(await shown("jrn_label_tie_5")).toMatchObject({ label: "Newest", lastStep: "newest" });
    });

    it("compares event ids byte by byte, whatever the database collation says", async () => {
      // "B" (0x42) sorts before "a" (0x61) in bytes and after it in most
      // linguistic collations. The rule has to mean the same on every install.
      // The stored ids are given a linguistic collation for this test, so a
      // comparison that followed the column's collation would pick "evt_B".
      const at = "2026-08-06T10:00:00Z";
      const linguistic = `text collate "en-x-icu"`;
      const plain = `text collate "default"`;
      const setCollation = async (type: string): Promise<void> => {
        await db.raw(
          `alter table journeys alter column label_event_id type ${type}, alter column last_step_event_id type ${type}`
        );
      };
      await setCollation(linguistic);
      try {
        const ordered: unknown = await db.raw(
          `select 'evt_B'::text collate "en-x-icu" > 'evt_a'::text collate "en-x-icu" as upper_first`
        );
        expect((ordered as { rows: { upper_first: boolean }[] }).rows[0]?.upper_first).toBe(true);
        // In one transaction, so the ids are what breaks the tie.
        await db.transaction(async (trx) => {
          await apply("jrn_label_bytes", "evt_a", at, "lower", "Lower", trx);
          await apply("jrn_label_bytes", "evt_B", at, "upper", "Upper", trx);
        });
        expect(await shown("jrn_label_bytes")).toMatchObject({ label: "Lower", lastStep: "lower" });
      } finally {
        await setCollation(plain);
      }
    });

    it("leaves the label alone for an event without one, however new", async () => {
      await apply("jrn_label_keep", "evt_1", "2026-08-06T10:00:01Z", "first", "Kept");
      await apply("jrn_label_keep", "evt_2", "2026-08-06T10:00:09Z", "second", null);
      expect(await shown("jrn_label_keep")).toMatchObject({
        label: "Kept",
        labelEventId: "evt_1",
        lastStep: "second"
      });
    });

    it("stores no label for a journey whose events never carry one", async () => {
      await apply("jrn_label_none", "evt_1", "2026-08-06T10:00:01Z", "first", null);
      expect(await shown("jrn_label_none")).toMatchObject({
        label: null,
        labelAt: null,
        labelEventId: null,
        lastStep: "first",
        lastStepAt: new Date("2026-08-06T10:00:01Z"),
        lastStepEventId: "evt_1"
      });
    });

    it("never moves the last step backwards, whatever order events arrive in", async () => {
      const steps = [
        ["evt_3", "2026-08-06T10:00:03Z", "three"],
        ["evt_1", "2026-08-06T10:00:01Z", "one"],
        ["evt_4", "2026-08-06T10:00:03Z", "four"],
        ["evt_2", "2026-08-06T10:00:02Z", "two"]
      ] as const;
      let latest = "";
      for (const [eventId, at, step] of steps) {
        await apply("jrn_step_order", eventId, at, step, null);
        const now = await shown("jrn_step_order");
        // Only ever forward: the timestamp it holds is never smaller than
        // before. evt_4 ties with evt_3 and was received later.
        const held = now.lastStepAt?.toISOString() ?? "";
        expect(held >= latest).toBe(true);
        latest = held;
      }
      expect(await shown("jrn_step_order")).toMatchObject({
        lastStep: "four",
        lastStepEventId: "evt_4"
      });
    });

    it("settles on the newest label and step under concurrent events", async () => {
      const events = Array.from({ length: 24 }, (_, i) => ({
        eventId: `evt_${String(i).padStart(2, "0")}`,
        at: new Date(Date.UTC(2026, 7, 6, 10, 0, i % 5)).toISOString(),
        label: i % 3 === 0 ? null : `Label ${String(i)}`
      }));
      await ensureJourney(db, projectId, {
        ...base,
        journeyId: "jrn_label_race",
        environmentId,
        eventTimestamp: new Date("2026-08-06T10:00:00Z"),
        operation: "received",
        hasError: false
      });
      // When each transaction started, which is when its event was received.
      const receivedAt = new Map<string, string>();
      await Promise.all(
        events.map((event) =>
          db.transaction(async (trx) => {
            const started: unknown = await trx.raw(
              "select to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') as at"
            );
            receivedAt.set(
              event.eventId,
              (started as { rows: { at: string }[] }).rows[0]?.at ?? ""
            );
            const facts = {
              ...base,
              journeyId: "jrn_label_race",
              environmentId,
              eventId: event.eventId,
              stepName: `step ${event.eventId}`,
              label: event.label,
              eventTimestamp: new Date(event.at),
              operation: "transformed",
              hasError: false
            };
            await ensureJourney(trx, projectId, facts);
            await updateJourneySummary(trx, projectId, facts);
          })
        )
      );
      // The timeline's order: timestamp, then arrival, then id.
      const key = (event: (typeof events)[number]): string =>
        `${event.at}|${receivedAt.get(event.eventId) ?? ""}|${event.eventId}`;
      const newest = (list: typeof events): (typeof events)[number] | undefined =>
        [...list].sort((a, b) => (key(a) < key(b) ? -1 : 1)).at(-1);
      const labelled = newest(events.filter((event) => event.label !== null));
      const last = newest(events);
      expect(await shown("jrn_label_race")).toMatchObject({
        label: labelled?.label,
        labelEventId: labelled?.eventId,
        lastStep: `step ${last?.eventId ?? ""}`,
        lastStepEventId: last?.eventId
      });
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
