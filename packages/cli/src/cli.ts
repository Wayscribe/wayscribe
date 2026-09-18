#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ApiError, Client } from "./client.js";
import { ConfigError, resolveConfig } from "./config.js";
import {
  formatEvent,
  formatJourney,
  formatProjects,
  formatSearch,
  styleFor,
  type Style
} from "./format.js";

const USAGE = `wayscribe — read journeys from a Wayscribe installation

  wayscribe search <value>        journeys for an entity id or alias value
  wayscribe journey <id>          the timeline, across every service
  wayscribe event <id> [--diff]   one step's payloads, or what changed
  wayscribe projects              projects this token can read

Options
  --url <url>        default $WAYSCRIBE_URL, then http://localhost:8080
  --token <token>    default $WAYSCRIBE_TOKEN; the admin token
  --project <id>     default $WAYSCRIBE_PROJECT; an admin token must name one
  --limit <n>        search only, default 20; above 100 the server reads it as 100
  --diff             event only, show the field-level diff instead of payloads
  --json             raw JSON, for scripts
  --help             this
  --version          the version of this CLI

Everything reads. Nothing here writes or deletes.`;

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  isTty: boolean;
  env: Record<string, string | undefined>;
}

/**
 * Returns an exit code rather than calling `process.exit`, so the whole command
 * is testable without spawning anything.
 */
export async function run(argv: readonly string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        url: { type: "string" },
        token: { type: "string" },
        project: { type: "string" },
        limit: { type: "string" },
        diff: { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" }
      }
    });
  } catch (error) {
    io.err((error as Error).message);
    io.err(USAGE);
    return 2;
  }

  const [command, argument] = parsed.positionals;

  if (parsed.values.version === true) {
    io.out(version());
    return 0;
  }

  if (parsed.values.help === true || command === undefined) {
    io.out(USAGE);
    return command === undefined && parsed.values.help !== true ? 2 : 0;
  }

  const style = parsed.values.json === true ? styleFor(false, {}) : styleFor(io.isTty, io.env);

  try {
    const config = resolveConfig(parsed.values, io.env);
    const client = new Client(config);
    const emit = (value: unknown, text: string): void => {
      io.out(config.json ? JSON.stringify(value, null, 2) : text);
    };

    switch (command) {
      case "projects": {
        const page = await client.projects();
        emit(page.items, formatProjects(page.items, style));
        return 0;
      }

      case "search": {
        if (argument === undefined) return missing("search <value>", io);
        // Digits only, checked before conversion: parseInt read "5abc" as 5
        // and sent it, and Number would take " 5" or "1e2". Above 100 is
        // passed on; the server reads it as 100 and pages the rest.
        const raw = parsed.values.limit ?? "20";
        const limit = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
        if (!(limit >= 1)) {
          io.err(`--limit must be a whole number of at least 1, not "${raw}".`);
          return 2;
        }
        const page = await client.search(argument, limit);
        emit(page.items, formatSearch(page.items, style));
        return 0;
      }

      case "journey": {
        if (argument === undefined) return missing("journey <id>", io);
        // Both, because a timeline without its journey has no entity to name
        // and a journey without its timeline is a header.
        const [journey, events] = await Promise.all([
          client.journey(argument),
          client.events(argument)
        ]);
        emit({ ...journey, events }, formatJourney(journey, events, style));
        return 0;
      }

      case "event": {
        if (argument === undefined) return missing("event <id>", io);
        const event = await client.event(argument);
        emit(event, formatEvent(event, parsed.values.diff === true, style));
        return 0;
      }

      default: {
        io.err(`Unknown command "${command}".`);
        io.err(USAGE);
        return 2;
      }
    }
  } catch (error) {
    if (error instanceof ConfigError || error instanceof ApiError) {
      io.err(error.message);
      return 1;
    }
    throw error;
  }
}

/**
 * The version in this package's own package.json.
 *
 * Read at run time rather than imported: the file sits outside `rootDir`, so
 * tsc will not compile an import of it. `../package.json` is the package root
 * from both `src/cli.ts`, under tsx and Vitest, and `dist/cli.js`, where the
 * build puts this module, and npm packs package.json whatever `files` says.
 */
export function version(): string {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  ) as { version?: unknown };
  if (typeof manifest.version !== "string") {
    throw new Error("package.json has no version.");
  }
  return manifest.version;
}

function missing(shape: string, io: Io): number {
  io.err(`Usage: wayscribe ${shape}`);
  return 2;
}

/** Kept out of `run` so importing this module never runs a command. */
export function isEntryPoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (argv1 === undefined) return false;
  return moduleUrl.endsWith("/cli.js") || moduleUrl.endsWith("/cli.ts");
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  const io: Io = {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    isTty: process.stdout.isTTY,
    env: process.env
  };
  process.exitCode = await run(process.argv.slice(2), io);
}

export type { Style };
