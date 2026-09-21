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
  OtlpResource
} from "./types.js";

export type MappingRefusalCode =
  | "duplicate_attribute"
  | "duplicate_map_key"
  | "ambiguous_any_value"
  | "invalid_any_value"
  | "invalid_timestamp"
  | "invalid_event";

export interface MappedEnvelope {
  protocolVersion: "0.1";
  event: JourneyEvent;
}

export type MappedLog =
  { ok: true; envelope: MappedEnvelope } | { ok: false; code: MappingRefusalCode };

export function mapExport(decoded: DecodedExport): readonly MappedLog[] {
  const mapped: MappedLog[] = [];
  for (const resourceLogs of decoded.resourceLogs) {
    const resource = mapResource(resourceLogs.resource);
    for (const scopeLogs of resourceLogs.scopeLogs) {
      for (const record of scopeLogs.logRecords) {
        mapped.push(resource.ok ? mapRecord(record, resource.value) : resource);
      }
    }
  }
  return mapped;
}

const resourceKeys = new Set(["service.name", "deployment.environment.name", "service.version"]);

const logKeys = new Set([
  "wayscribe.event.id",
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

function mapResource(resource: OtlpResource | undefined): Result<ResourceFields> {
  const attributes = collectAttributes(resource?.attributes ?? [], resourceKeys);
  if (!attributes.ok) return attributes;
  const budget = createAnyValueBudget();
  const service = readString(attributes.value, "service.name", budget);
  if (!service.ok) return service;
  const environment = readString(attributes.value, "deployment.environment.name", budget);
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

function mapRecord(record: OtlpLogRecord, resource: ResourceFields): MappedLog {
  const attributes = collectAttributes(record.attributes, logKeys);
  if (!attributes.ok) return attributes;
  const timestamp = toTimestamp(record);
  if (!timestamp.ok) return timestamp;
  const budget = createAnyValueBudget();

  const id = readString(attributes.value, "wayscribe.event.id", budget);
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
    if (!attempt.ok || attempt.value <= 0) return failure("invalid_event");
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
    if (!duration.ok || duration.value < 0) return failure("invalid_event");
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
    envelope: { protocolVersion: PROTOCOL_VERSION, event: parsed.event }
  };
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
  if (!values.has(key)) return failure("invalid_event");
  return readOriginalString(values.get(key), budget);
}

function readOriginalString(
  value: OtlpAnyValue | undefined,
  budget: AnyValueBudget
): Result<string> {
  const converted = mappedValue(value, budget);
  if (!converted.ok) return converted;
  if (!hasOnlyMember(value, "stringValue") || typeof value?.stringValue !== "string")
    return failure("invalid_event");
  return { ok: true, value: value.stringValue };
}

function readInteger(value: OtlpAnyValue | undefined, budget: AnyValueBudget): Result<number> {
  const converted = mappedValue(value, budget);
  if (!converted.ok) return converted;
  if (!hasOnlyMember(value, "intValue") && !hasOnlyMember(value, "doubleValue"))
    return failure("invalid_event");
  if (typeof converted.value !== "number" || !Number.isSafeInteger(converted.value))
    return failure("invalid_event");
  return { ok: true, value: converted.value };
}

function readStringMap(
  value: OtlpAnyValue | undefined,
  budget: AnyValueBudget
): Result<Record<string, string>> {
  const converted = mappedValue(value, budget);
  if (!converted.ok) return converted;
  if (!hasOnlyMember(value, "kvlistValue") || !isRecord(converted.value))
    return failure("invalid_event");
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
    return failure("invalid_event");
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
    return failure("invalid_event");
  for (const item of Object.values(converted.value)) {
    if (
      item !== null &&
      typeof item !== "string" &&
      typeof item !== "boolean" &&
      typeof item !== "number"
    )
      return failure("invalid_event");
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
    return failure("invalid_event");
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
