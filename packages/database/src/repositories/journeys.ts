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
  /** The event's own id, which breaks a tie between equal timestamps and arrivals. */
  eventId: string;
  /** The event's `name`, the step the timeline labels its row with. */
  stepName: string;
  /** The event's `journeyLabel`, or null when it carries none. */
  label: string | null;
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
 * The row is read `FOR KEY SHARE` after the insert, in the caller's
 * transaction. A concurrent create of the same id makes the insert wait on the
 * conflict until the other transaction commits, so the read sees the winner's
 * environment; the lock then holds until this transaction ends, and a deletion
 * cannot remove the row between the check and the event insert, because a
 * DELETE needs the lock KEY SHARE conflicts with.
 *
 * Why not the other row locks: `FOR UPDATE` worked and serialised every event
 * for one journey behind the one holding it (16 concurrent streams on one
 * journey, 22 ms p50 before this check, 31-33 ms with it). `FOR SHARE`
 * deadlocks: `updateJourneySummary` updates the row in the same transaction,
 * and two transactions each holding SHARE and asking for the update's lock wait
 * on each other. `FOR KEY SHARE` conflicts only with a DELETE or a change to a
 * key column; the summary update changes none, so it takes the weaker
 * `FOR NO KEY UPDATE` lock, which KEY SHARE holders do not block (20 ms p50).
 * `environment_id` is in no unique index, so nothing that changes it is
 * treated as a key update, and nothing changes it anyway.
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
    .forKeyShare()
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
 * Whether this event comes after the one that set the label in the timeline's
 * order, `(timestamp, received at, id)`, and carries a label. Reads the row
 * being updated; see updateJourneySummary.
 *
 * `now()` is when this event was received: the start of the transaction that
 * also inserts its row, whose `received_at` defaults to the same `now()`. A
 * null received-at (never written by this code) compares as the earliest.
 */
const TAKES_LABEL = `(e.event_label is not null and (label_at is null or (e.event_at, now(), e.event_id collate "C") > (label_at, coalesce(label_received_at, '-infinity'), label_event_id collate "C")))`;

/** The same comparison against the event that set the last step. */
const TAKES_STEP = `(last_step_at is null or (e.event_at, now(), e.event_id collate "C") > (last_step_at, coalesce(last_step_received_at, '-infinity'), last_step_event_id collate "C"))`;

/**
 * Advance the summary for one newly stored event. Never called for duplicates,
 * so event_count cannot drift.
 *
 * The label and the last step follow the event that comes last in the
 * journey's timeline order, `(timestamp, received at, event id)`
 * (event-reads.ts), not simply the one that arrived last, for the same reason
 * status does: events arrive late and out of order. Timestamps tie often: they
 * are stored to the millisecond, and the Node SDK stamps whole milliseconds,
 * so a quick journey's steps and a label set twice share one. Breaking that
 * tie by event id alone, which the SDK makes random, kept a random step and a
 * random label; the time the server received each event breaks it the way the
 * timeline does, so the last step is the timeline's last row. Events sent
 * concurrently in different requests are received in no guaranteed order.
 * Each value is stored with the three that set it, and an event replaces it
 * only when its own three are greater; nothing set yet is smaller than any. An event without
 * a label leaves the label as it is. Every event has a step name (`name` is
 * required by the protocol), so every event is a candidate for the last step.
 *
 * Event ids are compared with the "C" collation, byte by byte. The column's
 * collation is the database's default, which differs between installs, and a
 * tie must be broken the same way everywhere.
 *
 * The whole rule is part of this one update, so it costs no extra statement
 * on the hot path. The row lock the update takes serialises concurrent events
 * for one journey, and each re-evaluates its comparison against the row the
 * previous one left, so the outcome does not depend on commit order. That
 * holds only because the comparisons read the target row's own columns: a
 * subquery reading `journeys` would keep the version from the statement's
 * snapshot when the update waits for the lock, and compare against a stale
 * pair. The `from` row carries only the parameters, named once.
 */
export async function updateJourneySummary(
  db: Knex,
  projectId: string,
  facts: JourneyEventFacts
): Promise<void> {
  await db.raw(
    `
    update journeys set
      event_count = event_count + 1,
      started_at = least(started_at, e.event_at),
      last_event_at = greatest(last_event_at, e.event_at),
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
      --
      -- ADR-061 adds the last branch: a 'retried' event carrying no error
      -- clears a failure back to 'active'. ADR-022 renames a wrapped call's
      -- operation to 'retried' whenever the attempt is greater than 1,
      -- whichever way the call comes out, so the success of a step that failed
      -- on attempt 1 arrives as 'retried' with no error and nothing here could
      -- undo the earlier failure until finish() landed.
      --
      -- It clears rather than completes. A journey that retried successfully
      -- and then died without finishing must not read as completed: a falsely
      -- reassuring status is worse than a stale alarming one. 'completed' keeps
      -- its meaning, a 'completed' operation at or after the watermark, which
      -- in practice is finish().
      --
      -- The branch comes last, so the two rules above are untouched: a failure
      -- still wins whatever its timestamp says, and a status the watermark
      -- accepts still wins over the clearing. It carries the watermark test
      -- itself, so an older successful retry cannot clear a newer failure, and
      -- it fires only on a journey that is currently failed, so it can never
      -- knock a completed journey back to active.
      --
      -- It clears a terminal 'failed' too, the operation ADR-022 reserves for a
      -- dead-letter transition, and that is intended rather than an oversight.
      -- A dead letter is terminal for the attempt that produced it, not for the
      -- record: a message is replayed out of the queue and the replay records
      -- 'retried'. A later successful retry, stamped after that transition, is
      -- evidence the failure was superseded, and the journey is running again.
      -- The status is not the audit trail either way; the 'failed' event stays
      -- in the timeline and is what a reader opens the journey to see.
      status = case
        when e.event_status = 'failed' then 'failed'
        when e.event_at >= last_event_at and e.event_status is not null then e.event_status
        when e.clears_failure and e.event_at >= last_event_at and status = 'failed' then 'active'
        else status
      end,
      completed_at = case
        when e.event_at >= last_event_at and e.event_status = 'completed' then e.event_at
        else completed_at
      end,
      label = case when ${TAKES_LABEL} then e.event_label else label end,
      label_at = case when ${TAKES_LABEL} then e.event_at else label_at end,
      label_received_at = case when ${TAKES_LABEL} then now() else label_received_at end,
      label_event_id = case when ${TAKES_LABEL} then e.event_id else label_event_id end,
      last_step = case when ${TAKES_STEP} then e.event_step else last_step end,
      last_step_at = case when ${TAKES_STEP} then e.event_at else last_step_at end,
      last_step_received_at = case when ${TAKES_STEP} then now() else last_step_received_at end,
      last_step_event_id = case when ${TAKES_STEP} then e.event_id else last_step_event_id end,
      updated_at = now()
    from (
      select ?::timestamptz as event_at, ?::text as event_status, ?::text as event_id,
             ?::text as event_step, ?::text as event_label,
             ?::boolean as clears_failure
    ) e
    where project_id = ? and id = ?
    `,
    [
      facts.eventTimestamp,
      deriveStatus(facts),
      facts.eventId,
      facts.stepName,
      facts.label,
      clearsFailure(facts),
      projectId,
      facts.journeyId
    ]
  );
}

/** Null means this event does not affect status. */
function deriveStatus(facts: JourneyEventFacts): string | null {
  if (facts.hasError || facts.operation === "failed") return "failed";
  if (facts.operation === "completed") return "completed";
  return null;
}

/**
 * Whether this event clears an existing failure (ADR-061).
 *
 * A `retried` event carrying no error is the success of a step that failed
 * before: ADR-022 renames a wrapped call's operation to `retried` whenever the
 * attempt is greater than 1, whichever way the call comes out, so a successful
 * retry cannot be told from a failed one by its operation alone. The event
 * keeps the operation `retried`, because that is what happened; only what it
 * means for the summary's status changes.
 *
 * It clears the failure rather than completing the journey. `deriveStatus`
 * therefore still answers null for it, and nothing sets `completed_at`: a
 * journey that retried successfully and then died without finishing reads
 * `active`, not `completed`. The error test is in the caller's first branch,
 * so a retry that fails again is still a failure.
 */
function clearsFailure(facts: JourneyEventFacts): boolean {
  return facts.operation === "retried" && !facts.hasError;
}
