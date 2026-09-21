import protobuf from "protobufjs";
import { MAX_BATCH_EVENTS } from "@wayscribe/protocol";
import { descriptor } from "./schema/descriptor.js";
import type { DecodedExport, OtlpEncoding } from "./types.js";
export type { DecodedExport, OtlpEncoding } from "./types.js";

/** Request-wide ceilings, independent of the route's smaller configured byte cap. */
export const OTLP_LIMITS = Object.freeze({
  bodyBytes: 67_108_864,
  resourceLogs: 100,
  scopeLogs: 100,
  records: MAX_BATCH_EVENTS,
  attributes: 10_000,
  anyValues: 20_000,
  anyValueDepth: 24,
  messages: 65_536,
  readerOperations: 262_144,
  jsonDepth: 128,
  jsonWork: 262_144,
  numericCharacters: 128,
  exponentMagnitude: 10_000,
  responseBytes: 256
});
export type OtlpDecodeCode = "invalid_otlp" | "otlp_limit_exceeded";
export class OtlpDecodeError extends Error {
  constructor(readonly code: OtlpDecodeCode = "invalid_otlp") {
    super(code);
    this.name = "OtlpDecodeError";
  }
}
function invalid(): never {
  throw new OtlpDecodeError();
}
function limit(): never {
  throw new OtlpDecodeError("otlp_limit_exceeded");
}
const root = protobuf.Root.fromJSON(descriptor).resolveAll();
const requestType = root.lookupType(
  "opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest"
);
const responseType = root.lookupType(
  "opentelemetry.proto.collector.logs.v1.ExportLogsServiceResponse"
);
const statusType = root.lookupType("google.rpc.Status");
const utf8 = new TextDecoder("utf-8", { fatal: true });

class Budget {
  messages = 0;
  resourceLogs = 0;
  scopeLogs = 0;
  records = 0;
  attributes = 0;
  anyValues = 0;
  enter(type: protobuf.Type, depth: number): number {
    if (++this.messages > OTLP_LIMITS.messages) limit();
    switch (type.name) {
      case "ResourceLogs":
        if (++this.resourceLogs > OTLP_LIMITS.resourceLogs) limit();
        break;
      case "ScopeLogs":
        if (++this.scopeLogs > OTLP_LIMITS.scopeLogs) limit();
        break;
      case "LogRecord":
        if (++this.records > OTLP_LIMITS.records) limit();
        break;
      case "KeyValue":
        if (++this.attributes > OTLP_LIMITS.attributes) limit();
        break;
      case "AnyValue":
        if (++this.anyValues > OTLP_LIMITS.anyValues || ++depth > OTLP_LIMITS.anyValueDepth)
          limit();
    }
    return depth;
  }
}
interface Frame {
  type: protobuf.Type;
  tag: boolean;
  depth: number;
  wide: boolean;
  field: protobuf.Field | undefined;
  singular: Map<number, protobuf.Message>;
}
/** The library owns wire parsing. These request-local guards validate its read
 * boundaries and schema wire types; they never reconstruct a wire value. */
class BoundedReader extends protobuf.Reader {
  readonly budget = new Budget();
  readonly frames: Frame[] = [];
  operations = 0;
  skipping = 0;
  readingString = false;
  lastWord = 0;
  override uint32(): number {
    if (++this.operations > OTLP_LIMITS.readerOperations) limit();
    const frame = this.frames.at(-1);
    const start = this.pos;
    const value = super.uint32();
    this.lastWord = value;
    this.varintEnd(start, this.skipping === 0 && (frame?.wide ?? false));
    if (this.skipping || !frame) return value;
    if (!frame.tag) {
      frame.tag = true;
      frame.wide = false;
      return value;
    }
    if (value >>> 3 === 0) invalid();
    const field = frame.type.fieldsById[value >>> 3];
    frame.field = field;
    if (field) {
      const kind = field.resolvedType instanceof protobuf.Enum ? "int32" : field.type;
      const wire =
        field.resolvedType instanceof protobuf.Type
          ? 2
          : (protobuf.types.basic as Record<string, number | undefined>)[kind];
      if (wire === undefined || (value & 7) !== wire) invalid();
      // Only these library field readers consume uint32 after the tag.
      frame.tag = !["uint32", "int32", "bool", "string", "bytes"].includes(kind) && wire !== 2;
      frame.wide = kind === "int32" || kind === "bool";
    }
    return value;
  }
  private varintEnd(start: number, wide: boolean): void {
    const length = this.pos - start;
    const last = this.buf[this.pos - 1];
    if (this.pos > this.len || last === undefined || last > 127 || length > 10) invalid();
    if (length === 10 && last > 1) invalid();
    // uint32 may advance over bytes6..10 without examining their terminators.
    // Validate only its claimed scalar span (at most9 preceding bytes).
    for (let index = start; index < this.pos - 1; index++)
      if (((this.buf[index] ?? 0) & 0x80) === 0) invalid();
    if (!wide && length >= 5) {
      if ((this.buf[start + 4] ?? 0) & 0x70) invalid();
      for (let index = start + 5; index < this.pos; index++)
        if ((this.buf[index] ?? 0) & 0x7f) invalid();
    }
  }
  override int64(): protobuf.Long {
    const start = this.pos;
    const value = super.int64();
    this.varintEnd(start, true);
    return value;
  }
  override string(): string {
    this.readingString = true;
    try {
      return super.string();
    } finally {
      this.readingString = false;
    }
  }
  override bytes(): Uint8Array {
    const value = super.bytes();
    if (this.readingString) utf8.decode(value);
    return value;
  }
  override skip(length?: number): this {
    const start = this.pos;
    super.skip(length);
    if (length === undefined) this.varintEnd(start, true);
    return this;
  }
  override skipType(wireType: number, depth?: number): this {
    const tag = this.lastWord;
    if (tag >>> 3 === 0) invalid();
    this.skipping++;
    // The extra depth argument is part of the pinned runtime, not its .d.ts.
    const skip: (wire: number, depth?: number) => protobuf.Reader =
      protobuf.Reader.prototype.skipType.bind(this);
    try {
      skip(wireType, depth);
      if (wireType === 3 && this.lastWord >>> 3 !== tag >>> 3) invalid();
      return this;
    } finally {
      this.skipping--;
    }
  }
}

/** Merge decoded objects only. Append owned arrays in place so repeated
 * occurrences cannot turn a bounded wire input into quadratic copying. */
function mergeMessages(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  type: protobuf.Type
): void {
  for (const field of type.fieldsArray) {
    if (!Object.hasOwn(source, field.name)) continue;
    const incoming = source[field.name];
    const prior = target[field.name];
    if (field.repeated && Array.isArray(prior) && Array.isArray(incoming)) {
      for (const item of incoming) prior.push(item);
    } else if (
      field.resolvedType instanceof protobuf.Type &&
      Object.hasOwn(target, field.name) &&
      prior !== undefined &&
      prior !== null &&
      incoming !== null
    ) {
      mergeMessages(object(prior), object(incoming), field.resolvedType);
    } else {
      target[field.name] = incoming;
    }
  }
}
function guardDecoders(namespace: protobuf.Namespace): void {
  for (const value of namespace.nestedArray) {
    if (value instanceof protobuf.Type) {
      value.setup();
      const decode: (
        reader: protobuf.Reader,
        length?: number,
        end?: number,
        nesting?: number
      ) => protobuf.Message = value.decode.bind(value);
      value.decode = function (reader, length, end?: number, nesting?: number): protobuf.Message {
        if (!(reader instanceof BoundedReader)) invalid();
        const parent = reader.frames.at(-1);
        const field = parent?.field;
        const depth = reader.budget.enter(value, parent?.depth ?? 0);
        reader.frames.push({
          type: value,
          tag: true,
          depth,
          wide: false,
          field: undefined,
          singular: new Map()
        });
        try {
          const decoded = decode(reader, length, end, nesting);
          if (parent && field && !field.repeated) {
            const prior = parent.singular.get(field.id);
            if (prior) {
              mergeMessages(object(prior), object(decoded), value);
              return prior;
            }
            parent.singular.set(field.id, decoded);
          }
          return decoded;
        } finally {
          reader.frames.pop();
        }
      };
    }
    if (value instanceof protobuf.Namespace) guardDecoders(value);
  }
}
guardDecoders(root);

class NumericLexeme {
  constructor(readonly source: string) {}
}
/** Count each opening/closing container, comma, colon and opening quote outside
 * strings as one work unit. Backslash skips its next byte inside strings.
 * This is a conservative allocation/depth preflight, not a JSON parser. */
function jsonPreflight(body: Buffer): void {
  let depth = 0;
  let work = 0;
  let quoted = false;
  for (let index = 0; index < body.length; index++) {
    const byte = body[index];
    if (quoted) {
      if (byte === 92) index++;
      else if (byte === 34) quoted = false;
      continue;
    }
    if (byte === 34) quoted = true;
    if (byte === 123 || byte === 91) {
      if (++depth > OTLP_LIMITS.jsonDepth) limit();
    }
    if (byte === 125 || byte === 93) depth--;
    if (
      byte === 34 ||
      byte === 123 ||
      byte === 91 ||
      byte === 125 ||
      byte === 93 ||
      byte === 44 ||
      byte === 58
    ) {
      if (++work > OTLP_LIMITS.jsonWork) limit();
    }
  }
}
function parseJson(body: Buffer): unknown {
  jsonPreflight(body);
  return JSON.parse(
    utf8.decode(body),
    (_key: string, value: unknown, context?: { source?: string }): unknown => {
      if (typeof value !== "number") return value;
      if (context?.source === undefined) invalid();
      return new NumericLexeme(context.source);
    }
  ) as unknown;
}
function integer(value: unknown, min: bigint, max: bigint): bigint {
  const source = value instanceof NumericLexeme ? value.source : value;
  if (typeof source !== "string") invalid();
  if (source.length > OTLP_LIMITS.numericCharacters) limit();
  const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(source);
  if (!match) invalid();
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > OTLP_LIMITS.exponentMagnitude)
    limit();
  let digits = (String(match[2]) + fraction).replace(/^0+/, "");
  let scale = exponent - fraction.length;
  if (!digits) return 0n;
  while (scale < 0 && digits.endsWith("0")) {
    digits = digits.slice(0, -1);
    scale++;
  }
  if (scale < 0 || digits.length + scale > 20) invalid();
  const result = BigInt(String(match[1]) + digits + "0".repeat(scale));
  if (result < min || result > max) invalid();
  return result;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof NumericLexeme)
    invalid();
  return value as Record<string, unknown>;
}
function scalar(value: unknown, field: protobuf.Field, encoding: OtlpEncoding): unknown {
  const kind = field.resolvedType instanceof protobuf.Enum ? "enum" : field.type;
  switch (kind) {
    case "string":
      if (typeof value !== "string") invalid();
      return value;
    case "bool":
      if (typeof value !== "boolean") invalid();
      return value;
    case "bytes":
      if (encoding === "protobuf") {
        if (!(value instanceof Uint8Array)) invalid();
        return Buffer.from(value);
      }
      if (typeof value !== "string") invalid();
      if (field.name === "traceId" || field.name === "spanId") {
        if (!/^(?:[a-fA-F0-9]{2})*$/.test(value)) invalid();
        return Buffer.from(value, "hex");
      }
      if (
        !/^(?:[A-Za-z0-9+/_-]{4})*(?:[A-Za-z0-9+/_-]{2}(?:==)?|[A-Za-z0-9+/_-]{3}=?)?$/.test(value)
      )
        invalid();
      return Buffer.from(value, "base64");
    case "int64":
    case "fixed64":
      if (encoding === "protobuf") {
        if (!(value instanceof protobuf.util.Long)) invalid();
        const bits = (BigInt(value.high >>> 0) << 32n) | BigInt(value.low >>> 0);
        return kind === "int64" ? BigInt.asIntN(64, bits) : bits;
      }
      return integer(
        value,
        kind === "int64" ? -(1n << 63n) : 0n,
        kind === "int64" ? (1n << 63n) - 1n : (1n << 64n) - 1n
      );
    case "enum":
    case "uint32":
    case "fixed32":
    case "int32": {
      if (encoding === "protobuf") {
        if (typeof value !== "number" || !Number.isInteger(value)) invalid();
        return value;
      }
      if (kind === "enum" && !(value instanceof NumericLexeme)) invalid();
      const signed = kind === "enum" || kind === "int32";
      return Number(integer(value, signed ? -2147483648n : 0n, signed ? 2147483647n : 4294967295n));
    }
    case "double": {
      if (encoding === "protobuf") {
        if (typeof value !== "number") invalid();
        return value;
      }
      if (typeof value === "string" && ["NaN", "Infinity", "-Infinity"].includes(value))
        return Number(value);
      const source = value instanceof NumericLexeme ? value.source : value;
      if (
        typeof source !== "string" ||
        !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(source)
      )
        invalid();
      if (source.length > OTLP_LIMITS.numericCharacters) limit();
      const result = Number(source);
      if (!Number.isFinite(result)) invalid();
      return result;
    }
    default:
      return invalid();
  }
}
function convert(
  value: unknown,
  type: protobuf.Type,
  encoding: OtlpEncoding,
  budget: Budget,
  depth: number
): Record<string, unknown> {
  const input = object(value);
  const nextDepth = budget.enter(type, depth);
  const result: Record<string, unknown> = {};
  for (const field of type.fieldsArray) {
    const present =
      Object.hasOwn(input, field.name) &&
      input[field.name] !== null &&
      input[field.name] !== undefined;
    if (!present) {
      if (field.repeated) result[field.name] = [];
      continue;
    }
    const source = input[field.name];
    const one = (item: unknown): unknown =>
      field.resolvedType instanceof protobuf.Type
        ? convert(item, field.resolvedType, encoding, budget, nextDepth)
        : scalar(item, field, encoding);
    const converted = field.repeated
      ? Array.isArray(source)
        ? source.map(one)
        : invalid()
      : one(source);
    // Profiling dictionary indexes have no semantic value for log ingestion.
    if (field.name !== "stringValueStrindex" && field.name !== "keyStrindex")
      result[field.name] = converted;
  }
  return result;
}
export function decodeExport(body: Buffer, encoding: OtlpEncoding): DecodedExport {
  try {
    if (body.length > OTLP_LIMITS.bodyBytes) limit();
    const input: unknown =
      encoding === "protobuf" ? requestType.decode(new BoundedReader(body)) : parseJson(body);
    const budget = new Budget();
    const result = convert(input, requestType, encoding, budget, 0);
    return { ...result, recordCount: budget.records } as unknown as DecodedExport;
  } catch (error) {
    if (error instanceof OtlpDecodeError) throw error;
    throw new OtlpDecodeError();
  }
}

export const OTLP_PARTIAL_MESSAGE = "Some log records were rejected.";
export const OTLP_STATUS_MESSAGES = Object.freeze({
  invalid: Object.freeze({ code: 3, message: "Invalid OTLP request." }),
  unauthenticated: Object.freeze({ code: 16, message: "Authentication required." }),
  forbidden: Object.freeze({ code: 7, message: "Permission denied." }),
  oversized: Object.freeze({ code: 8, message: "OTLP request exceeds limits." }),
  unsupported: Object.freeze({ code: 3, message: "Unsupported OTLP encoding." }),
  unavailable: Object.freeze({ code: 14, message: "OTLP ingestion unavailable." })
});
function response(
  value: Record<string, unknown>,
  type: protobuf.Type,
  encoding: OtlpEncoding
): Buffer {
  const result =
    encoding === "json"
      ? Buffer.from(JSON.stringify(value))
      : Buffer.from(type.encode(type.fromObject(value)).finish());
  if (result.length > OTLP_LIMITS.responseBytes) throw new RangeError("invalid_otlp_response");
  return result;
}
export function encodeExportResponse(
  value: { rejectedLogRecords?: number; errorMessage?: string },
  encoding: OtlpEncoding
): Buffer {
  const rejected = value.rejectedLogRecords ?? 0;
  if (
    !Number.isSafeInteger(rejected) ||
    rejected < 0 ||
    rejected > MAX_BATCH_EVENTS ||
    (value.errorMessage !== undefined && value.errorMessage !== OTLP_PARTIAL_MESSAGE)
  )
    throw new RangeError("invalid_otlp_response");
  return response(
    rejected === 0
      ? {}
      : {
          partialSuccess: {
            rejectedLogRecords: String(rejected),
            errorMessage: OTLP_PARTIAL_MESSAGE
          }
        },
    responseType,
    encoding
  );
}
export function encodeStatus(
  value: { code: number; message: string },
  encoding: OtlpEncoding
): Buffer {
  if (
    !Object.values(OTLP_STATUS_MESSAGES).some(
      (safe) => safe.code === value.code && safe.message === value.message
    )
  )
    throw new RangeError("invalid_otlp_response");
  return response({ code: value.code, message: value.message }, statusType, encoding);
}
