import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import protobuf from "protobufjs";
import { describe, expect, it } from "vitest";
import { decodeExport } from "./codec.js";
import { mapExport, type MapOptions, type MappedLog } from "./mapping.js";
import type { DecodedExport, OtlpAnyValue, OtlpKeyValue, OtlpLogRecord } from "./types.js";

const text = (stringValue: string): OtlpAnyValue => ({ stringValue });
const attribute = (key: string, value?: OtlpAnyValue): OtlpKeyValue =>
  value === undefined ? { key } : { key, value };

const requiredAttributes = (): OtlpKeyValue[] => [
  attribute("wayscribe.event.id", text("evt_01")),
  attribute("wayscribe.journey.id", text("jrn_01")),
  attribute("wayscribe.entity.type", text("order")),
  attribute("wayscribe.entity.id", text("ord_42")),
  attribute("wayscribe.operation", text("received")),
  attribute("wayscribe.name", text("receive-order"))
];

const resourceAttributes = (): OtlpKeyValue[] => [
  attribute("service.name", text("orders-api")),
  attribute("deployment.environment.name", text("production")),
  attribute("service.version", text("1.2.3"))
];

function decoded(
  records: OtlpLogRecord[] = [
    { timeUnixNano: 1_700_000_000_123_456_789n, attributes: requiredAttributes() }
  ],
  resources: OtlpKeyValue[] = resourceAttributes()
): DecodedExport {
  return {
    resourceLogs: [
      { resource: { attributes: resources, entityRefs: [] }, scopeLogs: [{ logRecords: records }] }
    ],
    recordCount: records.length
  };
}

function mappedOne(value: DecodedExport, options?: MapOptions): MappedLog {
  const result = mapExport(value, options);
  expect(result).toHaveLength(1);
  const first = result[0];
  if (!first) throw new Error("missing mapped record");
  return first;
}

describe("OTLP log mapping", () => {
  it("maps every bound attribute without inferring body, severity, scope, or runtime", () => {
    const inputMap: OtlpAnyValue = {
      kvlistValue: {
        values: [
          attribute("large", { intValue: 9_007_199_254_740_992n }),
          attribute("bytes", { bytesValue: Buffer.from([0, 255]) }),
          attribute("empty"),
          attribute("__proto__", text("safe"))
        ]
      }
    };
    const record: OtlpLogRecord = {
      timeUnixNano: 1_700_000_000_123_456_789n,
      severityNumber: 17,
      severityText: "ERROR",
      eventName: "ignored-event-name",
      body: { doubleValue: Number.NaN },
      traceId: Buffer.from("4BF92F3577B34DA6A3CE929D0E0E4736", "hex"),
      spanId: Buffer.from("00F067AA0BA902B7", "hex"),
      attributes: [
        ...requiredAttributes(),
        attribute("wayscribe.input", inputMap),
        attribute("wayscribe.output", { arrayValue: { values: [] } }),
        attribute("wayscribe.metadata", {
          kvlistValue: {
            values: [
              attribute("attempt", text("metadata-value")),
              attribute("sampled", { boolValue: false }),
              attribute("__proto__", text("metadata-proto"))
            ]
          }
        }),
        attribute("wayscribe.aliases", {
          kvlistValue: {
            values: [
              attribute("orderId", text("ord_42")),
              attribute("__proto__", text("alias-proto"))
            ]
          }
        }),
        attribute("wayscribe.displayable_aliases", {
          arrayValue: { values: [text("orderId"), text("__proto__")] }
        }),
        attribute("wayscribe.journey.label", text("Order 42")),
        attribute("wayscribe.attempt", { intValue: 2n }),
        attribute("wayscribe.duration_ms", { doubleValue: 18 }),
        attribute("wayscribe.error", {
          kvlistValue: {
            values: [
              attribute("type", text("ValidationError")),
              attribute("message", text("phone required")),
              attribute("code", text("phone_required")),
              attribute("stack", text("stack")),
              attribute("future", text("ignored"))
            ]
          }
        }),
        attribute("wayscribe.parent_event.id", text("evt_00")),
        attribute("wayscribe.message.id", text("msg_01")),
        attribute("wayscribe.correlation.id", text("cor_01")),
        attribute("unmapped.secret", { stringValue: "ignored", boolValue: true })
      ]
    };

    const result = mappedOne(decoded([record]));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.envelope).toMatchObject({
      protocolVersion: "0.1",
      event: {
        id: "evt_01",
        journeyId: "jrn_01",
        environment: "production",
        service: "orders-api",
        entity: { type: "order", id: "ord_42" },
        operation: "received",
        name: "receive-order",
        timestamp: "2023-11-14T22:13:20.123Z",
        aliases: { orderId: "ord_42" },
        displayableAliases: ["orderId", "__proto__"],
        journeyLabel: "Order 42",
        durationMs: 18,
        parentEventId: "evt_00",
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        messageId: "msg_01",
        correlationId: "cor_01",
        output: [],
        error: {
          type: "ValidationError",
          message: "phone required",
          code: "phone_required",
          stack: "stack"
        },
        deployment: { version: "1.2.3" },
        metadata: { attempt: 2, sampled: false }
      }
    });
    expect(result.envelope.event.input).toMatchObject({
      large: "9007199254740992",
      bytes: "AP8=",
      empty: null
    });
    expect(Object.hasOwn(result.envelope.event.input as object, "__proto__")).toBe(true);
    expect((result.envelope.event.input as Record<string, unknown>)["__proto__"]).toBe("safe");
    expect(Object.hasOwn(result.envelope.event.aliases ?? {}, "__proto__")).toBe(true);
    expect(result.envelope.event.aliases?.["__proto__"]).toBe("alias-proto");
    expect(Object.hasOwn(result.envelope.event.metadata ?? {}, "__proto__")).toBe(true);
    expect(result.envelope.event.metadata?.["__proto__"]).toBe("metadata-proto");
    expect(result.envelope.event).not.toHaveProperty("runtime");
  });

  it("uses observed time only for an omitted or zero primary time and refuses unusable time", () => {
    const fallback = (timeUnixNano?: bigint, observedTimeUnixNano?: bigint): MappedLog =>
      mappedOne(
        decoded([
          {
            ...(timeUnixNano === undefined ? {} : { timeUnixNano }),
            ...(observedTimeUnixNano === undefined ? {} : { observedTimeUnixNano }),
            attributes: requiredAttributes()
          }
        ])
      );

    expect(fallback(undefined, 1_700_000_000_999_999_999n)).toMatchObject({
      ok: true,
      envelope: { event: { timestamp: "2023-11-14T22:13:20.999Z" } }
    });
    expect(fallback(0n, 1_700_000_000_999_999_999n)).toEqual(
      fallback(undefined, 1_700_000_000_999_999_999n)
    );
    expect(fallback()).toEqual({ ok: false, code: "invalid_timestamp" });
    expect(fallback(0n, 0n)).toEqual({ ok: false, code: "invalid_timestamp" });
    expect(fallback(18_446_744_073_709_551_615n)).toMatchObject({
      ok: true,
      envelope: { event: { timestamp: "2554-07-21T23:34:33.709Z" } }
    });
    expect(fallback(8_640_000_000_000_001_000_000n)).toEqual({
      ok: false,
      code: "invalid_timestamp"
    });
  });

  it("omits each invalid optional trace identifier independently", () => {
    const record: OtlpLogRecord = {
      timeUnixNano: 1n,
      traceId: Buffer.alloc(16),
      spanId: Buffer.from("00f067aa0ba902b7", "hex"),
      attributes: requiredAttributes()
    };
    const result = mappedOne(decoded([record]));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.envelope.event).not.toHaveProperty("traceId");
    expect(result.envelope.event.spanId).toBe("00f067aa0ba902b7");

    const wrongSpan = mappedOne(
      decoded([{ ...record, traceId: Buffer.alloc(15, 1), spanId: Buffer.alloc(9, 1) }])
    );
    expect(wrongSpan).toMatchObject({ ok: true });
    if (wrongSpan.ok) {
      expect(wrongSpan.envelope.event).not.toHaveProperty("traceId");
      expect(wrongSpan.envelope.event).not.toHaveProperty("spanId");
    }
  });

  it("distinguishes absent optional fields from present empty values", () => {
    const absent = mappedOne(decoded());
    expect(absent).toMatchObject({ ok: true });
    if (absent.ok) {
      expect(absent.envelope.event).not.toHaveProperty("input");
      expect(absent.envelope.event).not.toHaveProperty("metadata");
    }

    const present = mappedOne(
      decoded([
        {
          timeUnixNano: 1n,
          attributes: [
            ...requiredAttributes(),
            attribute("wayscribe.input"),
            attribute("wayscribe.output", {})
          ]
        }
      ])
    );
    expect(present).toMatchObject({
      ok: true,
      envelope: { event: { input: null, output: null } }
    });

    const typedNull = mappedOne(
      decoded([
        { timeUnixNano: 1n, attributes: [...requiredAttributes(), attribute("wayscribe.name")] }
      ])
    );
    expect(typedNull).toEqual({ ok: false, code: "duplicate_attribute" });
    expect(
      mappedOne(
        decoded(undefined, [...resourceAttributes().slice(0, 2), attribute("service.version")])
      )
    ).toEqual({ ok: false, code: "invalid_attribute_type" });
  });

  it("uses precise safe codes for duplicate, union, value, and protocol failures", () => {
    const base = { timeUnixNano: 1n, attributes: requiredAttributes() };
    expect(
      mappedOne(
        decoded([base], [...resourceAttributes(), attribute("service.name", text("duplicate"))])
      )
    ).toEqual({ ok: false, code: "duplicate_attribute" });
    expect(
      mappedOne(
        decoded([
          {
            ...base,
            attributes: [
              ...base.attributes,
              attribute("wayscribe.input", {
                kvlistValue: {
                  values: [attribute("same", text("first")), attribute("same", text("second"))]
                }
              })
            ]
          }
        ])
      )
    ).toEqual({ ok: false, code: "duplicate_map_key" });
    expect(
      mappedOne(
        decoded([
          {
            ...base,
            attributes: [
              ...base.attributes,
              attribute("wayscribe.input", { stringValue: "x", boolValue: true })
            ]
          }
        ])
      )
    ).toEqual({ ok: false, code: "ambiguous_any_value" });
    expect(
      mappedOne(
        decoded([
          {
            ...base,
            attributes: [
              ...base.attributes,
              attribute("wayscribe.input", { doubleValue: Number.NaN })
            ]
          }
        ])
      )
    ).toEqual({ ok: false, code: "invalid_any_value" });
    expect(
      mappedOne(
        decoded([
          {
            ...base,
            attributes: base.attributes.map((entry) =>
              entry.key === "wayscribe.operation" ? attribute(entry.key, text("invented")) : entry
            )
          }
        ])
      )
    ).toEqual({ ok: false, code: "invalid_event" });
  });

  it("requires original string and numeric variants for typed event fields", () => {
    const replace = (key: string, value: OtlpAnyValue): DecodedExport =>
      decoded([
        {
          timeUnixNano: 1n,
          attributes: requiredAttributes().map((entry) =>
            entry.key === key ? attribute(key, value) : entry
          )
        }
      ]);
    expect(mappedOne(replace("wayscribe.event.id", { bytesValue: Buffer.from("evt_01") }))).toEqual(
      {
        ok: false,
        code: "invalid_attribute_type"
      }
    );
    expect(
      mappedOne(replace("wayscribe.journey.id", { intValue: 9_007_199_254_740_992n }))
    ).toEqual({
      ok: false,
      code: "invalid_attribute_type"
    });
    for (const mappedAttribute of [
      attribute("wayscribe.duration_ms", text("18")),
      attribute("wayscribe.aliases", {
        kvlistValue: { values: [attribute("orderId", { bytesValue: Buffer.from("ord") })] }
      }),
      attribute("wayscribe.displayable_aliases", {
        arrayValue: { values: [{ intValue: 7n }] }
      }),
      attribute("wayscribe.error", {
        kvlistValue: { values: [attribute("message", { bytesValue: Buffer.from("error") })] }
      })
    ]) {
      expect(
        mappedOne(
          decoded([
            {
              timeUnixNano: 1n,
              attributes: [...requiredAttributes(), mappedAttribute]
            }
          ])
        )
      ).toEqual({ ok: false, code: "invalid_attribute_type" });
    }
    expect(
      mappedOne(
        decoded(undefined, [
          attribute("service.name", { bytesValue: Buffer.from("orders-api") }),
          attribute("deployment.environment.name", text("production"))
        ])
      )
    ).toEqual({ ok: false, code: "invalid_attribute_type" });
  });

  it("requires scalar metadata and lets explicit attempt replace metadata attempt", () => {
    const base: OtlpLogRecord = { timeUnixNano: 1n, attributes: requiredAttributes() };
    const structured = mappedOne(
      decoded([
        {
          ...base,
          attributes: [
            ...base.attributes,
            attribute("wayscribe.metadata", {
              kvlistValue: { values: [attribute("nested", { arrayValue: { values: [] } })] }
            })
          ]
        }
      ])
    );
    expect(structured).toEqual({ ok: false, code: "invalid_attribute_type" });

    const explicit = mappedOne(
      decoded([
        {
          ...base,
          attributes: [
            ...base.attributes,
            attribute("wayscribe.metadata", {
              kvlistValue: { values: [attribute("attempt", text("old")), attribute("nullable")] }
            }),
            attribute("wayscribe.attempt", { doubleValue: 3 })
          ]
        }
      ])
    );
    expect(explicit).toMatchObject({
      ok: true,
      envelope: { event: { operation: "received", metadata: { attempt: 3, nullable: null } } }
    });
  });

  it("preserves record order, isolates resource failures, and shares no mutable output", () => {
    const valid = {
      timeUnixNano: 1n,
      attributes: [
        ...requiredAttributes(),
        attribute("wayscribe.input", {
          kvlistValue: { values: [attribute("state", text("original"))] }
        })
      ]
    };
    const invalid = { timeUnixNano: 0n, attributes: requiredAttributes() };
    const input: DecodedExport = {
      resourceLogs: [
        {
          resource: {
            attributes: [...resourceAttributes(), attribute("service.name", text("duplicate"))],
            entityRefs: []
          },
          scopeLogs: [{ logRecords: [valid, valid] }]
        },
        {
          resource: { attributes: resourceAttributes(), entityRefs: [] },
          scopeLogs: [{ logRecords: [valid, invalid, valid] }]
        }
      ],
      recordCount: 5
    };

    const first = mapExport(input);
    const second = mapExport(input);
    expect(first).toEqual(second);
    expect(first.map((entry) => (entry.ok ? entry.envelope.event.id : entry.code))).toEqual([
      "duplicate_attribute",
      "duplicate_attribute",
      "evt_01",
      "invalid_timestamp",
      "evt_01"
    ]);
    const accepted = first.filter((entry) => entry.ok);
    expect(accepted).toHaveLength(2);
    if (accepted.length === 2) {
      expect(accepted[0]?.envelope).not.toBe(accepted[1]?.envelope);
      expect(accepted[0]?.envelope.event).not.toBe(accepted[1]?.envelope.event);
      if (accepted[0]) {
        accepted[0].envelope.event.entity.id = "mutated";
        (accepted[0].envelope.event.input as Record<string, unknown>)["state"] = "mutated";
      }
      expect(accepted[1]?.envelope.event.entity.id).toBe("ord_42");
      expect(accepted[1]?.envelope.event.input).toMatchObject({ state: "original" });
      expect(second[2]).toMatchObject({
        ok: true,
        envelope: { event: { entity: { id: "ord_42" }, input: { state: "original" } } }
      });
    }
    expect(input.resourceLogs[1]?.scopeLogs[0]?.logRecords[0]?.attributes).toEqual(
      valid.attributes
    );
  });
});

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

describe("JSON/protobuf mapping equivalence", () => {
  it("maps independently encoded retries to the same literal envelope", () => {
    const attributes = [
      { key: "wayscribe.event.id", value: { stringValue: "evt_retry" } },
      { key: "wayscribe.journey.id", value: { stringValue: "jrn_retry" } },
      { key: "wayscribe.entity.type", value: { stringValue: "order" } },
      { key: "wayscribe.entity.id", value: { stringValue: "ord_retry" } },
      { key: "wayscribe.operation", value: { stringValue: "retried" } },
      { key: "wayscribe.name", value: { stringValue: "retry-delivery" } },
      { key: "wayscribe.input", value: { intValue: "9007199254740992" } }
    ];
    const value = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "worker" } },
              {
                key: "deployment.environment.name",
                value: { stringValue: "development" }
              }
            ]
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "0",
                  observedTimeUnixNano: "1700000000123456789",
                  traceId: Buffer.from("AABBCCDDEEFF00112233445566778899", "hex"),
                  spanId: Buffer.from("AABBCCDDEEFF0011", "hex"),
                  attributes
                }
              ]
            }
          ]
        }
      ]
    };
    const jsonValue = {
      resourceLogs: [
        {
          resource: value.resourceLogs[0]?.resource,
          scopeLogs: [
            {
              logRecords: [
                {
                  ...value.resourceLogs[0]?.scopeLogs[0]?.logRecords[0],
                  traceId: "AaBbCcDdEeFf00112233445566778899",
                  spanId: "AABBCCDDEEFF0011"
                }
              ]
            }
          ]
        }
      ]
    };
    const jsonBody = Buffer.from(JSON.stringify(jsonValue));
    const protobufBody = Buffer.from(
      officialRequest.encode(officialRequest.fromObject(value)).finish()
    );

    const fromJson = mappedOne(decodedThrough(jsonBody, "json"));
    const fromProtobuf = mappedOne(decodedThrough(protobufBody, "protobuf"));
    const expected = {
      ok: true,
      envelope: {
        protocolVersion: "0.1",
        event: {
          id: "evt_retry",
          journeyId: "jrn_retry",
          environment: "development",
          service: "worker",
          entity: { type: "order", id: "ord_retry" },
          operation: "retried",
          name: "retry-delivery",
          timestamp: "2023-11-14T22:13:20.123Z",
          traceId: "aabbccddeeff00112233445566778899",
          spanId: "aabbccddeeff0011",
          input: "9007199254740992"
        }
      }
    };
    expect(fromJson).toEqual(expected);
    expect(fromProtobuf).toEqual(expected);
  });
});

function decodedThrough(body: Buffer, encoding: "json" | "protobuf"): DecodedExport {
  return decodeExport(body, encoding);
}

describe("stock OpenTelemetry records", () => {
  const digest = (content: string): string =>
    createHash("sha256").update(content).digest("hex").slice(0, 24);
  const options: MapOptions = {
    environment: "staging",
    fallbackEventIds: (content) => [`cur_${digest(content)}`, `prev_${digest(content)}`]
  };
  const without = (...keys: string[]): OtlpKeyValue[] =>
    requiredAttributes().filter((entry) => !keys.includes(entry.key ?? ""));
  const stockResource = (): OtlpKeyValue[] => [
    attribute("service.name", text("orders-api")),
    attribute("telemetry.sdk.language", text("java"))
  ];
  const eventOf = (mapped: MappedLog): Record<string, unknown> => {
    if (!mapped.ok) throw new Error(`refused: ${mapped.code}`);
    return mapped.envelope.event;
  };

  it("inherits the key's environment when the resource names none", () => {
    const mapped = mappedOne(decoded(undefined, stockResource()), options);
    expect(eventOf(mapped)["environment"]).toBe("staging");
  });

  it("refuses a record whose environment neither the resource nor the key determines", () => {
    for (const environment of [undefined, ""]) {
      expect(mappedOne(decoded(undefined, stockResource()), { ...options, environment })).toEqual({
        ok: false,
        code: "environment_unresolved"
      });
    }
  });

  it("falls back from wayscribe.event.id to log.record.uid", () => {
    const uid = attribute("log.record.uid", text("01JABCDEF0123456789XYZ0000"));
    const fromUid = mappedOne(
      decoded([{ timeUnixNano: 1n, attributes: [...without("wayscribe.event.id"), uid] }]),
      options
    );
    expect(eventOf(fromUid)["id"]).toBe("01JABCDEF0123456789XYZ0000");
    expect(fromUid).not.toHaveProperty("alternateIds");
    const explicit = mappedOne(
      decoded([{ timeUnixNano: 1n, attributes: [...requiredAttributes(), uid] }]),
      options
    );
    expect(eventOf(explicit)["id"]).toBe("evt_01");
    expect(
      mappedOne(
        decoded([
          {
            timeUnixNano: 1n,
            attributes: [...without("wayscribe.event.id"), attribute("log.record.uid", {})]
          }
        ]),
        options
      )
    ).toEqual({ ok: false, code: "invalid_attribute_type" });
  });

  it("derives a deterministic id from the record's content when no id is stated", () => {
    const record = (overrides: Partial<OtlpLogRecord> = {}): OtlpLogRecord => ({
      timeUnixNano: 1_700_000_000_123_456_789n,
      attributes: [
        ...without("wayscribe.event.id"),
        attribute("http.request.method", text("POST"))
      ],
      ...overrides
    });
    const first = mappedOne(decoded([record()], stockResource()), options);
    const retry = mappedOne(decoded([record()], stockResource()), options);
    expect(first.ok && retry.ok).toBe(true);
    expect(eventOf(first)["id"]).toMatch(/^cur_[0-9a-f]{24}$/);
    expect(retry).toEqual(first);
    expect(first).toMatchObject({ alternateIds: [expect.stringMatching(/^prev_/)] });

    // A nanosecond the millisecond timestamp drops, an unmapped attribute, the
    // body, the resource and the inherited environment all distinguish records.
    for (const [changed, changedOptions, resource] of [
      [record({ timeUnixNano: 1_700_000_000_123_456_790n }), options, stockResource()],
      [
        record({
          attributes: [
            ...without("wayscribe.event.id"),
            attribute("http.request.method", text("PUT"))
          ]
        }),
        options,
        stockResource()
      ],
      [record({ body: text("different") }), options, stockResource()],
      [record(), options, [...stockResource(), attribute("host.name", text("b"))]],
      [record(), { ...options, environment: "production" }, stockResource()]
    ] as const) {
      const other = mappedOne(decoded([changed], [...resource]), changedOptions);
      expect(eventOf(other)["id"]).not.toBe(eventOf(first)["id"]);
    }
  });

  it("derives the same id from the same record sent as JSON or protobuf", () => {
    const value = {
      resourceLogs: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "worker" } }] },
          scopeLogs: [
            {
              scope: { name: "io.example.orders", version: "1.0.0" },
              logRecords: [
                {
                  timeUnixNano: "1700000000123456789",
                  observedTimeUnixNano: "1700000000223456789",
                  severityNumber: 9,
                  severityText: "INFO",
                  body: { stringValue: "order received" },
                  attributes: [
                    { key: "wayscribe.journey.id", value: { stringValue: "jrn_stock" } },
                    { key: "wayscribe.entity.type", value: { stringValue: "order" } },
                    { key: "wayscribe.entity.id", value: { stringValue: "ord_stock" } },
                    { key: "wayscribe.operation", value: { stringValue: "received" } },
                    { key: "wayscribe.name", value: { stringValue: "receive" } },
                    { key: "http.request.method", value: { stringValue: "POST" } }
                  ]
                }
              ]
            }
          ]
        }
      ]
    };
    const fromJson = mappedOne(decodedThrough(Buffer.from(JSON.stringify(value)), "json"), options);
    const fromProtobuf = mappedOne(
      decodedThrough(
        Buffer.from(officialRequest.encode(officialRequest.fromObject(value)).finish()),
        "protobuf"
      ),
      options
    );
    expect(eventOf(fromJson)["id"]).toMatch(/^cur_/);
    expect(fromProtobuf).toEqual(fromJson);
  });

  it("names the missing or malformed attribute class instead of invalid_event", () => {
    expect(
      mappedOne(decoded([{ timeUnixNano: 1n, attributes: without("wayscribe.journey.id") }]))
    ).toEqual({ ok: false, code: "missing_attribute" });
    expect(
      mappedOne(decoded(undefined, [attribute("deployment.environment.name", text("p"))]))
    ).toEqual({ ok: false, code: "missing_attribute" });
    expect(
      mappedOne(decoded([{ timeUnixNano: 1n, attributes: without("wayscribe.event.id") }]))
    ).toEqual({ ok: false, code: "missing_attribute" });
    for (const [key, value] of [
      ["wayscribe.attempt", { intValue: 0n }],
      ["wayscribe.duration_ms", { intValue: -1n }],
      ["wayscribe.duration_ms", { doubleValue: 1.5 }]
    ] as const) {
      expect(
        mappedOne(
          decoded([
            { timeUnixNano: 1n, attributes: [...requiredAttributes(), attribute(key, value)] }
          ])
        )
      ).toEqual({ ok: false, code: "invalid_attribute_value" });
    }
    expect(
      mappedOne(
        decoded([
          {
            timeUnixNano: 1n,
            attributes: [
              ...requiredAttributes(),
              attribute("wayscribe.metadata", {
                kvlistValue: { values: [attribute("nested", { arrayValue: { values: [] } })] }
              })
            ]
          }
        ])
      )
    ).toEqual({ ok: false, code: "invalid_attribute_type" });
  });
});
