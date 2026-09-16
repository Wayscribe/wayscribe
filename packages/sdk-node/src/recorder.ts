import { randomUUID } from "node:crypto";
import {
  MAX_STRING_LENGTH,
  checkLimits,
  eventLimits,
  maskSecretsInText,
  payloadLimits,
  redact,
  toStorable,
  truncateStrings,
  type TruncationStats
} from "@flight-recorder/payload-security/redaction";
import { resolveConfig, type RecorderConfig } from "./config.js";
import { createDiagnostics, type Counters, type Diagnostics } from "./diagnostics.js";
import type { Operation } from "./operations.js";
import {
  extractHttpContext,
  fromQueueAttributes,
  injectHttpHeaders,
  toQueueAttributes,
  unwrapPayload,
  wrapPayload,
  type PropagatedContext
} from "./propagation.js";
import { BoundedQueue } from "./queue.js";
import { safely, safelyAsync } from "./safely.js";
import { deriveJourneyId, isEntity, journeyIdSecretProblem } from "./journey-id.js";
import { createTraceReader } from "./trace.js";
import { AbandonedError, Transport, UnsentError, type SendOutcome } from "./transport.js";

export interface JourneyContext {
  journeyId: string;
  entity: { type: string; id: string };
}

export interface RecordInput {
  /**
   * One of the eleven operations the server accepts.
   *
   * A union rather than `string`: anything else is refused at ingestion, and a
   * refused event leaves a timeline that is not empty but wrong.
   */
  operation: Operation;
  name: string;
  input?: unknown;
  output?: unknown;
  error?: { message: string; type?: string; code?: string };
  aliases?: Record<string, string>;
  /**
   * Alias types from `aliases` that a reader may see in full. Every other alias
   * is masked when read, and an alias is shown in full only while every event
   * that stated it listed it here (ADR-053).
   */
  displayableAliases?: readonly string[];
  metadata?: Record<string, unknown>;
  durationMs?: number;
  /**
   * When the operation began, in epoch milliseconds. Defaults to now.
   *
   * The wrappers set this to the moment the callback started, because the
   * timeline orders by timestamp and a step must not sort after the work it
   * caused.
   */
  startedAt?: number;
}

/**
 * Options for the four wrappers. `T` is what the callback returns, resolved if
 * it returns a promise, and is inferred from the callback.
 */
export interface WrapOptions<T = unknown> {
  /** Marks a result that did not throw but represents a failure, e.g. HTTP 422. */
  isFailure?: (result: T) => boolean;
  /** 1 for a first attempt. Anything higher records `retried` (ADR-022). */
  attempt?: number;
  metadata?: Record<string, unknown>;
  /**
   * What to record as the input, given the input. Runs when the wrapper is
   * called, before the callback, and what it returns is copied there and then,
   * so the record is the input as it went in even when the projection returns
   * objects the callback goes on to change. The callback still runs with
   * whatever it closes over; this changes only what is recorded.
   *
   * Synchronous. A projection that throws or returns a promise records
   * `[UNCAPTURABLE]` and a `payload_omitted` diagnostic, and never reaches your
   * code.
   */
  captureInput?: (input: unknown, journey: JourneyContext) => unknown;
  /**
   * What to record as the output, given the callback's value. The wrapper
   * still returns the value itself: a callback returning a `Buffer` can record
   * `{ bytes: buffer.length }` and hand the caller the `Buffer`. Not called
   * when the callback throws. Same failure rule as `captureInput`.
   */
  captureOutput?: (result: T, journey: JourneyContext) => unknown;
}

/**
 * What a journey and a group of journeys both do. On a group, each call
 * records one event per journey, with its own id and the same timing, and a
 * wrapper runs its callback once.
 */
export interface JourneyOperations {
  record(input: RecordInput): void;
  /**
   * Each wrapper returns whatever shape its callback returns.
   *
   * A callback returning a value returns a value; one returning a promise
   * returns a promise. Instrumenting a synchronous call therefore does not
   * change the control flow around it — which it used to, silently, turning a
   * handled error into an unhandled rejection.
   */
  transform<T>(
    name: string,
    input: unknown,
    fn: () => Promise<T>,
    options?: WrapOptions<T>
  ): Promise<T>;
  transform<T>(name: string, input: unknown, fn: () => T, options?: WrapOptions<T>): T;
  persist<T>(
    name: string,
    input: unknown,
    fn: () => Promise<T>,
    options?: WrapOptions<T>
  ): Promise<T>;
  persist<T>(name: string, input: unknown, fn: () => T, options?: WrapOptions<T>): T;
  publish<T>(
    name: string,
    message: unknown,
    fn: () => Promise<T>,
    options?: WrapOptions<T>
  ): Promise<T>;
  publish<T>(name: string, message: unknown, fn: () => T, options?: WrapOptions<T>): T;
  deliver<T>(
    name: string,
    payload: unknown,
    fn: () => Promise<T>,
    options?: WrapOptions<T>
  ): Promise<T>;
  deliver<T>(name: string, payload: unknown, fn: () => T, options?: WrapOptions<T>): T;
  fail(name: string, error: unknown, metadata?: Record<string, unknown>): void;
  finish(options?: { status?: "completed" | "failed" }): void;
}

export interface IdentifyOptions {
  /**
   * Alias types that may be shown in full to a reader. The default is none:
   * every alias is masked. List a type every time you state it, because an
   * alias is shown only while every statement of it says so (ADR-053).
   */
  displayable?: readonly string[];
}

export interface Journey extends JourneyOperations {
  context(): JourneyContext;
  identify(aliases: Record<string, string>, options?: IdentifyOptions): void;
}

/**
 * Several journeys that one operation touched, such as a digest written once
 * for many records. There is no `identify`: an alias identifies one record.
 */
export interface JourneyGroup extends JourneyOperations {
  /** The journeys this group records on, each once, in the order given. */
  journeys(): JourneyContext[];
}

export interface Recorder {
  startJourney(options: {
    entity: { type: string; id: string };
    aliases?: Record<string, string>;
    /** Passed to the `identify` that `aliases` makes. */
    displayable?: readonly string[];
  }): Journey;
  continueJourney(context: JourneyContext): Journey;
  /**
   * The journey id for an entity, the same on every run and every machine,
   * derived under `journeyIdSecret` so that it cannot be guessed from the
   * entity (ADR-052). The environment is part of the derivation.
   *
   * Never throws. Without a usable secret it reports a `configuration_error`
   * and returns a fresh random id, so recording goes on and nothing guessable
   * is ever produced.
   */
  journeyIdFor(entity: { type: string; id: string }): string;
  /**
   * The journeys one operation touched, to record it on each of them in one
   * call. A journey named twice, by handle or by context, is recorded once.
   */
  across(journeys: Iterable<Journey | JourneyContext>): JourneyGroup;
  consume(options: {
    context?: PropagatedContext | undefined;
    entityFallback?: { type: string; id: string };
  }): Journey;
  injectHttpHeaders(
    headers: Record<string, string>,
    context: PropagatedContext
  ): Record<string, string>;
  extractHttpContext(
    headers: Record<string, string | string[] | undefined> | undefined
  ): PropagatedContext | undefined;
  toQueueAttributes(
    context: PropagatedContext
  ): Record<string, { DataType: string; StringValue: string }>;
  fromQueueAttributes(attributes: unknown): PropagatedContext | undefined;
  wrapPayload(payload: unknown, context: PropagatedContext): { _flight: unknown; data: unknown };
  unwrapPayload(body: unknown): { context?: PropagatedContext; data: unknown };
  flush(): Promise<void>;
  shutdown(options?: { timeoutMs?: number }): Promise<Counters>;
  diagnostics(): Counters;
}

const TOO_LARGE = "[PAYLOAD_TOO_LARGE]";
const UNCAPTURABLE = "[UNCAPTURABLE]";

type PayloadField = "input" | "output" | "metadata";
const PAYLOAD_FIELDS: readonly PayloadField[] = ["input", "output", "metadata"];

/** A captured payload, and how many of its strings were cut, if any were. */
interface Captured {
  value: unknown;
  truncated?: TruncationStats;
}

/**
 * The protocol's limits on `error.message` and `error.stack`
 * (`packages/protocol` `errorSchema`). The server refuses anything longer, so
 * text beyond them is never worth masking or sending.
 */
export const MAX_ERROR_MESSAGE_LENGTH = 4096;
export const MAX_ERROR_STACK_LENGTH = 16_384;

const TRUNCATED = "[TRUNCATED]";

/**
 * `text` masked and cut to `limit` characters, ending in `[TRUNCATED]` when it
 * was cut.
 *
 * Masking runs over twice the limit before the final cut, not over exactly the
 * limit. Cutting first can split a credential so the masker no longer
 * recognises it, as `postgres://app:hunt` without its `@` shows. With the wider
 * window, a credential that reaches the kept part was seen whole unless it is
 * itself longer than the limit.
 *
 * The cut text is then masked again, and cut again if that changed it, until
 * masking leaves it alone. A cut can change how what remains reads:
 * `cookie: session expired` is a sentence, and `cookie: session[TRUNCATED]` is
 * not. Sending that would let the server's pass rewrite a message the SDK had
 * already masked. Text that has not settled after a few rounds, which no known
 * input reaches, is sent as the marker alone rather than as something the
 * server would change.
 */
export function boundedMaskedText(text: string, limit: number): string {
  const window = text.length <= limit ? text : text.slice(0, 2 * limit);
  let bounded = fit(maskSecretsInText(window), limit);
  for (let round = 0; round < SETTLING_ROUNDS; round += 1) {
    const remasked = maskSecretsInText(bounded);
    if (remasked === bounded) return bounded;
    bounded = fit(remasked, limit);
  }
  return TRUNCATED;
}

const SETTLING_ROUNDS = 4;

/**
 * `text` if it fits, or cut to `limit` including the marker. Either way a
 * surrogate pair split by a cut, here or at the window's edge, is repaired.
 */
function fit(text: string, limit: number): string {
  if (text.length <= limit) return text.toWellFormed();
  return text.slice(0, limit - TRUNCATED.length).toWellFormed() + TRUNCATED;
}

/**
 * `displayableAliases` for the event, copied at the call, with anything that is
 * not a string left out. A value that is not a list is dropped whole: a wrong
 * list can only mask, and a refused event would lose the aliases too.
 */
function displayableFor(list: unknown): { displayableAliases?: string[] } {
  if (!Array.isArray(list)) return {};
  return {
    displayableAliases: (list as unknown[]).filter(
      (type): type is string => typeof type === "string"
    )
  };
}

function isContext(value: unknown): value is JourneyContext {
  if (typeof value !== "object" || value === null) return false;
  const { journeyId, entity } = value as Partial<JourneyContext>;
  return (
    typeof journeyId === "string" &&
    typeof entity === "object" &&
    typeof entity.type === "string" &&
    typeof entity.id === "string"
  );
}

/** Duck-typed rather than `instanceof Promise`: a thenable from any library counts. */
function isThenable<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

interface BatchOutcome {
  status: "accepted" | "rejected";
  eventId?: string | null;
  error?: {
    code?: string;
    message?: string;
    httpStatus?: number;
    details?: { path: string; message: string }[];
  };
}

/**
 * What the server stored, reporting each permanent refusal on the way.
 *
 * Results are matched to events by position, which is how the batch route
 * builds them: one result per event, in order.
 *
 * A refusal with a per-event status below 500 is permanent: the event was
 * understood and refused, so it is counted separately from a transport failure
 * and never retried. The server's own message is passed through verbatim,
 * because it is far more specific than anything this side could reconstruct:
 * "event.entity.id: expected string, received number" ends the investigation
 * that "invalid_event" begins.
 *
 * A refusal at 500 or above (`storage_error`, `query_timeout`) is the server
 * failing, not the event, so the event goes back to the transport to be
 * retried, for up to 30 seconds from its first refusal or 10 sends, whichever
 * comes first. Treating those as permanent lost an event to a database hiccup and
 * reported it as a rejection, which tells an operator to fix an event that was
 * never wrong. A refusal with no status is treated as permanent, as before the
 * status was sent.
 *
 * An event the response gives no verdict for (a body that is not JSON, JSON
 * with no results, or fewer results than events) is counted as `dropped` with
 * reason `no_verdict`, and not retried. The request returned 2xx, so the
 * server may well have stored it, and resending on a proxy's rewritten body
 * would store it twice; the SDK cannot tell, so it says what it knows. Before
 * this, a body that was not JSON retried the whole batch and printed the
 * parser's message, which quotes the body, and a short or missing results
 * array lost events without a word. An entry that is not an object with a
 * status of `accepted` or `rejected` (null, a string, a number, an unknown
 * status) is a missing verdict too: reading it as one threw, and the whole
 * batch was retried, resending events the server had accepted. Verdicts past
 * the end of the batch are ignored rather than counted.
 */
function readOutcome(
  body: ParsedBody,
  batch: readonly unknown[],
  diagnostics: Diagnostics
): SendOutcome {
  const results = body.parsed
    ? (body.value as { data?: { results?: BatchOutcome[] } } | null)?.data?.results
    : undefined;
  const verdicts: unknown[] = Array.isArray(results) ? results.slice(0, batch.length) : [];
  const noVerdict = (why: string): void => {
    diagnostics.report({
      kind: "dropped",
      reason: `no_verdict: ${why}; the server may have stored this event, so it is not sent again`
    });
  };
  if (verdicts.length < batch.length) {
    const why = !body.parsed
      ? "unparseable response body"
      : Array.isArray(results)
        ? "the response had fewer results than events"
        : "the response had no results";
    for (let index = verdicts.length; index < batch.length; index += 1) noVerdict(why);
  }

  let accepted = 0;
  const retry: unknown[] = [];
  let reason: string | undefined;
  let logReason: string | undefined;
  verdicts.forEach((entry, index) => {
    if (!isVerdict(entry)) {
      noVerdict("the response's result for it was not a verdict");
      return;
    }
    const result = entry;
    if (result.status === "accepted") {
      accepted += 1;
      return;
    }

    const where = result.error?.details?.[0];
    const detail = where === undefined ? "" : ` (${where.path}: ${where.message})`;
    const described = `${result.error?.code ?? "rejected"}: ${result.error?.message ?? "The server refused this event."}${detail}`;
    const logLine = refusalLogLine(result.error?.code, where?.path);
    const event = batch[index];
    if ((result.error?.httpStatus ?? 0) >= 500 && event !== undefined) {
      retry.push(event);
      reason = described;
      logReason = logLine;
      return;
    }

    diagnostics.report({ kind: "rejected", reason: described, detail: result.error }, logLine);
  });
  return {
    accepted,
    retry,
    ...(reason === undefined ? {} : { reason }),
    ...(logReason === undefined ? {} : { logReason })
  };
}

/** An object whose status is one the batch route sends. */
function isVerdict(entry: unknown): entry is BatchOutcome {
  if (typeof entry !== "object" || entry === null) return false;
  const { status } = entry as { status?: unknown };
  return status === "accepted" || status === "rejected";
}

/** A response body, parsed if it was JSON. Its text is never kept. */
type ParsedBody = { parsed: true; value: unknown } | { parsed: false };

async function parseBody(response: Response): Promise<ParsedBody> {
  const text = await response.text();
  try {
    return { parsed: true, value: JSON.parse(text) as unknown };
  } catch {
    // The parser's message quotes the body, which can be anything a proxy put
    // there, so neither is kept.
    return { parsed: false };
  }
}

const ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const FIELD_PATH = /^[A-Za-z0-9_.$[\]-]{1,256}$/;

/**
 * A refusal as the console prints it: the server's error code and the path of
 * the first field it names, and never its message.
 *
 * Flight Recorder's API puts no event values in its messages, but the SDK
 * cannot know it is talking to that API rather than a proxy or another
 * server that echoes what it was sent, and a console line usually ends up in a
 * log store the operator does not control. The code and path say where to
 * look; `onDiagnostic` still receives the whole message. Anything that does
 * not look like a code or a path is left out rather than trusted.
 */
function refusalLogLine(code: string | undefined, path: string | undefined): string {
  const printedCode = code !== undefined && ERROR_CODE.test(code) ? code : "rejected";
  const printedPath = path !== undefined && FIELD_PATH.test(path) ? ` at ${path}` : "";
  return `${printedCode}${printedPath} (the server's message goes to onDiagnostic)`;
}

/**
 * Hosts an `http:` endpoint may name without a warning: this machine, or a
 * single-label name such as `api`.
 *
 * A name with no dot resolves only through container or cluster DNS, so the
 * traffic stays on the private network Compose or Kubernetes built for it,
 * which is how the demo and a sidecar-style install reach the API. IP literals
 * never count as single-label: an IPv4 address has dots, the URL parser turns
 * a bare number into one, and an IPv6 address is bracketed.
 */
function isLocalOrInternal(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") return true;
  if (hostname.endsWith(".localhost")) return true;
  return !hostname.includes(".") && !hostname.startsWith("[");
}

/**
 * Warns when the API key and payloads would cross a network in cleartext.
 *
 * Only the scheme and hostname are reported: the URL's userinfo, path, and
 * query can all carry secrets. An endpoint that is not a URL is left alone;
 * every send to it fails, and that is reported as it happens.
 */
function warnIfInsecure(endpoint: string, diagnostics: Diagnostics): void {
  if (!URL.canParse(endpoint)) return;
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || isLocalOrInternal(url.hostname)) return;
  diagnostics.report({
    kind: "insecure_endpoint",
    scheme: "http:",
    host: url.hostname,
    reason: `The endpoint is http: to ${url.hostname}, so the API key and payloads travel unencrypted. Use https: for any endpoint off this machine.`
  });
}

/**
 * The endpoint as scheme, host, and port only.
 *
 * Its path and query can carry a credential the masker does not recognise by
 * shape, and userinfo is a credential by definition, so none of them is
 * reported. The port stays: a wrong port is one of the things `delivered_first`
 * exists to rule out.
 */
function originOf(endpoint: string): string {
  return URL.canParse(endpoint) ? new URL(endpoint).origin : "the configured endpoint";
}

const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi;

/**
 * A fetch failure whose message names every URL in it by origin only.
 *
 * Node's fetch quotes the whole request URL in some messages, such as the one
 * refusing a URL with credentials, and the message becomes the
 * `transport_error` reason that is printed and passed to `onDiagnostic`. The
 * endpoint's path, query, and userinfo can carry credentials, so they are cut
 * as `delivered_first` cuts them. The original error, and its `cause`, which
 * can hold the URL too, are not kept.
 */
function withOriginsOnly(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const reduced = message.replace(URL_IN_TEXT, (url) =>
    URL.canParse(url) ? new URL(url).origin : "[URL]"
  );
  const replacement = new Error(reduced);
  if (error instanceof Error) replacement.name = error.name;
  return replacement;
}

/** How long shutdown waits for aborted sends to hand their events back. */
const ABANDON_WAIT_MS = 250;

/**
 * Resolves when `promise` settles or `ms` pass, whichever is first.
 *
 * The timer is cleared as soon as the race is decided and never holds the
 * process open: a shutdown that resolved must not keep the host alive for the
 * rest of its timeout.
 */
async function raceTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref();
  });
  try {
    await Promise.race([promise.then(() => undefined), expired]);
  } finally {
    clearTimeout(timer);
  }
}

export function createRecorder(config: RecorderConfig): Recorder {
  const resolved = resolveConfig(config);
  const diagnostics = createDiagnostics(resolved.onDiagnostic, { log: resolved.logDiagnostics });
  safely(diagnostics, "capture_error", () => {
    warnIfInsecure(resolved.endpoint, diagnostics);
  });
  // A secret that was configured and cannot be used is reported now, once, so
  // it surfaces at startup rather than at the first derived id. A missing one
  // is not: most recorders never derive an id.
  const secretProblem = journeyIdSecretProblem(resolved.journeyIdSecret);
  if (resolved.journeyIdSecret !== undefined && secretProblem !== undefined) {
    diagnostics.report({ kind: "configuration_error", reason: secretProblem });
  }
  const queue = new BoundedQueue<unknown>(resolved.maxBufferedEvents, diagnostics);
  // Resolved once: record() is synchronous, so this cannot be an async import.
  const readTrace = createTraceReader();
  let stopped = false;
  let delivered = false;
  /**
   * Set when shutdown's timeout or its drain has ended and anything not yet
   * delivered is given up on. From then on no request starts, the ones in
   * flight are aborted, and their events are handed back to be counted.
   */
  let abandoned = false;
  const requests = new Set<AbortController>();
  const sleepers = new Set<() => void>();
  /** Events handed back by sends abandoned at shutdown, to be counted there. */
  const abandonedEvents: unknown[] = [];

  const transport = new Transport(
    {
      send: async (batch) => {
        if (abandoned) throw new Error("The recorder has shut down.");
        const controller = new AbortController();
        requests.add(controller);
        const timer = setTimeout(() => {
          controller.abort();
        }, resolved.requestTimeoutMs);
        try {
          const response = await fetch(`${resolved.endpoint}/v1/events/batch`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${resolved.apiKey}`,
              "content-type": "application/json"
            },
            body: JSON.stringify({ events: batch }),
            signal: controller.signal
          }).catch((error: unknown) => {
            throw withOriginsOnly(error);
          });
          if (!response.ok) {
            // A 4xx is permanent: the server understood the request and
            // refused it. Retrying burns three attempts, drives the breaker
            // open, and requeues the batch to the FRONT — so one malformed
            // batch used to block every event behind it for the life of the
            // process. Marked so the transport can tell the two apart.
            const error = new Error(`Ingestion responded ${String(response.status)}.`);
            if (response.status >= 400 && response.status < 500) {
              (error as { permanent?: boolean }).permanent = true;
            }
            throw error;
          }

          // The batch route replies 202 with a per-event verdict, so a request
          // that "succeeded" may have stored nothing. Reading the body is the
          // only way to know, and not reading it is how a misconfigured
          // environment name looked exactly like a healthy recorder.
          const outcome = readOutcome(await parseBody(response), batch, diagnostics);
          const { accepted } = outcome;
          if (accepted > 0 && !delivered) {
            // Once: this answers "is it connected?", and repeating the answer
            // on every batch would be exactly the noise logDiagnostics avoids.
            delivered = true;
            const endpoint = originOf(resolved.endpoint);
            diagnostics.report({
              kind: "delivered_first",
              reason: `Connected to ${endpoint}; the server accepted ${String(accepted)} ${accepted === 1 ? "event" : "events"}.`,
              endpoint,
              accepted
            });
          }
          return outcome;
        } finally {
          clearTimeout(timer);
          requests.delete(controller);
        }
      },
      isAbandoned: () => abandoned,
      // Cut short when shutdown gives up, so a send waiting out its backoff
      // hands its events back at once instead of holding shutdown open.
      sleep: (ms) =>
        new Promise<void>((resolve) => {
          const wake = (): void => {
            clearTimeout(timer);
            sleepers.delete(wake);
            resolve();
          };
          const timer = setTimeout(wake, ms);
          sleepers.add(wake);
        }),
      maxAttempts: 3,
      baseBackoffMs: 100,
      maxBackoffMs: 2_000,
      breakerThreshold: 5,
      breakerCooldownMs: 30_000,
      // Measured from an event's first refusal, and checked only when the
      // server refuses it again, so an event waiting out an open breaker is
      // sent once more when it closes rather than dropped unsent. The same as
      // the breaker's cooldown, and twice the API's default statement timeout
      // of 15 seconds, the other thing a refusal for now waits on.
      retryBudgetMs: 30_000,
      maxRefusedSends: 10
    },
    diagnostics
  );

  /**
   * Capture is synchronous: the application may mutate the object after this
   * returns, and recording values the step never saw would make the diff lie.
   *
   * The size guard bounds the cost, because a server-side limit does not help a
   * host process that has already spent the CPU walking the payload.
   *
   * Returns what to send and, when strings were cut, how many. The cut is not
   * reported here: the payload may still be omitted once the whole event is
   * measured, and then nothing cut reached the server.
   */
  function capture(value: unknown, field: PayloadField): Captured | undefined {
    if (value === undefined) return undefined;
    if (resolved.captureMode === "metadata-only") return undefined;

    // Walking a payload runs the application's own code: `checkLimits` calls
    // Object.values, which invokes every own enumerable getter. A getter that
    // throws — `get total() { return this.lines.reduce(...) }` on an object
    // whose `lines` is undefined — used to escape from inside the event literal,
    // before queue.push, taking the whole event with it. The counters read
    // `dropped: 0` while OPERATIONS.md tells the operator that a non-zero
    // `dropped` is what means events were shed.
    //
    // Degrading to a marker keeps the event, and an event that says its payload
    // was uncapturable is far more useful than no event at all — especially
    // since the step being recorded is often the one that failed.
    try {
      // The server's own limits, as they fall on a payload two levels below the
      // envelope, with long strings measured as they will be cut (ADR-051). The
      // string limit used to be scaled with maxPayloadBytes, which the server
      // never did, so a 70 KB string passed here and cost the whole event there.
      const limits = checkLimits(value, payloadLimits(resolved.maxPayloadBytes));
      if (!limits.ok) {
        // Discarding a payload silently made a full timeline look like a step
        // that genuinely carried nothing.
        reportOmitted(field, limits.reason, `A payload was not captured: ${limits.reason}.`);
        return { value: TOO_LARGE };
      }

      // Sanitized, then cut. Cutting a masked string cannot reveal anything the
      // mask hid, and every string that leaves this process is one PostgreSQL
      // will accept and the server's string limit allows.
      const stats: TruncationStats = { strings: 0, charactersRemoved: 0 };
      const stored = truncateStrings(
        toStorable(redact(value, resolved.redact)),
        MAX_STRING_LENGTH,
        stats
      );
      return stats.strings === 0 ? { value: stored } : { value: stored, truncated: stats };
    } catch {
      return { value: UNCAPTURABLE };
    }
  }

  function reportOmitted(field: PayloadField, reason: string, message: string): void {
    diagnostics.report({
      kind: "payload_omitted",
      reason: message,
      detail: { field, reason }
    });
  }

  /** Captured metadata, or nothing at all when it cannot be represented. */
  function metadataFor(metadata: Record<string, unknown> | undefined): Captured | undefined {
    if (metadata === undefined) return undefined;
    const captured = capture(metadata, "metadata");
    if (typeof captured?.value !== "object" || captured.value === null) return undefined;
    return captured;
  }

  /**
   * Makes the event fit the budget the server measures it against, by the same
   * check the server runs (ADR-051).
   *
   * Every payload has already passed the per-payload limits, so an envelope
   * that fails here fails on bytes: the payloads share one budget. The larger
   * of `input` and `output` is omitted first, then the other, then `metadata`,
   * which is dropped rather than replaced because the protocol types it as a
   * record. An envelope that still fails, or fails on something no payload
   * caused, is sent as it is and the server's refusal is counted. The event is
   * never withheld.
   */
  function fitToBudget(envelope: { event: Record<string, unknown> }): void {
    const { event } = envelope;
    const limits = eventLimits(resolved.maxPayloadBytes);
    for (;;) {
      const result = checkLimits(envelope, limits);
      if (result.ok || result.reason !== "payload_too_large") return;
      const field = nextToOmit(event);
      if (field === undefined) return;
      if (field === "metadata") delete event["metadata"];
      else event[field] = TOO_LARGE;
      reportOmitted(
        field,
        "payload_too_large",
        `The event exceeded maxPayloadBytes, so its ${field} was not captured.`
      );
    }
  }

  function nextToOmit(event: Record<string, unknown>): PayloadField | undefined {
    const size = (field: "input" | "output"): number => {
      const value = event[field];
      if (value === undefined || value === TOO_LARGE || value === UNCAPTURABLE) return 0;
      return Buffer.byteLength(JSON.stringify(value), "utf8");
    };
    const input = size("input");
    const output = size("output");
    if (input > 0 || output > 0) return input >= output ? "input" : "output";
    return event["metadata"] === undefined ? undefined : "metadata";
  }

  /** One `payload_truncated` per payload that reached the event with a string cut. */
  function reportTruncations(
    event: Record<string, unknown>,
    captured: Record<PayloadField, Captured | undefined>
  ): void {
    for (const field of PAYLOAD_FIELDS) {
      const one = captured[field];
      // Omitted after all: nothing cut is being sent.
      if (one?.truncated === undefined || event[field] !== one.value) continue;
      const { strings } = one.truncated;
      diagnostics.report({
        kind: "payload_truncated",
        reason: `${String(strings)} ${strings === 1 ? "string" : "strings"} in the ${field} were cut to ${MAX_STRING_LENGTH.toLocaleString("en-US")} characters.`,
        detail: { field, ...one.truncated }
      });
    }
  }

  /**
   * An error record with credential-shaped text masked (ADR-046).
   *
   * Here rather than in `toErrorRecord`, because every error record reaches
   * the queue through this point and not every one comes from there:
   * `record()` takes one straight from the application. The protocol's `stack`
   * is masked too when a JavaScript caller passes one the type does not admit.
   * The server masks again before storing, which changes nothing: masking is
   * idempotent.
   *
   * Both fields are bounded to what the protocol accepts, so a megabyte of
   * message costs the host no more than four kilobytes of one.
   */
  function maskedError(error: NonNullable<RecordInput["error"]>): RecordInput["error"] {
    const { message } = error;
    const stack = (error as { stack?: unknown }).stack;
    return {
      ...error,
      ...(typeof message === "string"
        ? { message: boundedMaskedText(message, MAX_ERROR_MESSAGE_LENGTH) }
        : {}),
      ...(typeof stack === "string"
        ? { stack: boundedMaskedText(stack, MAX_ERROR_STACK_LENGTH) }
        : {})
    };
  }

  function enqueue(
    journeyId: string,
    entity: JourneyContext["entity"],
    input: RecordInput,
    /**
     * The input, already captured at the call, for a wrapper whose
     * `captureInput` projection may share objects its callback goes on to
     * change. When given, `input.input` is not captured again.
     */
    capturedInput?: { value: Captured | undefined }
  ): void {
    if (stopped) {
      // Silent until now: after shutdown the wrappers still ran the callback
      // and returned the right value, the server received nothing, and the
      // counters kept reporting a clean bill of health. Reachable by ordinary
      // reading, because `flush()` appears in no user-facing documentation and
      // the example calls shutdown "flush".
      diagnostics.report({
        kind: "dropped",
        reason: "The recorder was shut down; this event was not recorded.",
        detail: { name: input.name, operation: input.operation }
      });
      return;
    }

    const captured = {
      input: capturedInput === undefined ? capture(input.input, "input") : capturedInput.value,
      output: capture(input.output, "output"),
      // Through capture like input and output: metadata used to go in raw,
      // so a Prisma BigInt or a circular request object threw inside
      // JSON.stringify at flush time and took the whole batch with it.
      //
      // Omitted rather than replaced when capture cannot represent it. The
      // protocol types metadata as a record, so substituting a marker string
      // makes the whole event fail validation — trading a lost payload for a
      // lost event, which is the worse half of the trade.
      metadata: metadataFor(input.metadata)
    };

    const event: Record<string, unknown> = {
      id: `evt_${randomUUID()}`,
      journeyId,
      environment: resolved.environment,
      service: resolved.serviceName,
      entity,
      operation: input.operation,
      name: input.name,
      timestamp: new Date(input.startedAt ?? Date.now()).toISOString(),
      ...(readTrace() ?? {}),
      ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
      ...(captured.input === undefined ? {} : { input: captured.input.value }),
      ...(captured.output === undefined ? {} : { output: captured.output.value }),
      ...(input.error === undefined ? {} : { error: maskedError(input.error) }),
      ...(input.aliases === undefined ? {} : { aliases: input.aliases }),
      ...displayableFor(input.displayableAliases),
      ...(captured.metadata === undefined ? {} : { metadata: captured.metadata.value })
    };
    const envelope = { protocolVersion: "0.1", event };

    fitToBudget(envelope);
    reportTruncations(event, captured);
    queue.push(envelope);

    // Capped, because N events recorded in one turn of the event loop used to
    // start floor(N / batchSize) simultaneous requests: 1,000 records opened
    // 200 concurrent sockets, sent 12,000 events for the 4,000 produced, and
    // reported dropped: 3000 while the database held every one of them.
    //
    // Skipping a flush is safe: the queue is bounded and drops oldest if it
    // fills, the interval timer drains what is left, and shutdown drains the
    // rest.
    if (queue.size() >= resolved.batchSize) maybeFlush();
  }

  /**
   * Flushes started in the background, so `flush()` and `shutdown()` can wait
   * for them.
   *
   * Without this set, `enqueue`'s fire-and-forget flush was unobservable:
   * `shutdown()` drained an already-empty queue, returned immediately, and read
   * the counters before the in-flight send had recorded anything. A run of
   * exactly `batchSize` events reported `sent: 0` while the server held all of
   * them, and `process.exit(0)` straight after `shutdown()` abandoned the batch
   * for real.
   */
  const inFlight = new Set<Promise<void>>();

  function track(promise: Promise<void>): void {
    inFlight.add(promise);
    void promise.finally(() => inFlight.delete(promise));
  }

  /** Waits for every background flush, including ones started by those flushes. */
  async function settle(): Promise<void> {
    while (inFlight.size > 0) {
      await Promise.allSettled([...inFlight]);
    }
  }

  async function flush(): Promise<void> {
    const batch = queue.drain(resolved.batchSize);
    if (batch.length === 0) return;
    try {
      await transport.send(batch);
    } catch (error) {
      const unsent = error instanceof UnsentError ? error.unsent : batch;
      if (abandoned || error instanceof AbandonedError) {
        abandonedEvents.push(...unsent);
        return;
      }
      // Ordering matters: a retried batch must not reorder the timeline. Only
      // what is still unsent goes back; events stored on an earlier attempt
      // would otherwise be sent, and counted, twice.
      queue.requeue(unsent);
    }
  }

  /**
   * Drains everything currently queued, not just one batch.
   *
   * Stops as soon as a pass makes no progress. A failed send requeues its
   * batch, so looping on `size > 0` alone spins forever against an endpoint
   * that is refusing connections — which is precisely the situation where the
   * SDK must not hold the host process.
   */
  async function drainAll(): Promise<void> {
    // Background flushes finish first, so this does not add a request on top of
    // the ones already in flight and push past the concurrency cap.
    await settle();

    let previous = Number.POSITIVE_INFINITY;
    while (!abandoned && queue.size() > 0 && queue.size() < previous) {
      // Counted against the cap like any other send. Untracked, a burst
      // recorded while this pass was in flight started a full set of sends
      // beside it; and a full set started since must finish one first.
      while (inFlight.size >= resolved.maxConcurrentSends) {
        await Promise.race([...inFlight]);
      }
      previous = queue.size();
      const pass = flush();
      track(pass);
      await pass;
    }
    await settle();
  }

  // debtwatch:start
  // id: DEBT-WGN0N4
  // owner: flight-recorder
  // expires: 2027-03-01
  // reason: A fixed cap cannot fit both one process in front of a scaled-out API and a fleet sharing one pool; adaptive concurrency, lowering the cap on timeouts and 5xx and raising it while sends succeed, is the long-term fix
  // tags: sdk, performance
  // debtwatch:end
  /**
   * Starts a background flush unless the cap is already reached.
   *
   * The cap is `maxConcurrentSends` (config.ts says why the default is four).
   */
  function maybeFlush(): void {
    if (inFlight.size < resolved.maxConcurrentSends) track(flush());
  }

  // The interval goes through the same cap. Without that it could add one more
  // request on top of a full set already in flight, which is exactly what the
  // burst test caught.
  const interval = setInterval(maybeFlush, resolved.flushIntervalMs);
  // Never hold the host's event loop open on our account.
  interval.unref();

  /**
   * Counts every event shutdown could not deliver, once, as `dropped`.
   *
   * These used to vanish: events the server was still refusing for now when
   * the drain stopped making progress, the queue left behind by an unreachable
   * endpoint, and a batch still in flight when the timeout won. Sent, rejected,
   * and dropped now add up to what was recorded.
   *
   * In-flight requests are aborted and backoffs cut short, so their sends hand
   * their events back within a few milliseconds. The wait for that is bounded
   * anyway, so shutdown still returns if a request ignored its abort; its
   * events would then go uncounted, which no test has managed to cause.
   */
  async function abandonRemaining(drain: Promise<unknown>): Promise<void> {
    abandoned = true;
    for (const controller of requests) controller.abort();
    for (const wake of [...sleepers]) wake();
    await raceTimeout(Promise.allSettled([drain, settle()]), ABANDON_WAIT_MS);

    const lost = [...queue.drain(queue.size()), ...abandonedEvents.splice(0)];
    for (const _event of lost) {
      diagnostics.report({
        kind: "dropped",
        reason: "shutdown: the recorder shut down before this event was delivered"
      });
    }
  }

  function toErrorRecord(error: unknown): { message: string; type?: string; code?: string } {
    if (error instanceof Error) {
      const code = (error as { code?: unknown }).code;
      return {
        message: error.message,
        type: error.name,
        ...(typeof code === "string" ? { code } : {})
      };
    }
    return { message: String(error) };
  }

  /**
   * One implementation behind all the public wrappers, so the contract cannot
   * drift between them.
   *
   * Returns the callback's value unchanged and rethrows its exact error object.
   * Everything the recorder does sits inside `safely`, so a recording failure
   * cannot reach the caller.
   */
  /**
   * One implementation behind all the public wrappers.
   *
   * **Synchronous in, synchronous out.** The wrappers used to be `async`
   * unconditionally, which meant instrumenting a synchronous call inside a
   * synchronous handler silently changed its control flow: adding
   * `journey.transform("parse-body", raw, () => JSON.parse(raw))` to a handler
   * that correctly returned 400 on malformed input turned it into a 200 with an
   * empty body and an unhandled rejection, from one bad request. The README's
   * three promises — returns the value unchanged, rethrows the exact error,
   * cannot break the application — were all false for a sync callback.
   *
   * So the shape of the return follows the shape of the callback: a callback
   * that returns a value returns a value, and one that returns a promise
   * returns a promise. A synchronous throw still propagates synchronously,
   * which is what the caller's try/catch is waiting for.
   */
  function wrap<T>(
    contexts: readonly JourneyContext[],
    naturalOperation: Operation,
    name: string,
    input: unknown,
    fn: () => T | Promise<T>,
    options: WrapOptions<T> = {}
  ): T | Promise<T> {
    const startedAt = Date.now();
    const attempt = options.attempt ?? 1;
    // ADR-022: a retry records as `retried` rather than the natural verb.
    const operation = attempt > 1 ? "retried" : naturalOperation;
    const metadata =
      options.metadata === undefined && attempt === 1
        ? undefined
        : { ...options.metadata, attempt };

    // Projected and captured now, before the callback can change what it was
    // given. Capturing copies: a projection usually returns parts of the input
    // rather than a copy of them, and the callback may change those parts.
    const projection = options.captureInput;
    const capturedInputs =
      projection === undefined
        ? undefined
        : contexts.map((context) => ({
            value: safely(diagnostics, "capture_error", () =>
              capture(project(projection, input, context, "input"), "input")
            )
          }));

    const recordAll = (outcome: (context: JourneyContext) => Partial<RecordInput>): void => {
      const durationMs = Date.now() - startedAt;
      contexts.forEach((context, index) => {
        safely(diagnostics, "capture_error", () => {
          enqueue(
            context.journeyId,
            context.entity,
            {
              operation,
              name,
              input,
              startedAt,
              durationMs,
              ...outcome(context),
              ...(metadata === undefined ? {} : { metadata })
            },
            capturedInputs?.[index]
          );
        });
      });
    };

    const recordFailure = (error: unknown): void => {
      safely(diagnostics, "capture_error", () => {
        const record = toErrorRecord(error);
        recordAll(() => ({ error: record }));
      });
    };

    const recordSuccess = (result: T): void => {
      safely(diagnostics, "capture_error", () => {
        const failed = options.isFailure === undefined ? false : options.isFailure(result);
        recordAll((context) => ({
          output:
            options.captureOutput === undefined
              ? result
              : project(options.captureOutput, result, context, "output"),
          ...(failed
            ? { error: { message: `${name} reported a failed result.`, code: "result_failed" } }
            : {})
        }));
      });
    };

    let produced: T | Promise<T>;
    try {
      produced = fn();
    } catch (error) {
      recordFailure(error);
      // The original object, not a copy: application code branches on
      // instanceof and on custom properties.
      throw error;
    }

    if (!isThenable(produced)) {
      recordSuccess(produced);
      return produced;
    }

    return produced.then(
      (result) => {
        recordSuccess(result);
        return result;
      },
      (error: unknown) => {
        recordFailure(error);
        throw error;
      }
    );
  }

  /**
   * A host's projection, run so that nothing it does can reach the host.
   *
   * A throw, or a returned promise, records `[UNCAPTURABLE]` and one
   * `payload_omitted`. A returned promise is given a handler, so its rejection
   * cannot surface as an unhandled rejection. The projection's own error goes to
   * `onDiagnostic` in `detail` and never into the reason, which is what
   * `logDiagnostics` prints: its message can quote the payload.
   */
  function project<V>(
    projection: (value: V, journey: JourneyContext) => unknown,
    value: V,
    context: JourneyContext,
    field: "input" | "output"
  ): unknown {
    const option = field === "input" ? "captureInput" : "captureOutput";
    const failed = (reason: string, error?: unknown): string => {
      diagnostics.report({
        kind: "payload_omitted",
        reason,
        detail: { field, reason: "projection_failed", ...(error === undefined ? {} : { error }) }
      });
      return UNCAPTURABLE;
    };
    try {
      const projected = projection(value, context);
      // Inside the try as well: reading `then` runs the value's own getter.
      if (!isThenable(projected)) return projected;
      projected.then(
        () => undefined,
        () => undefined
      );
      return failed(
        `The ${option} projection returned a promise; projections must be synchronous, so the ${field} was not captured.`
      );
    } catch (error) {
      return failed(`The ${option} projection threw, so the ${field} was not captured.`, error);
    }
  }

  /**
   * `input` on every journey in `contexts`, with one timestamp for all of them.
   * Each event goes through its own boundary, so one that cannot be recorded
   * does not cost the others.
   */
  function recordOn(contexts: readonly JourneyContext[], input: RecordInput): void {
    const startedAt = input.startedAt ?? Date.now();
    for (const context of contexts) {
      safely(diagnostics, "capture_error", () => {
        enqueue(context.journeyId, context.entity, { ...input, startedAt });
      });
    }
  }

  function operationsOn(contexts: readonly JourneyContext[]): JourneyOperations {
    return {
      record(input) {
        safely(diagnostics, "capture_error", () => {
          recordOn(contexts, input);
        });
      },
      transform: (name, input, fn, options) =>
        wrap(contexts, "transformed", name, input, fn, options),
      persist: (name, input, fn, options) => wrap(contexts, "persisted", name, input, fn, options),
      publish: (name, message, fn, options) =>
        wrap(contexts, "published", name, message, fn, options),
      deliver: (name, payload, fn, options) =>
        wrap(contexts, "delivered", name, payload, fn, options),
      fail(name, error, metadata) {
        safely(diagnostics, "capture_error", () => {
          recordOn(contexts, {
            operation: "failed",
            name,
            error: toErrorRecord(error),
            ...(metadata === undefined ? {} : { metadata })
          });
        });
      },
      finish(options) {
        safely(diagnostics, "capture_error", () => {
          recordOn(contexts, {
            operation: options?.status === "failed" ? "failed" : "completed",
            name: "finish"
          });
        });
      }
    };
  }

  function makeJourney(context: JourneyContext): Journey {
    return {
      ...operationsOn([context]),
      context: () => context,
      identify(aliases, options) {
        safely(diagnostics, "capture_error", () => {
          enqueue(context.journeyId, context.entity, {
            operation: "identified",
            name: "identify",
            // Top-level, not under metadata: EVENT_PROTOCOL puts aliases on the
            // event itself, and ingestion reads them from there. Nested, they
            // are accepted and then ignored, costing every alias-based search.
            aliases,
            ...(options?.displayable === undefined
              ? {}
              : { displayableAliases: options.displayable })
          });
        });
      }
    };
  }

  /**
   * The distinct journeys in `journeys`, by id, in the order given.
   *
   * Something that is neither a journey nor a context is reported and left
   * out, so a bad element costs its own event and not the host's call.
   */
  function contextsOf(journeys: Iterable<Journey | JourneyContext>): JourneyContext[] {
    const seen = new Set<string>();
    const contexts: JourneyContext[] = [];
    for (const one of journeys) {
      const context = safely(diagnostics, "capture_error", () => {
        const candidate: unknown =
          typeof (one as Partial<Journey> | null)?.context === "function"
            ? (one as Journey).context()
            : one;
        if (!isContext(candidate)) {
          throw new TypeError("across() was given something that is not a journey.");
        }
        return candidate;
      });
      if (context === undefined || seen.has(context.journeyId)) continue;
      seen.add(context.journeyId);
      contexts.push(context);
    }
    return contexts;
  }

  return {
    startJourney(options) {
      const context = safely(diagnostics, "capture_error", () => ({
        journeyId: `jrn_${randomUUID()}`,
        entity: options.entity
      }));

      const journey = makeJourney(
        context ?? { journeyId: `jrn_${randomUUID()}`, entity: { type: "unknown", id: "unknown" } }
      );
      if (options.aliases !== undefined) {
        journey.identify(
          options.aliases,
          options.displayable === undefined ? undefined : { displayable: options.displayable }
        );
      }
      return journey;
    },
    continueJourney: (context) => makeJourney(context),
    journeyIdFor(entity) {
      const derived = safely(diagnostics, "capture_error", () => {
        const secret = resolved.journeyIdSecret;
        if (secretProblem !== undefined || secret === undefined) {
          diagnostics.report({
            kind: "configuration_error",
            reason: secretProblem ?? "journeyIdSecret is not usable."
          });
          return undefined;
        }
        if (!isEntity(entity)) {
          diagnostics.report({
            kind: "configuration_error",
            reason:
              "journeyIdFor needs an entity whose type and id are strings, so it returned a random journey id."
          });
          return undefined;
        }
        return deriveJourneyId(secret, resolved.environment, entity);
      });
      return derived ?? `jrn_${randomUUID()}`;
    },
    across(journeys) {
      const contexts = safely(diagnostics, "capture_error", () => contextsOf(journeys)) ?? [];
      return { ...operationsOn(contexts), journeys: () => [...contexts] };
    },
    // At the default propagation level the journey ID crosses the boundary and
    // the entity does not, so the consumer supplies the entity it already has
    // from the message body.
    consume: (options) =>
      makeJourney({
        journeyId: options.context?.journeyId ?? `jrn_${randomUUID()}`,
        entity: options.context?.entity ??
          options.entityFallback ?? { type: "unknown", id: "unknown" }
      }),
    // These six were the only public entry points not going through `safely`,
    // which contradicted safely.ts's own claim that every one does. The
    // consequence was not theoretical: a plain-JavaScript relay calling
    // `injectHttpHeaders({}, extractHttpContext(req.headers))` works for an
    // instrumented caller and kills the process on the first un-instrumented
    // one, because extract returns undefined and inject dereferences it. It
    // passes in testing and dies during rollout.
    //
    // The fallbacks are chosen so a failure degrades rather than breaks: no
    // headers rather than no request, and no context rather than no consumer.
    injectHttpHeaders: (headers, context) =>
      safely(diagnostics, "capture_error", () =>
        injectHttpHeaders(headers, context, resolved.propagate)
      ) ?? headers,
    extractHttpContext: (headers) =>
      safely(diagnostics, "capture_error", () => extractHttpContext(headers)),
    toQueueAttributes: (context) =>
      safely(diagnostics, "capture_error", () => toQueueAttributes(context, resolved.propagate)) ??
      {},
    fromQueueAttributes: (attributes) =>
      safely(diagnostics, "capture_error", () => fromQueueAttributes(attributes)),
    wrapPayload: (payload, context) =>
      safely(diagnostics, "capture_error", () =>
        wrapPayload(payload, context, resolved.propagate)
      ) ?? { _flight: {}, data: payload },
    unwrapPayload: (body) =>
      safely(diagnostics, "capture_error", () => unwrapPayload(body)) ?? { data: body },
    async flush() {
      await safelyAsync(diagnostics, "transport_error", drainAll);
    },
    async shutdown(options) {
      stopped = true;
      clearInterval(interval);
      const timeoutMs = options?.timeoutMs ?? 2_000;
      // Never hang: a process that cannot exit because of a telemetry library is
      // the same failure ADR-007 forbids, arriving later.
      const drain = safelyAsync(diagnostics, "transport_error", drainAll);
      await raceTimeout(drain, timeoutMs);
      await safelyAsync(diagnostics, "capture_error", () => abandonRemaining(drain));
      // Last, so a repeat suppressed during the final drain is still reported
      // before the process exits.
      safely(diagnostics, "capture_error", () => {
        diagnostics.flushLog();
      });
      // Read after the race, so the counters describe what actually landed.
      return diagnostics.counters();
    },
    diagnostics: () => diagnostics.counters()
  };
}
