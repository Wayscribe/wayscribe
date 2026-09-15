import type { Knex } from "knex";
import { withoutStatementTimeout } from "../statement-timeout.js";
import { lockHolderAlive, withTransactionLock } from "./advisory-lock.js";

/**
 * An arbitrary but fixed 64-bit key for `pg_try_advisory_xact_lock`.
 *
 * The number itself carries no meaning; what matters is that every replica uses
 * the same one, so only one of them sweeps at a time (ADR-026). Range deletion
 * takes the same key, so a range deletion and a sweep never run at once.
 */
export const RETENTION_LOCK_KEY = 4_919_072_026;

export interface SweepResult {
  /** False when another replica held the lock. Nothing was examined. */
  ran: boolean;
  journeysDeleted: number;
  batches: number;
  environmentsExamined: number;
  /**
   * The connection holding the lock ended mid-sweep, for example by
   * `idle_in_transaction_session_timeout`, and the sweep stopped after the
   * batch in progress. The counts are what committed; the next sweep deletes
   * the rest.
   */
  stoppedEarly: boolean;
}

export interface SweepOptions {
  /** Journeys removed per statement. Bounds the lock duration on a large table. */
  batchSize?: number;
  /** Ceiling on batches per environment per sweep, so one sweep cannot run forever. */
  maxBatchesPerEnvironment?: number;
}

interface EnvironmentRow {
  id: string;
  projectId: string;
  retentionDays: number;
}

/**
 * Delete journeys past their environment's retention window.
 *
 * Every child row goes with them: `journey_events`, `entity_aliases`, and
 * `replay_runs` all cascade on the journey's composite key, so this is one
 * statement rather than four in a careful order.
 *
 * Retention is per environment rather than global, because the same
 * installation reasonably keeps production for thirty days and a local sandbox
 * for one.
 *
 * Returns rather than logs, so the caller decides what to say and tests can
 * assert on the numbers.
 */
export async function sweepExpiredJourneys(
  db: Knex,
  options: SweepOptions = {}
): Promise<SweepResult> {
  const batchSize = options.batchSize ?? 1_000;
  const maxBatches = options.maxBatchesPerEnvironment ?? 50;

  // A transaction-scoped lock on one connection held for the whole sweep.
  // It used to be a session lock taken and released by separate pooled
  // queries: under contention the release landed on a different connection
  // and failed, the lock stayed with an idle pooled backend, and every later
  // sweep on every replica skipped until a restart. `withTransactionLock`
  // holds it on one transaction instead, and the deletes run on other
  // connections, so each batch commits as it goes rather than when the sweep
  // ends.
  const run = await withTransactionLock(db, RETENTION_LOCK_KEY, async (holder) => {
    const rows: unknown = await db("environments").select(
      "id",
      "project_id as projectId",
      "retention_days as retentionDays"
    );
    const environments = rows as EnvironmentRow[];

    let journeysDeleted = 0;
    let batches = 0;
    const result = (stoppedEarly: boolean): SweepResult => ({
      ran: true,
      journeysDeleted,
      batches,
      environmentsExamined: environments.length,
      stoppedEarly
    });

    for (const environment of environments) {
      for (let batch = 0; batch < maxBatches; batch += 1) {
        // Before every batch: without the lock another replica may be sweeping
        // too, so a lost lock ends this sweep after the batch that committed.
        if (!(await lockHolderAlive(holder))) return result(true);

        // `last_event_at`, not `started_at`: a journey that is still receiving
        // events is still interesting, however long ago it began.
        //
        // Its own transaction, as the bare statement was, so the batch can run
        // without the API's statement timeout (see withoutStatementTimeout).
        const deleted: unknown = await db.transaction(async (trx): Promise<unknown> => {
          await withoutStatementTimeout(trx);
          return await trx.raw(
            `delete from journeys
               where (project_id, id) in (
                 select project_id, id from journeys
                  where project_id = ?
                    and environment_id = ?
                    and last_event_at < now() - make_interval(days => ?)
                  order by last_event_at
                  limit ?
               )`,
            [environment.projectId, environment.id, environment.retentionDays, batchSize]
          );
        });

        const count = (deleted as { rowCount?: number }).rowCount ?? 0;
        journeysDeleted += count;
        if (count > 0) batches += 1;
        if (count < batchSize) break;
      }
    }

    return result(false);
  });

  return run.acquired
    ? run.value
    : { ran: false, journeysDeleted: 0, batches: 0, environmentsExamined: 0, stoppedEarly: false };
}
