import type { Counters } from "./diagnostics.js";
import type { Operation } from "./operations.js";
import type {
  ContextEnvelope,
  ExtractedPayload,
  HttpHeadersInput,
  PropagatedContext,
  SqsMessageAttributes
} from "./propagation.js";

/**
 * The public shapes of the recorder, its journeys and their options.
 *
 * Every optional property a host passes in is typed `?: T | undefined`, so a
 * host compiled with `exactOptionalPropertyTypes` can pass a value that may be
 * undefined, such as `process.env.JOURNEY_ID_SECRET`. The recorder already
 * treats an explicit `undefined` as absent.
 */

/** The record a journey is about: what it is, and its identifier. */
export interface Entity {
  type: string;
  id: string;
}

/** A journey's identity: its id and its entity. What `journey.context()` returns. */
export interface JourneyContext {
  journeyId: string;
  entity: Entity;
}

/**
 * An error as `record()` takes it. The wrappers and `fail()` build one from
 * the thrown value: its `message`, its `name` as `type`, and a string `code`.
 */
export interface ErrorInput {
  /** Masked for credential shapes and cut to 4,096 characters before it is queued. */
  message: string;
  /** Cut to 256 characters. */
  type?: string | undefined;
  /** Cut to 256 characters. */
  code?: string | undefined;
  /**
   * Masked like `message` and cut to 16,384 characters. The SDK never sends
   * one of its own, and SDK-22 says not to: a stack is the largest part of an
   * error, and the timeline already shows where the failure happened.
   */
  stack?: string | undefined;
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
  error?: ErrorInput | undefined;
  /** Other identifiers the record is known by, by alias type. */
  aliases?: Record<string, string> | undefined;
  /**
   * Alias types from `aliases` that a reader may see in full. Every other alias
   * is masked when read, and an alias is shown in full only while every event
   * that stated it listed it here (ADR-053).
   *
   * @defaultValue none: every alias is masked
   */
  displayableAliases?: readonly string[] | undefined;
  metadata?: Record<string, unknown> | undefined;
  /** How long the operation took, in whole milliseconds. */
  durationMs?: number | undefined;
  /**
   * When the operation began, in epoch milliseconds.
   *
   * The wrappers set this to the moment the callback started, because the
   * timeline orders by timestamp and a step must not sort after the work it
   * caused.
   *
   * @defaultValue the moment `record` is called
   */
  startedAt?: number | undefined;
}

/**
 * Options for the four wrappers. `T` is what the callback returns, resolved if
 * it returns a promise or another thenable, and `I` is the wrapper's input;
 * both are inferred.
 */
export interface WrapOptions<T = unknown, I = unknown> {
  /**
   * Marks a result that did not throw but represents a failure, such as an
   * HTTP 422. Receives the resolved value.
   */
  isFailure?: ((result: T) => boolean) | undefined;
  /**
   * 1 for a first attempt. Anything higher records `retried` (ADR-022), with
   * the attempt in metadata.
   *
   * @defaultValue 1
   */
  attempt?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
  /**
   * What to record as the input, given the input. Runs when the wrapper is
   * called, before the callback, and what it returns is copied there and then,
   * so the record is the input as it went in even when the projection returns
   * objects the callback goes on to change. The callback still runs with
   * whatever it closes over; this changes only what is recorded.
   *
   * Synchronous. A projection that throws or returns a promise records
   * `[UNCAPTURABLE]` and a `payload_omitted` diagnostic with code
   * `projection_failed`, and never reaches your code.
   *
   * @experimental The projection signature came from one dogfood pass.
   */
  captureInput?: ((input: I, journey: JourneyContext) => unknown) | undefined;
  /**
   * What to record as the output, given the callback's resolved value. The
   * wrapper still returns the value itself: a callback returning a `Buffer` can
   * record `{ bytes: buffer.length }` and hand the caller the `Buffer`. Not
   * called when the callback throws. Same failure rule as `captureInput`.
   *
   * @experimental The projection signature came from one dogfood pass.
   */
  captureOutput?: ((result: T, journey: JourneyContext) => unknown) | undefined;
}

export interface FailOptions {
  metadata?: Record<string, unknown> | undefined;
}

export interface FinishOptions {
  /**
   * `completed` records `completed`; `failed` records `failed`.
   *
   * @defaultValue "completed"
   */
  status?: "completed" | "failed" | undefined;
}

/**
 * What a journey and a group of journeys both do. On a group, each call
 * records one event per journey, with its own id and the same timing, and a
 * wrapper runs its callback once.
 *
 * Each wrapper returns what its callback returns, in the same shape: a
 * callback returning a value returns that value, and one returning a promise,
 * or any other thenable, returns a native promise of its resolved value. So
 * instrumenting a synchronous call does not change the control flow around it.
 */
export interface JourneyOperations {
  /** Records one event. Never waits on the network. */
  record(input: RecordInput): void;
  /** Runs `fn` and records `transformed`, with `input` and what `fn` returned. */
  transform<T, I = unknown>(
    name: string,
    input: I,
    fn: () => PromiseLike<T>,
    options?: WrapOptions<Awaited<T>, I>
  ): Promise<Awaited<T>>;
  transform<T, I = unknown>(name: string, input: I, fn: () => T, options?: WrapOptions<T, I>): T;
  /** Runs `fn` and records `persisted`. */
  persist<T, I = unknown>(
    name: string,
    input: I,
    fn: () => PromiseLike<T>,
    options?: WrapOptions<Awaited<T>, I>
  ): Promise<Awaited<T>>;
  persist<T, I = unknown>(name: string, input: I, fn: () => T, options?: WrapOptions<T, I>): T;
  /** Runs `fn` and records `published`. */
  publish<T, I = unknown>(
    name: string,
    message: I,
    fn: () => PromiseLike<T>,
    options?: WrapOptions<Awaited<T>, I>
  ): Promise<Awaited<T>>;
  publish<T, I = unknown>(name: string, message: I, fn: () => T, options?: WrapOptions<T, I>): T;
  /** Runs `fn` and records `delivered`. */
  deliver<T, I = unknown>(
    name: string,
    payload: I,
    fn: () => PromiseLike<T>,
    options?: WrapOptions<Awaited<T>, I>
  ): Promise<Awaited<T>>;
  deliver<T, I = unknown>(name: string, payload: I, fn: () => T, options?: WrapOptions<T, I>): T;
  /**
   * Records `failed`, for a terminal failure such as a dead-letter move. A
   * failed attempt that will be retried is the attempt's own operation with an
   * error, which the wrappers record.
   */
  fail(name: string, error: unknown, options?: FailOptions): void;
  /** Records `completed`, or `failed`, named `finish`. */
  finish(options?: FinishOptions): void;
}

export interface IdentifyOptions {
  /**
   * Alias types that may be shown in full to a reader. List a type every time
   * you state it, because an alias is shown only while every statement of it
   * says so (ADR-053).
   *
   * @defaultValue none: every alias is masked
   */
  displayableAliases?: readonly string[] | undefined;
}

export interface Journey extends JourneyOperations {
  context(): JourneyContext;
  /** Records an `identified` event carrying `aliases`. */
  identify(aliases: Record<string, string>, options?: IdentifyOptions): void;
  /**
   * Names the journey for the Journeys page, where partial text finds it.
   * Records nothing itself: every later event of this journey object carries
   * the label, including events recorded through `across`. The server keeps the
   * label of the event that started last, so repeating it costs nothing, and a
   * lost event cannot take the label with it.
   *
   * Stored and shown in plain text, and never redacted: do not put personal
   * data in it. Over 200 code points it is cut to 199 and `…`, and reported as
   * `payload_truncated`. Anything that is not a non-empty string is left unset,
   * keeping any earlier label, and reported as `key_dropped`. Never throws.
   *
   * @experimental It depends on the Journeys page, which is new.
   */
  label(text: string): void;
}

/**
 * Several journeys that one operation touched, such as a digest written once
 * for many records. There is no `identify`: an alias identifies one record.
 * There is no `label` either, for the same reason; an event a group records
 * carries the label of the journey it is recorded on.
 *
 * @experimental The name, the deduplication and label rules, and what an
 * empty group does came from one dogfood pass.
 */
export interface JourneyGroup extends JourneyOperations {
  /** The journeys this group records on, each once, in the order given. */
  journeys(): JourneyContext[];
}

export interface StartJourneyOptions {
  entity: Entity;
  /** Passed to the `identify` that starting with aliases records. */
  aliases?: Record<string, string> | undefined;
  /**
   * Passed to that `identify`, as `IdentifyOptions.displayableAliases`.
   *
   * @defaultValue none: every alias is masked
   */
  displayableAliases?: readonly string[] | undefined;
  /**
   * Set before anything is recorded, as `journey.label` would set it.
   *
   * @experimental As `Journey.label`.
   */
  label?: string | undefined;
}

/**
 * How to join a journey that started elsewhere: from a context another
 * process propagated, or from a journey id this process already has.
 *
 * The journey id is the context's, else `journeyId`, else a new random one.
 * The entity is the context's, else `entity`, else `{ type: "unknown", id:
 * "unknown" }`. At the default propagation level the entity's id does not
 * cross the boundary, so a consumer passes the entity it has from the message.
 */
export interface ContinueJourneyOptions {
  /** What `extractHttpContext`, `extractSqsContext` or `extractPayload` returned, or a journey's context. */
  context?: PropagatedContext | undefined;
  /** A journey id this process already holds, used when there is no context. */
  journeyId?: string | undefined;
  /** The entity to use when the context carries none. */
  entity?: Entity | undefined;
  /**
   * Set before anything is recorded, as `journey.label` would set it.
   *
   * @experimental As `Journey.label`.
   */
  label?: string | undefined;
}

export interface ShutdownOptions {
  /**
   * How long to spend delivering what is queued before giving it up.
   *
   * @defaultValue 2000
   */
  timeoutMs?: number | undefined;
}

export interface Recorder {
  /** Starts a new journey, with a random id, for `entity`. */
  startJourney(options: StartJourneyOptions): Journey;
  /**
   * Joins a journey that started elsewhere. Records nothing by itself.
   *
   * @example `recorder.continueJourney({ context: recorder.extractSqsContext(attributes), entity })`
   */
  continueJourney(options: ContinueJourneyOptions): Journey;
  /**
   * The journey id for an entity, the same on every run and every machine,
   * derived under `journeyIdSecret` so that it cannot be guessed from the
   * entity (ADR-052). The environment is part of the derivation.
   *
   * Never throws. Without a usable secret it reports a `configuration_error`
   * and returns a fresh random id, so recording goes on and nothing guessable
   * is ever produced.
   *
   * @experimental The derivation is fixed by test vectors; the surface around
   * it, such as secret rotation, is new.
   */
  journeyIdFor(entity: Entity): string;
  /**
   * The journeys one operation touched, to record it on each of them in one
   * call. A journey named twice, by handle or by context, is recorded once.
   *
   * @experimental As `JourneyGroup`.
   */
  across(journeys: Iterable<Journey | JourneyContext>): JourneyGroup;
  /**
   * A copy of `headers` with the journey added, at the configured
   * `propagation` level. Without a context, `headers` unchanged.
   *
   * @experimental The header names wait on the propagation specification.
   */
  injectHttpHeaders(
    headers: Record<string, string>,
    context: PropagatedContext
  ): Record<string, string>;
  /**
   * The journey an inbound request carried, or undefined when it carried none
   * that is well formed. Pass the result to `continueJourney` as `context`.
   *
   * @experimental As `injectHttpHeaders`.
   */
  extractHttpContext(headers: HttpHeadersInput | undefined): PropagatedContext | undefined;
  /**
   * A copy of `attributes` with the journey added as SQS or SNS message
   * attributes, at the configured `propagation` level.
   *
   * @experimental The attribute names wait on the propagation specification.
   */
  injectSqsAttributes<A extends object>(
    attributes: A,
    context: PropagatedContext
  ): A & SqsMessageAttributes;
  /**
   * The journey a message's attributes carried, or undefined. Takes the SQS
   * attribute shape or plain name-to-value pairs.
   *
   * @experimental As `injectSqsAttributes`.
   */
  extractSqsContext(attributes: unknown): PropagatedContext | undefined;
  /**
   * `payload` in an envelope beside the journey, for a carrier with no headers
   * or attributes. The payload itself is not changed.
   *
   * @experimental The envelope's key waits on the propagation specification.
   */
  injectPayload<T>(payload: T, context: PropagatedContext): ContextEnvelope<T>;
  /**
   * The payload from an envelope, and its journey. A body that is not an
   * envelope comes back as `data`, with no context.
   *
   * @experimental As `injectPayload`.
   */
  extractPayload(body: unknown): ExtractedPayload;
  /** Sends everything queued now, and resolves when it has been sent or given up on. */
  flush(): Promise<void>;
  /**
   * Stops accepting events, delivers what is queued within `timeoutMs`, gives
   * up the rest as `dropped`, and resolves with the final counters. Never
   * throws and never hangs.
   */
  shutdown(options?: ShutdownOptions): Promise<Counters>;
  /** The counters so far, as a copy. */
  counters(): Counters;
}
