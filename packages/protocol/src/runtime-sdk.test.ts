import { describe, expect, it } from "vitest";
import { parseEnvelope } from "./envelope.js";
import { journeyEventSchema, runtimeSchema } from "./event.js";
import { runtimeSdkSchema } from "./index.js";

/**
 * `runtime.sdk`: which SDK recorded an event (F-046, ADR-063 decision 1). An
 * optional field inside `runtime`, so the protocol version stays `0.1`.
 */

const event = {
  id: "evt_01",
  journeyId: "jrn_01",
  environment: "development",
  service: "customer-integration",
  entity: { type: "customer", id: "18492" },
  operation: "received",
  name: "receive-salesforce-webhook",
  timestamp: "2026-08-06T18:31:02.000Z"
};

const sdk = {
  name: "@wayscribe/node",
  version: "0.1.0",
  commit: "27f4d64a3b1c0e9f8d7c6b5a4f3e2d1c0b9a8f7e"
};

function refusal(runtime: unknown): string[] {
  const result = parseEnvelope({ protocolVersion: "0.1", event: { ...event, runtime } });
  if (result.ok) return [];
  return result.details.map((detail) => detail.path);
}

describe("runtime.sdk", () => {
  it("is accepted with a name, a version and a commit, and kept by the parse", () => {
    const result = parseEnvelope({
      protocolVersion: "0.1",
      event: { ...event, runtime: { language: "node", version: "24.19.0", sdk } }
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.runtime).toEqual({ language: "node", version: "24.19.0", sdk });
    }
  });

  it("is accepted without a commit, and at every limit", () => {
    expect(runtimeSdkSchema.safeParse({ name: "n", version: "v" }).success).toBe(true);
    expect(
      runtimeSdkSchema.safeParse({
        name: "n".repeat(128),
        version: "v".repeat(64),
        commit: "c".repeat(128)
      }).success
    ).toBe(true);
  });

  it.each([
    ["an empty name", { ...sdk, name: "" }, "event.runtime.sdk.name"],
    ["a name over 128", { ...sdk, name: "n".repeat(129) }, "event.runtime.sdk.name"],
    ["no name", { version: "0.1.0" }, "event.runtime.sdk.name"],
    ["an empty version", { ...sdk, version: "" }, "event.runtime.sdk.version"],
    ["a version over 64", { ...sdk, version: "v".repeat(65) }, "event.runtime.sdk.version"],
    ["no version", { name: "@wayscribe/node" }, "event.runtime.sdk.version"],
    ["an empty commit", { ...sdk, commit: "" }, "event.runtime.sdk.commit"],
    ["a commit over 128", { ...sdk, commit: "c".repeat(129) }, "event.runtime.sdk.commit"],
    ["a name that is not a string", { ...sdk, name: 7 }, "event.runtime.sdk.name"]
  ])("refuses %s as invalid_event, naming the field", (_what, value, path) => {
    expect(refusal({ sdk: value })).toEqual([path]);
  });

  it("is what runtimeSchema's sdk field is", () => {
    expect(runtimeSchema.shape.sdk.unwrap()).toBe(runtimeSdkSchema);
  });

  it("is stripped, with the rest of runtime kept, by a server from before it", () => {
    // What an old server's schema is: runtime without sdk. A plain z.object
    // strips an unknown key (ADR-049), so a new SDK works against it.
    const before = journeyEventSchema.extend({
      runtime: runtimeSchema.omit({ sdk: true }).optional()
    });
    const result = before.safeParse({
      ...event,
      runtime: { language: "node", version: "24.19.0", sdk }
    });
    expect(result.success).toBe(true);
    expect(result.data?.runtime).toEqual({ language: "node", version: "24.19.0" });
  });
});
