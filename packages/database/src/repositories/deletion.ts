import { searchTokens, type Keyring } from "@flight-recorder/payload-security";
import type { Knex } from "knex";
import { lockHolderAlive, withTransactionLock } from "./advisory-lock.js";
import { recordAudit, updateAuditMetadata } from "./audit.js";
import { RETENTION_LOCK_KEY } from "./retention.js";

/** Journeys per transaction for an erasure. Bounds how long one batch holds its row locks. */
const ERASURE_BATCH_SIZE = 500;
/** Journeys per transaction for a range deletion, as for the retention sweep. */
const RANGE_BATCH_SIZE = 1_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EnvironmentNotFound {
  ok: false;
  reason: "environment_not_found";
}

/** One journey a dry run reports. */
export interface MatchedJourney {
  id: string;
  environment: string;
  entityType: string;
  eventCount: number;
  lastEventAt: Date;
}

export type JourneyMatches =
  | {
      ok: true;
      /** Most recent first, at most `limit` of them. */
      journeys: MatchedJourney[];
      /** Every journey a real run would delete now, whatever `limit` cut off. */
      total: number;
    }
  | EnvironmentNotFound;

export interface MatchOptions {
  /** Ceiling on `journeys`. `total` still counts everything. Unlimited when absent. */
  limit?: number;
}

export interface BatchProgress {
  batch: number;
  deletedJourneys: number;
  deletedEvents: number;
}

export interface BatchOptions {
  batchSize?: number;
  /** Called after each batch that deleted something has committed, audit row included. */
  onBatch?: (progress: BatchProgress) => void | Promise<void>;
}

export type JourneyDeletion =
  | { ok: true; journeyId: string; environment: string; eventCount: number }
  | { ok: false; reason: "journey_not_found" };

/**
 * Delete one journey and, through the cascade on its composite key, its events,
 * aliases, and the replay runs of those events.
 *
 * Scoped on project, so a journey with the same id in another project is not
 * found and not touched. The audit row is written in the same transaction: a
 * deletion never commits without its record.
 */
export async function deleteJourney(
  db: Knex,
  input: { projectId: string; journeyId: string; actor: string }
): Promise<JourneyDeletion> {
  return db.transaction(async (trx): Promise<JourneyDeletion> => {
    const deleted: unknown = await trx("journeys")
      .where({ project_id: input.projectId, id: input.journeyId })
      .del()
      .returning(["environment_id as environmentId", "event_count as eventCount"]);
    const [row] = deleted as { environmentId: string; eventCount: number }[];
    if (row === undefined) return { ok: false, reason: "journey_not_found" };

    const environment = await environmentName(trx, input.projectId, row.environmentId);
    await recordAudit(trx, {
      projectId: input.projectId,
      actor: input.actor,
      action: "journey.deleted",
      resourceType: "journey",
      resourceId: input.journeyId,
      metadata: { environment, eventCount: row.eventCount }
    });
    return { ok: true, journeyId: input.journeyId, environment, eventCount: row.eventCount };
  });
}

export interface IdentifierSelection {
  projectId: string;
  /** The identifier as a user would paste it into search. Never stored. */
  value: string;
  /** An environment name. Every environment of the project when absent. */
  environment?: string | undefined;
}

/**
 * The journeys an erasure of `value` would delete: exactly what search finds
 * for it by entity id or alias.
 *
 * Matches every token the keyring gives the value, so a journey still stored
 * under the previous key during a rotation is found. A dry run reads through
 * the same selection the deletion uses, so it cannot drift from it.
 */
export async function findJourneysByIdentifier(
  db: Knex,
  keyring: Keyring,
  selection: IdentifierSelection,
  options: MatchOptions = {}
): Promise<JourneyMatches> {
  const environmentId = await optionalEnvironmentId(db, selection.projectId, selection.environment);
  if (environmentId === null) return { ok: false, reason: "environment_not_found" };

  const tokens = searchTokens(keyring, selection.value);
  return listMatches(
    (trx) => identifierSelection(trx, selection.projectId, environmentId, tokens),
    db,
    options
  );
}

export type ErasureResult =
  | {
      ok: true;
      deletedJourneys: number;
      /** From `journeys.event_count`, which ingestion advances once per stored event. */
      deletedEvents: number;
      /** Batches that deleted something. */
      batches: number;
      auditId: string;
    }
  | EnvironmentNotFound;

/**
 * Delete every journey matching an identifier, in transactions of 500.
 *
 * One audit row per erasure, `erasure.completed`, carrying the current key's
 * search token and never the value. It is inserted in the first batch's
 * transaction, even when nothing matches, and each later batch that deletes
 * something updates its counts in that batch's own transaction. So a process
 * that dies part way leaves a row whose counts are exactly what committed,
 * never deleted journeys with no row, and never a row claiming more than was
 * deleted. Running the erasure again finishes the job and writes a second row.
 *
 * Batches continue until one deletes nothing rather than until one comes back
 * short: a concurrent deletion of a selected row shortens a batch without
 * meaning nothing is left.
 */
export async function eraseIdentifier(
  db: Knex,
  keyring: Keyring,
  input: IdentifierSelection & { actor: string },
  options: BatchOptions = {}
): Promise<ErasureResult> {
  const environmentId = await optionalEnvironmentId(db, input.projectId, input.environment);
  if (environmentId === null) return { ok: false, reason: "environment_not_found" };

  const tokens = searchTokens(keyring, input.value);
  const [token] = tokens;
  // searchTokens always returns the current key's token first; the check is for
  // the type, which cannot know that.
  if (token === undefined) throw new Error("searchTokens returned no current token.");

  const outcome = await deleteInBatches(
    db,
    options.batchSize ?? ERASURE_BATCH_SIZE,
    (trx) => identifierSelection(trx, input.projectId, environmentId, tokens),
    {
      projectId: input.projectId,
      actor: input.actor,
      action: "erasure.completed",
      resourceType: "identifier",
      resourceId: null,
      metadata: (totals) => ({
        token,
        environment: input.environment ?? null,
        deletedJourneys: totals.deletedJourneys,
        deletedEvents: totals.deletedEvents
      })
    },
    options.onBatch,
    null
  );

  return {
    ok: true,
    deletedJourneys: outcome.deletedJourneys,
    deletedEvents: outcome.deletedEvents,
    batches: outcome.batches,
    // The loop always runs its first transaction, which writes the row.
    auditId: requireAuditId(outcome.auditId)
  };
}

export interface RangeSelection {
  projectId: string;
  /** An environment name. */
  environment: string;
  /** Inclusive. The beginning of time when absent. */
  after?: Date | undefined;
  /** Exclusive. */
  before: Date;
}

/**
 * The journeys a range deletion would delete: those in one environment whose
 * `last_event_at` is in `[after, before)`.
 *
 * `last_event_at`, matching retention: a journey still receiving events is
 * judged by its latest one.
 */
export async function findJourneysInRange(
  db: Knex,
  selection: RangeSelection,
  options: MatchOptions = {}
): Promise<JourneyMatches> {
  assertValidRange(selection);
  const environmentId = await environmentIdByName(db, selection.projectId, selection.environment);
  if (environmentId === null) return { ok: false, reason: "environment_not_found" };

  return listMatches((trx) => rangeSelection(trx, selection, environmentId), db, options);
}

export type RangeDeletion =
  | {
      ok: true;
      environmentId: string;
      deletedJourneys: number;
      deletedEvents: number;
      /** Batches that deleted something. */
      batches: number;
      /** Null only when the lock was lost before the first batch, so nothing was deleted or recorded. */
      auditId: string | null;
      /**
       * The connection holding the lock ended mid-run, for example by
       * `idle_in_transaction_session_timeout`, and the run stopped after the
       * batch in progress. The counts, in the result and the audit row, are what
       * committed; running it again deletes the rest.
       */
      lockLost: boolean;
    }
  | EnvironmentNotFound
  /** A retention sweep or another range deletion holds the lock. Nothing was examined. */
  | { ok: false; reason: "lock_held" };

/**
 * Delete an environment's journeys in a time window, in transactions of 1,000.
 *
 * Holds the retention sweep's advisory lock for the whole run, so a range
 * deletion and a sweep never run at once, and checks before every batch that
 * the lock is still held. The audit row, `range.deleted`, follows the same rule
 * as an erasure's: inserted with the first batch, updated with each later one.
 */
export async function deleteRange(
  db: Knex,
  input: RangeSelection & { actor: string },
  options: BatchOptions = {}
): Promise<RangeDeletion> {
  assertValidRange(input);
  const environmentId = await environmentIdByName(db, input.projectId, input.environment);
  if (environmentId === null) return { ok: false, reason: "environment_not_found" };

  const run = await withTransactionLock(db, RETENTION_LOCK_KEY, async (holder) =>
    deleteInBatches(
      db,
      options.batchSize ?? RANGE_BATCH_SIZE,
      (trx) => rangeSelection(trx, input, environmentId),
      {
        projectId: input.projectId,
        actor: input.actor,
        action: "range.deleted",
        resourceType: "environment",
        resourceId: environmentId,
        metadata: (totals) => ({
          after: input.after?.toISOString() ?? null,
          before: input.before.toISOString(),
          deletedJourneys: totals.deletedJourneys
        })
      },
      options.onBatch,
      holder
    )
  );
  if (!run.acquired) return { ok: false, reason: "lock_held" };

  return {
    ok: true,
    environmentId,
    deletedJourneys: run.value.deletedJourneys,
    deletedEvents: run.value.deletedEvents,
    batches: run.value.batches,
    auditId: run.value.auditId,
    lockLost: run.value.lockLost
  };
}

export type DestinationDeletion =
  | { ok: true; destinationId: string; name: string; deletedRuns: number }
  | { ok: false; reason: "destination_not_found" };

/**
 * Delete a replay destination and every replay run sent to it, in one transaction.
 *
 * `replay_runs.destination_id` has no cascade, so the runs go explicitly: a run
 * without its destination cannot be read or repeated, and the runs hold the
 * replayed payloads an operator removing data wants gone.
 *
 * The audit row records the name and the run count, not the base URL, which can
 * name a host the operator considers internal, and never the headers.
 */
export async function deleteReplayDestination(
  db: Knex,
  input: { projectId: string; destinationId: string; actor: string }
): Promise<DestinationDeletion> {
  // Not a uuid cannot be a destination, and PostgreSQL would reject the
  // comparison with an error rather than find nothing.
  if (!UUID_PATTERN.test(input.destinationId)) {
    return { ok: false, reason: "destination_not_found" };
  }

  return db.transaction(async (trx): Promise<DestinationDeletion> => {
    // Locked first, so a replay starting now waits on the destination row and
    // then fails its foreign key, rather than adding a run this delete misses.
    const found: unknown = await trx("replay_destinations")
      .where({ project_id: input.projectId, id: input.destinationId })
      .forUpdate()
      .first("name");
    const destination = found as { name: string } | undefined;
    if (destination === undefined) return { ok: false, reason: "destination_not_found" };

    const deletedRuns = await trx("replay_runs")
      .where({ project_id: input.projectId, destination_id: input.destinationId })
      .del();
    await trx("replay_destinations")
      .where({ project_id: input.projectId, id: input.destinationId })
      .del();

    await recordAudit(trx, {
      projectId: input.projectId,
      actor: input.actor,
      action: "replay_destination.deleted",
      resourceType: "replay_destination",
      resourceId: input.destinationId,
      metadata: { name: destination.name, deletedRuns }
    });
    return {
      ok: true,
      destinationId: input.destinationId,
      name: destination.name,
      deletedRuns
    };
  });
}

/** A query over `journeys as j` restricted to what a deletion selects. */
type Selection = (db: Knex) => Knex.QueryBuilder;

function identifierSelection(
  db: Knex,
  projectId: string,
  environmentId: string | undefined,
  tokens: readonly string[]
): Knex.QueryBuilder {
  // The same token match as search: entity id or any alias, every token the
  // keyring gives the value, scoped inside the query.
  return db({ j: "journeys" })
    .where("j.project_id", projectId)
    .modify((scoped) => {
      if (environmentId !== undefined) void scoped.andWhere("j.environment_id", environmentId);
    })
    .andWhere((match) => {
      void match.whereIn("j.primary_entity_id_hash", tokens).orWhereExists((exists) => {
        void exists
          .select(db.raw("1"))
          .from({ a: "entity_aliases" })
          .whereRaw("a.project_id = j.project_id and a.journey_id = j.id")
          .whereIn("a.alias_value_hash", tokens);
      });
    });
}

function rangeSelection(
  db: Knex,
  selection: RangeSelection,
  environmentId: string
): Knex.QueryBuilder {
  return db({ j: "journeys" })
    .where("j.project_id", selection.projectId)
    .andWhere("j.environment_id", environmentId)
    .andWhere("j.last_event_at", "<", selection.before)
    .modify((bounded) => {
      if (selection.after !== undefined) {
        void bounded.andWhere("j.last_event_at", ">=", selection.after);
      }
    });
}

async function listMatches(
  selection: Selection,
  db: Knex,
  options: MatchOptions
): Promise<JourneyMatches> {
  // One transaction, so the total and the list see the same snapshot.
  return db.transaction(
    async (trx): Promise<JourneyMatches> => {
      const counted: unknown = await selection(trx).count({ n: "*" });
      const total = Number((counted as { n: string | number }[])[0]?.n ?? 0);

      const rows: unknown = await selection(trx)
        .join({ e: "environments" }, "e.id", "j.environment_id")
        .select(
          "j.id as id",
          "e.name as environment",
          "j.entity_type as entityType",
          "j.event_count as eventCount",
          "j.last_event_at as lastEventAt"
        )
        .orderBy([
          { column: "j.last_event_at", order: "desc" },
          { column: "j.id", order: "desc" }
        ])
        .modify((limited) => {
          if (options.limit !== undefined) void limited.limit(options.limit);
        });

      return { ok: true, journeys: rows as MatchedJourney[], total };
    },
    { isolationLevel: "repeatable read", readOnly: true }
  );
}

interface AuditPlan {
  projectId: string;
  actor: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: (totals: { deletedJourneys: number; deletedEvents: number }) => Record<string, unknown>;
}

interface BatchOutcome {
  deletedJourneys: number;
  deletedEvents: number;
  batches: number;
  auditId: string | null;
  lockLost: boolean;
}

/**
 * Delete a selection batch by batch, one transaction per batch, keeping one
 * audit row current with what has committed.
 *
 * With a `holder`, the lock it holds is checked before every batch, and a lost
 * lock ends the run after the batch that committed.
 */
async function deleteInBatches(
  db: Knex,
  batchSize: number,
  selection: Selection,
  audit: AuditPlan,
  onBatch: BatchOptions["onBatch"],
  holder: Knex.Transaction | null
): Promise<BatchOutcome> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new RangeError("batchSize must be a positive integer.");
  }

  let deletedJourneys = 0;
  let deletedEvents = 0;
  let batches = 0;
  let auditId: string | null = null;

  for (;;) {
    if (holder !== null && !(await lockHolderAlive(holder))) {
      return { deletedJourneys, deletedEvents, batches, auditId, lockLost: true };
    }

    const existingAuditId = auditId;
    const committed = await db.transaction(
      async (trx): Promise<{ journeys: number; events: number; auditId: string }> => {
        const deleted: unknown = await trx("journeys")
          .whereIn(
            ["project_id", "id"],
            selection(trx).select("j.project_id", "j.id").limit(batchSize)
          )
          .del()
          .returning("event_count as eventCount");
        const rows = deleted as { eventCount: number }[];
        const journeys = rows.length;
        const events = rows.reduce((sum, row) => sum + row.eventCount, 0);
        const metadata = audit.metadata({
          deletedJourneys: deletedJourneys + journeys,
          deletedEvents: deletedEvents + events
        });

        if (existingAuditId === null) {
          const id = await recordAudit(trx, {
            projectId: audit.projectId,
            actor: audit.actor,
            action: audit.action,
            resourceType: audit.resourceType,
            resourceId: audit.resourceId,
            metadata
          });
          return { journeys, events, auditId: id };
        }
        if (journeys > 0) {
          await updateAuditMetadata(trx, audit.projectId, existingAuditId, metadata);
        }
        return { journeys, events, auditId: existingAuditId };
      }
    );

    // Only after commit: an id assigned inside a transaction that then failed
    // would name a row that does not exist.
    auditId = committed.auditId;
    if (committed.journeys === 0) break;

    deletedJourneys += committed.journeys;
    deletedEvents += committed.events;
    batches += 1;
    await onBatch?.({ batch: batches, deletedJourneys, deletedEvents });
  }

  return { deletedJourneys, deletedEvents, batches, auditId, lockLost: false };
}

/**
 * The id of a named environment in the project, or null when the name matches nothing.
 *
 * A misspelled environment is reported rather than treated as matching
 * nothing: a dry run of zero and an audit row saying zero were deleted would
 * both look like a successful erasure.
 */
async function environmentIdByName(
  db: Knex,
  projectId: string,
  name: string
): Promise<string | null> {
  const row: unknown = await db("environments").where({ project_id: projectId, name }).first("id");
  return (row as { id: string } | undefined)?.id ?? null;
}

/** As `environmentIdByName`, with undefined for "every environment" when no name was given. */
async function optionalEnvironmentId(
  db: Knex,
  projectId: string,
  name: string | undefined
): Promise<string | undefined | null> {
  return name === undefined ? undefined : environmentIdByName(db, projectId, name);
}

async function environmentName(
  db: Knex,
  projectId: string,
  environmentId: string
): Promise<string> {
  const row: unknown = await db("environments")
    .where({ project_id: projectId, id: environmentId })
    .first("name");
  const found = row as { name: string } | undefined;
  // The journey's composite foreign key makes this impossible while it exists.
  if (found === undefined) throw new Error("The journey's environment does not exist.");
  return found.name;
}

function assertValidRange(selection: { after?: Date | undefined; before: Date }): void {
  if (Number.isNaN(selection.before.getTime())) throw new RangeError("before is not a valid date.");
  if (selection.after !== undefined && Number.isNaN(selection.after.getTime())) {
    throw new RangeError("after is not a valid date.");
  }
}

function requireAuditId(auditId: string | null): string {
  if (auditId === null) throw new Error("An erasure finished without writing its audit row.");
  return auditId;
}
