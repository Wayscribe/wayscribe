import type { Knex } from "knex";
import { scoped, type ReadScope } from "./read-scope.js";

export interface JourneyAlias {
  aliasType: string;
  encryptedDisplayValue: string | null;
}

export interface JourneyDetail {
  journeyId: string;
  entityType: string;
  encryptedPrimaryEntityId: string | null;
  status: string;
  eventCount: number;
  startedAt: Date;
  completedAt: Date | null;
  lastEventAt: Date;
  aliases: JourneyAlias[];
  services: string[];
}

/**
 * One journey with its aliases and the distinct services that touched it.
 *
 * Three queries rather than one join: joining aliases and events to the journey
 * row multiplies it by both, and the caller would have to undo a fan-out the
 * database had just performed.
 *
 * Returns undefined rather than throwing when the journey is outside the
 * caller's scope, so the route can answer 404 — confirming existence to an
 * unauthorized caller is itself a disclosure.
 */
export async function findJourneyDetail(
  db: Knex,
  scope: ReadScope,
  journeyId: string
): Promise<JourneyDetail | undefined> {
  const row: unknown = await scoped(db("journeys"), scope)
    .where({ id: journeyId })
    .first(
      "id as journeyId",
      "entity_type as entityType",
      "encrypted_primary_entity_id as encryptedPrimaryEntityId",
      "status",
      "event_count as eventCount",
      "started_at as startedAt",
      "completed_at as completedAt",
      "last_event_at as lastEventAt"
    );

  if (row === undefined) return undefined;

  // Project alone, deliberately: the journey above already had to be inside the
  // caller's scope for this line to be reached, and `entity_aliases` carries no
  // environment of its own.
  const aliases: unknown = await db("entity_aliases")
    .where({ project_id: scope.projectId, journey_id: journeyId })
    .select("alias_type as aliasType", "encrypted_display_value as encryptedDisplayValue")
    .orderBy("alias_type");

  const services: unknown = await db("journey_events")
    .where({ project_id: scope.projectId, journey_id: journeyId })
    .distinct("service")
    .orderBy("service");

  return {
    ...(row as Omit<JourneyDetail, "aliases" | "services">),
    aliases: aliases as JourneyAlias[],
    services: (services as { service: string }[]).map((s) => s.service)
  };
}
