import type { Knex } from "knex";
import { orderJourneysAfter, toJourneyPage, type JourneyPage } from "./journey-keyset.js";
import { journeySummaryColumns, type DisplayableAlias } from "./journey-summary.js";
import type { ReadScope } from "./read-scope.js";

export interface SearchHit {
  journeyId: string;
  entityType: string;
  encryptedPrimaryEntityId: string | null;
  status: string;
  eventCount: number;
  startedAt: Date;
  lastEventAt: Date;
  /** Public display text, or null when no event has set one. */
  label: string | null;
  /** The step name of the latest event, or null for a journey not written since migration 018. */
  lastStep: string | null;
  /** Aliases a reader may see in full, in alias type order, then by value. */
  displayableAliases: DisplayableAlias[];
}

export type SearchPage = JourneyPage<SearchHit>;

/**
 * What narrows a search, all of it optional.
 *
 * With none of it the search spans the project's whole history and every
 * environment the scope allows, which is what it did before F-028: a Leadline
 * run searching by an email address reused across runs got 5 to 8 journeys
 * where it expected 1, because nothing bounded the search to the run.
 */
export interface SearchFilters {
  /** Journeys whose last activity is at or after this instant. */
  since?: Date | undefined;
  /** Journeys whose last activity is before this instant. */
  until?: Date | undefined;
  /** An environment name, applied on top of the scope, never instead of it. */
  environment?: string | undefined;
}

/**
 * One branch each rather than one `trace_id = ? or span_id = ? ...`: an OR
 * across columns cannot use any one column's index, and each of these has its
 * own (006 and 014).
 */
const TECHNICAL_IDENTIFIER_COLUMNS = [
  "trace_id",
  "span_id",
  "message_id",
  "correlation_id"
] as const;

/**
 * Resolve one query string against every identifier a developer might paste.
 *
 * One round trip rather than seven sequential probes. Technical
 * identifiers compare as plaintext; entity and alias compare as search tokens,
 * which the caller has already computed (ADR-028 makes that token
 * type-independent, so a bare value is enough).
 *
 * `tokens` is every token the value may be stored under: one normally, two
 * during a key rotation, when rows not yet re-encrypted still carry the
 * previous key's. The hash indexes serve an `IN` of two as well as an `=`.
 *
 * Scoping is inside the query, not applied to the results. A post-filter still
 * fetches the rows, and a later refactor that drops it leaks silently instead of
 * failing.
 *
 * Matching journey ids are a UNION of one index lookup per kind of identifier,
 * each within the project, and journeys are joined once for the columns, the
 * order, and the cursor. It used to be one `id = ? or hash in (?) or exists
 * (...) or exists (...)` over the project's journeys; PostgreSQL cannot serve
 * an OR across tables from an index, so it sorted every journey in the project
 * and probed aliases and events for each, and the cost grew with the journey
 * count however selective the value was.
 *
 * The environment is applied once, to the joined journey, and not inside the
 * branches. entity_aliases has no environment column, and an event's
 * environment can differ from its journey's (ingestion attaches an event to an
 * existing journey whichever environment sent it), so filtering events by
 * their own environment would change what an API key finds. The project is
 * applied in every branch as well as on the join: journey ids are unique only
 * within a project, and an unscoped branch would bring another project's id
 * for the join to match. `search-equivalence.integration.test.ts` holds the old
 * query and compares the two across generated data.
 *
 * Measured on PostgreSQL 17 (default configuration, 128 MB shared_buffers) on
 * an Apple M3 Pro, EXPLAIN (ANALYZE, BUFFERS), median execution time, page of
 * 25, API key scoped to one of four environments. Data: 1.1 million journeys
 * (1,000,000 in the measured project), 3 events and 1.5 aliases per journey,
 * trace ids on a sixth of events and span ids on half.
 *
 * - one matching alias value: was 575 ms at 120,000 journeys and 22 s at
 *   1,000,000 (a sort of every journey, then 250,000 alias and event probes);
 *   now 0.08 ms and 0.11 ms, 30 buffers.
 * - a value matching nothing, a journey id, a trace id, a span id: the same,
 *   within 0.1 ms of each other at both sizes. Without an environment in the
 *   scope the old query took 1.5 s and 20 to 40 s.
 * - a value matching many journeys: 13 ms for 2,400 matches at 120,000
 *   journeys and 64 ms for 20,000 at 1,000,000 (20 ms and 89 ms without an
 *   environment). Once the matches number in the thousands the planner hashes
 *   them and joins with a sequential scan of the project's journeys, so in
 *   that regime the cost tracks the journey count again, though at a few
 *   percent of what the old query paid for any value.
 *
 * `filters` needs no index of its own, measured the same way on PostgreSQL 17
 * with 200,000 journeys in one project over four environments, one alias each,
 * 2,000 of them sharing one value, last activity spread over 60 days:
 *
 * - a value matching one journey: 0.09 ms with no window, 0.12 ms with a
 *   one-day window. The plan is the same nested loop over the identifier
 *   indexes either way; the bounds only filter its one row.
 * - a value matching 2,000 journeys: 18.8 ms with no window, 14.7 ms with
 *   `since` alone, 25.6 ms with both bounds. The plan is unchanged, the hash
 *   join above, and the bounds ride along as a filter on the sequential scan
 *   that plan already does.
 * - the same value in a one-minute window: 1.1 ms, and the planner switches to
 *   an index scan on `journeys_project_recent_idx` (migration 019,
 *   `(project_id, last_event_at, id)`), whose leading columns are exactly what
 *   the bounds compare. A window selective enough to be worth an index is
 *   already served by one the journey list added.
 * - `environment` adds a join to `environments`, four rows here: 20.4 ms
 *   against 18.8 ms, inside the run-to-run spread.
 */
export async function searchJourneys(
  db: Knex,
  scope: ReadScope,
  query: string,
  tokens: readonly string[],
  filters: SearchFilters,
  limit: number,
  cursor?: string
): Promise<SearchPage> {
  const project = scope.projectId;

  const statement = db
    .with("matches", (matches) => {
      void matches
        .select("id as journey_id")
        .from("journeys")
        .where("project_id", project)
        .andWhere("id", query)
        .union((branch) => {
          void branch
            .select("id as journey_id")
            .from("journeys")
            .where("project_id", project)
            .whereIn("primary_entity_id_hash", tokens);
        })
        .union((branch) => {
          void branch
            .select("journey_id")
            .from("entity_aliases")
            .where("project_id", project)
            .whereIn("alias_value_hash", tokens);
        })
        .union(
          TECHNICAL_IDENTIFIER_COLUMNS.map((column) => (branch: Knex.QueryBuilder): void => {
            void branch
              .select("journey_id")
              .from("journey_events")
              .where("project_id", project)
              .andWhere(column, query);
          })
        );
    })
    .select(...journeySummaryColumns(db))
    .from({ j: "journeys" })
    .join("matches", "matches.journey_id", "j.id")
    .modify((joined) => {
      // The environments join only exists to resolve `environment` to an id,
      // so a search without that filter runs exactly the query it always has.
      if (filters.environment !== undefined) {
        // On id alone: the composite foreign key (environment_id, project_id)
        // on journeys already guarantees the environment belongs to the same
        // project.
        void joined.join({ env: "environments" }, "env.id", "j.environment_id");
      }
    })
    .where("j.project_id", project)
    .modify((scoped) => {
      if (scope.environmentId !== undefined) {
        void scoped.andWhere("j.environment_id", scope.environmentId);
      }
      // Applied on top of the scope, never instead of it, exactly as the
      // journey list applies it: an environment-scoped API key that names
      // another environment gets an empty page rather than an error, because
      // outside its scope nothing exists (ADR-029).
      if (filters.environment !== undefined) {
        void scoped.andWhere("env.name", filters.environment);
      }
      // The window is on last activity, the same column and the same meaning
      // as the journey list's, so a caller can hand both endpoints one pair of
      // bounds. A journey whose matching event is inside the window but whose
      // last activity is after `until` is outside it: the window selects
      // journeys, not events, because that is what search returns.
      if (filters.since !== undefined) {
        void scoped.andWhere("j.last_event_at", ">=", filters.since);
      }
      if (filters.until !== undefined) {
        void scoped.andWhere("j.last_event_at", "<", filters.until);
      }
    });

  const rows: unknown = await orderJourneysAfter(statement, "j", limit, cursor);
  return toJourneyPage(rows as SearchHit[], limit);
}
