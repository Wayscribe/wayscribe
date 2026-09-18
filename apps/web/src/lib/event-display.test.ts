import { describe, expect, it } from "vitest";
import { displayChange, eventForDisplay, type ApiEventDetail } from "./event-display";
import { MAX_METADATA_TEXT, metadataEntries, runtimeFormat } from "./metadata";

/** An event as `GET /v1/events/:id` answers it, parsed from its JSON text. */
const raw = (fields: string): ApiEventDetail =>
  JSON.parse(`{"id":"evt_1","journeyId":"jrn_1","operation":"transformed","name":"step",
    "service":"s","eventTimestamp":"2026-09-18T00:00:00.000Z","receivedAt":"2026-09-18T00:00:00.000Z",
    "durationMs":null,"hasInput":true,"hasOutput":true,"hasError":false,"traceId":null,"messageId":null,
    "inputPayload":null,"outputPayload":null,"payloadDiff":null,"error":null${fields}}`) as ApiEventDetail;

describe("eventForDisplay", () => {
  // The display rules the components used before this moved to the server,
  // kept byte for byte: pretty-printed payloads and errors, compact diff
  // values, and an em dash for a side a change does not have.
  it("writes payloads and the error as the page showed them", () => {
    const event = eventForDisplay(
      raw(',"inputPayload":{"a":1,"b":[1,2]},"outputPayload":"text","error":{"message":"m"}')
    );
    expect(event.inputText).toBe(JSON.stringify({ a: 1, b: [1, 2] }, null, 2));
    expect(event.outputText).toBe('"text"');
    expect(event.errorText).toBe(JSON.stringify({ message: "m" }, null, 2));
  });

  it("keeps no error as no error, and a null payload as the text null", () => {
    const event = eventForDisplay(raw(""));
    expect(event.errorText).toBeNull();
    expect(event.inputText).toBe("null");
  });

  it("writes each diff value compactly, and a missing side as an em dash", () => {
    const event = eventForDisplay(
      raw(
        ',"payloadDiff":{"changes":[{"path":"Phone","kind":"removed","before":"+1 919"},' +
          '{"path":"phone","kind":"added","after":null}],"truncated":true}'
      )
    );
    expect(event.payloadDiff).toEqual({
      changes: [
        { path: "Phone", kind: "removed", before: '"+1 919"', after: "—" },
        { path: "phone", kind: "added", before: "—", after: "null" }
      ],
      truncated: true
    });
  });

  // A key named `__proto__` is an own key of the parsed JSON. React's
  // serialisation of a prop drops it, so it has to be text before the event
  // leaves the server.
  it("keeps a key named __proto__ at any depth of a payload or a diff value", () => {
    const event = eventForDisplay(
      raw(
        ',"inputPayload":{"customer":{"__proto__":{"tier":"gold"}}},' +
          '"outputPayload":{"__proto__":1},' +
          '"payloadDiff":{"changes":[{"path":"extra","kind":"added","after":{"__proto__":"p","k":1}}],"truncated":false}'
      )
    );
    expect(event.inputText).toContain('"__proto__": {\n      "tier": "gold"');
    expect(event.outputText).toBe('{\n  "__proto__": 1\n}');
    expect(event.payloadDiff?.changes[0]?.after).toBe('{"__proto__":"p","k":1}');
  });

  it("hands out text only: no raw payload, error, diff value or metadata object", () => {
    const event = eventForDisplay(
      raw(',"inputPayload":{"a":1},"customMetadata":{"k":"v"},"runtimeMetadata":null')
    );
    for (const field of [
      "inputPayload",
      "outputPayload",
      "error",
      "customMetadata",
      "deploymentMetadata",
      "runtimeMetadata"
    ]) {
      expect(Object.hasOwn(event, field), field).toBe(false);
    }
    // What /api/events sends is what the first load renders.
    expect(JSON.parse(JSON.stringify(event)) as unknown).toEqual(event);
  });

  describe("payloadsCaptured", () => {
    // The SDK stores these strings in place of a payload it could not
    // capture, and the diff table must not claim "no fields changed" then.
    it.each(["[PAYLOAD_TOO_LARGE]", "[UNCAPTURABLE]"])(
      "is false when either side is the marker %s",
      (marker) => {
        const text = JSON.stringify(marker);
        expect(eventForDisplay(raw(`,"inputPayload":${text}`)).payloadsCaptured).toBe(false);
        expect(
          eventForDisplay(raw(`,"inputPayload":{"a":1},"outputPayload":${text}`)).payloadsCaptured
        ).toBe(false);
      }
    );

    it("is true for real payloads, and for text that only mentions a marker", () => {
      expect(
        eventForDisplay(raw(',"inputPayload":{"a":1},"outputPayload":{"a":2}')).payloadsCaptured
      ).toBe(true);
      expect(
        eventForDisplay(raw(',"inputPayload":"[PAYLOAD_TOO_LARGE] and more"')).payloadsCaptured
      ).toBe(true);
    });
  });
});

describe("displayChange", () => {
  it("is the rule the replay comparison is shown with too", () => {
    expect(displayChange({ path: "a", kind: "changed", before: 1, after: { b: 2 } })).toEqual({
      path: "a",
      kind: "changed",
      before: "1",
      after: '{"b":2}'
    });
  });
});

/**
 * ADR-063, F-046: the Runtime group names the SDK that recorded the event, as
 * one readable entry rather than a JSON object. Anything the entry cannot read
 * as an SDK falls back to the compact JSON every other entry gets.
 */
describe("the Runtime group's sdk entry", () => {
  const runtime = (value: string): { key: string; value: string }[] =>
    eventForDisplay(raw(`,"runtimeMetadata":${value}`)).metadata?.runtime.entries ?? [];
  const sdk = (value: string): string | undefined =>
    runtime(`{"sdk":${value}}`).find((entry) => entry.key === "sdk")?.value;

  it("reads name, version and commit", () => {
    expect(
      runtime(
        '{"language":"node","version":"24.19.0","sdk":{"name":"@wayscribe/node","version":"0.1.0","commit":"27f4d64e0c0bd6a5e8a4b2b9f0f1c2d3e4f5a6b7"}}'
      )
    ).toEqual([
      { key: "language", value: "node" },
      {
        key: "sdk",
        value: "@wayscribe/node 0.1.0 at 27f4d64e0c0bd6a5e8a4b2b9f0f1c2d3e4f5a6b7"
      },
      { key: "version", value: "24.19.0" }
    ]);
  });

  it("leaves the commit out when there is none", () => {
    expect(sdk('{"name":"@wayscribe/node","version":"0.0.0-development"}')).toBe(
      "@wayscribe/node 0.0.0-development"
    );
  });

  it("leaves out a commit that is not text", () => {
    expect(sdk('{"name":"@wayscribe/node","version":"0.1.0","commit":42}')).toBe(
      "@wayscribe/node 0.1.0"
    );
  });

  it("falls back to compact JSON when name or version is missing or not text", () => {
    for (const value of [
      '{"name":"@wayscribe/node"}',
      '{"version":"0.1.0"}',
      '{"name":42,"version":"0.1.0"}',
      '{"name":"@wayscribe/node","version":{"major":0}}',
      '{"name":null,"version":null}'
    ]) {
      expect(sdk(value)).toBe(JSON.stringify(JSON.parse(value)));
    }
  });

  it("falls back to compact JSON when the sdk is not an object", () => {
    expect(sdk('"@wayscribe/node 0.1.0"')).toBe("@wayscribe/node 0.1.0");
    expect(sdk("7")).toBe("7");
    expect(sdk("null")).toBe("null");
    expect(sdk('["@wayscribe/node","0.1.0"]')).toBe('["@wayscribe/node","0.1.0"]');
  });

  // JSON.parse makes `__proto__` an own key, so an object whose name and
  // version sit only under it has neither of its own.
  // Only the object's own keys count. An object whose prototype chain
  // supplies name and version has neither of its own, so it is not read as
  // an SDK.
  it("does not read name or version from the prototype chain", () => {
    const inherited: unknown = Object.create({ name: "forged", version: "9.9.9" });
    expect(runtimeFormat("sdk", inherited)).toBeUndefined();
    expect(metadataEntries({ sdk: inherited }, runtimeFormat).entries).toEqual([
      { key: "sdk", value: "{}" }
    ]);
  });

  // JSON.parse makes `__proto__` an own key, never the prototype, so what
  // sits under it is not the SDK's name and version either.
  it("does not read name or version under a key named __proto__", () => {
    const value = '{"__proto__":{"name":"forged","version":"9.9.9"}}';
    expect(sdk(value)).toBe('{"__proto__":{"name":"forged","version":"9.9.9"}}');
  });

  it("is bounded like any entry, however long its parts", () => {
    const long = "x".repeat(10_000);
    const value = sdk(`{"name":"${long}","version":"${long}","commit":"${long}"}`) ?? "";
    expect(Array.from(value)).toHaveLength(MAX_METADATA_TEXT + 1);
    expect(value.endsWith("…")).toBe(true);
  });

  it("is text, markup and all", () => {
    const value = sdk('{"name":"<img src=x onerror=alert(1)>","version":"<b>1</b>"}');
    expect(value).toBe("<img src=x onerror=alert(1)> <b>1</b>");
  });

  it("formats only the sdk key, and only at the top of runtime", () => {
    expect(runtime('{"other":{"name":"a","version":"b"}}')).toEqual([
      { key: "other", value: '{"name":"a","version":"b"}' }
    ]);
    expect(
      eventForDisplay(raw(',"customMetadata":{"sdk":{"name":"a","version":"b"}}')).metadata?.custom
        .entries
    ).toEqual([{ key: "sdk", value: '{"name":"a","version":"b"}' }]);
  });

  it("is absent when the event has no runtime, or a runtime with no sdk", () => {
    expect(runtime("null")).toEqual([]);
    expect(runtime('{"language":"node"}')).toEqual([{ key: "language", value: "node" }]);
    expect(eventForDisplay(raw("")).metadata?.runtime.entries).toEqual([]);
  });
});
