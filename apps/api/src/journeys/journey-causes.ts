import {
  listJourneyFailureFacts,
  listJourneyPayloadDiffs,
  type ReadScope
} from "@wayscribe/database";
import type { Knex } from "knex";
import {
  MAX_JOURNEY_EVENTS_FOR_CAUSES,
  findLikelyCauses,
  type LikelyCause
} from "./likely-cause.js";

/** Whether an event fails a journey: `deriveStatus`'s test, on a read row. */
export function isFailedEvent(event: { hasError: boolean; operation: string }): boolean {
  return event.hasError || event.operation === "failed";
}

/**
 * Every failed event's likely causes for one journey (ADR-072), by event id.
 *
 * One past the cap is read, so a journey at it is told from one over it; over
 * it, or when no failure names a field, the diffs are never read and the
 * answer is empty. Failures that share a reporter share its cause objects:
 * serialize them, never change them.
 */
export async function journeyLikelyCauses(
  db: Knex,
  scope: ReadScope,
  journeyId: string
): Promise<Map<string, LikelyCause[]>> {
  const facts = await listJourneyFailureFacts(
    db,
    scope,
    journeyId,
    MAX_JOURNEY_EVENTS_FOR_CAUSES + 1
  );
  if (
    facts.length > MAX_JOURNEY_EVENTS_FOR_CAUSES ||
    !facts.some((fact) => fact.failed && Array.isArray(fact.errorFields))
  ) {
    return new Map();
  }
  const diffs = await listJourneyPayloadDiffs(db, scope, journeyId);
  return findLikelyCauses(
    facts.map((fact) => ({
      id: fact.id,
      step: fact.name,
      failed: fact.failed,
      fields: fact.errorFields,
      diff: diffs.get(fact.id) ?? null
    }))
  );
}
