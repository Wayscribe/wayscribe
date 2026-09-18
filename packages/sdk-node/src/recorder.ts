import { randomUUID } from "node:crypto";
import {
  MAX_STRING_LENGTH,
  checkLimits,
  eventLimits,
  maskSecretsInText,
  payloadLimits,
  redact,
  toStorable,
  type LimitViolation,
  type TruncationStats
} from "@wayscribe/payload-security/redaction";
import { fitsCodePoints } from "./code-points.js";
import {
  firstRequiredSettingWarning,
  resolveConfig,
  type ConfigProblem,
  type RecorderConfig
} from "./config.js";
import {
  createDiagnostics,
  printDiagnostic,
  type Diagnostic,
  type Diagnostics,
  type KeyDroppedDiagnostic,
  type PayloadOmittedDiagnostic
} from "./diagnostics.js";
import type { Operation } from "./operations.js";
import {
  extractHttpContext,
  extractPayload,
  extractSqsContext,
  injectHttpHeaders,
  injectPayload,
  injectSqsAttributes
} from "./propagation.js";
import type { ContextEnvelope, PropagatedContext, SqsMessageAttributes } from "./propagation.js";
import { acceptLabel } from "./label.js";
import { BoundedQueue } from "./queue.js";
import { safely, safelyAsync } from "./safely.js";
import { createSecretNameWarnings, type FoundName, type PayloadField } from "./secret-names.js";
import {
  deriveJourneyId,
  entityProblem,
  firstSecretWarning,
  journeyIdSecretProblem
} from "./journey-id.js";
import { createTraceReader } from "./trace.js";
import { AbandonedError, Transport, UnsentError, type SendOutcome } from "./transport.js";

import type {
  ContinueJourneyOptions,
  Entity,
  ErrorInput,
  Journey,
  JourneyContext,
  JourneyOperations,
  RecordInput,
  Recorder,
  WrapOptions
} from "./types.js";

export type {
  ContinueJourneyOptions,
  Entity,
  ErrorInput,
  FailOptions,
  FinishOptions,
  IdentifyOptions,
  Journey,
  JourneyContext,
  JourneyGroup,
  JourneyOperations,
  RecordInput,
  Recorder,
  ShutdownOptions,
  StartJourneyOptions,
  WrapOptions
} from "./types.js";

const TOO_LARGE = "[PAYLOAD_TOO_LARGE]";
const UNCAPTURABLE = "[UNCAPTURABLE]";

/**
 * The code a payload omitted for breaking a limit is reported with. The limit's
 * own name goes in the reason only: codes are the SDK's API, and the limit
 * names belong to payload-security.
 */
const OMITTED_CODE: Record<LimitViolation, PayloadOmittedDiagnostic["code"]> = {
  payload_too_large: "too_large",
  max_depth_exceeded: "too_deep",
  max_keys_exceeded: "too_wide",
  // Unreachable: payload limits measure a long string as it will be cut, so no
  // string is ever over the limit here. Mapped only because the type is total.
  max_string_length_exceeded: "too_large",
  unserialisable_payload: "unserialisable"
};

const PAYLOAD_FIELDS: readonly PayloadField[] = ["input", "output", "metadata"];

/** A captured payload, and how many of its strings were cut, if any were. */
interface Captured {
  value: unknown;
  truncated?: TruncationStats;
  /** Secret-looking names the walk kept, reported only if this payload is sent. */
  secretNames?: FoundName[];
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
 * The protocol's caps on keys and short fields (`packages/protocol` event
 * schema), which count Unicode code points. The server refuses the whole event
 * over any one of them, so the SDK applies them before sending.
 * `capped-fields.test.ts` checks the result against that schema.
 */
const MAX_KEY_LENGTH = 128;
const MAX_ALIAS_VALUE_LENGTH = 512;
const MAX_ERROR_FIELD_LENGTH = 256;
const KEY_TOO_LONG = "[KEY_TOO_LONG]";

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

/** Sets an own property, so a `__proto__` key stays a key. */
function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true
  });
}

/** A wrapper's options as read once, at the call. */
interface WrapSettings<T> {
  operation: Operation;
  metadata?: Record<string, unknown> | undefined;
  captureInput?: WrapOptions<T>["captureInput"] | undefined;
  captureOutput?: WrapOptions<T>["captureOutput"] | undefined;
  isFailure?: WrapOptions<T>["isFailure"] | undefined;
}

/**
 * A journey the recorder records on, and how to read its label at the moment
 * an event is made. A journey named by its context alone has no label.
 */
interface Target {
  context: JourneyContext;
  label: () => string | undefined;
}

const NO_LABEL = (): undefined => undefined;

/** The entity of a journey the host gave none for. */
const UNKNOWN_ENTITY: Entity = { type: "unknown", id: "unknown" };

/** A non-empty string, which is what the protocol requires of an identifier. */
function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/** An entity the server will accept: an object whose type and id are non-empty strings. */
function isUsableEntity(value: unknown): value is Entity {
  if (typeof value !== "object" || value === null) return false;
  const { type, id } = value as Partial<Entity>;
  return isIdentifier(type) && isIdentifier(id);
}

/** A journey's context the recorder can record on. Reading it runs the host's getters. */
function isContext(value: unknown): value is JourneyContext {
  if (typeof value !== "object" || value === null) return false;
  const { journeyId, entity } = value as Partial<JourneyContext>;
  return isIdentifier(journeyId) && isUsableEntity(entity);
}

/** A copy, so a later change to the host's object does not change what is recorded. */
function copyEntity(entity: Entity): Entity {
  return { type: entity.type, id: entity.id };
}

/** Something shaped like a propagated context, as a one-argument inject call passes. */
function isPropagated(value: unknown): boolean {
  return typeof value === "object" && value !== null && "journeyId" in value;
}

/** What a journey's error becomes when the thrown value cannot be read at all. */
const UNREADABLE_ERROR = "The thrown value could not be read.";

/** Duck-typed rather than `instanceof Promise`: a thenable from any library counts. */
function isThenable<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
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
      code: "no_verdict",
      reason: `The server's reply gave no verdict for this event (${why}); the server may have stored it, so it is not sent again.`,
      detail: {}
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

    diagnostics.report(
      {
        kind: "rejected",
        code: "event_refused",
        reason: described,
        detail: { serverError: result.error }
      },
      logLine
    );
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
 * Wayscribe's API puts no event values in its messages, but the SDK
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
    code: "unencrypted_endpoint",
    reason: `The endpoint is http: to ${url.hostname}, so the API key and payloads travel unencrypted. Use https: for any endpoint off this machine.`,
    detail: { scheme: "http:", host: url.hostname }
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

/**
 * Why one line about a rejected setting is printed although `logDiagnostics`
 * is off. Each reason is different, and the line is the only sign an operator
 * who reads no diagnostics will get (SDK-56, SDK-60, ADR-060).
 */
function whyPrinted(required: boolean, code: ConfigProblem["code"]): string {
  if (required) {
    return "printed once per process, whether or not logDiagnostics is on, because nothing recorded reaches the server until it is fixed";
  }
  if (code === "setting_renamed") {
    return "printed once per process, whether or not logDiagnostics is on, because the setting is otherwise lost unseen";
  }
  return "printed once per process, whether or not logDiagnostics is on, because the setting was replaced by its default while the recorder went on looking healthy";
}

export function createRecorder(config: RecorderConfig): Recorder {
  const resolved = resolveConfig(config);
  const diagnostics = createDiagnostics(resolved.onDiagnostic, { log: resolved.logDiagnostics });
  safely(diagnostics, "capture_error", () => {
    warnIfInsecure(resolved.endpoint, diagnostics);
  });
  // Settings resolveConfig had to replace. Reported rather than thrown, so the
  // host starts either way (SDK-6); the reason names the setting, never its
  // value. Exempt from the log's rate limit: they arrive together, once, and
  // each is a different thing to fix.
  //
  // A required setting has no default, so every event is lost until it is
  // fixed, silently to anybody not reading diagnostics. Like an unusable
  // secret, it prints one line per process and setting even with
  // logDiagnostics off, the other exception to SDK-40 that SDK-56 allows.
  //
  // So does an optional one (ADR-060): it was replaced by its default, and
  // with logDiagnostics off and no onDiagnostic read nothing else said so,
  // while the recorder went on looking healthy (F-010).
  safely(diagnostics, "capture_error", () => {
    for (const { setting, code, reason, required, printed } of resolved.problems) {
      const diagnostic: Diagnostic = {
        kind: "configuration_error",
        code,
        reason,
        detail: { setting }
      };
      diagnostics.report(diagnostic, undefined, { unlimited: true });
      if (!printed || resolved.logDiagnostics || !firstRequiredSettingWarning(setting)) continue;
      printDiagnostic(diagnostic, whyPrinted(required, code));
    }
  });
  // A secret that was configured and cannot be used is reported now, once, so
  // it surfaces at startup rather than at the first derived id. A missing one
  // is not: most recorders never derive an id.
  const secretProblem = journeyIdSecretProblem(resolved.journeyIdSecret);
  /**
   * A secret that cannot be used splits every derived journey into one per
   * run, silently to anybody not reading diagnostics. So besides the
   * diagnostic, one line is printed per process even with logDiagnostics off,
   * as SDK-56 allows; the other unasked warnings are a required setting that
   * cannot be used, a renamed setting, and a secret-looking name (SDK-60,
   * SDK-61). With logging on, the ordinary line already says it.
   */
  const reportSecretProblem = (reason: string): void => {
    const diagnostic: Diagnostic = {
      kind: "configuration_error",
      code:
        resolved.journeyIdSecret === undefined
          ? "journey_id_secret_missing"
          : "journey_id_secret_unusable",
      reason,
      detail: { setting: "journeyIdSecret" }
    };
    // The first report is the warning, so with logging on it is printed even
    // when another configuration problem was printed this minute.
    const first = firstSecretWarning();
    diagnostics.report(diagnostic, undefined, { unlimited: first });
    if (!first || resolved.logDiagnostics) return;
    printDiagnostic(
      diagnostic,
      "printed once per process, whether or not logDiagnostics is on, because derived journeys split until it is fixed"
    );
  };
  if (resolved.journeyIdSecret !== undefined && secretProblem !== undefined) {
    safely(diagnostics, "capture_error", () => {
      reportSecretProblem(secretProblem);
    });
  }
  const queue = new BoundedQueue<unknown>(resolved.maxBufferedEvents, diagnostics);
  const secretNames = createSecretNameWarnings({
    diagnostics,
    knownSafeNames: new Set(resolved.knownSafeNames),
    logDiagnostics: resolved.logDiagnostics
  });
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
              Object.assign(error, { permanent: true, httpStatus: response.status });
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
              code: "first_delivery",
              reason: `Connected to ${endpoint}; the server accepted ${String(accepted)} ${accepted === 1 ? "event" : "events"}.`,
              detail: { endpoint, accepted }
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
      // string limit used to be scaled with maxEventBytes, which the server
      // never did, so a 70 KB string passed here and cost the whole event there.
      const limits = checkLimits(value, payloadLimits(resolved.maxEventBytes));
      if (!limits.ok) {
        // Discarding a payload silently made a full timeline look like a step
        // that genuinely carried nothing.
        reportOmitted(
          field,
          OMITTED_CODE[limits.reason],
          `A payload was not captured: ${limits.reason}.`
        );
        return { value: TOO_LARGE };
      }

      // Sanitized, then cut. Cutting a masked string cannot reveal anything the
      // mask hid, and every string that leaves this process is one PostgreSQL
      // will accept and the server's string limit allows.
      //
      // The redaction walk also collects what it kept under a name that reads
      // as a secret, so the warning costs no second walk (ADR-055). Anything
      // left from a capture that failed part way is dropped first.
      secretNames.take(field);
      const stats: TruncationStats = { strings: 0, charactersRemoved: 0 };
      const stored = toStorable(redact(value, resolved.redact, secretNames.observerFor(field)), {
        max: MAX_STRING_LENGTH,
        stats
      });
      const found = secretNames.take(field);
      return {
        value: stored,
        ...(stats.strings === 0 ? {} : { truncated: stats }),
        ...(found === undefined ? {} : { secretNames: found })
      };
    } catch (error) {
      // A getter or a toJSON that throws. The event is kept with a marker, and
      // the omission is reported like any other; the reason never quotes what
      // was thrown, which can carry the payload.
      diagnostics.report({
        kind: "payload_omitted",
        code: "unserialisable",
        reason: `The ${field} could not be read, so it was not captured.`,
        detail: { field, error }
      });
      return { value: UNCAPTURABLE };
    }
  }

  function reportOmitted(
    field: PayloadField,
    code: PayloadOmittedDiagnostic["code"],
    message: string
  ): void {
    diagnostics.report({ kind: "payload_omitted", code, reason: message, detail: { field } });
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
    if (plainlyWithinBudget(envelope)) return;
    const { event } = envelope;
    const limits = eventLimits(resolved.maxEventBytes);
    for (;;) {
      const result = checkLimits(envelope, limits);
      if (result.ok || result.reason !== "payload_too_large") return;
      const field = nextToOmit(event);
      if (field === undefined) return;
      if (field === "metadata") delete event["metadata"];
      else event[field] = TOO_LARGE;
      reportOmitted(
        field,
        "too_large",
        `The event exceeded maxEventBytes, so its ${field} was not captured.`
      );
    }
  }

  /**
   * True when the envelope is certainly within the byte budget, measured
   * without the server's check. `fitToBudget` then has nothing to do: the check
   * could only answer `ok`, or a structural reason it does not act on.
   *
   * The check walks the envelope and serialises it through a replacer, which
   * calls back into JavaScript for every value. On a 1 KiB `transform` that was
   * a quarter of the time a wrapped call took (measured on 2026-09-16).
   *
   * Plain `JSON.stringify` measures what the wire carries, since the batch is
   * sent with it too. For the payloads that is also what the check measures:
   * `input`, `output` and `metadata` have been through capture, so every Map,
   * Set, Error, BigInt and cycle in them is already rendered. Not everything on
   * the envelope has: `name` and `operation` are the caller's, and `error`
   * keeps any extra fields a JavaScript caller put on it. A Map in one of those
   * measures here as the `{}` it is sent as, where the check would have
   * weighed its entries; a BigInt or a cycle throws, here and when the batch
   * is sent, and falls back to the check.
   */
  function plainlyWithinBudget(envelope: { event: Record<string, unknown> }): boolean {
    try {
      const text = JSON.stringify(envelope);
      return Buffer.byteLength(text, "utf8") <= resolved.maxEventBytes;
    } catch {
      return false;
    }
  }

  function nextToOmit(event: Record<string, unknown>): PayloadField | undefined {
    const size = (field: "input" | "output"): number => {
      const value = event[field];
      if (value === undefined || value === TOO_LARGE || value === UNCAPTURABLE) return 0;
      // A function or a Symbol serialises to nothing: it takes no room, and
      // weighing `undefined` threw and lost the whole event.
      const text = JSON.stringify(value) as string | undefined;
      return text === undefined ? 0 : Buffer.byteLength(text, "utf8");
    };
    const input = size("input");
    const output = size("output");
    if (input > 0 || output > 0) return input >= output ? "input" : "output";
    return event["metadata"] === undefined ? undefined : "metadata";
  }

  function reportDropped(
    field: KeyDroppedDiagnostic["detail"]["field"],
    code: KeyDroppedDiagnostic["code"],
    keys: number,
    what: string
  ): void {
    diagnostics.report({
      kind: "key_dropped",
      code,
      reason: `${String(keys)} ${keys === 1 ? "entry" : "entries"} left off the event's ${field}: ${what}.`,
      detail: { field, keys }
    });
  }

  /**
   * The aliases the server will accept, copied at the call. An alias whose type
   * is over the key cap, or whose value is not a string within the value cap,
   * is left off and reported; no marker is added, because a marker would be
   * stored as an alias and found by search. The keys are not quoted back: they
   * can be data.
   */
  function aliasesFor(aliases: unknown): { aliases?: Record<string, string> } {
    if (aliases === undefined) return {};
    if (typeof aliases !== "object" || aliases === null || Array.isArray(aliases)) {
      reportDropped(
        "aliases",
        "aliases_not_object",
        1,
        "aliases that are not an object of alias types to values"
      );
      return {};
    }
    const kept: Record<string, string> = {};
    let dropped = 0;
    for (const [type, value] of Object.entries(aliases)) {
      if (
        fitsCodePoints(type, MAX_KEY_LENGTH) &&
        typeof value === "string" &&
        fitsCodePoints(value, MAX_ALIAS_VALUE_LENGTH)
      ) {
        defineOwn(kept, type, value);
      } else {
        dropped += 1;
      }
    }
    if (dropped > 0) {
      reportDropped(
        "aliases",
        "alias_invalid",
        dropped,
        "an alias type over 128 characters, or a value that is not a string of at most 512"
      );
    }
    return { aliases: kept };
  }

  /** `displayableAliases`, copied at the call, without entries the server would refuse. */
  function displayableFor(list: unknown): { displayableAliases?: string[] } {
    if (!Array.isArray(list)) return {};
    const kept = (list as unknown[]).filter(
      (type): type is string => typeof type === "string" && fitsCodePoints(type, MAX_KEY_LENGTH)
    );
    const dropped = list.length - kept.length;
    if (dropped > 0) {
      reportDropped(
        "displayableAliases",
        "displayable_alias_invalid",
        dropped,
        "an entry that is not an alias type of at most 128 characters"
      );
    }
    return { displayableAliases: kept };
  }

  /**
   * Captured metadata without top-level keys over the cap, which is the only
   * level the server checks, and with `"[KEY_TOO_LONG]": n` saying how many
   * went. Captured metadata is already a copy, so it is changed in place.
   */
  function withinKeyCap(metadata: unknown): unknown {
    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
      return metadata;
    }
    const record = metadata as Record<string, unknown>;
    let dropped = 0;
    for (const key of Object.keys(record)) {
      if (fitsCodePoints(key, MAX_KEY_LENGTH)) continue;
      Reflect.deleteProperty(record, key);
      dropped += 1;
    }
    if (dropped === 0) return metadata;
    defineOwn(record, KEY_TOO_LONG, dropped);
    reportDropped("metadata", "metadata_key_too_long", dropped, "a key over 128 characters");
    return record;
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
        code: "strings_cut",
        reason: `${String(strings)} ${strings === 1 ? "string" : "strings"} in the ${field} were cut to ${MAX_STRING_LENGTH.toLocaleString("en-US")} characters.`,
        detail: { field, ...one.truncated }
      });
    }
  }

  /**
   * The secret-name warning for each payload that reached the event. One the
   * budget omitted sent nothing under those names, and must not spend the
   * name's one warning (SDK-61).
   */
  function reportSecretNames(
    event: Record<string, unknown>,
    captured: Record<PayloadField, Captured | undefined>
  ): void {
    for (const field of PAYLOAD_FIELDS) {
      const one = captured[field];
      if (one?.secretNames === undefined || event[field] !== one.value) continue;
      secretNames.report(field, one.secretNames);
    }
  }

  /**
   * An error record with credential-shaped text masked (ADR-046).
   *
   * Here rather than in `toErrorRecord`, because every error record reaches
   * the queue through this point and not every one comes from there:
   * `record()` takes one straight from the application, `stack` included.
   * The server masks again before storing, which changes nothing: masking is
   * idempotent.
   *
   * Both fields are bounded to what the protocol accepts, so a megabyte of
   * message costs the host no more than four kilobytes of one.
   */
  function maskedError(error: ErrorInput): ErrorInput {
    // Read as unknown: a JavaScript caller can pass anything.
    const { message, stack, type, code } = error as Record<keyof ErrorInput, unknown>;
    return {
      ...error,
      // A class name or an error code is not free text worth masking, but the
      // protocol caps both, and a long one would cost the event.
      ...(typeof type === "string" && !fitsCodePoints(type, MAX_ERROR_FIELD_LENGTH)
        ? { type: fit(type, MAX_ERROR_FIELD_LENGTH) }
        : {}),
      ...(typeof code === "string" && !fitsCodePoints(code, MAX_ERROR_FIELD_LENGTH)
        ? { code: fit(code, MAX_ERROR_FIELD_LENGTH) }
        : {}),
      ...(typeof message === "string"
        ? { message: boundedMaskedText(message, MAX_ERROR_MESSAGE_LENGTH) }
        : {}),
      ...(typeof stack === "string"
        ? { stack: boundedMaskedText(stack, MAX_ERROR_STACK_LENGTH) }
        : {})
    };
  }

  function enqueue(
    target: Target,
    input: RecordInput,
    /**
     * The input, already captured at the call, for a wrapper whose
     * `captureInput` projection may share objects its callback goes on to
     * change. When given, `input.input` is not captured again.
     */
    capturedInput?: { value: Captured | undefined }
  ): void {
    if (stopped) {
      // This was once silent: after shutdown the wrappers still ran the
      // callback and returned the right value, the server received nothing,
      // and the counters kept reporting a clean bill of health. It was
      // reachable by ordinary reading, when `flush()` was documented nowhere
      // and the example called shutdown "flush". Counted as recorded, so
      // sent + rejected + dropped still equals recorded.
      diagnostics.countRecorded();
      diagnostics.report({
        kind: "dropped",
        code: "after_shutdown",
        reason: "The recorder was shut down, so this event was not sent.",
        detail: { name: input.name, operation: input.operation }
      });
      return;
    }

    const { journeyId, entity } = target.context;
    // Read now, so the event carries the label its journey has as it is made.
    const journeyLabel = target.label();
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
      ...aliasesFor(input.aliases),
      ...displayableFor(input.displayableAliases),
      ...(journeyLabel === undefined ? {} : { journeyLabel }),
      ...(captured.metadata === undefined
        ? {}
        : { metadata: withinKeyCap(captured.metadata.value) })
    };
    const envelope = { protocolVersion: "0.1", event };

    fitToBudget(envelope);
    reportTruncations(event, captured);
    reportSecretNames(event, captured);
    diagnostics.countRecorded();
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
  // owner: wayscribe
  // expires: 2027-03-01
  // reason: A fixed cap cannot fit both one process in front of a scaled-out API and a fleet sharing one pool; adaptive concurrency, lowering the cap on timeouts and 5xx and raising it while sends succeed, is the long-term fix
  // tags: sdk, performance
  // debtwatch:end
  /**
   * Starts a background flush unless the cap is already reached.
   *
   * The cap is `maxConcurrentSends` (config.ts says why the default is four).
   *
   * Nothing is started while the breaker is open: that send would throw at
   * once and hand its batch back unchanged, so skipping it changes no event
   * and no counter. It used to run for every event recorded against a
   * refusing endpoint, inside the call being recorded. The interval tries
   * again once the cooldown is over, and `flush()` and `shutdown()` do not
   * come through here.
   */
  function maybeFlush(): void {
    if (inFlight.size < resolved.maxConcurrentSends && !transport.isOpen()) track(flush());
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
        code: "shutdown",
        reason: "The recorder shut down before this event was delivered.",
        detail: {}
      });
    }
  }

  /**
   * The error record for a thrown value. Never throws: a value that cannot be
   * read, such as a revoked Proxy or a null-prototype object, is recorded with
   * a fixed message, so the failure it stands for is still on the timeline.
   */
  function toErrorRecord(error: unknown): ErrorInput {
    try {
      if (error instanceof Error) {
        // Typed as strings, but a host's error can hold anything.
        const { message, name, code } = error as {
          message: unknown;
          name: unknown;
          code?: unknown;
        };
        return {
          message: String(message),
          type: String(name),
          ...(typeof code === "string" ? { code } : {})
        };
      }
      return { message: String(error) };
    } catch {
      return { message: UNREADABLE_ERROR };
    }
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
    targets: readonly Target[],
    naturalOperation: Operation,
    name: string,
    input: unknown,
    fn: () => T | PromiseLike<T>,
    options: WrapOptions<T> | undefined
  ): T | Promise<T> {
    const startedAt = Date.now();
    // Read once, inside the boundary: options that are null, or a getter or a
    // metadata spread that throws, used to throw into the host before its
    // callback ran. Options that cannot be read are reported and the step is
    // recorded as a first attempt with no options.
    const settings: WrapSettings<T> = safely(diagnostics, "capture_error", () => {
      // Each option read once: a getter is the host's code, and reading it
      // twice can give two answers.
      const given: WrapOptions<T> = options ?? {};
      const { captureInput, captureOutput, isFailure } = given;
      const attempt = given.attempt ?? 1;
      const extra = given.metadata;
      const metadata = extra === undefined && attempt === 1 ? undefined : { ...extra, attempt };
      return {
        // ADR-022: a retry records as `retried` rather than the natural verb.
        operation: attempt > 1 ? ("retried" as const) : naturalOperation,
        metadata,
        captureInput,
        captureOutput,
        isFailure
      };
    }) ?? { operation: naturalOperation };
    const { operation, metadata, captureInput, captureOutput, isFailure } = settings;

    // Projected and captured now, before the callback can change what it was
    // given. Capturing copies: a projection usually returns parts of the input
    // rather than a copy of them, and the callback may change those parts.
    const projection = captureInput;
    const capturedInputs =
      projection === undefined
        ? undefined
        : targets.map(({ context }) => ({
            value: safely(diagnostics, "capture_error", () =>
              capture(project(projection, input, context, "input"), "input")
            )
          }));

    const recordAll = (outcome: (context: JourneyContext) => Partial<RecordInput>): void => {
      const durationMs = Date.now() - startedAt;
      targets.forEach((target, index) => {
        safely(diagnostics, "capture_error", () => {
          enqueue(
            target,
            {
              operation,
              name,
              input,
              startedAt,
              durationMs,
              ...outcome(target.context),
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
        const failed = isFailure === undefined ? false : isFailure(result);
        recordAll((context) => ({
          output:
            captureOutput === undefined
              ? result
              : project(captureOutput, result, context, "output"),
          ...(failed
            ? { error: { message: `${name} reported a failed result.`, code: "result_failed" } }
            : {})
        }));
      });
    };

    let produced: T | PromiseLike<T>;
    try {
      produced = fn();
    } catch (error) {
      recordFailure(error);
      // The original object, not a copy: application code branches on
      // instanceof and on custom properties.
      throw error;
    }

    let thenable: boolean;
    try {
      thenable = isThenable(produced);
    } catch (error) {
      // A `then` getter that throws. `await` would reject with its error, so
      // the wrapper does too, rather than throw into the host, and the step is
      // recorded as failed with it.
      safely(diagnostics, "capture_error", () => {
        diagnostics.report({
          kind: "capture_error",
          code: "unexpected_error",
          reason: `${name} returned a value whose then could not be read; the wrapper rejects with the error it threw.`,
          detail: { error }
        });
      });
      recordFailure(error);
      // The host's own error, whatever it is, as the rethrow rule requires.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(error);
    }
    if (!thenable) {
      recordSuccess(produced as T);
      return produced as T;
    }

    // Through Promise.resolve, so a thenable from another library comes back
    // as the native promise the types promise. A native promise is returned by
    // Promise.resolve as it is, so nothing changes for one.
    return Promise.resolve(produced as PromiseLike<T>).then(
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
        code: "projection_failed",
        reason,
        detail: { field, ...(error === undefined ? {} : { error }) }
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
   * `input` on every journey in `targets`, with one timestamp for all of them.
   * Each event goes through its own boundary, so one that cannot be recorded
   * does not cost the others.
   */
  function recordOn(targets: readonly Target[], input: RecordInput): void {
    const startedAt = input.startedAt ?? Date.now();
    for (const target of targets) {
      safely(diagnostics, "capture_error", () => {
        enqueue(target, { ...input, startedAt });
      });
    }
  }

  function operationsOn(targets: readonly Target[]): JourneyOperations {
    // One untyped implementation behind the four overloaded wrappers: the
    // overloads describe what `wrap` does with each shape of callback.
    const wrapper =
      (operation: Operation) =>
      (name: string, input: unknown, fn: () => unknown, options?: WrapOptions): unknown =>
        wrap(targets, operation, name, input, fn, options);
    return {
      record(input) {
        safely(diagnostics, "capture_error", () => {
          recordOn(targets, input);
        });
      },
      transform: wrapper("transformed") as JourneyOperations["transform"],
      persist: wrapper("persisted") as JourneyOperations["persist"],
      publish: wrapper("published") as JourneyOperations["publish"],
      deliver: wrapper("delivered") as JourneyOperations["deliver"],
      fail(name, error, options) {
        // The options apart from the event: options that cannot be read cost
        // their metadata, not the failure being recorded.
        const metadata = safely(diagnostics, "capture_error", () => failMetadata(options));
        safely(diagnostics, "capture_error", () => {
          recordOn(targets, {
            operation: "failed",
            name,
            error: toErrorRecord(error),
            ...(metadata === undefined ? {} : { metadata })
          });
        });
      },
      finish(options) {
        safely(diagnostics, "capture_error", () => {
          recordOn(targets, {
            operation: options?.status === "failed" ? "failed" : "completed",
            name: "finish"
          });
        });
      }
    };
  }

  /**
   * How `across` reads the label of a journey it was handed, by the handle's
   * identity. Weak, so a finished journey is not kept alive by it; and only
   * this recorder's journeys are in it, so nothing a host passes is read for a
   * label.
   */
  const labelOf = new WeakMap<object, () => string | undefined>();

  function makeJourney(context: JourneyContext): Journey {
    // Per handle: a second handle for the same journey starts without one.
    let label: string | undefined;
    const target: Target = { context, label: () => label };
    const journey: Journey = {
      ...operationsOn([target]),
      context: () => context,
      label(text) {
        safely(diagnostics, "capture_error", () => {
          // A refused label leaves the earlier one: the server never clears a
          // label either, so an empty string cannot remove one by accident.
          label = acceptLabel(text, diagnostics) ?? label;
        });
      },
      identify(aliases, options) {
        safely(diagnostics, "capture_error", () => {
          reportRenamedOption(options, "displayable", "displayableAliases", "identify");
          enqueue(target, {
            operation: "identified",
            name: "identify",
            // Top-level, not under metadata: EVENT_PROTOCOL puts aliases on the
            // event itself, and ingestion reads them from there. Nested, they
            // are accepted and then ignored, costing every alias-based search.
            aliases,
            ...(options?.displayableAliases === undefined
              ? {}
              : { displayableAliases: options.displayableAliases })
          });
        });
      }
    };
    labelOf.set(journey, target.label);
    return journey;
  }

  /**
   * Whether an inject helper was given a context to inject, reporting it when
   * not. A relay passing what `extractHttpContext` returned for a caller that
   * does not record gets the carrier back unchanged.
   */
  function hasContext(context: unknown, call: string): context is PropagatedContext {
    if (typeof context === "object" && context !== null) return true;
    diagnostics.report({
      kind: "capture_error",
      code: "context_missing",
      reason: `${call} was given no journey context, so it added none. Pass journey.context() as the last argument.`,
      detail: { call }
    });
    return false;
  }

  /**
   * A call's options that are not an object, or that hold something the call
   * does not read, reported once. Key names are never quoted: a host's keys can
   * be data.
   */
  function reportInvalidOptions(call: string, reason: string): void {
    diagnostics.report({
      kind: "capture_error",
      code: "invalid_options",
      reason,
      detail: { call }
    });
  }

  /**
   * An option a JavaScript caller passed under the name it had before the
   * first release. Reported, because the call otherwise loses it unseen.
   */
  function reportRenamedOption(options: unknown, old: string, current: string, call: string): void {
    if (typeof options !== "object" || options === null) return;
    try {
      if (!(old in options)) return;
    } catch {
      // A Proxy that refuses `in`: its reads are reported where they fail.
      return;
    }
    diagnostics.report({
      kind: "configuration_error",
      code: "setting_renamed",
      reason: `${call} was given ${old}, which is now called ${current}; ${old} is not read.`,
      detail: { setting: old }
    });
  }

  function reportEntity(setting: string, reason: string): void {
    diagnostics.report({
      kind: "configuration_error",
      code: "entity_invalid",
      reason,
      detail: { setting }
    });
  }

  /** `fail`'s metadata, reporting options it cannot use. */
  function failMetadata(options: unknown): Record<string, unknown> | undefined {
    if (options === undefined) return undefined;
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      reportInvalidOptions(
        "fail",
        "fail was given options that are not an object; pass metadata as { metadata }."
      );
      return undefined;
    }
    if (Object.keys(options).some((key) => key !== "metadata")) {
      reportInvalidOptions(
        "fail",
        "fail was given options other than metadata, which are not read; pass metadata as { metadata }."
      );
    }
    return (options as { metadata?: Record<string, unknown> }).metadata;
  }

  /**
   * The entity `startJourney` records under: the host's, copied, or the unknown
   * entity, reported, when the host's cannot be recorded. The steps are kept
   * either way; an event with an unusable entity would be refused whole.
   */
  function startedEntity(options: unknown): Entity {
    // Unreadable options throw to the caller's boundary, which reports them.
    const entity: unknown = (options as { entity?: unknown }).entity;
    if (isUsableEntity(entity)) return copyEntity(entity);
    reportEntity(
      "entity",
      "startJourney was given an entity whose type and id are not both non-empty strings, so its steps are recorded under the unknown entity."
    );
    return UNKNOWN_ENTITY;
  }

  /**
   * The context `continueJourney` joins.
   *
   * The journey id is the context's, else `journeyId`, else a new random one.
   * The entity is the context's, else `entity`, else the unknown entity. At the
   * default propagation level the journey id crosses the boundary and the
   * entity does not, so the consumer supplies the entity it already has from
   * the message body.
   *
   * Anything that cannot be used is reported and treated as absent: a context
   * whose id is not a non-empty string, which used to be recorded as it was
   * and cost the whole journey at the server; an entity whose type or id is
   * not; options that are not an object, reported once. Each option is read
   * inside the boundary, and apart, so a getter that throws costs that option.
   */
  function continuedContext(options: unknown): JourneyContext {
    if (typeof options !== "object" || options === null) {
      reportInvalidOptions(
        "continueJourney",
        "continueJourney was given options that are not an object, so it started a new journey under the unknown entity."
      );
      return { journeyId: `jrn_${randomUUID()}`, entity: UNKNOWN_ENTITY };
    }
    const given = options as Record<keyof ContinueJourneyOptions, unknown>;
    const read = (key: keyof ContinueJourneyOptions): unknown =>
      safely(diagnostics, "capture_error", () => given[key]);
    reportRenamedOption(options, "entityFallback", "entity", "continueJourney");

    let journeyId: string | undefined;
    let entity: Entity | undefined;

    const context = read("context");
    if (context !== undefined) {
      const propagated = safely(diagnostics, "capture_error", () => {
        if (typeof context !== "object" || context === null) return {};
        const { journeyId: id, entity: carried } = context as Record<string, unknown>;
        return { id, carried };
      });
      if (propagated !== undefined) {
        if (isIdentifier(propagated.id)) {
          journeyId = propagated.id;
        } else {
          diagnostics.report({
            kind: "configuration_error",
            code: "journey_id_invalid",
            reason:
              "continueJourney was given a context without a journey id, so it was not used. Pass what an extract helper returned, or a journey's context().",
            detail: { setting: "context" }
          });
        }
        if (isUsableEntity(propagated.carried)) {
          entity = copyEntity(propagated.carried);
        } else if (journeyId !== undefined && propagated.carried !== undefined) {
          reportEntity(
            "context",
            "continueJourney was given a context whose entity type and id are not both non-empty strings, so its entity was not used."
          );
        }
      }
    }

    if (journeyId === undefined) {
      const held = read("journeyId");
      if (isIdentifier(held)) {
        journeyId = held;
      } else if (held !== undefined) {
        diagnostics.report({
          kind: "configuration_error",
          code: "journey_id_invalid",
          reason:
            "continueJourney was given a journeyId that is not a non-empty string, so it was not used.",
          detail: { setting: "journeyId" }
        });
      }
    }

    if (entity === undefined) {
      const fallback = read("entity");
      if (isUsableEntity(fallback)) {
        entity = copyEntity(fallback);
      } else if (fallback !== undefined) {
        reportEntity(
          "entity",
          "continueJourney was given an entity whose type and id are not both non-empty strings, so its steps are recorded under the unknown entity."
        );
      } else {
        reportEntity(
          "entity",
          "continueJourney had no entity, from the context or the options, so its steps are recorded under the unknown entity. Pass the entity you have as entity."
        );
      }
    }

    return {
      journeyId: journeyId ?? `jrn_${randomUUID()}`,
      entity: entity ?? UNKNOWN_ENTITY
    };
  }

  /**
   * The distinct journeys in `journeys`, by id, in the order given.
   *
   * Something that is neither a journey nor a context is reported and left
   * out, so a bad element costs its own event and not the host's call.
   */
  function targetsOf(journeys: Iterable<Journey | JourneyContext>): Target[] {
    const seen = new Set<string>();
    const targets: Target[] = [];
    for (const one of journeys) {
      const target = safely(diagnostics, "capture_error", (): Target | undefined => {
        const candidate: unknown =
          typeof (one as Partial<Journey> | null)?.context === "function"
            ? (one as Journey).context()
            : one;
        if (!isContext(candidate)) {
          diagnostics.report({
            kind: "capture_error",
            code: "not_a_journey",
            reason: "across() was given something that is not a journey, so it was left out.",
            detail: {}
          });
          return undefined;
        }
        // Typed as a journey or a context, but a host can pass anything.
        const handle: unknown = one;
        const label =
          typeof handle === "object" && handle !== null ? labelOf.get(handle) : undefined;
        return { context: candidate, label: label ?? NO_LABEL };
      });
      // The first handle named wins, label and all, as the first id always has.
      if (target === undefined || seen.has(target.context.journeyId)) continue;
      seen.add(target.context.journeyId);
      targets.push(target);
    }
    return targets;
  }

  return {
    startJourney(options) {
      const entity =
        safely(diagnostics, "capture_error", () => startedEntity(options)) ?? UNKNOWN_ENTITY;
      const journey = makeJourney({ journeyId: `jrn_${randomUUID()}`, entity });
      // Each option is read inside the boundary, and apart, so a getter that
      // throws, or options that are not an object, cost that option and not
      // the journey the host is about to use.
      //
      // The label first, so the identify below carries it.
      safely(diagnostics, "capture_error", () => {
        const { label } = options;
        if (label !== undefined) journey.label(label);
      });
      safely(diagnostics, "capture_error", () => {
        reportRenamedOption(options, "displayable", "displayableAliases", "startJourney");
        const { aliases, displayableAliases } = options;
        if (aliases === undefined) return;
        journey.identify(
          aliases,
          displayableAliases === undefined ? undefined : { displayableAliases }
        );
      });
      return journey;
    },
    continueJourney(options) {
      const context = safely(diagnostics, "capture_error", () => continuedContext(options)) ?? {
        journeyId: `jrn_${randomUUID()}`,
        entity: UNKNOWN_ENTITY
      };
      const journey = makeJourney(context);
      const given: unknown = options;
      if (typeof given !== "object" || given === null) return journey;
      safely(diagnostics, "capture_error", () => {
        const { label } = options;
        if (label !== undefined) journey.label(label);
      });
      return journey;
    },
    journeyIdFor(entity) {
      const derived = safely(diagnostics, "capture_error", () => {
        const secret = resolved.journeyIdSecret;
        if (secretProblem !== undefined || secret === undefined) {
          reportSecretProblem(secretProblem ?? "journeyIdSecret is not usable.");
          return undefined;
        }
        const problem = entityProblem(entity);
        if (problem !== undefined) {
          diagnostics.report({
            kind: "configuration_error",
            code: "entity_invalid",
            reason: problem,
            detail: {}
          });
          return undefined;
        }
        return deriveJourneyId(secret, resolved.environment, entity);
      });
      return derived ?? `jrn_${randomUUID()}`;
    },
    across(journeys) {
      const targets = safely(diagnostics, "capture_error", () => targetsOf(journeys)) ?? [];
      return {
        ...operationsOn(targets),
        journeys: () => targets.map(({ context }) => context)
      };
    },
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
        hasContext(context, "injectHttpHeaders")
          ? injectHttpHeaders(headers, context, resolved.propagation)
          : headers
      ) ?? headers,
    extractHttpContext: (headers) =>
      safely(diagnostics, "capture_error", () => extractHttpContext(headers)),
    injectSqsAttributes: (attributes, context) =>
      safely(diagnostics, "capture_error", () => {
        if (hasContext(context, "injectSqsAttributes")) {
          return injectSqsAttributes(attributes, context, resolved.propagation);
        }
        // A context passed as the only argument would otherwise go out as the
        // message's attributes.
        return (isPropagated(attributes) ? {} : attributes) as typeof attributes &
          SqsMessageAttributes;
      }) ?? (attributes as typeof attributes & SqsMessageAttributes),
    extractSqsContext: (attributes) =>
      safely(diagnostics, "capture_error", () => extractSqsContext(attributes)),
    // Without a context there is no envelope to fill, so the payload goes out
    // in one with no journey, which extractPayload reads as no context.
    injectPayload: (payload, context) =>
      safely(diagnostics, "capture_error", () =>
        hasContext(context, "injectPayload")
          ? injectPayload(payload, context, resolved.propagation)
          : undefined
      ) ?? ({ _wayscribe: {}, data: payload } as unknown as ContextEnvelope<typeof payload>),
    extractPayload: (body) =>
      safely(diagnostics, "capture_error", () => extractPayload(body)) ?? { data: body },
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
    counters: () => diagnostics.counters()
  };
}
