import type { Knex } from "knex";
import { orderJourneysAfter, toJourneyPage, type JourneyPage } from "./journey-keyset.js";
import { JOURNEY_SUMMARY_COLUMNS } from "./journey-summary.js";
import type { ReadScope } from "./read-scope.js";

export interface SearchHit {
  journeyId: string;
  entityType: string;
  encryptedPrimaryEntityId: string | null;
  status: string;
  eventCount: number;
  startedAt: Date;
  lastEventAt: Date;
}

export type SearchPage = JourneyPage<SearchHit>;

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
 */
export async function searchJourneys(
  db: Knex,
  scope: ReadScope,
  query: string,
  tokens: readonly string[],
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
    .select(...JOURNEY_SUMMARY_COLUMNS)
    .from({ j: "journeys" })
    .join("matches", "matches.journey_id", "j.id")
    .where("j.project_id", project)
    .modify((scoped) => {
      if (scope.environmentId !== undefined) {
        void scoped.andWhere("j.environment_id", scope.environmentId);
      }
    });

  const rows: unknown = await orderJourneysAfter(statement, "j", limit, cursor);
  return toJourneyPage(rows as SearchHit[], limit);
}
