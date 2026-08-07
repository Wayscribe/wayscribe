import type { Knex } from "knex";

/**
 * An arbitrary but fixed 64-bit key for `pg_try_advisory_lock`.
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

  // Session-level, released explicitly below. A replica that dies mid-sweep
  // drops its connection, and PostgreSQL releases the lock with it.
  const acquired: unknown = await db.raw("select pg_try_advisory_lock(?) as locked", [
    ADVISORY_LOCK_KEY
  ]);
  const locked = ((acquired as { rows?: { locked?: boolean }[] }).rows ?? [])[0]?.locked === true;
  if (!locked) {
    return { ran: false, journeysDeleted: 0, batches: 0, environmentsExamined: 0 };
  }

  try {
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
    await db.raw("select pg_advisory_unlock(?)", [ADVISORY_LOCK_KEY]);
  }
}
