import type { OtlpAnyValue } from "./types.js";
import { OTLP_LIMITS } from "./codec.js";

export type ConvertedAnyValue =
  null | string | boolean | number | ConvertedAnyValue[] | { [key: string]: ConvertedAnyValue };

export type AnyValueRefusalCode = "duplicate_map_key" | "ambiguous_any_value" | "invalid_any_value";

export type AnyValueResult =
  { ok: true; value: ConvertedAnyValue } | { ok: false; code: AnyValueRefusalCode };

export interface AnyValueBudget {
  anyValues: number;
  attributes: number;
}

export function createAnyValueBudget(): AnyValueBudget {
  return { anyValues: 0, attributes: 0 };
}

const members = [
  "stringValue",
  "boolValue",
  "intValue",
  "doubleValue",
  "arrayValue",
  "kvlistValue",
  "bytesValue"
] as const;

export function convertAnyValue(
  value: OtlpAnyValue | undefined,
  budget: AnyValueBudget = createAnyValueBudget()
): AnyValueResult {
  return convert(value, budget, 1);
}

function convert(
  value: OtlpAnyValue | undefined,
  budget: AnyValueBudget,
  depth: number
): AnyValueResult {
  if (value === undefined) return { ok: true, value: null };
  if (++budget.anyValues > OTLP_LIMITS.anyValues || depth > OTLP_LIMITS.anyValueDepth)
    return { ok: false, code: "invalid_any_value" };

  const present = members.filter(
    (member) => Object.hasOwn(value, member) && value[member] !== undefined
  );
  if (present.length > 1) return { ok: false, code: "ambiguous_any_value" };
  const member = present[0];
  if (member === undefined) return { ok: true, value: null };

  switch (member) {
    case "stringValue":
      return typeof value.stringValue === "string"
        ? { ok: true, value: value.stringValue }
        : { ok: false, code: "invalid_any_value" };
    case "boolValue":
      return typeof value.boolValue === "boolean"
        ? { ok: true, value: value.boolValue }
        : { ok: false, code: "invalid_any_value" };
    case "intValue":
      return typeof value.intValue === "bigint"
        ? {
            ok: true,
            value:
              value.intValue >= BigInt(Number.MIN_SAFE_INTEGER) &&
              value.intValue <= BigInt(Number.MAX_SAFE_INTEGER)
                ? Number(value.intValue)
                : value.intValue.toString()
          }
        : { ok: false, code: "invalid_any_value" };
    case "doubleValue":
      return typeof value.doubleValue === "number" && Number.isFinite(value.doubleValue)
        ? { ok: true, value: value.doubleValue }
        : { ok: false, code: "invalid_any_value" };
    case "bytesValue":
      return Buffer.isBuffer(value.bytesValue)
        ? { ok: true, value: value.bytesValue.toString("base64") }
        : { ok: false, code: "invalid_any_value" };
    case "arrayValue": {
      if (!value.arrayValue || !Array.isArray(value.arrayValue.values))
        return { ok: false, code: "invalid_any_value" };
      const result: ConvertedAnyValue[] = [];
      for (const item of value.arrayValue.values) {
        const converted = convert(item, budget, depth + 1);
        if (!converted.ok) return converted;
        result.push(converted.value);
      }
      return { ok: true, value: result };
    }
    case "kvlistValue": {
      if (!value.kvlistValue || !Array.isArray(value.kvlistValue.values))
        return { ok: false, code: "invalid_any_value" };
      const result: { [key: string]: ConvertedAnyValue } = Object.create(null) as {
        [key: string]: ConvertedAnyValue;
      };
      const keys = new Set<string>();
      for (const entry of value.kvlistValue.values) {
        if (++budget.attributes > OTLP_LIMITS.attributes)
          return { ok: false, code: "invalid_any_value" };
        const key = entry.key ?? "";
        if (typeof key !== "string") return { ok: false, code: "invalid_any_value" };
        if (keys.has(key)) return { ok: false, code: "duplicate_map_key" };
        keys.add(key);
        const converted = convert(entry.value, budget, depth + 1);
        if (!converted.ok) return converted;
        Object.defineProperty(result, key, {
          value: converted.value,
          enumerable: true,
          configurable: true,
          writable: true
        });
      }
      return { ok: true, value: result };
    }
  }
}
