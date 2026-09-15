/**
 * The columns of one journey list row, aliased to `SearchHit`'s field names,
 * for a query that names the journeys table `j`.
 *
 * Shared by search and the recent list so the two cannot select different
 * fields for what the API presents as the same row.
 */
export const JOURNEY_SUMMARY_COLUMNS = [
  "j.id as journeyId",
  "j.entity_type as entityType",
  "j.encrypted_primary_entity_id as encryptedPrimaryEntityId",
  "j.status as status",
  "j.event_count as eventCount",
  "j.started_at as startedAt",
  "j.last_event_at as lastEventAt"
] as const;
