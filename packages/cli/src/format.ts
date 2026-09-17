import type {
  DiffChange,
  EventDetail,
  EventSummary,
  JourneyDetail,
  JourneySummary,
  Project
} from "./client.js";

/**
 * Terminal output, aligned by hand.
 *
 * No dependency and no colour library: colour is four escape codes, and the
 * decision that actually matters is whether to emit them at all.
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
  const width = Math.max(...projects.map((p) => p.slug.length), 4);
  const header = style.dim(`${pad("SLUG", width)}  ${pad("NAME", 28)}ID`);
  const rows = projects.map((p) => `${pad(p.slug, width)}  ${pad(p.name, 28)}${style.dim(p.id)}`);
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
    const entity = `${j.entity.type}:${j.entity.id}`;
    return (
      pad(j.journeyId, 44) +
      pad(entity.length > 24 ? `${entity.slice(0, 23)}…` : entity, 26) +
      cell(j.status, 10, statusColour(j.status, style)) +
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
  lines.push(style.bold(`${journey.entity.type}:${journey.entity.id}`));
  lines.push(
    style.dim(
      `${journey.journeyId}  ·  ${statusColour(journey.status, style)(journey.status)}  ·  ${String(events.length)} events  ·  ${journey.services.join(", ")}`
    )
  );
  if (journey.aliases.length > 0) {
    lines.push(
      style.dim(
        `also known as  ${journey.aliases.map((a) => `${a.type}=${a.displayValue}`).join("  ")}`
      )
    );
  }
  lines.push("");

  if (events.length === 0) {
    lines.push("This journey has no events yet.");
    return lines.join("\n");
  }

  const spansDays = new Set(events.map((e) => e.eventTimestamp.slice(0, 10))).size > 1;
  const opWidth = Math.max(...events.map((e) => e.operation.length), 9);
  const nameWidth = Math.max(...events.map((e) => e.name.length), 4);

  for (const event of events) {
    const when = spansDays
      ? `${DATE.format(new Date(event.eventTimestamp))} ${TIME.format(new Date(event.eventTimestamp))}`
      : TIME.format(new Date(event.eventTimestamp));
    const duration = event.durationMs === null ? "" : style.dim(` ${String(event.durationMs)}ms`);
    const flag = event.hasError ? style.red(" !") : "  ";
    lines.push(
      `${style.dim(when)}${flag} ${cell(event.operation, opWidth, operationColour(event.operation, style))}  ${pad(event.name, nameWidth)}  ${style.dim(event.service)}${duration}`
    );
  }

  lines.push("");
  lines.push(style.dim("All times UTC. Open a step with: wayscribe event <id> --diff"));
  return lines.join("\n");
}

export function formatEvent(event: EventDetail, showDiff: boolean, style: Style): string {
  const lines: string[] = [];
  lines.push(style.bold(`${event.operation}  ${event.name}`));
  lines.push(
    style.dim(
      `${event.id}  ·  ${event.service}  ·  ${DATE.format(new Date(event.eventTimestamp))} ${TIME.format(new Date(event.eventTimestamp))} UTC`
    )
  );

  if (event.error !== undefined && event.error !== null) {
    lines.push("");
    lines.push(style.red(`error  ${event.error.message}`));
  }

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
    lines.push(JSON.stringify(payload, null, 2));
  }
  return lines.join("\n");
}

export function formatDiff(changes: DiffChange[] | undefined, style: Style): string {
  if (changes === undefined) {
    return "No diff for this step. A diff is produced where a step recorded both an input and an output.";
  }
  if (changes.length === 0) {
    return "No fields changed between input and output.";
  }

  const width = Math.max(...changes.map((c) => c.path.length), 5);
  const lines = [style.dim(`${pad("FIELD", width)}  BEFORE  →  AFTER`)];
  for (const change of changes) {
    const before = change.kind === "added" ? style.dim("—") : style.red(render(change.before));
    const after = change.kind === "removed" ? style.dim("—") : style.green(render(change.after));
    lines.push(`${pad(change.path, width)}  ${before}  →  ${after}`);
  }
  return lines.join("\n");
}

function render(value: unknown): string {
  if (value === undefined) return "—";
  const text = JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
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
