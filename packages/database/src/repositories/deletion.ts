import {
  normalizeSearchValue,
  searchTokens,
  type Keyring
} from "@flight-recorder/payload-security";
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

/** An identifier that is empty once normalized: it names nobody, so nothing is matched. */
export interface EmptyValue {
  ok: false;
  reason: "empty_value";
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

export type IdentifierMatches = JourneyMatches | EmptyValue;

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
): Promise<IdentifierMatches> {
  if (isEmptyValue(selection.value)) return { ok: false, reason: "empty_value" };
  const environmentId = await optionalEnvironmentId(db, selection.projectId, selection.environment);
  if (environmentId === null) return { ok: false, reason: "environment_not_found" };

  const tokens = searchTokens(keyring, selection.value);
  return listMatches(
    (trx, cutoff) => identifierSelection(trx, selection.projectId, environmentId, tokens, cutoff),
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
  | EnvironmentNotFound
  | EmptyValue;

/**
 * Delete every journey matching an identifier, in transactions of 500.
 *
 * One audit row per erasure, `erasure.completed`, carrying the current key's
 * search token and never the value. It is inserted with `complete: false` in
 * the first batch's transaction, and each later batch updates its counts in
 * that batch's own transaction; the final batch, which finds nothing left,
 * sets `complete: true`. So a process that dies part way leaves a row whose
 * counts are exactly what committed and which says it did not finish: never
 * deleted journeys with no row, and never a row claiming more than was deleted.
 * Running the erasure again finishes the job and writes a second row.
 *
 * Only journeys created by the time the erasure starts are selected. A
 * customer still being written by live ingestion would otherwise keep every
 * batch full and the run would never end; what arrives later is left for the
 * next erasure, which a dry run will show.
 */
export async function eraseIdentifier(
  db: Knex,
  keyring: Keyring,
  input: IdentifierSelection & { actor: string },
  options: BatchOptions = {}
): Promise<ErasureResult> {
  if (isEmptyValue(input.value)) return { ok: false, reason: "empty_value" };
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
    (trx, cutoff) => identifierSelection(trx, input.projectId, environmentId, tokens, cutoff),
    ["j.id"],
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

  return listMatches(
    (trx, cutoff) => rangeSelection(trx, selection, environmentId, cutoff),
    db,
    options
  );
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
 * as an erasure's: inserted with the first batch as incomplete, updated with
 * each later one, and marked complete by the batch that finds nothing left. A
 * run that loses its lock leaves it incomplete and adds `lockLost: true`.
 *
 * As with an erasure, only journeys created by the time the run starts are
 * selected, so a `before` in the future on a live environment still ends
 * rather than holding the sweep's lock while new journeys arrive.
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
      (trx, cutoff) => rangeSelection(trx, input, environmentId, cutoff),
      ["j.last_event_at", "j.id"],
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
    // FOR UPDATE conflicts with the key-share lock a replay_runs insert takes on
    // the destination it references. A replay starting while this runs waits,
    // then fails its foreign key once the destination is gone, instead of
    // committing a run after the runs were deleted, which would make the
    // destination's own delete fail.
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

/**
 * A query over `journeys as j` restricted to what a deletion selects, among
 * journeys created no later than `cutoff`, a timestamp the database gave.
 */
type Selection = (db: Knex, cutoff: string) => Knex.QueryBuilder;

function identifierSelection(
  db: Knex,
  projectId: string,
  environmentId: string | undefined,
  tokens: readonly string[],
  cutoff: string
): Knex.QueryBuilder {
  // The same token match as search: entity id or any alias, every token the
  // keyring gives the value, scoped inside the query.
  return db({ j: "journeys" })
    .where("j.project_id", projectId)
    .andWhereRaw("j.created_at <= ?::timestamptz", [cutoff])
    .modify((scoped) => {
      if (environmentId !== undefined) void scoped.andWhere("j.environment_id", environmentId);
    })
    .andWhere((match) => {
      void match.whereIn("j.primary_entity_id_hash", tokens).orWhereExists((exists) => {
        // Correlated on project as well as journey id: journey ids repeat across
        // projects, and the keyring is installation-wide, so another project's
        // alias carries the same token.
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
  environmentId: string,
  cutoff: string
): Knex.QueryBuilder {
  // Not fixed, and the same as the retention sweep: a batch's delete selects
  // its rows and then locks them, so a journey whose new event moves its
  // `last_event_at` out of the range in between is still deleted.
  return db({ j: "journeys" })
    .where("j.project_id", selection.projectId)
    .andWhere("j.environment_id", environmentId)
    .andWhereRaw("j.created_at <= ?::timestamptz", [cutoff])
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
  // One transaction, so the total and the list see the same snapshot, and the
  // cutoff is taken as a real run takes it: when the run starts.
  return db.transaction(
    async (trx): Promise<JourneyMatches> => {
      const cutoff = await databaseNow(trx);
      const counted: unknown = await selection(trx, cutoff).count({ n: "*" });
      const total = Number((counted as { n: string | number }[])[0]?.n ?? 0);

      const rows: unknown = await selection(trx, cutoff)
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
 * The cutoff is read from the database once, before the first batch, so the
 * selection is bounded by what existed then and the run ends however fast
 * matching journeys arrive.
 *
 * The run ends with a batch that deletes nothing and then finds nothing left
 * to select. A batch coming back short, or even empty, is not enough: a
 * concurrent deletion of rows it selected shortens it while later matches
 * remain. That final batch marks the audit row complete.
 *
 * With a `holder`, the lock it holds is checked before every batch, and a lost
 * lock ends the run after the batch that committed.
 */
async function deleteInBatches(
  db: Knex,
  batchSize: number,
  selection: Selection,
  order: readonly string[],
  audit: AuditPlan,
  onBatch: BatchOptions["onBatch"],
  holder: Knex.Transaction | null
): Promise<BatchOutcome> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new RangeError("batchSize must be a positive integer.");
  }

  const cutoff = await databaseNow(db);
  let deletedJourneys = 0;
  let deletedEvents = 0;
  let batches = 0;
  let auditId: string | null = null;

  for (;;) {
    if (holder !== null && !(await lockHolderAlive(holder))) {
      if (auditId !== null) {
        await updateAuditMetadata(db, audit.projectId, auditId, {
          ...audit.metadata({ deletedJourneys, deletedEvents }),
          complete: false,
          lockLost: true
        });
      }
      return { deletedJourneys, deletedEvents, batches, auditId, lockLost: true };
    }

    const existingAuditId = auditId;
    const committed = await db.transaction(
      async (
        trx
      ): Promise<{ journeys: number; events: number; auditId: string; done: boolean }> => {
        const deleted: unknown = await trx("journeys")
          .whereIn(
            ["project_id", "id"],
            selection(trx, cutoff)
              .select("j.project_id", "j.id")
              .orderBy([...order])
              .limit(batchSize)
          )
          .del()
          .returning("event_count as eventCount");
        const rows = deleted as { eventCount: number }[];
        const journeys = rows.length;
        const events = rows.reduce((sum, row) => sum + row.eventCount, 0);
        const remaining: unknown =
          journeys === 0 ? await selection(trx, cutoff).first(trx.raw("1 as found")) : true;
        const done = remaining === undefined;
        const metadata = {
          ...audit.metadata({
            deletedJourneys: deletedJourneys + journeys,
            deletedEvents: deletedEvents + events
          }),
          complete: done
        };

        if (existingAuditId === null) {
          const id = await recordAudit(trx, {
            projectId: audit.projectId,
            actor: audit.actor,
            action: audit.action,
            resourceType: audit.resourceType,
            resourceId: audit.resourceId,
            metadata
          });
          return { journeys, events, auditId: id, done };
        }
        if (journeys > 0 || done) {
          await updateAuditMetadata(trx, audit.projectId, existingAuditId, metadata);
        }
        return { journeys, events, auditId: existingAuditId, done };
      }
    );

    // Only after commit: an id assigned inside a transaction that then failed
    // would name a row that does not exist.
    auditId = committed.auditId;
    if (committed.done) break;
    if (committed.journeys === 0) continue;

    deletedJourneys += committed.journeys;
    deletedEvents += committed.events;
    batches += 1;
    await onBatch?.({ batch: batches, deletedJourneys, deletedEvents });
  }

  return { deletedJourneys, deletedEvents, batches, auditId, lockLost: false };
}

/**
 * The database's current time, to the microsecond, as text.
 *
 * Text rather than a JavaScript Date, which keeps milliseconds only: a cutoff
 * truncated to the millisecond would exclude a journey created earlier in that
 * same millisecond.
 */
async function databaseNow(db: Knex): Promise<string> {
  const result: unknown = await db.raw(
    `select to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as now`
  );
  const now = (result as { rows: { now: string }[] }).rows[0]?.now;
  if (now === undefined) throw new Error("The database returned no time.");
  return now;
}

function isEmptyValue(value: string): boolean {
  return normalizeSearchValue(value) === "";
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
  if (selection.after === undefined) return;
  if (Number.isNaN(selection.after.getTime())) throw new RangeError("after is not a valid date.");
  // An empty range selects nothing, and an inverted one is almost certainly the
  // two dates swapped: refused rather than recorded as a deletion of nothing.
  if (selection.after.getTime() >= selection.before.getTime()) {
    throw new RangeError("after must be earlier than before.");
  }
}

function requireAuditId(auditId: string | null): string {
  if (auditId === null) throw new Error("An erasure finished without writing its audit row.");
  return auditId;
}
