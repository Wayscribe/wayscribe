import { commandUsage, flag, parseCommandArgs, type FlagsRead } from "./cli-commands.js";
import type {
  BatchProgress,
  DestinationDeletion,
  ErasureResult,
  IdentifierMatches,
  JourneyDeletion,
  MatchedJourney,
  RangeDeletion
} from "./repositories/deletion.js";

/**
 * What the deletion commands print, and how they read their arguments.
 *
 * Kept apart from the CLI so the wording, the table, and every refusal are
 * tested without a database or a process. A report is lines for stdout, lines
 * for stderr, and the exit code: 1 whenever the operator asked for something
 * that did not fully happen, so a script cannot mistake it for success.
 */
export interface Report {
  stdout: string[];
  stderr: string[];
  code: 0 | 1;
}

export interface ReportContext {
  projectSlug: string;
  /** The environment name, or "all environments". */
  scope: string;
  command: string;
}

const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/**
 * An ISO-8601 date (midnight UTC) or a timestamp with an explicit offset.
 *
 * A timestamp without an offset is refused rather than read in the local zone:
 * the same command would delete a different window on a server in another
 * zone, and nothing in the output would show it.
 */
export function parseTimestamp(
  flag: string,
  raw: string
): { ok: true; date: Date } | { ok: false; message: string } {
  const invalid = {
    ok: false as const,
    message:
      `${flag} is not an ISO-8601 date or timestamp: "${raw}". ` +
      "Use a date such as 2026-09-01, or a timestamp with an offset such as 2026-09-01T00:00:00Z."
  };
  const match = TIMESTAMP_PATTERN.exec(raw);
  if (match === null) return invalid;

  // Date.parse rolls 2026-02-30 over into March rather than refusing it.
  const [, year, month, day] = match.map(Number);
  if (year === undefined || month === undefined || day === undefined) return invalid;
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return invalid;

  const time = Date.parse(raw);
  return Number.isNaN(time) ? invalid : { ok: true, date: new Date(time) };
}

/**
 * `<project-slug> <id>` for the commands with no flags, with `--` accepted
 * before an id that begins with a dash, as for the others.
 */
export function parseIdArgs(
  command: "delete:journey" | "delete:destination",
  args: readonly string[]
): { ok: true; projectSlug: string; id: string } | { ok: false; message: string } {
  const parsed = parseCommandArgs(command, args);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  const [projectSlug = "", id = ""] = parsed.positionals;
  return { ok: true, projectSlug, id };
}

export type IdentifierArgs =
  | {
      ok: true;
      projectSlug: string;
      value: string;
      environment: string | undefined;
      dryRun: boolean;
    }
  | { ok: false; message: string };

export function parseIdentifierArgs(args: readonly string[]): IdentifierArgs {
  const parsed = parseCommandArgs("delete:identifier", args);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  const read = {
    environment: parsed.values.environment,
    "dry-run": parsed.values["dry-run"] === true
  } satisfies FlagsRead<"delete:identifier">;

  const [projectSlug = "", value = ""] = parsed.positionals;
  return {
    ok: true,
    projectSlug,
    value,
    environment: read.environment,
    dryRun: read["dry-run"]
  };
}

export type RangeArgs =
  | {
      ok: true;
      projectSlug: string;
      environment: string;
      before: Date;
      after: Date | undefined;
      dryRun: boolean;
    }
  | { ok: false; message: string };

export function parseRangeArgs(args: readonly string[]): RangeArgs {
  const parsed = parseCommandArgs("delete:range", args);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  const read = {
    before: parsed.values.before,
    after: parsed.values.after,
    "dry-run": parsed.values["dry-run"] === true
  } satisfies FlagsRead<"delete:range">;

  const [projectSlug = "", environment = ""] = parsed.positionals;
  const BEFORE = flag("delete:range", "--before");
  const AFTER = flag("delete:range", "--after");
  if (read.before === undefined) {
    return { ok: false, message: `${BEFORE} is required.\n${commandUsage("delete:range")}` };
  }

  const before = parseTimestamp(BEFORE, read.before);
  if (!before.ok) return before;
  let after: Date | undefined;
  if (read.after !== undefined) {
    const parsedAfter = parseTimestamp(AFTER, read.after);
    if (!parsedAfter.ok) return parsedAfter;
    after = parsedAfter.date;
    if (after.getTime() >= before.date.getTime()) {
      return {
        ok: false,
        message: `${AFTER} (${after.toISOString()}) must be earlier than ${BEFORE} (${before.date.toISOString()}).`
      };
    }
  }

  return {
    ok: true,
    projectSlug,
    environment,
    before: before.date,
    after,
    dryRun: read["dry-run"]
  };
}

/** One line as each batch commits, so a long run shows it is moving. */
export function formatBatchProgress(progress: BatchProgress): string {
  return `  batch ${String(progress.batch)}: ${count(progress.deletedJourneys, "journey")} deleted so far`;
}

export function formatJourneyTable(journeys: readonly MatchedJourney[]): string[] {
  const header = ["ID", "ENVIRONMENT", "ENTITY TYPE", "EVENTS", "LAST ACTIVITY"];
  const rows = journeys.map((journey) => [
    journey.id,
    journey.environment,
    journey.entityType,
    String(journey.eventCount),
    journey.lastEventAt.toISOString().slice(0, 19).replace("T", " ")
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]?.length ?? 0))
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) =>
        column === cells.length - 1 ? cell : cell.padEnd((widths[column] ?? 0) + 2)
      )
      .join("");
  return [line(header), ...rows.map(line)];
}

/** A dry run: the journeys a real run would delete now. */
export function reportMatches(result: IdentifierMatches, context: ReportContext): Report {
  if (!result.ok) return refusal(result.reason, context);

  const stdout = [
    `Dry run: ${count(result.total, "journey")} ${result.total === 1 ? "matches" : "match"} in ${context.projectSlug} (${context.scope}). Nothing was deleted.`
  ];
  if (result.journeys.length > 0) {
    stdout.push("", ...formatJourneyTable(result.journeys));
  }
  if (result.total > result.journeys.length) {
    stdout.push(
      "",
      `Showing the ${String(result.journeys.length)} most recent of ${String(result.total)}.`
    );
  }
  return { stdout, stderr: [], code: 0 };
}

export function reportJourneyDeletion(
  result: JourneyDeletion,
  projectSlug: string,
  journeyId: string
): Report {
  if (!result.ok) {
    return { stdout: [], stderr: [`No journey ${journeyId} in project ${projectSlug}.`], code: 1 };
  }
  return {
    stdout: [
      `Deleted journey ${result.journeyId} (${result.environment}, ${count(result.eventCount, "event")}). Recorded in the audit log.`
    ],
    stderr: [],
    code: 0
  };
}

export function reportErasure(result: ErasureResult, context: ReportContext): Report {
  if (!result.ok) return refusal(result.reason, context);
  return {
    stdout: [
      `${deleted(result.deletedJourneys, result.deletedEvents)} in ${context.projectSlug} (${context.scope}). The audit log records the search token, not the value.`,
      LATE_ARRIVALS
    ],
    stderr: [],
    code: 0
  };
}

/** An erasure that committed some batches and then failed. */
export function reportErasureStopped(progress: BatchProgress, error: unknown): Report {
  return {
    stdout: [],
    stderr: [
      `delete:identifier stopped after deleting ${count(progress.deletedJourneys, "journey")} and ${count(progress.deletedEvents, "event")}: ${messageOf(error)}`,
      "What it deleted stands, and the audit log records the erasure as incomplete. Run delete:identifier again to delete the rest."
    ],
    code: 1
  };
}

export function reportRange(result: RangeDeletion, context: ReportContext): Report {
  if (!result.ok) {
    if (result.reason === "lock_held") {
      return {
        stdout: [],
        stderr: [
          "A retention sweep or another delete:range holds the retention lock, so nothing was deleted. Run it again once that finishes."
        ],
        code: 1
      };
    }
    return refusal(result.reason, context);
  }

  const stdout = [
    `${deleted(result.deletedJourneys, result.deletedEvents)} in ${context.projectSlug} (${context.scope}). Recorded in the audit log.`
  ];
  if (!result.lockLost) return { stdout: [...stdout, LATE_ARRIVALS], stderr: [], code: 0 };
  return {
    stdout,
    stderr: [
      "delete:range lost the retention lock: the database connection holding it ended, for example through idle_in_transaction_session_timeout. " +
        "It stopped after the batch in progress. What it deleted stands and the audit log records the run as incomplete; run delete:range again to finish."
    ],
    code: 1
  };
}

export function reportDestination(
  result: DestinationDeletion,
  projectSlug: string,
  destinationId: string
): Report {
  if (!result.ok) {
    return {
      stdout: [],
      stderr: [`No replay destination ${destinationId} in project ${projectSlug}.`],
      code: 1
    };
  }
  return {
    stdout: [
      `Deleted replay destination "${result.name}" and ${count(result.deletedRuns, "replay run")}. Recorded in the audit log.`
    ],
    stderr: [],
    code: 0
  };
}

const LATE_ARRIVALS =
  "Journeys recorded after the run started were left alone; run it again with " +
  `${flag("delete:identifier", "--dry-run")} to check for any.`;

function refusal(reason: "environment_not_found" | "empty_value", context: ReportContext): Report {
  return {
    stdout: [],
    stderr: [
      reason === "environment_not_found"
        ? `No environment "${context.scope}" in project ${context.projectSlug}.`
        : "The value is empty once surrounding whitespace is removed, so it names nobody. Nothing was deleted."
    ],
    code: 1
  };
}

function deleted(journeys: number, events: number): string {
  return `Deleted ${count(journeys, "journey")} and ${count(events, "event")}`;
}

function count(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? "" : "s"}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
