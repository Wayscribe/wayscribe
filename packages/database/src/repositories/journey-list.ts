import type { Knex } from "knex";
import { orderJourneysAfter, toJourneyPage, type JourneyPage } from "./journey-keyset.js";
import { journeySummaryColumns } from "./journey-summary.js";
import type { ReadScope } from "./read-scope.js";
import type { SearchHit } from "./search.js";

/** The values `journeys_status_valid` allows. */
export const JOURNEY_STATUSES = ["active", "completed", "failed"] as const;
export type JourneyStatus = (typeof JOURNEY_STATUSES)[number];

export interface JourneyListFilters {
  /** Journeys whose last activity is at or after this instant. */
  since: Date;
  /** Journeys whose last activity is before this instant. Omitted means no upper bound. */
  until?: Date | undefined;
  /** Omitted means any status. */
  status?: JourneyStatus | undefined;
  /** An environment name. Omitted means every environment the scope allows. */
  environment?: string | undefined;
  /** An exact service name some event of the journey was recorded by. */
  service?: string | undefined;
  /** An exact entity type. */
  entityType?: string | undefined;
  /**
   * Text the journey's label or one of its displayable alias values contains,
   * ignoring case. Never compared with masked aliases or entity ids, which are
   * stored only as ciphertext and hashes.
   */
  text?: string | undefined;
}

/** A search hit plus where it ran, since this list spans environments. */
export interface ListedJourney extends SearchHit {
  environment: string;
}

export type JourneyListPage = JourneyPage<ListedJourney>;

/**
 * Journeys in a window, newest activity first, for an investigation that
 * starts from "what happened" or "what failed" rather than from an identifier.
 *
 * `since` is required rather than defaulted so every query is bounded by
 * `last_event_at`, which `journeys_recent_idx` (environment first),
 * `journeys_status_recent_idx` (status first, migration 013) and
 * `journeys_project_recent_idx` (nothing between, migration 019) lead with
 * after the project. Measured plans are summarised on those migrations.
 *
 * `until`, `entityType` and `text` narrow the same window. The cursor holds a
 * position only, `(last_event_at, id)`, and the filters always come from the
 * request, so a cursor used with other filters continues those filters' list
 * after the same position rather than being refused.
 *
 * The environment filter is by name and is applied on top of the scope, never
 * instead of it: an environment-scoped caller asking for another environment
 * gets an empty page, which is how search treats scope too.
 */
export async function listJourneys(
  db: Knex,
  scope: ReadScope,
  filters: JourneyListFilters,
  limit: number,
  cursor?: string
): Promise<JourneyListPage> {
  const query = db
    .select(...journeySummaryColumns(db), "env.name as environment")
    .from({ j: "journeys" })
    // On id alone: the composite foreign key (environment_id, project_id) on
    // journeys already guarantees the environment belongs to the same project.
    .join({ env: "environments" }, "env.id", "j.environment_id")
    .where("j.project_id", scope.projectId)
    .andWhere("j.last_event_at", ">=", filters.since)
    .modify((builder) => {
      if (filters.until !== undefined) {
        void builder.andWhere("j.last_event_at", "<", filters.until);
      }
      if (scope.environmentId !== undefined) {
        void builder.andWhere("j.environment_id", scope.environmentId);
      }
      if (filters.environment !== undefined) {
        void builder.andWhere("env.name", filters.environment);
      }
      if (filters.status !== undefined) {
        void builder.andWhere("j.status", filters.status);
      }
      if (filters.service !== undefined) {
        const service = filters.service;
        // A semi-join rather than a join: a journey with many events from the
        // service is still one row.
        void builder.whereExists((exists) => {
          void exists
            .select(db.raw("1"))
            .from({ e: "journey_events" })
            .whereRaw("e.project_id = j.project_id and e.journey_id = j.id")
            .andWhere("e.service", service);
        });
      }
      if (filters.entityType !== undefined) {
        void builder.andWhere("j.entity_type", filters.entityType);
      }
      if (filters.text !== undefined) {
        const pattern = containsPattern(filters.text);
        // A filter on the rows the window already selected, not an index
        // lookup: no extension is required, and the window bounds the work.
        // What that work costs at 120,000 journeys is measured in
        // docs/OPERATIONS.md (Sizing, Listing journeys).
        // Only the two plain-text columns are compared. Masked aliases hold
        // no display_value (migration 018's check), and entity ids and alias
        // values are otherwise stored as ciphertext and tokens.
        //
        // An aggregate rather than EXISTS on purpose. PostgreSQL may run an
        // EXISTS under OR as a hashed subplan: one sequential scan of every
        // alias in the table, every project and every date, before the
        // window is read. An aggregate subquery is always probed per journey,
        // through entity_aliases_displayable_idx (migration 019, an
        // index-only scan once the pages are all-visible), so the cost stays
        // bounded by the window and the query stops after one page.
        void builder.whereRaw(
          `(j.label ilike ? escape '\\'
            or coalesce(
                 (select bool_or(a.display_value ilike ? escape '\\')
                    from entity_aliases a
                   where a.project_id = j.project_id
                     and a.journey_id = j.id
                     and a.displayable),
                 false))`,
          [pattern, pattern]
        );
      }
    });

  const rows: unknown = await orderJourneysAfter(query, "j", limit, cursor);
  return toJourneyPage(rows as ListedJourney[], limit);
}

/**
 * A LIKE pattern that matches `text` anywhere, with LIKE's own characters
 * taken literally: `%`, `_` and the escape character itself.
 */
export function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}
