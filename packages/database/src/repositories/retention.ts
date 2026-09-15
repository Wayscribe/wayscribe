import type { Knex } from "knex";

// debtwatch:start
// id: DEBT-N11B8K
// owner: flight-recorder
// expires: 2027-01-01
// reason: The only way to delete anything is this sweep — time-based, per-environment, all-or-nothing. A redaction miss leaves rows nothing can remove, and it is also the answer to an erasure request
// tags: operations, data-protection
// debtwatch:end
/**
 * An arbitrary but fixed 64-bit key for `pg_try_advisory_xact_lock`.
 *
 * The number itself carries no meaning; what matters is that every replica uses
 * the same one, so only one of them sweeps at a time (ADR-026).
 */
const ADVISORY_LOCK_KEY = 4_919_072_026;

export interface SweepResult {
  /** False when another replica held the lock. Nothing was examined. */
  ran: boolean;
  journeysDeleted: number;
  batches: number;
  environmentsExamined: number;
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
  // sweep on every replica skipped until a restart. Committing the holder
  // releases it, and a replica that dies drops the connection and the lock
  // with it. The deletes run on other connections, each its own transaction,
  // so each batch commits as it goes rather than when the sweep ends.
  //
  // The key is inlined, not bound: a bound parameter leaves an unnamed portal
  // open with its snapshot for the life of the transaction, which would keep
  // VACUUM from removing the very rows this sweep deletes.
  const holder = await db.transaction();
  try {
    const acquired: unknown = await holder.raw(
      `select pg_try_advisory_xact_lock(${String(ADVISORY_LOCK_KEY)}) as locked`
    );
    const locked = (acquired as { rows: { locked: boolean }[] }).rows[0]?.locked === true;
    if (!locked) {
      return { ran: false, journeysDeleted: 0, batches: 0, environmentsExamined: 0 };
    }

    const rows: unknown = await db("environments").select(
      "id",
      "project_id as projectId",
      "retention_days as retentionDays"
    );
    const environments = rows as EnvironmentRow[];

    let journeysDeleted = 0;
    let batches = 0;

    for (const environment of environments) {
      for (let batch = 0; batch < maxBatches; batch += 1) {
        // `last_event_at`, not `started_at`: a journey that is still receiving
        // events is still interesting, however long ago it began.
        const deleted: unknown = await db.raw(
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

        const count = (deleted as { rowCount?: number }).rowCount ?? 0;
        journeysDeleted += count;
        if (count > 0) batches += 1;
        if (count < batchSize) break;
      }
    }

    return {
      ran: true,
      journeysDeleted,
      batches,
      environmentsExamined: environments.length
    };
  } finally {
    // Nothing was written through the holder. If its connection has already
    // gone, so has the lock, and a failure here must not hide the sweep's own
    // error.
    await holder.commit().catch(() => undefined);
  }
}
