import { sweepExpiredJourneys } from "@wayscribe/database";
import type { FastifyInstance } from "fastify";

export interface RetentionJobOptions {
  intervalMs?: number;
  batchSize?: number;
}

export interface RetentionJob {
  /** Runs one sweep now. Exposed so a test does not have to wait for a timer. */
  runOnce(): Promise<void>;
  stop(): void;
}

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Delete expired journeys on an interval, inside the API process (ADR-026).
 *
 * No extra container, which keeps PostgreSQL the only required backing service.
 * The advisory lock in the repository means several replicas can run this
 * without deleting concurrently, and retention simply stops while the API is
 * down — acceptable for a cleanup job, and stated in the ADR.
 *
 * One structured log line per sweep that deleted something, and every sweep's
 * outcome in the metrics, so an alert can notice a sweep that has stopped
 * completing, which no log line announces.
 */
export function startRetentionJob(
  app: FastifyInstance,
  options: RetentionJobOptions = {}
): RetentionJob {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  let running = false;

  async function runOnce(): Promise<void> {
    // Guards against an overlapping run when a sweep outlasts the interval.
    if (running) return;
    running = true;
    const startedAt = Date.now();

    try {
      const result = await sweepExpiredJourneys(app.db, {
        ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize })
      });

      if (!result.ran) {
        app.metrics.recordSweep("locked", 0);
        app.log.debug("retention sweep skipped; another replica holds the lock");
        return;
      }
      app.metrics.recordSweep(
        result.stoppedEarly ? "stopped_early" : "completed",
        result.journeysDeleted
      );
      if (result.stoppedEarly) {
        // The lock's connection ended mid-sweep, so another replica may now be
        // sweeping. What committed stands, and the next interval sweeps the rest.
        app.log.warn(
          { journeysDeleted: result.journeysDeleted, batches: result.batches },
          "retention sweep lost its lock and stopped early; the next sweep continues"
        );
        return;
      }
      if (result.journeysDeleted > 0) {
        app.log.info(
          {
            journeysDeleted: result.journeysDeleted,
            batches: result.batches,
            environmentsExamined: result.environmentsExamined,
            durationMs: Date.now() - startedAt
          },
          "retention sweep deleted expired journeys"
        );
      }
    } catch (error) {
      // A failed sweep must never take the API down: the next interval retries,
      // and serving reads matters more than reclaiming disk on schedule.
      app.metrics.recordSweep("failed", 0);
      app.log.error({ err: error }, "retention sweep failed");
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void runOnce(), intervalMs);
  // Never hold the process open on the cleanup job's account.
  timer.unref();

  return {
    runOnce,
    stop: () => {
      clearInterval(timer);
    }
  };
}
