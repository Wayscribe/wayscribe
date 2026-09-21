import { describe, expect, it } from "vitest";
import { convertAnyValue } from "./any-value.js";
import type { OtlpAnyValue } from "./types.js";

function expectValue(input: OtlpAnyValue | undefined): unknown {
  const result = convertAnyValue(input);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(result.code);
  return result.value;
}

describe("OTLP AnyValue conversion", () => {
  it("preserves explicit empty values and scalar types", () => {
    expect(expectValue(undefined)).toBeNull();
    expect(expectValue({})).toBeNull();
    expect(expectValue({ stringValue: "" })).toBe("");
    expect(expectValue({ boolValue: false })).toBe(false);
    expect(expectValue({ intValue: 42n })).toBe(42);
    expect(expectValue({ doubleValue: 1.5 })).toBe(1.5);
  });

  it("keeps exact large integers and binary values as strings", () => {
    expect(expectValue({ intValue: 9_007_199_254_740_992n })).toBe("9007199254740992");
    expect(expectValue({ intValue: -9_223_372_036_854_775_808n })).toBe("-9223372036854775808");
    expect(expectValue({ bytesValue: Buffer.from([0, 255]) })).toBe("AP8=");
  });

  it("builds fresh arrays and safe maps with own arbitrary keys", () => {
    const source: OtlpAnyValue = {
      arrayValue: {
        values: [
          {
            kvlistValue: {
              values: [
                { key: "__proto__", value: { stringValue: "safe" } },
                { key: "", value: { arrayValue: { values: [] } } },
                { key: "missing" }
              ]
            }
          }
        ]
      }
    };
    const value = expectValue(source) as Array<Record<string, unknown>>;

    expect(Object.hasOwn(value[0] ?? {}, "__proto__")).toBe(true);
    expect(JSON.stringify(value)).toBe('[{"__proto__":"safe","":[],"missing":null}]');
    expect(Object.getPrototypeOf(value[0])).toBeNull();
    expect(value).not.toBe(source.arrayValue?.values);
  });

  it("refuses duplicate map keys, including absent keys as empty strings", () => {
    expect(
      convertAnyValue({
        kvlistValue: { values: [{}, { key: "", value: { stringValue: "later" } }] }
      })
    ).toEqual({ ok: false, code: "duplicate_map_key" });
  });

  it("refuses ambiguous unions and nonfinite numbers with distinct safe codes", () => {
    expect(convertAnyValue({ stringValue: "x", boolValue: true })).toEqual({
      ok: false,
      code: "ambiguous_any_value"
    });
    for (const doubleValue of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(convertAnyValue({ doubleValue })).toEqual({
        ok: false,
        code: "invalid_any_value"
      });
    }
  });

  it("accepts the agreed depth boundary and refuses the next level", () => {
    const nested = (depth: number): OtlpAnyValue => {
      let value: OtlpAnyValue = { stringValue: "leaf" };
      for (let level = 1; level < depth; level += 1) {
        value = { arrayValue: { values: [value] } };
      }
      return value;
    };

    expect(convertAnyValue(nested(24))).toMatchObject({ ok: true });
    expect(convertAnyValue(nested(25))).toEqual({ ok: false, code: "invalid_any_value" });
  });
});
