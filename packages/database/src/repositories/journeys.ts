import type { Knex } from "knex";

export interface JourneyEventFacts {
  journeyId: string;
  environmentId: string;
  entityType: string;
  primaryEntityIdHash: string;
  encryptedPrimaryEntityId: string | null;
  eventTimestamp: Date;
  operation: string;
  hasError: boolean;
}

export interface JourneySummary {
  id: string;
  status: string;
  eventCount: number;
  startedAt: Date;
  lastEventAt: Date;
}

export async function findJourney(
  db: Knex,
  projectId: string,
  journeyId: string
): Promise<JourneySummary | undefined> {
  const row: unknown = await db("journeys")
    .where({ project_id: projectId, id: journeyId })
    .first(
      "id",
      "status",
      "event_count as eventCount",
      "started_at as startedAt",
      "last_event_at as lastEventAt"
    );
  return row === undefined ? undefined : (row as JourneySummary);
}

/**
 * Create or update the journey summary for one newly stored event.
 *
 * started_at takes the minimum timestamp and last_event_at the maximum, because
 * events arrive late and out of order and last-write-wins would corrupt both.
 *
 * Status follows the newest event by *event timestamp*, not arrival. PostgreSQL
 * evaluates every SET expression against the pre-update row, so comparing the
 * incoming timestamp to last_event_at inside the same statement compares against
 * the previous maximum — which is exactly the test needed, and needs no extra
 * column.
 *
 * The insert uses ON CONFLICT DO NOTHING so two events racing to create the same
 * journey do not fail each other.
 *
 * Bindings are positional rather than named: knex parses `:name:` as an
 * identifier, which collides with the `::type` casts these NULL-able parameters
 * require.
 */
/**
 * Create the journey row if it does not exist yet.
 *
 * This must run *before* the event insert. `journey_events` carries a composite
 * foreign key to `journeys`, so ARCHITECTURE.md section 8's ordering — insert
 * the event, then create the journey — cannot work as written.
 *
 * The row starts at event_count 0; the count is advanced by
 * updateJourneySummary, and only for events that were genuinely new.
 *
 * Resolves to the environment the journey belongs to: the one that created it,
 * which nothing changes afterwards. It differs from `facts.environmentId` when
 * another environment created the journey first, and the caller must then
 * refuse the event. Events and aliases attach by `(project_id, journey_id)`, so
 * without that check one environment's key could write into another
 * environment's journey.
 *
 * The row is read `FOR UPDATE` after the insert, in the caller's transaction.
 * A concurrent create of the same id makes the insert wait on the conflict
 * until the other transaction commits, so the read sees the winner's
 * environment; the lock then holds the row until this transaction ends, so a
 * deletion cannot remove it between the check and the event insert. `FOR
 * SHARE` would not do: `updateJourneySummary` updates the row in the same
 * transaction, and two transactions upgrading shared locks on one row deadlock.
 */
export async function ensureJourney(
  db: Knex,
  projectId: string,
  facts: JourneyEventFacts
): Promise<string | undefined> {
  await db("journeys")
    .insert({
      id: facts.journeyId,
      project_id: projectId,
      environment_id: facts.environmentId,
      entity_type: facts.entityType,
      primary_entity_id_hash: facts.primaryEntityIdHash,
      encrypted_primary_entity_id: facts.encryptedPrimaryEntityId,
      status: "active",
      started_at: facts.eventTimestamp,
      last_event_at: facts.eventTimestamp,
      event_count: 0
    })
    .onConflict(["project_id", "id"])
    .ignore();

  const row: unknown = await db("journeys")
    .where({ project_id: projectId, id: facts.journeyId })
    .forUpdate()
    .first("environment_id as environmentId");
  return (row as { environmentId: string } | undefined)?.environmentId;
}

export async function applyJourneyEvent(
  db: Knex,
  projectId: string,
  facts: JourneyEventFacts
): Promise<void> {
  await db("journeys")
    .insert({
      id: facts.journeyId,
      project_id: projectId,
      environment_id: facts.environmentId,
      entity_type: facts.entityType,
      primary_entity_id_hash: facts.primaryEntityIdHash,
      encrypted_primary_entity_id: facts.encryptedPrimaryEntityId,
      status: "active",
      started_at: facts.eventTimestamp,
      last_event_at: facts.eventTimestamp,
      event_count: 0
    })
    .onConflict(["project_id", "id"])
    .ignore();

  await updateJourneySummary(db, projectId, facts);
}

/**
 * Advance the summary for one newly stored event. Never called for duplicates,
 * so event_count cannot drift.
 */
export async function updateJourneySummary(
  db: Knex,
  projectId: string,
  facts: JourneyEventFacts
): Promise<void> {
  const status = deriveStatus(facts);
  const at = facts.eventTimestamp;

  await db.raw(
    `
    update journeys set
      event_count = event_count + 1,
      started_at = least(started_at, ?),
      last_event_at = greatest(last_event_at, ?),
      -- A failure always registers, whatever its timestamp says.
      --
      -- The watermark rule below is right for ordinary status changes and
      -- wrong for failures. last_event_at advances on every event, including
      -- status-less ones, so an earlier-stamped failure arriving afterwards
      -- failed the watermark test and was discarded -- leaving a journey at
      -- 'active' with a failed event in its own timeline, which the search list
      -- paints in the ordinary colour so nobody opens it.
      --
      -- ADR-031 makes this the common case rather than a race: a wrapped event
      -- is stamped when its callback starts and enqueued when it finishes, so a
      -- slow failing step is always stamped earlier than it arrives.
      status = case
        when ?::text = 'failed' then 'failed'
        when ?::timestamptz >= last_event_at and ?::text is not null then ?::text
        else status
      end,
      completed_at = case
        when ?::timestamptz >= last_event_at and ?::text = 'completed' then ?::timestamptz
        else completed_at
      end,
      updated_at = now()
    where project_id = ? and id = ?
    `,
    [at, at, status, at, status, status, at, status, at, projectId, facts.journeyId]
  );
}

/** Null means this event does not affect status. */
function deriveStatus(facts: JourneyEventFacts): string | null {
  if (facts.hasError || facts.operation === "failed") return "failed";
  if (facts.operation === "completed") return "completed";
  return null;
}
