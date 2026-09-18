import type { Entity } from "./types.js";

/**
 * Carrying a journey across a process boundary: in HTTP headers, in SQS
 * message attributes, or in an envelope around a payload.
 *
 * The rule for the names is `inject<Carrier>` and `extract<Carrier>Context`,
 * as OpenTelemetry's propagators have it. The header, attribute and envelope
 * names themselves, and their value grammar, are not yet fixed by a
 * propagation specification, so all of this is experimental until one is.
 */

/**
 * What crosses a boundary. `journey-only`: the journey id. `journey-and-type`:
 * the journey id and the entity type. `full`: those and the entity id. Aliases
 * never cross, at any level.
 *
 * @experimental The names and grammar wait on the propagation specification.
 */
export type PropagationLevel = "journey-only" | "journey-and-type" | "full";

/**
 * A journey as it crossed a boundary: its id, and its entity when the level
 * sent one. A journey's own context is one.
 *
 * @experimental As `PropagationLevel`.
 */
export interface PropagatedContext {
  journeyId: string;
  entity?: Entity | undefined;
}

/**
 * Anything `extractHttpContext` reads: a fetch `Headers`, or a plain object of
 * header names to values such as Node's `IncomingHttpHeaders`. Values that are
 * not strings are ignored, and of a list the first is read.
 *
 * @experimental As `PropagationLevel`.
 */
export type HttpHeadersInput =
  | { get(name: string): string | null }
  | Readonly<Record<string, string | readonly string[] | number | undefined>>;

/**
 * One SQS or SNS message attribute, as `injectSqsAttributes` writes it.
 *
 * @experimental As `PropagationLevel`.
 */
export interface SqsMessageAttributeValue {
  DataType: string;
  StringValue: string;
}

/**
 * SQS or SNS message attributes, by name.
 *
 * @experimental As `PropagationLevel`.
 */
export type SqsMessageAttributes = Record<string, SqsMessageAttributeValue>;

/**
 * A payload with the journey beside it, for a carrier with no headers or
 * attributes. The envelope's key waits on the propagation specification.
 *
 * @experimental As `PropagationLevel`.
 */
export interface ContextEnvelope<T> {
  _wayscribe: { journeyId: string; entityType?: string; entityId?: string };
  data: T;
}

/**
 * The envelope a payload goes out in when there was no journey to inject: the
 * same shape with nothing in it, so `extractPayload` can read the absence of a
 * journey later rather than guess at it.
 *
 * It exists because the value the SDK itself produces did not satisfy
 * `ContextEnvelope`, and the SDK's own source cast it to get past the type
 * checker; anything reproducing the shape, such as a recorder that records
 * nothing, needed the same cast (F-014, ADR-060).
 *
 * @experimental As `PropagationLevel`.
 */
export interface NoContextEnvelope<T> {
  _wayscribe: { journeyId?: undefined };
  data: T;
}

/**
 * What `injectPayload` returns: the envelope with the journey, or the one
 * without.
 *
 * TypeScript does not narrow a union on a nested property, so reading
 * `envelope._wayscribe.journeyId` leaves the value typed as the union, however
 * the check is written. `hasJourney` is the narrowing; the usual path is
 * `extractPayload`, which hands back the context and the payload apart.
 *
 * @experimental As `PropagationLevel`.
 */
export type PayloadEnvelope<T> = ContextEnvelope<T> | NoContextEnvelope<T>;

/**
 * Whether a value is an envelope carrying a journey, narrowing it to
 * `ContextEnvelope`.
 *
 * For a reader holding an envelope, such as a queue consumer typed on its job
 * payload, or a body typed `unknown`: the nested `journeyId` cannot narrow the
 * union on its own, and this saves the cast that would otherwise be written in
 * its place. Most consumers want `extractPayload` instead, which returns the
 * context and the payload apart and reads a body that is not an envelope at
 * all.
 *
 * `false` answers two different questions alike: the value is not an envelope
 * (`{ a: 1 }`), or it is an envelope with no journey (`{ _wayscribe: {}, data
 * }`). A caller that must tell those apart, to unwrap `data` from the second
 * but not the first, reads `_wayscribe` itself (F-034).
 *
 * There is no type parameter, because `data` is never read and one the caller
 * set would assert the payload's type unchecked (ADR-062). None is needed: a
 * `PayloadEnvelope<Job>` narrows to `ContextEnvelope<Job>` inside the guard
 * and to `NoContextEnvelope<Job>` in its `else`, and a body typed `unknown`
 * narrows to `ContextEnvelope<unknown>`, whose `data` is the caller's to check.
 *
 * Takes anything, because a body off a queue is whatever was put there, and
 * never throws: a value whose reads fail is a value with no journey, and a
 * public entry point does not propagate into the caller's code.
 *
 * @experimental As `PropagationLevel`.
 */
export function hasJourney(envelope: unknown): envelope is ContextEnvelope<unknown> {
  if (typeof envelope !== "object" || envelope === null) return false;
  try {
    // Both reads inside: a getter is the host's own code, and a revoked Proxy,
    // or one whose get trap throws, fails on the first of them.
    const carried: unknown = (envelope as { _wayscribe?: unknown })._wayscribe;
    if (typeof carried !== "object" || carried === null) return false;
    const { journeyId } = carried as { journeyId?: unknown };
    return typeof journeyId === "string" && journeyId !== "";
  } catch {
    // Nothing usable is there to read, which is the answer.
    return false;
  }
}

/**
 * What `extractPayload` returns: the payload, and the journey when the body
 * was an envelope that carried a usable one.
 *
 * @experimental As `PropagationLevel`.
 */
export interface ExtractedPayload {
  context?: PropagatedContext;
  data: unknown;
}

const HEADER_JOURNEY = "x-wayscribe-journey-id";
const HEADER_ENTITY_TYPE = "x-wayscribe-entity-type";
const HEADER_ENTITY_ID = "x-wayscribe-entity-id";

const ATTR_JOURNEY = "wayscribeJourneyId";
const ATTR_ENTITY_TYPE = "wayscribeEntityType";
const ATTR_ENTITY_ID = "wayscribeEntityId";

const HEADERS: ReadonlySet<string> = new Set([
  HEADER_JOURNEY,
  HEADER_ENTITY_TYPE,
  HEADER_ENTITY_ID
]);
const ATTRIBUTES: ReadonlySet<string> = new Set([ATTR_JOURNEY, ATTR_ENTITY_TYPE, ATTR_ENTITY_ID]);

/**
 * A copy of `carrier` without the journey's own names. A carrier forwarded
 * from an inbound message still holds that journey's values, and merging over
 * them would pair an old entity id with the new journey whenever the level
 * does not send one. HTTP names compare without case; SQS names with it.
 */
function without<C extends object>(
  carrier: C,
  names: ReadonlySet<string>,
  fold: (name: string) => string
): C {
  const copy: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(carrier)) {
    if (!names.has(fold(name))) copy[name] = value;
  }
  return copy as C;
}

const MAX_VALUE_LENGTH = 256;
// Printable, no whitespace or control characters: enough for our own identifiers,
// and it rejects header injection outright.
const SAFE_VALUE = /^[\w.:@=+-]+$/;

interface Fields {
  journeyId: string;
  entityType?: string;
  entityId?: string;
}

/**
 * Which fields a level emits.
 *
 * Aliases appear in no branch and are not configurable: SECURITY.md section 10
 * states that unconditionally, and an alias is exactly the identifier a
 * downstream system should not receive incidentally.
 */
function fieldsFor(context: PropagatedContext, level: PropagationLevel): Fields {
  // Guarded: this used to dereference `context.journeyId` on whatever it was
  // handed, and callers hand it the result of `extractHttpContext`, which
  // returns undefined for any request that did not carry context.
  if ((context as PropagatedContext | undefined) === undefined) {
    throw new TypeError("A journey context is required to propagate.");
  }

  if (level === "journey-only") return { journeyId: context.journeyId };

  if (level === "journey-and-type") {
    return {
      journeyId: context.journeyId,
      ...(context.entity === undefined ? {} : { entityType: context.entity.type })
    };
  }

  return {
    journeyId: context.journeyId,
    ...(context.entity === undefined
      ? {}
      : {
          entityType: context.entity.type,
          // Validated on the way out, not just on the way in. An entity id is
          // whatever the application's data contains: "José-42" and
          // "ORD/2024/12" were injected happily and then silently dropped by
          // the consumer's own validation, so `full` quietly did nothing, while
          // "顧客-42" threw a TypeError out of the caller's fetch and "C123\r"
          // threw ERR_INVALID_CHAR from node:http.
          ...(isSafe(context.entity.id) ? { entityId: context.entity.id } : {})
        })
  };
}

export function injectHttpHeaders(
  headers: Record<string, string>,
  context: PropagatedContext,
  level: PropagationLevel = "journey-and-type"
): Record<string, string> {
  const fields = fieldsFor(context, level);
  // A copy: mutating the caller's header object would surprise anyone reusing it.
  return {
    ...without(headers, HEADERS, (name) => name.toLowerCase()),
    [HEADER_JOURNEY]: fields.journeyId,
    ...(fields.entityType === undefined ? {} : { [HEADER_ENTITY_TYPE]: fields.entityType }),
    ...(fields.entityId === undefined ? {} : { [HEADER_ENTITY_ID]: fields.entityId })
  };
}

export function extractHttpContext(
  headers: HttpHeadersInput | undefined
): PropagatedContext | undefined {
  // Typed as never null, but a plain-JavaScript host can pass anything.
  const given: unknown = headers;
  if (typeof given !== "object" || given === null) return undefined;
  const read = headerReader(given as HttpHeadersInput);
  return build(read(HEADER_JOURNEY), read(HEADER_ENTITY_TYPE), read(HEADER_ENTITY_ID));
}

/**
 * How to read one header, by its lower-case name. A `Headers` object compares
 * names without case itself; a plain object is read by the exact name first,
 * as Node gives it, and then by any key that differs only in case.
 */
function headerReader(headers: HttpHeadersInput): (name: string) => string | undefined {
  const get = (headers as { get?: unknown }).get;
  if (typeof get === "function") {
    return (name) => stringOrUndefined((get as (key: string) => unknown).call(headers, name));
  }
  const record = headers as Readonly<Record<string, unknown>>;
  return (name) => {
    if (Object.hasOwn(record, name)) return single(record[name]);
    const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === name);
    return key === undefined ? undefined : single(record[key]);
  };
}

export function injectSqsAttributes<A extends object>(
  attributes: A,
  context: PropagatedContext,
  level: PropagationLevel = "journey-and-type"
): A & SqsMessageAttributes {
  const fields = fieldsFor(context, level);
  const attribute = (StringValue: string): SqsMessageAttributeValue => ({
    DataType: "String",
    StringValue
  });

  // A copy, as the HTTP helper makes: the caller may reuse its attributes.
  return {
    ...without(attributes, ATTRIBUTES, (name) => name),
    [ATTR_JOURNEY]: attribute(fields.journeyId),
    ...(fields.entityType === undefined
      ? {}
      : { [ATTR_ENTITY_TYPE]: attribute(fields.entityType) }),
    ...(fields.entityId === undefined ? {} : { [ATTR_ENTITY_ID]: attribute(fields.entityId) })
  };
}

export function extractSqsContext(attributes: unknown): PropagatedContext | undefined {
  if (typeof attributes !== "object" || attributes === null) return undefined;
  const record = attributes as Record<string, unknown>;
  return build(
    attributeValue(record[ATTR_JOURNEY]),
    attributeValue(record[ATTR_ENTITY_TYPE]),
    attributeValue(record[ATTR_ENTITY_ID])
  );
}

export function injectPayload<T>(
  payload: T,
  context: PropagatedContext,
  level: PropagationLevel = "journey-and-type"
): ContextEnvelope<T> {
  return { _wayscribe: fieldsFor(context, level), data: payload };
}

export function extractPayload(body: unknown): ExtractedPayload {
  if (typeof body !== "object" || body === null || !("_wayscribe" in body)) {
    return { data: body };
  }

  // Read through a record: narrowing on `"_wayscribe" in body` gives an intersection
  // that will not accept a cast to a shape with a `data` field.
  const record = body as Record<string, unknown>;
  const envelope = record["_wayscribe"];
  const data = record["data"];
  if (typeof envelope !== "object" || envelope === null) return { data };

  const fields = envelope as Record<string, unknown>;
  const context = build(
    stringOrUndefined(fields["journeyId"]),
    stringOrUndefined(fields["entityType"]),
    stringOrUndefined(fields["entityId"])
  );
  return context === undefined ? { data } : { context, data };
}

/** Accepts either the SQS attribute shape or a plain value. */
function attributeValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "StringValue" in value) {
    // The `in` check already narrows; no assertion needed.
    return stringOrUndefined(value.StringValue);
  }
  return undefined;
}

/** A header's value: the value itself, or the first of a list, if it is a string. */
function single(value: unknown): string | undefined {
  return stringOrUndefined(Array.isArray(value) ? (value as unknown[])[0] : value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Build a context from untrusted input.
 *
 * Rejecting a malformed journey ID means the consumer starts a fresh journey
 * rather than joining a corrupted one. This stops injection, absurd lengths, and
 * control characters. It does not stop a well-formed forgery, and is not an
 * authorization control.
 */
function build(
  journeyId: string | undefined,
  entityType: string | undefined,
  entityId: string | undefined
): PropagatedContext | undefined {
  if (!isSafe(journeyId) || !journeyId.startsWith("jrn_")) return undefined;

  if (isSafe(entityType) && isSafe(entityId)) {
    return { journeyId, entity: { type: entityType, id: entityId } };
  }
  return { journeyId };
}

function isSafe(value: string | undefined): value is string {
  return (
    value !== undefined &&
    value.length > 0 &&
    value.length <= MAX_VALUE_LENGTH &&
    SAFE_VALUE.test(value)
  );
}
