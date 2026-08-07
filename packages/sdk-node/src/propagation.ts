export type PropagationLevel = "journey-only" | "journey-and-type" | "full";

export interface PropagatedContext {
  journeyId: string;
  entity?: { type: string; id: string };
}

const HEADER_JOURNEY = "x-flight-journey-id";
const HEADER_ENTITY_TYPE = "x-flight-entity-type";
const HEADER_ENTITY_ID = "x-flight-entity-id";

const ATTR_JOURNEY = "flightJourneyId";
const ATTR_ENTITY_TYPE = "flightEntityType";
const ATTR_ENTITY_ID = "flightEntityId";

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
      : { entityType: context.entity.type, entityId: context.entity.id })
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
    ...headers,
    [HEADER_JOURNEY]: fields.journeyId,
    ...(fields.entityType === undefined ? {} : { [HEADER_ENTITY_TYPE]: fields.entityType }),
    ...(fields.entityId === undefined ? {} : { [HEADER_ENTITY_ID]: fields.entityId })
  };
}

export function extractHttpContext(
  headers: Record<string, string | string[] | undefined> | undefined
): PropagatedContext | undefined {
  if (headers === undefined) return undefined;
  return build(
    single(headers[HEADER_JOURNEY]),
    single(headers[HEADER_ENTITY_TYPE]),
    single(headers[HEADER_ENTITY_ID])
  );
}

export function toQueueAttributes(
  context: PropagatedContext,
  level: PropagationLevel = "journey-and-type"
): Record<string, { DataType: string; StringValue: string }> {
  const fields = fieldsFor(context, level);
  const attribute = (StringValue: string): { DataType: string; StringValue: string } => ({
    DataType: "String",
    StringValue
  });

  return {
    [ATTR_JOURNEY]: attribute(fields.journeyId),
    ...(fields.entityType === undefined
      ? {}
      : { [ATTR_ENTITY_TYPE]: attribute(fields.entityType) }),
    ...(fields.entityId === undefined ? {} : { [ATTR_ENTITY_ID]: attribute(fields.entityId) })
  };
}

export function fromQueueAttributes(attributes: unknown): PropagatedContext | undefined {
  if (typeof attributes !== "object" || attributes === null) return undefined;
  const record = attributes as Record<string, unknown>;
  return build(
    attributeValue(record[ATTR_JOURNEY]),
    attributeValue(record[ATTR_ENTITY_TYPE]),
    attributeValue(record[ATTR_ENTITY_ID])
  );
}

export function wrapPayload(
  payload: unknown,
  context: PropagatedContext,
  level: PropagationLevel = "journey-and-type"
): { _flight: Fields; data: unknown } {
  return { _flight: fieldsFor(context, level), data: payload };
}

export function unwrapPayload(body: unknown): { context?: PropagatedContext; data: unknown } {
  if (typeof body !== "object" || body === null || !("_flight" in body)) {
    return { data: body };
  }

  // Read through a record: narrowing on `"_flight" in body` gives an intersection
  // that will not accept a cast to a shape with a `data` field.
  const record = body as Record<string, unknown>;
  const envelope = record["_flight"];
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

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
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
