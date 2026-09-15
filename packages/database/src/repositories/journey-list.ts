import type { Knex } from "knex";
import { orderJourneysAfter, toJourneyPage, type JourneyPage } from "./journey-keyset.js";
import type { ReadScope } from "./read-scope.js";
import type { SearchHit } from "./search.js";

/** The values `journeys_status_valid` allows. */
export const JOURNEY_STATUSES = ["active", "completed", "failed"] as const;
export type JourneyStatus = (typeof JOURNEY_STATUSES)[number];

export interface RecentJourneyFilters {
  /** Journeys whose last activity is at or after this instant. */
  since: Date;
  /** Omitted means any status. */
  status?: JourneyStatus | undefined;
  /** An environment name. Omitted means every environment the scope allows. */
  environment?: string | undefined;
  /** An exact service name some event of the journey was recorded by. */
  service?: string | undefined;
}

/** A search hit plus where it ran, since this list spans environments. */
export interface RecentJourney extends SearchHit {
  environment: string;
}

export type RecentJourneyPage = JourneyPage<RecentJourney>;

/**
 * Recent journeys, newest activity first, for an investigation that starts
 * from "what failed" rather than from an identifier.
 *
 * `since` is required rather than defaulted so every query is bounded by
 * `last_event_at`, which both `journeys_recent_idx` (environment first) and
 * `journeys_status_recent_idx` (status first, migration 013) lead with after
 * the project. Measured plans are summarised on that migration.
 *
 * The environment filter is by name and is applied on top of the scope, never
 * instead of it: an environment-scoped caller asking for another environment
 * gets an empty page, which is how search treats scope too.
 */
export async function listRecentJourneys(
  db: Knex,
  scope: ReadScope,
  filters: RecentJourneyFilters,
  limit: number,
  cursor?: string
): Promise<RecentJourneyPage> {
  const query = db
    .select(
      "j.id as journeyId",
      "j.entity_type as entityType",
      "j.encrypted_primary_entity_id as encryptedPrimaryEntityId",
      "j.status as status",
      "j.event_count as eventCount",
      "j.started_at as startedAt",
      "j.last_event_at as lastEventAt",
      "env.name as environment"
    )
    .from({ j: "journeys" })
    // Both columns, so the join cannot cross a project even if an id collided.
    .join({ env: "environments" }, (on) => {
      void on.on("env.id", "=", "j.environment_id").andOn("env.project_id", "=", "j.project_id");
    })
    .where("j.project_id", scope.projectId)
    .andWhere("j.last_event_at", ">=", filters.since)
    .modify((builder) => {
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
    });

  const rows: unknown = await orderJourneysAfter(query, "j", limit, cursor);
  return toJourneyPage(rows as RecentJourney[], limit);
}
