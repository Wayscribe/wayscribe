import { randomUUID } from "node:crypto";
import {
  DEFAULT_LIMITS,
  checkLimits,
  maskSecretsInText,
  redact,
  toStorable
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
import { createTraceReader } from "./trace.js";
import { Transport, UnsentError, type SendOutcome } from "./transport.js";

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

export interface WrapOptions {
  /** Marks a result that did not throw but represents a failure, e.g. HTTP 422. */
  isFailure?: (result: unknown) => boolean;
  /** 1 for a first attempt. Anything higher records `retried` (ADR-022). */
  attempt?: number;
  metadata?: Record<string, unknown>;
}

export interface Journey {
  context(): JourneyContext;
  record(input: RecordInput): void;
  identify(aliases: Record<string, string>): void;
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
    options?: WrapOptions
  ): Promise<T>;
  transform<T>(name: string, input: unknown, fn: () => T, options?: WrapOptions): T;
  persist<T>(name: string, input: unknown, fn: () => Promise<T>, options?: WrapOptions): Promise<T>;
  persist<T>(name: string, input: unknown, fn: () => T, options?: WrapOptions): T;
  publish<T>(
    name: string,
    message: unknown,
    fn: () => Promise<T>,
    options?: WrapOptions
  ): Promise<T>;
  publish<T>(name: string, message: unknown, fn: () => T, options?: WrapOptions): T;
  deliver<T>(
    name: string,
    payload: unknown,
    fn: () => Promise<T>,
    options?: WrapOptions
  ): Promise<T>;
  deliver<T>(name: string, payload: unknown, fn: () => T, options?: WrapOptions): T;
  fail(name: string, error: unknown, metadata?: Record<string, unknown>): void;
  finish(options?: { status?: "completed" | "failed" }): void;
}

export interface Recorder {
  startJourney(options: {
    entity: { type: string; id: string };
    aliases?: Record<string, string>;
  }): Journey;
  continueJourney(context: JourneyContext): Journey;
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
 * A body this cannot parse counts as nothing stored and nothing to retry. The
 * request did return 2xx, and resending on a proxy's rewritten body would
 * duplicate work the server most likely did.
 */
function readOutcome(
  body: unknown,
  batch: readonly unknown[],
  diagnostics: Diagnostics
): SendOutcome {
  const results = (body as { data?: { results?: BatchOutcome[] } } | null)?.data?.results;
  if (!Array.isArray(results)) return { accepted: 0, retry: [] };

  let accepted = 0;
  const retry: unknown[] = [];
  let reason: string | undefined;
  let logReason: string | undefined;
  results.forEach((result, index) => {
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

export function createRecorder(config: RecorderConfig): Recorder {
  const resolved = resolveConfig(config);
  const diagnostics = createDiagnostics(resolved.onDiagnostic, { log: resolved.logDiagnostics });
  safely(diagnostics, "capture_error", () => {
    warnIfInsecure(resolved.endpoint, diagnostics);
  });
  const queue = new BoundedQueue<unknown>(resolved.maxBufferedEvents, diagnostics);
  // Resolved once: record() is synchronous, so this cannot be an async import.
  const readTrace = createTraceReader();
  let stopped = false;
  let delivered = false;

  const transport = new Transport(
    {
      send: async (batch) => {
        const controller = new AbortController();
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
          const outcome = readOutcome(await response.json(), batch, diagnostics);
          const { accepted } = outcome;
          if (accepted > 0 && !delivered) {
            // Once: this answers "is it connected?", and repeating the answer
            // on every batch would be exactly the noise logDiagnostics avoids.
            delivered = true;
            const endpoint = maskSecretsInText(resolved.endpoint);
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
        }
      },
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
   */
  function capture(value: unknown): unknown {
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
      const limits = checkLimits(value, {
        ...DEFAULT_LIMITS,
        maxBytes: resolved.maxPayloadBytes,
        // Scaled with the budget the operator actually set. Overriding only
        // maxBytes left maxStringLength pinned at 64 KiB, so raising
        // maxPayloadBytes to 5 MB still discarded a 70 KB HTML email body —
        // while the README documents maxPayloadBytes as the knob for exactly
        // that. A single string cannot exceed the whole payload anyway.
        maxStringLength: Math.max(DEFAULT_LIMITS.maxStringLength, resolved.maxPayloadBytes)
      });
      if (!limits.ok) {
        // Discarding a payload silently made a full timeline look like a step
        // that genuinely carried nothing.
        diagnostics.report({
          kind: "dropped",
          reason: `A payload was not captured: ${limits.reason}.`,
          detail: { reason: limits.reason }
        });
        return TOO_LARGE;
      }

      // Sanitized last, so redaction markers are untouched and every string
      // that leaves this process is one PostgreSQL will accept.
      return toStorable(redact(value, resolved.redact));
    } catch {
      return UNCAPTURABLE;
    }
  }

  /** Captured metadata, or nothing at all when it cannot be represented. */
  function metadataFor(metadata: Record<string, unknown> | undefined): {
    metadata?: Record<string, unknown>;
  } {
    if (metadata === undefined) return {};
    const captured = capture(metadata);
    if (typeof captured !== "object" || captured === null) return {};
    return { metadata: captured as Record<string, unknown> };
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

  function enqueue(journeyId: string, entity: JourneyContext["entity"], input: RecordInput): void {
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

    queue.push({
      protocolVersion: "0.1",
      event: {
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
        ...(input.input === undefined ? {} : { input: capture(input.input) }),
        ...(input.output === undefined ? {} : { output: capture(input.output) }),
        ...(input.error === undefined ? {} : { error: maskedError(input.error) }),
        ...(input.aliases === undefined ? {} : { aliases: input.aliases }),
        // Through capture like input and output: metadata used to go in raw,
        // so a Prisma BigInt or a circular request object threw inside
        // JSON.stringify at flush time and took the whole batch with it.
        //
        // Omitted rather than replaced when capture cannot represent it. The
        // protocol types metadata as a record, so substituting a marker string
        // makes the whole event fail validation — trading a lost payload for a
        // lost event, which is the worse half of the trade.
        ...metadataFor(input.metadata)
      }
    });

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
      // Ordering matters: a retried batch must not reorder the timeline. Only
      // what is still unsent goes back; events stored on an earlier attempt
      // would otherwise be sent, and counted, twice.
      queue.requeue(error instanceof UnsentError ? error.unsent : batch);
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
    // the ones already in flight and push past the concurrency cap. What
    // follows is sequential by construction.
    await settle();

    let previous = Number.POSITIVE_INFINITY;
    while (queue.size() > 0 && queue.size() < previous) {
      previous = queue.size();
      await flush();
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
    context: JourneyContext,
    naturalOperation: Operation,
    name: string,
    input: unknown,
    fn: () => T | Promise<T>,
    options: WrapOptions = {}
  ): T | Promise<T> {
    const startedAt = Date.now();
    const attempt = options.attempt ?? 1;
    // ADR-022: a retry records as `retried` rather than the natural verb.
    const operation = attempt > 1 ? "retried" : naturalOperation;
    const metadata =
      options.metadata === undefined && attempt === 1
        ? undefined
        : { ...options.metadata, attempt };

    const recordFailure = (error: unknown): void => {
      safely(diagnostics, "capture_error", () => {
        enqueue(context.journeyId, context.entity, {
          operation,
          name,
          input,
          startedAt,
          durationMs: Date.now() - startedAt,
          error: toErrorRecord(error),
          ...(metadata === undefined ? {} : { metadata })
        });
      });
    };

    const recordSuccess = (result: T): void => {
      safely(diagnostics, "capture_error", () => {
        const failed = options.isFailure === undefined ? false : options.isFailure(result);
        enqueue(context.journeyId, context.entity, {
          operation,
          name,
          input,
          output: result,
          startedAt,
          durationMs: Date.now() - startedAt,
          ...(failed
            ? { error: { message: `${name} reported a failed result.`, code: "result_failed" } }
            : {}),
          ...(metadata === undefined ? {} : { metadata })
        });
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

  function makeJourney(context: JourneyContext): Journey {
    return {
      context: () => context,
      record(input) {
        safely(diagnostics, "capture_error", () => {
          enqueue(context.journeyId, context.entity, input);
        });
      },
      identify(aliases) {
        safely(diagnostics, "capture_error", () => {
          enqueue(context.journeyId, context.entity, {
            operation: "identified",
            name: "identify",
            // Top-level, not under metadata: EVENT_PROTOCOL puts aliases on the
            // event itself, and ingestion reads them from there. Nested, they
            // are accepted and then ignored, costing every alias-based search.
            aliases
          });
        });
      },
      transform: (name, input, fn, options) =>
        wrap(context, "transformed", name, input, fn, options),
      persist: (name, input, fn, options) => wrap(context, "persisted", name, input, fn, options),
      publish: (name, message, fn, options) =>
        wrap(context, "published", name, message, fn, options),
      deliver: (name, payload, fn, options) =>
        wrap(context, "delivered", name, payload, fn, options),
      fail(name, error, metadata) {
        safely(diagnostics, "capture_error", () => {
          enqueue(context.journeyId, context.entity, {
            operation: "failed",
            name,
            error: toErrorRecord(error),
            ...(metadata === undefined ? {} : { metadata })
          });
        });
      },
      finish(options) {
        safely(diagnostics, "capture_error", () => {
          enqueue(context.journeyId, context.entity, {
            operation: options?.status === "failed" ? "failed" : "completed",
            name: "finish"
          });
        });
      }
    };
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
      if (options.aliases !== undefined) journey.identify(options.aliases);
      return journey;
    },
    continueJourney: (context) => makeJourney(context),
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
      await Promise.race([
        safelyAsync(diagnostics, "transport_error", drainAll),
        new Promise((resolve) => {
          setTimeout(resolve, timeoutMs);
        })
      ]);
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
