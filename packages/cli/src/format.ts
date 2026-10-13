import type {
  DiffChange,
  EventDetail,
  EventSummary,
  JourneyDetail,
  JourneySummary,
  LikelyCause,
  Project
} from "./client.js";
import { bounded, isBelow } from "./cause-paths.js";
import { jsonSafe, terminalSafe as safe, terminalSafeWithin } from "./terminal-safe.js";

/**
 * Terminal output, aligned by hand.
 *
 * No dependency and no colour library: colour is four escape codes, and the
 * decision that actually matters is whether to emit them at all.
 *
 * Every string the server supplies goes through `safe` before it is padded
 * or printed, so its control characters show as escapes rather than act on
 * the terminal, and widths count what is actually shown.
 */
const TIME = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "UTC"
});

const DATE = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });

export interface Style {
  dim: (text: string) => string;
  bold: (text: string) => string;
  red: (text: string) => string;
  green: (text: string) => string;
}

const PLAIN: Style = {
  dim: (t) => t,
  bold: (t) => t,
  red: (t) => t,
  green: (t) => t
};

const ESC = "\u001b";
const COLOUR: Style = {
  dim: (t) => `${ESC}[2m${t}${ESC}[22m`,
  bold: (t) => `${ESC}[1m${t}${ESC}[22m`,
  red: (t) => `${ESC}[31m${t}${ESC}[39m`,
  green: (t) => `${ESC}[32m${t}${ESC}[39m`
};

/**
 * Colour when a person is watching and has not asked to be spared.
 *
 * `NO_COLOR` is honoured because piping into `grep` or a file is the second
 * thing anybody does with a CLI, and escape codes ruin both.
 */
export function styleFor(isTty: boolean, env: Record<string, string | undefined>): Style {
  if (!isTty) return PLAIN;
  if (env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") return PLAIN;
  if (env["TERM"] === "dumb") return PLAIN;
  return COLOUR;
}

const pad = (text: string, width: number): string => text.padEnd(width);

/**
 * Pad first, colour second.
 *
 * `padEnd` counts escape bytes, so colouring before padding silently shortens
 * every coloured column by the length of its escape sequence.
 */
const cell = (text: string, width: number, colour: (t: string) => string): string =>
  colour(text.padEnd(width));

export function formatProjects(projects: Project[], style: Style): string {
  if (projects.length === 0) {
    return "No projects yet.\nCreate one with: project:create <slug> <name>  (see docs/OPERATIONS.md)";
  }
  const shown = projects.map((p) => ({ slug: safe(p.slug), name: safe(p.name), id: safe(p.id) }));
  const width = Math.max(...shown.map((p) => p.slug.length), 4);
  const header = style.dim(`${pad("SLUG", width)}  ${pad("NAME", 28)}ID`);
  const rows = shown.map((p) => `${pad(p.slug, width)}  ${pad(p.name, 28)}${style.dim(p.id)}`);
  return [header, ...rows].join("\n");
}

export function formatSearch(journeys: JourneySummary[], style: Style): string {
  if (journeys.length === 0) {
    return "Nothing matched.\nSearch takes an entity id or any alias value you recorded with identify().";
  }
  const header = style.dim(
    `${pad("JOURNEY", 44)}${pad("ENTITY", 26)}${pad("STATUS", 10)}${pad("EVENTS", 8)}STARTED`
  );
  const rows = journeys.map((j) => {
    // Bounded by the width shown, cut between escapes, never inside one.
    const entity = terminalSafeWithin(`${j.entity.type}:${j.entity.id}`, 24);
    return (
      pad(safe(j.journeyId), 44) +
      pad(entity, 26) +
      cell(safe(j.status), 10, statusColour(j.status, style)) +
      pad(String(j.eventCount), 8) +
      style.dim(`${DATE.format(new Date(j.startedAt))} ${TIME.format(new Date(j.startedAt))}`)
    );
  });
  return [header, ...rows].join("\n");
}

export function formatJourney(
  journey: JourneyDetail,
  events: EventSummary[],
  style: Style
): string {
  const lines: string[] = [];
  lines.push(style.bold(safe(`${journey.entity.type}:${journey.entity.id}`)));
  lines.push(
    style.dim(
      `${safe(journey.journeyId)}  ·  ${statusColour(journey.status, style)(safe(journey.status))}  ·  ${String(events.length)} events  ·  ${safe(journey.services.join(", "))}`
    )
  );
  if (journey.aliases.length > 0) {
    lines.push(
      style.dim(
        `also known as  ${journey.aliases.map((a) => safe(`${a.type}=${a.displayValue}`)).join("  ")}`
      )
    );
  }
  lines.push("");

  if (events.length === 0) {
    lines.push("This journey has no events yet.");
    return lines.join("\n");
  }

  const spansDays = new Set(events.map((e) => e.eventTimestamp.slice(0, 10))).size > 1;
  // ADR-072: the journey's likely cause goes under the step that failed it,
  // the last failing event of that name, as the API chose it.
  const failedRow =
    journey.status === "failed" && typeof journey.failedStep === "string"
      ? events.findLast(
          (e) => (e.hasError || e.operation === "failed") && e.name === journey.failedStep
        )
      : undefined;
  const nameOf = (eventId: string): string | null =>
    events.find((e) => e.id === eventId)?.name ?? null;
  const opWidth = Math.max(...events.map((e) => safe(e.operation).length), 9);
  const nameWidth = Math.max(...events.map((e) => safe(e.name).length), 4);

  for (const event of events) {
    const when = spansDays
      ? `${DATE.format(new Date(event.eventTimestamp))} ${TIME.format(new Date(event.eventTimestamp))}`
      : TIME.format(new Date(event.eventTimestamp));
    const duration = event.durationMs === null ? "" : style.dim(` ${String(event.durationMs)}ms`);
    const flag = event.hasError ? style.red(" !") : "  ";
    lines.push(
      `${style.dim(when)}${flag} ${cell(safe(event.operation), opWidth, operationColour(event.operation, style))}  ${pad(safe(event.name), nameWidth)}  ${style.dim(safe(event.service))}${duration}`
    );
    if (event === failedRow) {
      lines.push(...formatLikelyCauses(journey.likelyCauses, null, nameOf, style));
    }
  }

  lines.push("");
  lines.push(style.dim("All times UTC. Open a step with: wayscribe event <id> --diff"));
  return lines.join("\n");
}

export function formatEvent(event: EventDetail, showDiff: boolean, style: Style): string {
  const lines: string[] = [];
  lines.push(style.bold(safe(`${event.operation}  ${event.name}`)));
  lines.push(
    style.dim(
      `${safe(event.id)}  ·  ${safe(event.service)}  ·  ${DATE.format(new Date(event.eventTimestamp))} ${TIME.format(new Date(event.eventTimestamp))} UTC`
    )
  );

  if (event.error !== undefined && event.error !== null) {
    lines.push("");
    lines.push(style.red(`error  ${safe(event.error.message)}`));
  }
  lines.push(...formatLikelyCauses(event.likelyCauses, event.id, () => null, style));

  if (showDiff) {
    lines.push("");
    lines.push(formatDiff(event.payloadDiff?.changes, style));
    return lines.join("\n");
  }

  for (const [label, payload] of [
    ["input", event.inputPayload],
    ["output", event.outputPayload]
  ] as const) {
    if (payload === undefined) continue;
    lines.push("");
    lines.push(style.dim(label));
    // JSON has escaped C0 already; `jsonSafe` adds DEL, C1 and bidi as
    // `\uXXXX`, so the printed payload stays valid JSON.
    lines.push(jsonSafe(JSON.stringify(payload, null, 2)));
  }
  return lines.join("\n");
}

/**
 * The likely-cause lines (ADR-072), indented under a failed step: the same
 * sentence the web app shows. When the changed path lies below the reported
 * field, the line names that path, whose values it gives, and the field it
 * sits in. The reporter is named when it is not the failure itself, by step
 * name where the timeline has it, else by id. A cause is never changed.
 */
export function formatLikelyCauses(
  causes: readonly LikelyCause[] | undefined,
  failedEventId: string | null,
  nameOf: (eventId: string) => string | null,
  style: Style
): string[] {
  const lines: string[] = [];
  for (const cause of causes ?? []) {
    const { change } = cause;
    const verb = change.lost ? "lost" : change.kind === "removed" ? "removed" : "changed";
    const subject = isBelow(change.path, cause.field)
      ? `${safe(change.path)} (in ${safe(cause.field)})`
      : safe(cause.field);
    const values =
      verb === "changed"
        ? ` (was ${causeValue(change.before)}, now ${causeValue(change.after)})`
        : ` (was ${causeValue(change.before)})`;
    const reporter =
      cause.reportedBy === failedEventId
        ? ""
        : `, reported by ${safe(nameOf(cause.reportedBy) ?? cause.reportedBy)}`;
    lines.push(
      `  ${style.bold("Likely cause:")} ${subject} ${verb} at ${safe(cause.step)}${values}${reporter}`
    );
    if (cause.alsoChangedAt.length > 0) {
      lines.push(
        style.dim(
          `  Also changed earlier at: ${safe(cause.alsoChangedAt.map((s) => s.step).join(", "))}`
        )
      );
    }
    if (cause.incomplete === true) {
      lines.push(style.dim("  Some earlier steps' changes were too large to check."));
    }
  }
  return lines;
}

/**
 * A string as it is up to the web's bound, anything else as `render` shows a
 * diff value. Bounded first, as the web counts the raw value's code points,
 * then escaped, so the bound never cuts an escape in half.
 */
function causeValue(value: unknown): string {
  return typeof value === "string" ? safe(bounded(value)) : render(value);
}

export function formatDiff(changes: DiffChange[] | undefined, style: Style): string {
  if (changes === undefined) {
    return "No diff for this step. A diff is produced where a step recorded both an input and an output.";
  }
  if (changes.length === 0) {
    return "No fields changed between input and output.";
  }

  const width = Math.max(...changes.map((c) => safe(c.path).length), 5);
  const lines = [style.dim(`${pad("FIELD", width)}  BEFORE  →  AFTER`)];
  for (const change of changes) {
    const before = change.kind === "added" ? style.dim("—") : style.red(render(change.before));
    const after = change.kind === "removed" ? style.dim("—") : style.green(render(change.after));
    lines.push(`${pad(safe(change.path), width)}  ${before}  →  ${after}`);
  }
  return lines.join("\n");
}

function render(value: unknown): string {
  if (value === undefined) return "—";
  const text = JSON.stringify(value);
  return safe(text.length > 60 ? `${text.slice(0, 59)}…` : text);
}

/** The colour a status wears, as a function so padding can happen first. */
function statusColour(status: string, style: Style): (text: string) => string {
  if (status === "failed") return style.red;
  if (status === "completed") return style.green;
  return (text) => text;
}

function operationColour(operation: string, style: Style): (text: string) => string {
  return operation === "failed" ? style.red : (text) => text;
}
