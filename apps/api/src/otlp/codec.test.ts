import { readFileSync } from "node:fs";
import protobuf from "protobufjs";
import type { OtlpLogRecord } from "./types.js";
import { describe, expect, it } from "vitest";
import {
  decodeExport,
  encodeExportResponse,
  encodeStatus,
  OtlpDecodeError,
  OTLP_LIMITS
} from "./codec.js";

const json = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));
const record = (value: unknown): Buffer =>
  json({ resourceLogs: [{ scopeLogs: [{ logRecords: [value] }] }] });
const first = (body: Buffer, encoding: "json" | "protobuf" = "json"): OtlpLogRecord | undefined =>
  decodeExport(body, encoding).resourceLogs[0]?.scopeLogs[0]?.logRecords[0];

describe("OTLP export codecs", () => {
  it("accepts empty exports and a literal binary minimal log", () => {
    expect(decodeExport(Buffer.alloc(0), "protobuf")).toEqual({ resourceLogs: [], recordCount: 0 });
    expect(decodeExport(json({ resourceLogs: [] }), "json")).toEqual({
      resourceLogs: [],
      recordCount: 0
    });
    expect(decodeExport(Buffer.from("0a0412021200", "hex"), "protobuf")).toEqual(
      decodeExport(record({}), "json")
    );
    expect(decodeExport(record({}), "json").recordCount).toBe(1);
  });
  it("retains uint64 source digits and negative int64 values", () => {
    const input = Buffer.from(
      '{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"timeUnixNano":18446744073709551615,"body":{"intValue":-9223372036854775808}}]}]}]}'
    );
    expect(first(input)?.timeUnixNano).toBe(18446744073709551615n);
    expect(first(input)?.body).toEqual({ intValue: -9223372036854775808n });
    // resource(26), scope(24), record(22): fixed64 max and AnyValue int64 min.
    const binary = Buffer.from("0a1a1218121609ffffffffffffffff2a0b1880808080808080808001", "hex");
    expect(first(binary, "protobuf")).toEqual(first(input));
  });
  it("normalizes nonzero mixed-case hex IDs and decodes bytes as bytes", () => {
    const value = first(
      record({
        traceId: "aABBccDDeeFF00112233445566778899",
        spanId: "AaBbCcDdEeFf0011",
        body: { bytesValue: "AP8=" }
      })
    );
    expect(value?.traceId).toEqual(Buffer.from("aabbccddeeff00112233445566778899", "hex"));
    expect(value?.spanId).toEqual(Buffer.from("aabbccddeeff0011", "hex"));
    expect(value?.body).toEqual({ bytesValue: Buffer.from([0, 255]) });
  });
  it("preserves nested AnyValue, duplicate attributes, union members and absence", () => {
    expect(
      first(
        record({
          attributes: [
            { key: "k" },
            { key: "k", value: {} },
            { key: "k", value: { stringValue: "a", boolValue: false } }
          ],
          body: {
            arrayValue: {
              values: [{ kvlistValue: { values: [{ key: "n", value: { intValue: "-1" } }] } }]
            }
          }
        })
      )?.attributes
    ).toEqual([
      { key: "k" },
      { key: "k", value: {} },
      { key: "k", value: { stringValue: "a", boolValue: false } }
    ]);
    expect(first(record({ body: { arrayValue: { values: [{}] } } }))?.body).toEqual({
      arrayValue: { values: [{}] }
    });
  });
  it("ignores unknown fields and profiling-only indexes, applies null as unset", () => {
    expect(
      first(
        record({
          unknown: { intValue: "secret" },
          body: { stringValueStrindex: 7 },
          attributes: null,
          timeUnixNano: null
        })
      )
    ).toEqual({ attributes: [], body: {} });
    expect(first(record({ body: { stringValue: null } }))?.body).toEqual({});
    expect(decodeExport(Buffer.from("980601", "hex"), "protobuf").recordCount).toBe(0);
  });
  it.each(["18446744073709551615", "1.8446744073709551615e19", "184467440737095516150e-1"])(
    "accepts exact ProtoJSON integer notation %s",
    (value) => {
      expect(first(record({ timeUnixNano: value }))?.timeUnixNano).toBe(18446744073709551615n);
    }
  );
  it.each([
    { timeUnixNano: "18446744073709551616" },
    { timeUnixNano: -1 },
    { timeUnixNano: "1.1" },
    { timeUnixNano: true },
    { severityNumber: "SEVERITY_NUMBER_INFO" },
    { severityNumber: "9" },
    { severityNumber: 1.5 },
    { severityText: 1 },
    { attributes: {} },
    { attributes: [null] },
    { body: { boolValue: "false" } },
    { body: { intValue: "-9223372036854775809" } },
    { body: { bytesValue: "%%" } },
    { traceId: "xyz" },
    { body: [] }
  ])("rejects malformed typed JSON fields %#", (value) => {
    expect(() => decodeExport(record(value), "json")).toThrow(OtlpDecodeError);
  });
  it.each(["0a80", "0800", "0a0412021000", "0a0412031200", "0a0a120812062a0418808080"])(
    "rejects literal malformed protobuf %s",
    (hex) => {
      expect(() => decodeExport(Buffer.from(hex, "hex"), "protobuf")).toThrow(OtlpDecodeError);
    }
  );
  it("bounds unknown binary group recursion and skips shallow groups", () => {
    expect(decodeExport(Buffer.from([0x7b, 0x08, 0x01, 0x7c]), "protobuf").recordCount).toBe(0);
    expect(() =>
      decodeExport(Buffer.concat([Buffer.alloc(102, 0x7b), Buffer.alloc(102, 0x7c)]), "protobuf")
    ).toThrow(OtlpDecodeError);
  });
  it("encodes independently specified success and partial bytes", () => {
    expect(encodeExportResponse({}, "json").toString()).toBe("{}");
    expect(encodeExportResponse({}, "protobuf")).toEqual(Buffer.alloc(0));
    const response = { rejectedLogRecords: 2, errorMessage: "Some log records were rejected." };
    expect(encodeExportResponse(response, "json").toString()).toBe(
      '{"partialSuccess":{"rejectedLogRecords":"2","errorMessage":"Some log records were rejected."}}'
    );
    expect(encodeExportResponse(response, "protobuf").toString("hex")).toBe(
      "0a230802121f536f6d65206c6f67207265636f72647320776572652072656a65637465642e"
    );
  });
  it("encodes only fixed safe status messages", () => {
    expect(encodeStatus({ code: 3, message: "Invalid OTLP request." }, "json").toString()).toBe(
      '{"code":3,"message":"Invalid OTLP request."}'
    );
    expect(
      encodeStatus({ code: 3, message: "Invalid OTLP request." }, "protobuf").toString("hex")
    ).toBe("08031215496e76616c6964204f544c5020726571756573742e");
    expect(() => encodeStatus({ code: 3, message: "secret" }, "json")).toThrow();
    expect(() => encodeExportResponse({ rejectedLogRecords: 101 }, "json")).toThrow();
  });
});

// Independent fixture encoder: parse the unmodified official .proto sources,
// rather than the new codec or its generated descriptor.
const official = new protobuf.Root();
for (const source of [
  "common/v1/common.proto",
  "resource/v1/resource.proto",
  "logs/v1/logs.proto",
  "collector/logs/v1/logs_service.proto"
]) {
  protobuf.parse(
    readFileSync(
      new URL(`./schema/sources/opentelemetry/proto/${source}`, import.meta.url),
      "utf8"
    ),
    official
  );
}
const officialRequest = official
  .resolveAll()
  .lookupType("opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest");
const binary = (value: Record<string, unknown>): Buffer =>
  Buffer.from(officialRequest.encode(officialRequest.fromObject(value)).finish());
const envelope = (value: unknown): Record<string, unknown> => ({
  resourceLogs: [{ scopeLogs: [{ logRecords: [value] }] }]
});
const encode = (value: Record<string, unknown>, encoding: "json" | "protobuf"): Buffer =>
  encoding === "json" ? json(value) : binary(value);
function nested(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { stringValue: "leaf" };
  for (let index = 1; index < depth; index++)
    value = { kvlistValue: { values: [{ key: "k", value }] } };
  return value;
}
function expectLimit(body: Buffer, encoding: "json" | "protobuf"): void {
  expect(() => decodeExport(body, encoding)).toThrow(
    expect.objectContaining({ code: "otlp_limit_exceeded", message: "otlp_limit_exceeded" })
  );
}

describe("OTLP allocation and work bounds", () => {
  it.each(["json", "protobuf"] as const)(
    "bounds resource and scope allocation in %s",
    (encoding) => {
      expect(
        decodeExport(
          encode({ resourceLogs: Array.from({ length: 100 }, () => ({})) }, encoding),
          encoding
        ).resourceLogs
      ).toHaveLength(100);
      expectLimit(
        encode({ resourceLogs: Array.from({ length: 101 }, () => ({})) }, encoding),
        encoding
      );
      expect(
        decodeExport(
          encode(
            { resourceLogs: [{ scopeLogs: Array.from({ length: 100 }, () => ({})) }] },
            encoding
          ),
          encoding
        ).resourceLogs[0]?.scopeLogs
      ).toHaveLength(100);
      expectLimit(
        encode(
          { resourceLogs: [{ scopeLogs: Array.from({ length: 101 }, () => ({})) }] },
          encoding
        ),
        encoding
      );
      expectLimit(
        encode(
          {
            resourceLogs: [
              { scopeLogs: Array.from({ length: 50 }, () => ({})) },
              { scopeLogs: Array.from({ length: 51 }, () => ({})) }
            ]
          },
          encoding
        ),
        encoding
      );
    }
  );
  it.each(["json", "protobuf"] as const)(
    "counts the complete record batch before returning in %s",
    (encoding) => {
      const value = {
        resourceLogs: [{ scopeLogs: [{ logRecords: Array.from({ length: 100 }, () => ({})) }] }]
      };
      expect(decodeExport(encode(value, encoding), encoding).recordCount).toBe(100);
      value.resourceLogs[0]?.scopeLogs[0]?.logRecords.push({});
      expectLimit(encode(value, encoding), encoding);
    }
  );
  it.each(["json", "protobuf"] as const)(
    "bounds cumulative attributes and AnyValue allocation in %s",
    (encoding) => {
      const attributes = Array.from({ length: 10_000 }, () => ({}));
      expect(first(encode(envelope({ attributes }), encoding), encoding)?.attributes).toHaveLength(
        10_000
      );
      expectLimit(encode(envelope({ attributes: [...attributes, {}] }), encoding), encoding);
      const values = Array.from({ length: 19_999 }, () => ({}));
      expect(
        first(encode(envelope({ body: { arrayValue: { values } } }), encoding), encoding)?.body
          ?.arrayValue?.values
      ).toHaveLength(19_999);
      expectLimit(
        encode(envelope({ body: { arrayValue: { values: [...values, {}] } } }), encoding),
        encoding
      );
    }
  );
  it("accepts depth24 identically in JSON and binary and refuses depth25", () => {
    const boundary = envelope({ body: nested(24) });
    expect(decodeExport(json(boundary), "json")).toEqual(
      decodeExport(binary(boundary), "protobuf")
    );
    expectLimit(json(envelope({ body: nested(25) })), "json");
    expectLimit(binary(envelope({ body: nested(25) })), "protobuf");
  });
  it("bounds messages before allocating arbitrarily many empty EntityRef instances", () => {
    // root + ResourceLogs + Resource =3; EntityRef limit leaves65533 entries.
    const entityRefs = Array.from({ length: 65_533 }, () => ({}));
    expect(
      decodeExport(binary({ resourceLogs: [{ resource: { entityRefs } }] }), "protobuf")
        .resourceLogs[0]?.resource?.entityRefs
    ).toHaveLength(65_533);
    expectLimit(
      binary({ resourceLogs: [{ resource: { entityRefs: [...entityRefs, {}] } }] }),
      "protobuf"
    );
  });
  it("bounds unknown-field work before parsing JSON", () => {
    // {, opening key quote, colon, array brackets, } =6; each comma adds1.
    const atLimit = Buffer.from(
      '{"unknown":[' + Array.from({ length: 262_139 }, () => "0").join(",") + "]}"
    );
    expect(decodeExport(atLimit, "json").recordCount).toBe(0);
    expectLimit(Buffer.from(atLimit.toString().replace("]}", ",0]}")), "json");
    const atDepth = Buffer.from('{"unknown":' + "[".repeat(127) + "0" + "]".repeat(127) + "}");
    expect(decodeExport(atDepth, "json").recordCount).toBe(0);
    expectLimit(Buffer.from('{"unknown":' + "[".repeat(128) + "0" + "]".repeat(128) + "}"), "json");
  });
  it("counts unknown binary tags without shared request budgets", () => {
    const atLimit = Buffer.alloc(262_144 * 2);
    for (let index = 0; index < atLimit.length; index += 2) {
      atLimit[index] = 0x78;
      atLimit[index + 1] = 1;
    }
    expect(decodeExport(atLimit, "protobuf").recordCount).toBe(0);
    expectLimit(Buffer.concat([atLimit, Buffer.from([0x78, 1])]), "protobuf");
    expect(decodeExport(Buffer.alloc(0), "protobuf").recordCount).toBe(0);
    expect(decodeExport(atLimit, "protobuf").recordCount).toBe(0);
  });
  it("bounds numeric exponent work without rounding fractions", () => {
    expect(first(record({ timeUnixNano: "0e10000" }))?.timeUnixNano).toBe(0n);
    expectLimit(record({ timeUnixNano: "0e10001" }), "json");
    expectLimit(record({ timeUnixNano: "0." + "0".repeat(127) }), "json");
    expect(() => decodeExport(record({ timeUnixNano: "1e-10000" }), "json")).toThrow(
      OtlpDecodeError
    );
    expect(first(record({ timeUnixNano: "1.0000000000000000000e1" }))?.timeUnixNano).toBe(10n);
  });
  it("applies the absolute body ceiling before either parser", () => {
    const input = Buffer.alloc(OTLP_LIMITS.bodyBytes + 1);
    expectLimit(input, "json");
    expectLimit(input, "protobuf");
  });
  it.each([
    "0a07120512032a0118",
    "0a0a120812062a0418808080",
    "0a11120f120d2a0b18ffffffffffffffffff7f",
    "0a0f120d120b2a0919ffffffffffffffff"
  ])("rejects malformed scalar literal %s", (hex) => {
    expect(() => decodeExport(Buffer.from(hex, "hex"), "protobuf")).toThrow(OtlpDecodeError);
  });
  it("retains a valid negative int64 and binary ambiguous union independently", () => {
    expect(
      first(Buffer.from("0a11120f120d2a0b18ffffffffffffffffff01", "hex"), "protobuf")?.body
    ).toEqual({ intValue: -1n });
    expect(first(Buffer.from("0a0b120912072a050a01611000", "hex"), "protobuf")?.body).toEqual({
      stringValue: "a",
      boolValue: false
    });
  });
  it("never includes parser values in safe errors", () => {
    expect(() => decodeExport(Buffer.from('{"secret":"private'), "json")).toThrow(
      expect.objectContaining({ code: "invalid_otlp", message: "invalid_otlp" })
    );
  });
});

describe("strict unknown binary field boundaries", () => {
  it.each([
    "788080808080808080808000",
    "78ffffffffffffffffff7f",
    "7b8401",
    "7b03047c",
    "0000",
    "0400",
    "7b00ff7c"
  ])("refuses malformed unknown field %s", (hex) => {
    expect(() => decodeExport(Buffer.from(hex, "hex"), "protobuf")).toThrow(OtlpDecodeError);
  });
  it.each(["78ffffffffffffffffff01", "7b830184017c", "7b7a007c", "7b08017c"])(
    "skips valid unknown field %s",
    (hex) => {
      expect(decodeExport(Buffer.from(hex, "hex"), "protobuf").recordCount).toBe(0);
    }
  );
});

describe("duplicate singular protobuf messages", () => {
  it("preserves duplicate Resource attributes in their original order", () => {
    // Two resource occurrences, each with attribute k and distinct string value.
    const input = Buffer.from("0a180a0a0a080a016b12030a01610a0a0a080a016b12030a0162", "hex");
    expect(decodeExport(input, "protobuf").resourceLogs[0]?.resource?.attributes).toEqual([
      { key: "k", value: { stringValue: "a" } },
      { key: "k", value: { stringValue: "b" } }
    ]);
  });
  it("retains distinct AnyValue members across duplicate body occurrences", () => {
    expect(first(Buffer.from("0a0d120b12092a030a01612a021001", "hex"), "protobuf")?.body).toEqual({
      stringValue: "a",
      boolValue: true
    });
  });
  it("merges nested singular messages and leaves scalar values last-wins", () => {
    expect(first(Buffer.from("0a0e120c120a2a082a020a002a020a00", "hex"), "protobuf")?.body).toEqual(
      { arrayValue: { values: [{}, {}] } }
    );
    expect(first(Buffer.from("0a0e120c120a2a030a01612a030a0162", "hex"), "protobuf")?.body).toEqual(
      { stringValue: "b" }
    );
  });
  it("bounds many duplicate messages without quadratic array copies or shared state", () => {
    // 65534 empty Resource occurrences: root+ResourceLogs+65534=65536 messages.
    const empty = Buffer.alloc(65_534 * 2);
    for (let index = 0; index < empty.length; index += 2) empty[index] = 0x0a;
    const input = Buffer.concat([Buffer.from("0afcff07", "hex"), empty]);
    expect(decodeExport(input, "protobuf").resourceLogs[0]?.resource?.attributes).toEqual([]);
    expectLimit(
      Buffer.concat([Buffer.from("0afeff07", "hex"), empty, Buffer.from("0a00", "hex")]),
      "protobuf"
    );
    expect(decodeExport(Buffer.alloc(0), "protobuf").resourceLogs).toEqual([]);
  });
});

describe("canonical scalar and ordering semantics", () => {
  it("preserves resource/scope/record order and integer enum values", () => {
    const value = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                { timeUnixNano: "1", severityNumber: 9 },
                { timeUnixNano: "2", severityNumber: 12345 }
              ]
            },
            { logRecords: [{ timeUnixNano: "3" }] }
          ]
        },
        { scopeLogs: [{ logRecords: [{ timeUnixNano: "4" }] }] }
      ]
    };
    for (const encoding of ["json", "protobuf"] as const) {
      const decoded = decodeExport(encode(value, encoding), encoding);
      expect(
        decoded.resourceLogs.flatMap((resource) =>
          resource.scopeLogs.flatMap((scope) => scope.logRecords.map((entry) => entry.timeUnixNano))
        )
      ).toEqual([1n, 2n, 3n, 4n]);
      expect(
        decoded.resourceLogs[0]?.scopeLogs[0]?.logRecords.map((entry) => entry.severityNumber)
      ).toEqual([9, 12345]);
    }
  });
  it("decodes large bytes within the body ceiling without regex stack exhaustion", () => {
    const bytes = Buffer.alloc(1_048_576, 255);
    expect(
      first(record({ body: { bytesValue: bytes.toString("base64") } }))?.body?.bytesValue
    ).toEqual(bytes);
  });
  it.each(["AP8=", "AP8", "AP_="])("accepts ProtoJSON base64 form %s", (value) => {
    expect(first(record({ body: { bytesValue: value } }))?.body?.bytesValue).toEqual(
      Buffer.from([0, 255])
    );
  });
  it.each(["NaN", "Infinity", "-Infinity"])(
    "preserves special double value %s for mapping",
    (value) => {
      expect(first(record({ body: { doubleValue: value } }))?.body?.doubleValue).toBe(
        Number(value)
      );
    }
  );
  it("does not reinterpret structural punctuation in escaped strings", () => {
    expect(
      first(record({ body: { stringValue: '[{"quoted":"\\"}]}'.repeat(30_000) } }))?.body
        ?.stringValue
    ).toHaveLength(510_000);
  });
  it("rejects invalid UTF8 rather than replacing invalid bytes", () => {
    expect(() =>
      decodeExport(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]), "json")
    ).toThrow(OtlpDecodeError);
    expect(() => decodeExport(Buffer.from("0a09120712052a030a01ff", "hex"), "protobuf")).toThrow(
      OtlpDecodeError
    );
  });
});

describe("library-reported uint32 read boundaries", () => {
  it.each(["f880808080000000000001", "7b7a808080808000000000007c"])(
    "rejects an earlier terminator hidden inside the reported span %s",
    (hex) => {
      expect(() => decodeExport(Buffer.from(hex, "hex"), "protobuf")).toThrow(OtlpDecodeError);
    }
  );
  it("accepts an overlong but uninterrupted unknown tag", () => {
    expect(decodeExport(Buffer.from("f880808080808080800001", "hex"), "protobuf").recordCount).toBe(
      0
    );
  });
});

it("merges a newly present nested AnyValue member without treating prototype null as present", () => {
  expect(first(Buffer.from("0a0d120b12092a030a01612a022a00", "hex"), "protobuf")?.body).toEqual({
    stringValue: "a",
    arrayValue: { values: [] }
  });
});
