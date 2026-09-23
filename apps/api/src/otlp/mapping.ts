import { parseEnvelope, PROTOCOL_VERSION, type JourneyEvent } from "@wayscribe/protocol";
import {
  convertAnyValue,
  createAnyValueBudget,
  type AnyValueBudget,
  type ConvertedAnyValue
} from "./any-value.js";
import type {
  DecodedExport,
  OtlpAnyValue,
  OtlpKeyValue,
  OtlpLogRecord,
  OtlpResource,
  OtlpScope
} from "./types.js";

export type MappingRefusalCode =
  | "duplicate_attribute"
  | "duplicate_map_key"
  | "ambiguous_any_value"
  | "invalid_any_value"
  | "invalid_timestamp"
  | "missing_attribute"
  | "invalid_attribute_type"
  | "invalid_attribute_value"
  | "environment_unresolved"
  | "invalid_event";

export interface MappedEnvelope {
  protocolVersion: "0.1";
  event: JourneyEvent;
}

export type MappedLog =
  | {
      ok: true;
      envelope: MappedEnvelope;
      /**
       * Present only for an id derived from the record's content: the same
       * derivation under the previous key during a rotation, so a retry that
       * straddles the rotation can find the event its first attempt stored.
       */
      alternateIds?: readonly string[];
    }
  | { ok: false; code: MappingRefusalCode };

export interface MapOptions {
  /**
   * The environment the API key is scoped to, used when the resource carries
   * no `deployment.environment.name`. A resource that names one keeps it, and
   * ingestion refuses it when it is not the key's.
   */
  environment?: string | undefined;
  /**
   * Ids for a record that states neither `wayscribe.event.id` nor
   * `log.record.uid`, from its canonical content: the current key's id first,
   * then the previous key's during a rotation. Keyed, because the content is
   * unredacted (ADR-048).
   */
  fallbackEventIds?: (content: string) => readonly [string, ...string[]];
}

export function mapExport(decoded: DecodedExport, options: MapOptions = {}): readonly MappedLog[] {
  const mapped: MappedLog[] = [];
  for (const resourceLogs of decoded.resourceLogs) {
    const resource = mapResource(resourceLogs.resource, options.environment);
    for (const scopeLogs of resourceLogs.scopeLogs) {
      for (const record of scopeLogs.logRecords) {
        mapped.push(
          resource.ok
            ? mapRecord(record, resource.value, {
                resource: resourceLogs.resource,
                scope: scopeLogs.scope,
                fallbackEventIds: options.fallbackEventIds
              })
            : resource
        );
      }
    }
  }
  return mapped;
}

interface RecordContext {
  resource: OtlpResource | undefined;
  scope: OtlpScope | undefined;
  fallbackEventIds: MapOptions["fallbackEventIds"];
}

const resourceKeys = new Set(["service.name", "deployment.environment.name", "service.version"]);

const logKeys = new Set([
  "wayscribe.event.id",
  "log.record.uid",
  "wayscribe.journey.id",
  "wayscribe.entity.type",
  "wayscribe.entity.id",
  "wayscribe.operation",
  "wayscribe.name",
  "wayscribe.input",
  "wayscribe.output",
  "wayscribe.metadata",
  "wayscribe.aliases",
  "wayscribe.displayable_aliases",
  "wayscribe.journey.label",
  "wayscribe.attempt",
  "wayscribe.duration_ms",
  "wayscribe.error",
  "wayscribe.parent_event.id",
  "wayscribe.message.id",
  "wayscribe.correlation.id"
]);

type Failure = { ok: false; code: MappingRefusalCode };
type Result<T> = { ok: true; value: T } | Failure;

interface ResourceFields {
  service: string;
  environment: string;
  version?: string;
}

function failure(code: MappingRefusalCode): Failure {
  return { ok: false, code };
}

function mapResource(
  resource: OtlpResource | undefined,
  keyEnvironment: string | undefined
): Result<ResourceFields> {
  const attributes = collectAttributes(resource?.attributes ?? [], resourceKeys);
  if (!attributes.ok) return attributes;
  const budget = createAnyValueBudget();
  const service = readString(attributes.value, "service.name", budget);
  if (!service.ok) return service;
  let environment: Result<string>;
  if (attributes.value.has("deployment.environment.name")) {
    environment = readString(attributes.value, "deployment.environment.name", budget);
  } else if (keyEnvironment !== undefined && keyEnvironment !== "") {
    environment = { ok: true, value: keyEnvironment };
  } else {
    environment = failure("environment_unresolved");
  }
  if (!environment.ok) return environment;
  if (!attributes.value.has("service.version")) {
    return { ok: true, value: { service: service.value, environment: environment.value } };
  }
  const version = readString(attributes.value, "service.version", budget);
  if (!version.ok) return version;
  return {
    ok: true,
    value: { service: service.value, environment: environment.value, version: version.value }
  };
}

function mapRecord(
  record: OtlpLogRecord,
  resource: ResourceFields,
  context: RecordContext
): MappedLog {
  const attributes = collectAttributes(record.attributes, logKeys);
  if (!attributes.ok) return attributes;
  const timestamp = toTimestamp(record);
  if (!timestamp.ok) return timestamp;
  const budget = createAnyValueBudget();

  let id: Result<string>;
  let alternateIds: readonly string[] = [];
  if (attributes.value.has("wayscribe.event.id")) {
    id = readString(attributes.value, "wayscribe.event.id", budget);
  } else if (attributes.value.has("log.record.uid")) {
    id = readString(attributes.value, "log.record.uid", budget);
  } else if (context.fallbackEventIds !== undefined) {
    const [current, ...previous] = context.fallbackEventIds(
      recordContent(record, resource.environment, context)
    );
    id = { ok: true, value: current };
    alternateIds = previous;
  } else {
    id = failure("missing_attribute");
  }
  if (!id.ok) return id;
  const journeyId = readString(attributes.value, "wayscribe.journey.id", budget);
  if (!journeyId.ok) return journeyId;
  const entityType = readString(attributes.value, "wayscribe.entity.type", budget);
  if (!entityType.ok) return entityType;
  const entityId = readString(attributes.value, "wayscribe.entity.id", budget);
  if (!entityId.ok) return entityId;
  const operation = readString(attributes.value, "wayscribe.operation", budget);
  if (!operation.ok) return operation;
  const name = readString(attributes.value, "wayscribe.name", budget);
  if (!name.ok) return name;

  const event: Record<string, unknown> = {
    id: id.value,
    journeyId: journeyId.value,
    environment: resource.environment,
    service: resource.service,
    entity: { type: entityType.value, id: entityId.value },
    operation: operation.value,
    name: name.value,
    timestamp: timestamp.value
  };
  if (resource.version !== undefined) event["deployment"] = { version: resource.version };

  for (const [attributeKey, eventKey] of [
    ["wayscribe.input", "input"],
    ["wayscribe.output", "output"]
  ] as const) {
    if (!attributes.value.has(attributeKey)) continue;
    const converted = mappedValue(attributes.value.get(attributeKey), budget);
    if (!converted.ok) return converted;
    event[eventKey] = converted.value;
  }

  if (attributes.value.has("wayscribe.aliases")) {
    const aliases = readStringMap(attributes.value.get("wayscribe.aliases"), budget);
    if (!aliases.ok) return aliases;
    event["aliases"] = aliases.value;
  }
  if (attributes.value.has("wayscribe.displayable_aliases")) {
    const displayable = readStringArray(
      attributes.value.get("wayscribe.displayable_aliases"),
      budget
    );
    if (!displayable.ok) return displayable;
    event["displayableAliases"] = displayable.value;
  }

  for (const [attributeKey, eventKey] of [
    ["wayscribe.journey.label", "journeyLabel"],
    ["wayscribe.parent_event.id", "parentEventId"],
    ["wayscribe.message.id", "messageId"],
    ["wayscribe.correlation.id", "correlationId"]
  ] as const) {
    if (!attributes.value.has(attributeKey)) continue;
    const value = readString(attributes.value, attributeKey, budget);
    if (!value.ok) return value;
    event[eventKey] = value.value;
  }

  let metadata: Record<string, ConvertedAnyValue> | undefined;
  if (attributes.value.has("wayscribe.metadata")) {
    const value = readMetadata(attributes.value.get("wayscribe.metadata"), budget);
    if (!value.ok) return value;
    metadata = value.value;
  }
  if (attributes.value.has("wayscribe.attempt")) {
    const attempt = readInteger(attributes.value.get("wayscribe.attempt"), budget);
    if (!attempt.ok) return attempt;
    if (attempt.value <= 0) return failure("invalid_attribute_value");
    metadata ??= Object.create(null) as Record<string, ConvertedAnyValue>;
    Object.defineProperty(metadata, "attempt", {
      value: attempt.value,
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  if (metadata !== undefined) event["metadata"] = metadata;

  if (attributes.value.has("wayscribe.duration_ms")) {
    const duration = readInteger(attributes.value.get("wayscribe.duration_ms"), budget);
    if (!duration.ok) return duration;
    if (duration.value < 0) return failure("invalid_attribute_value");
    event["durationMs"] = duration.value;
  }
  if (attributes.value.has("wayscribe.error")) {
    const error = readError(attributes.value.get("wayscribe.error"), budget);
    if (!error.ok) return error;
    event["error"] = error.value;
  }

  const traceId = traceIdentifier(record.traceId, 16);
  if (traceId !== undefined) event["traceId"] = traceId;
  const spanId = traceIdentifier(record.spanId, 8);
  if (spanId !== undefined) event["spanId"] = spanId;

  const envelope = { protocolVersion: PROTOCOL_VERSION, event };
  const parsed = parseEnvelope(envelope);
  if (!parsed.ok) return failure("invalid_event");
  return {
    ok: true,
    envelope: { protocolVersion: PROTOCOL_VERSION, event: parsed.event },
    ...(alternateIds.length > 0 ? { alternateIds } : {})
  };
}

/**
 * The content a fallback event id is derived from: the resolved environment,
 * the whole resource and instrumentation scope, and the whole log record as
 * decoded (both timestamps at full nanosecond precision, severity, body, every
 * attribute including unmapped ones, flags, trace and span ids, event name and
 * dropped-attribute counts). Unknown fields and schema URLs are not part of
 * it. A Collector retry resends the same record, so it derives the same id;
 * JSON and protobuf decode to the same structure, so either encoding does.
 */
function recordContent(record: OtlpLogRecord, environment: string, context: RecordContext): string {
  return JSON.stringify(
    { environment, resource: context.resource ?? null, scope: context.scope ?? null, record },
    (_key: string, value: unknown): unknown => {
      if (typeof value === "bigint") return `${value.toString()}n`;
      if (isBufferJson(value)) return `bytes:${Buffer.from(value.data).toString("hex")}`;
      return value;
    }
  );
}

function isBufferJson(value: unknown): value is { type: "Buffer"; data: number[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "Buffer" &&
    Array.isArray((value as { data?: unknown }).data)
  );
}

function collectAttributes(
  attributes: OtlpKeyValue[],
  known: ReadonlySet<string>
): Result<Map<string, OtlpAnyValue | undefined>> {
  const values = new Map<string, OtlpAnyValue | undefined>();
  for (const attribute of attributes) {
    const key = attribute.key ?? "";
    if (!known.has(key)) continue;
    if (values.has(key)) return failure("duplicate_attribute");
    values.set(key, attribute.value);
  }
  return { ok: true, value: values };
}

function mappedValue(
  value: OtlpAnyValue | undefined,
  budget: AnyValueBudget
): Result<ConvertedAnyValue> {
  const converted = convertAnyValue(value, budget);
  return converted.ok ? converted : failure(converted.code);
}

function readString(
  values: ReadonlyMap<string, OtlpAnyValue | undefined>,
  key: string,
  budget: AnyValueBudget
): Result<string> {
  if (!values.has(key)) return failure("missing_attribute");
  return readOriginalString(values.get(key), budget);
}

function readOriginalString(
  value: OtlpAnyValue | undefined,
  budget: AnyValueBudget
): Result<string> {
  const converted = mappedValue(value, budget);
  if (!converted.ok) return converted;
  if (!hasOnlyMember(value, "stringValue") || typeof value?.stringValue !== "string")
    return failure("invalid_attribute_type");
  return { ok: true, value: value.stringValue };
}

function readInteger(value: OtlpAnyValue | undefined, budget: AnyValueBudget): Result<number> {
  const converted = mappedValue(value, budget);
  if (!converted.ok) return converted;
  if (!hasOnlyMember(value, "intValue") && !hasOnlyMember(value, "doubleValue"))
    return failure("invalid_attribute_type");
  if (typeof converted.value !== "number" || !Number.isSafeInteger(converted.value))
    return failure("invalid_attribute_value");
  return { ok: true, value: converted.value };
}

function readStringMap(
  value: OtlpAnyValue | undefined,
  budget: AnyValueBudget
): Result<Record<string, string>> {
  const converted = mappedValue(value, budget);
  if (!converted.ok) return converted;
  if (!hasOnlyMember(value, "kvlistValue") || !isRecord(converted.value))
    return failure("invalid_attribute_type");
  for (const entry of value?.kvlistValue?.values ?? []) {
    const item = readOriginalString(entry.value, createAnyValueBudget());
    if (!item.ok) return item;
  }
  return { ok: true, value: converted.value as Record<string, string> };
}

function readStringArray(
  value: OtlpAnyValue | undefined,
  budget: AnyValueBudget
): Result<string[]> {
  const converted = mappedValue(value, budget);
  if (!converted.ok) return converted;
  if (!hasOnlyMember(value, "arrayValue") || !Array.isArray(converted.value))
    return failure("invalid_attribute_type");
  for (const item of value?.arrayValue?.values ?? []) {
    const checked = readOriginalString(item, createAnyValueBudget());
    if (!checked.ok) return checked;
  }
  return { ok: true, value: converted.value as string[] };
}

function readMetadata(
  value: OtlpAnyValue | undefined,
  budget: AnyValueBudget
): Result<Record<string, ConvertedAnyValue>> {
  const converted = mappedValue(value, budget);
  if (!converted.ok) return converted;
  if (!hasOnlyMember(value, "kvlistValue") || !isRecord(converted.value))
    return failure("invalid_attribute_type");
  for (const item of Object.values(converted.value)) {
    if (
      item !== null &&
      typeof item !== "string" &&
      typeof item !== "boolean" &&
      typeof item !== "number"
    )
      return failure("invalid_attribute_type");
  }
  return { ok: true, value: converted.value };
}

function readError(
  value: OtlpAnyValue | undefined,
  budget: AnyValueBudget
): Result<Record<string, string>> {
  const converted = mappedValue(value, budget);
  if (!converted.ok) return converted;
  if (!hasOnlyMember(value, "kvlistValue") || !isRecord(converted.value))
    return failure("invalid_attribute_type");
  const error: Record<string, string> = {};
  for (const entry of value?.kvlistValue?.values ?? []) {
    const key = entry.key ?? "";
    if (!new Set(["type", "message", "code", "stack"]).has(key)) continue;
    const item = readOriginalString(entry.value, createAnyValueBudget());
    if (!item.ok) return item;
    error[key] = item.value;
  }
  return { ok: true, value: error };
}

function hasOnlyMember(value: OtlpAnyValue | undefined, expected: keyof OtlpAnyValue): boolean {
  if (!value || !Object.hasOwn(value, expected) || value[expected] === undefined) return false;
  return [
    "stringValue",
    "boolValue",
    "intValue",
    "doubleValue",
    "arrayValue",
    "kvlistValue",
    "bytesValue"
  ].every((member) => member === expected || value[member as keyof OtlpAnyValue] === undefined);
}

function isRecord(value: ConvertedAnyValue): value is Record<string, ConvertedAnyValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toTimestamp(record: OtlpLogRecord): Result<string> {
  const nanoseconds =
    record.timeUnixNano !== undefined && record.timeUnixNano !== 0n
      ? record.timeUnixNano
      : record.observedTimeUnixNano;
  if (nanoseconds === undefined || nanoseconds <= 0n) return failure("invalid_timestamp");
  const milliseconds = nanoseconds / 1_000_000n;
  if (milliseconds > 8_640_000_000_000_000n) return failure("invalid_timestamp");
  try {
    return { ok: true, value: new Date(Number(milliseconds)).toISOString() };
  } catch {
    return failure("invalid_timestamp");
  }
}

function traceIdentifier(value: Buffer | undefined, length: number): string | undefined {
  if (!Buffer.isBuffer(value) || value.length !== length || value.every((byte) => byte === 0))
    return undefined;
  return value.toString("hex");
}
