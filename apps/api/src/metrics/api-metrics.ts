import type { Knex } from "knex";
import { Registry } from "./exposition.js";

/**
 * Request duration buckets, in seconds.
 *
 * Prometheus's usual HTTP spread from 5 ms to 10 s, which separates an
 * ingestion write (single-digit milliseconds against a local database) from a
 * search (tens) from something wrong (seconds), plus one at 30 s. The default
 * statement timeout of 15 s lands inside (10, 30], so requests that ran into it
 * are counted apart from ordinary slow ones rather than lost in `+Inf`.
 */
export const HTTP_DURATION_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30
];

/** The label for a request no route matched, so a scanner's paths share one series. */
export const UNMATCHED_ROUTE = "unmatched";

/**
 * Methods reported by name. Node's parser admits a few dozen others (WebDAV,
 * `PURGE`, and so on), none of which this API routes, so they share one value.
 */
const KNOWN_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

export type EventResult = "accepted" | "duplicate" | "rejected";
export type SweepOutcome = "completed" | "locked" | "stopped_early" | "failed";

/** The part of tarn's pool, which knex uses, that says how busy it is. */
interface PoolCounts {
  numUsed: () => number;
  numFree: () => number;
  numPendingAcquires: () => number;
}

export interface ApiMetrics {
  /** `route` is the matched route pattern, or undefined when nothing matched. Never the raw path. */
  observeRequest(method: string, route: string | undefined, status: number, seconds: number): void;
  countEvent(result: EventResult): void;
  countQueryTimeout(route: string | undefined): void;
  recordSweep(outcome: SweepOutcome, journeysDeleted: number): void;
  /** Rows and keys the configured keys cannot read, by table, from the boot check. */
  setUnreadable(counts: Readonly<Record<string, number>>): void;
  render(): Promise<string>;
}

/**
 * Every series the API exposes, and nothing more.
 *
 * No label carries a project id, key prefix, entity, or any value from a
 * request: each label here takes its values from a fixed set or from the
 * router's own table of patterns, so the number of series is bounded by the
 * code, not by traffic.
 */
export function createApiMetrics(db: Knex): ApiMetrics {
  const registry = new Registry();

  const requests = registry.counter(
    "flight_recorder_http_requests_total",
    "HTTP requests answered by the API, by method, route pattern, and status.",
    ["method", "route", "status"]
  );
  const durations = registry.histogram(
    "flight_recorder_http_request_duration_seconds",
    "Time from receiving a request to finishing its response, by method and route pattern.",
    HTTP_DURATION_BUCKETS,
    ["method", "route"]
  );
  const events = registry.counter(
    "flight_recorder_events_total",
    "Events that reached ingestion, by result. Duplicates are accepted and not stored again.",
    ["result"]
  );
  for (const result of ["accepted", "duplicate", "rejected"] as const) events.inc({ result }, 0);

  const timeouts = registry.counter(
    "flight_recorder_query_timeouts_total",
    "Requests whose database statement was cancelled by DATABASE_STATEMENT_TIMEOUT_MS, by route pattern.",
    ["route"]
  );
  const pool = registry.gauge(
    "flight_recorder_db_pool_connections",
    "Database pool connections: used, free, and requests waiting for one.",
    ["state"]
  );
  const sweeps = registry.counter(
    "flight_recorder_retention_sweep_runs_total",
    "Retention sweeps this process started, by outcome. `locked` means another replica held the lock.",
    ["outcome"]
  );
  for (const outcome of ["completed", "locked", "stopped_early", "failed"] as const) {
    sweeps.inc({ outcome }, 0);
  }
  const deleted = registry.counter(
    "flight_recorder_retention_journeys_deleted_total",
    "Journeys the retention sweep deleted."
  );
  const lastSuccess = registry.gauge(
    "flight_recorder_retention_last_success_timestamp_seconds",
    "Unix time of the last retention sweep this process completed. 0 until one does."
  );
  const unreadable = registry.gauge(
    "flight_recorder_unreadable_values",
    "Stored values and API keys the configured keys cannot read, by table, as of the boot check.",
    ["table"]
  );
  const memory = registry.gauge(
    "process_resident_memory_bytes",
    "Resident memory size of the API process in bytes."
  );
  const lag = registry.gauge(
    "nodejs_eventloop_lag_seconds",
    "How long a callback queued at scrape time waited for the event loop, in seconds."
  );

  registry.onCollect(async () => {
    // Read at scrape time: a gauge recorded on change would need a hook in
    // tarn, and the pool's own counts are cheap to ask for.
    const counts = (db as unknown as { client?: { pool?: PoolCounts } }).client?.pool;
    pool.set({ state: "used" }, counts?.numUsed() ?? 0);
    pool.set({ state: "free" }, counts?.numFree() ?? 0);
    pool.set({ state: "pending" }, counts?.numPendingAcquires() ?? 0);

    memory.set({}, process.memoryUsage.rss());

    // Measured the way prom-client measures it: how long a callback queued
    // now waits behind whatever else is on the loop.
    const started = process.hrtime.bigint();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    lag.set({}, Number(process.hrtime.bigint() - started) / 1e9);
  });

  return {
    observeRequest(method, route, status, seconds) {
      const labels = {
        method: KNOWN_METHODS.has(method) ? method : "other",
        route: route ?? UNMATCHED_ROUTE
      };
      requests.inc({ ...labels, status: String(status) });
      durations.observe(labels, seconds);
    },
    countEvent(result) {
      events.inc({ result });
    },
    countQueryTimeout(route) {
      timeouts.inc({ route: route ?? UNMATCHED_ROUTE });
    },
    recordSweep(outcome, journeysDeleted) {
      sweeps.inc({ outcome });
      if (journeysDeleted > 0) deleted.inc({}, journeysDeleted);
      if (outcome === "completed") lastSuccess.set({}, Math.floor(Date.now() / 1000));
    },
    setUnreadable(counts) {
      for (const [table, count] of Object.entries(counts)) unreadable.set({ table }, count);
    },
    render: () => registry.render()
  };
}
