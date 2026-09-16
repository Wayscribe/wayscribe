import type { Knex } from "knex";

/** One alias a reader may see in full, as a journey list row carries it. */
export interface DisplayableAlias {
  type: string;
  value: string;
}

/**
 * The columns of one journey list row, aliased to `SearchHit`'s field names,
 * for a query that names the journeys table `j`.
 *
 * Shared by search and the recent list so the two cannot select different
 * fields for what the API presents as the same row.
 *
 * `displayableAliases` reads the plain-text copy (`display_value`), which
 * exists only while an alias is displayable (migration 018's check), so a
 * masked value cannot reach a row, and no row needs decrypting. A displayable
 * alias written before that migration has no copy yet and is left out until
 * an event states it again. The subquery runs once per returned row: the
 * `(project_id, journey_id, ...)` unique index finds a journey's aliases, and
 * PostgreSQL evaluates it after the limit when the list is read in index order.
 */
export function journeySummaryColumns(db: Knex): (string | Knex.Raw)[] {
  return [
    "j.id as journeyId",
    "j.entity_type as entityType",
    "j.encrypted_primary_entity_id as encryptedPrimaryEntityId",
    "j.status as status",
    "j.event_count as eventCount",
    "j.started_at as startedAt",
    "j.last_event_at as lastEventAt",
    "j.label as label",
    "j.last_step as lastStep",
    db.raw(
      `coalesce(
         (select json_agg(json_build_object('type', a.alias_type, 'value', a.display_value)
                          order by a.alias_type, a.display_value)
            from entity_aliases a
           where a.project_id = j.project_id
             and a.journey_id = j.id
             and a.displayable
             and a.display_value is not null),
         '[]'::json
       ) as ??`,
      ["displayableAliases"]
    )
  ];
}
