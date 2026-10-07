import { createHash } from "node:crypto";

/**
 * Visit notifications for the public demo (docs/DEMO_HOSTING.md). Demo
 * infrastructure, not product code: nothing in apps/ or packages/ tracks
 * visitors.
 *
 * Runs on Node 22.12 with type stripping, so erasable TypeScript only: no
 * enums, namespaces or parameter properties.
 */

export const SMOKE_USER_AGENT_PREFIX = "wayscribe-smoke/";
export const DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000;
export const HOURLY_LIMIT = 10;
const HOUR_MS = 60 * 60 * 1000;
const MAX_REMEMBERED_CLIENTS = 100_000;

export interface AccessRecord {
  /** Unix milliseconds. */
  at: number;
  clientIp: string;
  userAgent: string;
  method: string;
  /** Without the query: a search's query string is what was searched. */
  path: string;
  status: number;
  referer: string | null;
}

export interface Message {
  title: string;
  body: string;
}

export interface NotifierState {
  saltDay: string;
  /** Held in memory only, replaced daily; the client key is a hash under it. */
  salt: string;
  /** Client key to the last time it was seen. No address is kept. */
  seen: Map<string, number>;
  windowStart: number | null;
  sentInWindow: number;
  suppressedInWindow: number;
}

type CaddyHeaders = Record<string, unknown> | undefined;

function firstHeader(headers: CaddyHeaders, name: string): string | null {
  const value = headers?.[name];
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : null;
}

export function pathOnly(uri: string): string {
  const cut = uri.search(/[?#]/);
  return cut === -1 ? uri : uri.slice(0, cut);
}

/** One line of Caddy's JSON access log, or null for anything else. */
export function parseCaddyLine(line: string): AccessRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const entry = parsed as { ts?: unknown; status?: unknown; request?: unknown };
  if (typeof entry.request !== "object" || entry.request === null) return null;
  const request = entry.request as {
    client_ip?: unknown;
    remote_ip?: unknown;
    method?: unknown;
    uri?: unknown;
    headers?: CaddyHeaders;
  };
  const clientIp =
    typeof request.client_ip === "string"
      ? request.client_ip
      : typeof request.remote_ip === "string"
        ? request.remote_ip
        : null;
  if (
    clientIp === null ||
    typeof request.method !== "string" ||
    typeof request.uri !== "string" ||
    typeof entry.status !== "number"
  ) {
    return null;
  }
  const at =
    typeof entry.ts === "number"
      ? Math.round(entry.ts * 1000)
      : typeof entry.ts === "string"
        ? Date.parse(entry.ts)
        : Number.NaN;
  if (!Number.isFinite(at)) return null;
  return {
    at,
    clientIp,
    userAgent: firstHeader(request.headers, "User-Agent") ?? "",
    method: request.method,
    path: pathOnly(request.uri),
    status: entry.status,
    referer: firstHeader(request.headers, "Referer")
  };
}

const NOT_PAGES = ["/_next/", "/api/", "/health", "/favicon", "/robots.txt"];
const FILE_EXTENSION = /\.[A-Za-z0-9]{1,8}$/;

/** A page a person asked for: not an asset, API, health check or error. */
export function isPageRequest(record: AccessRecord): boolean {
  if (record.method !== "GET") return false;
  if (record.status < 200 || record.status >= 400) return false;
  if (NOT_PAGES.some((prefix) => record.path.startsWith(prefix))) return false;
  return !FILE_EXTENSION.test(record.path);
}

const ROBOT = /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|headless|lighthouse/i;

/** Not the smoke check (CI, deploy, uptime), and not a self-declared robot. */
export function isCountedAgent(userAgent: string): boolean {
  if (userAgent.trim() === "") return false;
  if (userAgent.startsWith(SMOKE_USER_AGENT_PREFIX)) return false;
  return !ROBOT.test(userAgent);
}

export function clientKey(salt: string, clientIp: string, userAgent: string): string {
  return createHash("sha256").update(`${salt}\n${clientIp}\n${userAgent}`, "utf8").digest("hex");
}

export function browserFamily(userAgent: string): string {
  if (/Edg\//.test(userAgent)) return "Edge";
  if (/OPR\//.test(userAgent)) return "Opera";
  if (/Firefox\//.test(userAgent)) return "Firefox";
  if (/Chrome\/|CriOS\//.test(userAgent)) return "Chrome";
  if (/Safari\//.test(userAgent)) return "Safari";
  return "Other browser";
}

export function osFamily(userAgent: string): string {
  if (/iPhone|iPad|iPod/.test(userAgent)) return "iOS";
  if (/Android/.test(userAgent)) return "Android";
  if (/CrOS/.test(userAgent)) return "ChromeOS";
  if (/Mac OS X|Macintosh/.test(userAgent)) return "macOS";
  if (/Windows/.test(userAgent)) return "Windows";
  if (/Linux/.test(userAgent)) return "Linux";
  return "other OS";
}

export function referrerHost(referer: string | null, ownHost: string): string {
  if (referer === null) return "direct";
  try {
    const host = new URL(referer).hostname;
    return host === "" || host === ownHost ? "direct" : host;
  } catch {
    return "direct";
  }
}

const NEW_YORK_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit"
});

export function newYorkTime(at: number): string {
  // ICU 72 and later (Node 20+) put a narrow no-break space before AM/PM.
  return `${NEW_YORK_CLOCK.format(at).replace(/\u202f/g, " ")} ET`;
}

const utcDay = (at: number): string => new Date(at).toISOString().slice(0, 10);

export function createState(now: number, newSalt: () => string): NotifierState {
  return {
    saltDay: utcDay(now),
    salt: newSalt(),
    seen: new Map(),
    windowStart: null,
    sentInWindow: 0,
    suppressedInWindow: 0
  };
}

/**
 * Ends the hour if it is over and returns the summary owed, if any. Called on
 * every record and once a minute, so a quiet hour still gets its summary.
 */
export function closeWindowIfOver(state: NotifierState, now: number): Message[] {
  if (state.windowStart === null || now < state.windowStart + HOUR_MS) return [];
  const suppressed = state.suppressedInWindow;
  state.windowStart = null;
  state.sentInWindow = 0;
  state.suppressedInWindow = 0;
  return suppressed === 0
    ? []
    : [
        {
          title: "Demo visits",
          body: `${String(suppressed)} more visit${suppressed === 1 ? "" : "s"} in the last hour.`
        }
      ];
}

function rotateSaltIfNewDay(state: NotifierState, now: number, newSalt: () => string): void {
  const day = utcDay(now);
  if (day === state.saltDay) return;
  state.saltDay = day;
  state.salt = newSalt();
  // Keys under the old salt can never match again.
  state.seen.clear();
}

function forgetOld(state: NotifierState, now: number): void {
  for (const [key, last] of state.seen) {
    if (now - last >= DEDUPE_WINDOW_MS) state.seen.delete(key);
  }
  if (state.seen.size > MAX_REMEMBERED_CLIENTS) state.seen.clear();
}

function visitMessage(record: AccessRecord, ownHost: string): Message {
  return {
    title: "Demo visit",
    body: [
      newYorkTime(record.at),
      `Landed on ${record.path}`,
      `From ${referrerHost(record.referer, ownHost)}`,
      `${browserFamily(record.userAgent)} on ${osFamily(record.userAgent)}`
    ].join("\n")
  };
}

/** What one access-log record should send, updating the state. */
export function handleRecord(
  state: NotifierState,
  record: AccessRecord,
  options: { now: number; ownHost: string; newSalt: () => string }
): Message[] {
  const out = closeWindowIfOver(state, options.now);
  if (!isPageRequest(record) || !isCountedAgent(record.userAgent)) return out;

  rotateSaltIfNewDay(state, options.now, options.newSalt);
  forgetOld(state, options.now);
  const key = clientKey(state.salt, record.clientIp, record.userAgent);
  const last = state.seen.get(key);
  state.seen.set(key, options.now);
  if (last !== undefined && options.now - last < DEDUPE_WINDOW_MS) return out;

  if (state.windowStart === null) state.windowStart = options.now;
  if (state.sentInWindow < HOURLY_LIMIT) {
    state.sentInWindow += 1;
    out.push(visitMessage(record, options.ownHost));
    return out;
  }
  state.suppressedInWindow += 1;
  if (state.suppressedInWindow === 1) {
    out.push({
      title: "Demo visits muted",
      body: `More than ${String(HOURLY_LIMIT)} visits this hour. Muted until ${newYorkTime(state.windowStart + HOUR_MS)}; a summary follows.`
    });
  }
  return out;
}

export interface SendOptions {
  url: string;
  topic: string;
  fetch: typeof fetch;
  log: (line: string) => void;
  timeoutMs?: number;
}

/** POST one message to ntfy. Logs and drops on any failure; never throws. */
export async function sendToNtfy(message: Message, options: SendOptions): Promise<boolean> {
  const target = `${options.url.replace(/\/+$/, "")}/${encodeURIComponent(options.topic)}`;
  try {
    const response = await options.fetch(target, {
      method: "POST",
      headers: { Title: message.title, Tags: "eyes" },
      body: message.body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000)
    });
    if (!response.ok) {
      options.log(`visit-notifier: ntfy answered ${String(response.status)}; message dropped`);
      return false;
    }
    return true;
  } catch (error) {
    options.log(
      `visit-notifier: ntfy unreachable (${error instanceof Error ? error.name : "error"}); message dropped`
    );
    return false;
  }
}
