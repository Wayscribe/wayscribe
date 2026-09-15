import type { Knex } from "knex";
import { orderJourneysAfter, toJourneyPage, type JourneyPage } from "./journey-keyset.js";
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
 */
// debtwatch:start
// id: DEBT-82X79Y
// owner: flight-recorder
// expires: 2027-05-01
// reason: Cost scales with journey count, not with the query; measured 33ms at 12k and 1.1s at 120k
// issue: needs a UNION rewrite, not an index
// tags: database, performance
// debtwatch:end
export async function searchJourneys(
  db: Knex,
  scope: ReadScope,
  query: string,
  tokens: readonly string[],
  limit: number,
  cursor?: string
): Promise<SearchPage> {
  const statement = db
    .with("matches", (builder) => {
      void builder
        .select("j.id")
        .from({ j: "journeys" })
        .where("j.project_id", scope.projectId)
        .modify((scoped) => {
          if (scope.environmentId !== undefined) {
            void scoped.andWhere("j.environment_id", scope.environmentId);
          }
        })
        .andWhere((where) => {
          void where
            .where("j.id", query)
            .orWhereIn("j.primary_entity_id_hash", tokens)
            .orWhereExists((exists) => {
              void exists
                .select(db.raw("1"))
                .from({ a: "entity_aliases" })
                .whereRaw("a.project_id = j.project_id and a.journey_id = j.id")
                .whereIn("a.alias_value_hash", tokens);
            })
            .orWhereExists((exists) => {
              void exists
                .select(db.raw("1"))
                .from({ e: "journey_events" })
                .whereRaw("e.project_id = j.project_id and e.journey_id = j.id")
                .andWhere((technical) => {
                  void technical
                    .where("e.trace_id", query)
                    .orWhere("e.span_id", query)
                    .orWhere("e.message_id", query)
                    .orWhere("e.correlation_id", query);
                });
            });
        });
    })
    .select(
      "j.id as journeyId",
      "j.entity_type as entityType",
      "j.encrypted_primary_entity_id as encryptedPrimaryEntityId",
      "j.status as status",
      "j.event_count as eventCount",
      "j.started_at as startedAt",
      "j.last_event_at as lastEventAt"
    )
    .from({ j: "journeys" })
    .join("matches", "matches.id", "j.id")
    .where("j.project_id", scope.projectId);

  const rows: unknown = await orderJourneysAfter(statement, "j", limit, cursor);
  return toJourneyPage(rows as SearchHit[], limit);
}
