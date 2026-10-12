import { errorSchema } from "@wayscribe/protocol";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { Diagnostic } from "./diagnostics.js";
import { MAX_ERROR_FIELDS, MAX_ERROR_FIELD_LENGTH, errorFields } from "./error-fields.js";
import { createRecorder, type Journey, type Recorder } from "./index.js";

/**
 * An error's `fields` (ADR-072): the paths the failing system named, read by
 * convention like `code`, kept to what the server accepts, and never allowed
 * to cost the step it describes.
 */

const LINES = Array.from(
  { length: 25 },
  (_, index) => `Opportunity_Lines__c[${String(index)}].Unit_Price__c`
);

describe("errorFields", () => {
  it("keeps the paths a list names, in order", () => {
    expect(
      errorFields(["phone", "BillingAddress.PostalCode", "Opportunity_Lines__c[0].Unit_Price__c"])
    ).toEqual(["phone", "BillingAddress.PostalCode", "Opportunity_Lines__c[0].Unit_Price__c"]);
  });

  it("keeps only non-empty strings", () => {
    expect(errorFields(["", 42, null, { path: "phone" }, ["phone"], "phone"])).toEqual(["phone"]);
  });

  it("cuts the list to twenty and each path to two hundred code points", () => {
    const kept = errorFields(["😀".repeat(250), ...LINES]);
    expect(kept).toEqual(["😀".repeat(200), ...LINES.slice(0, 19)]);
    expect(kept).toHaveLength(MAX_ERROR_FIELDS);
  });

  it.each([
    ["a string", "phone"],
    ["an object", { phone: true }],
    ["a number", 7],
    ["null", null],
    ["undefined", undefined],
    ["an empty list", []],
    ["a list of nothing usable", ["", 0, false]]
  ])("answers undefined for %s", (_label, value) => {
    expect(errorFields(value)).toBeUndefined();
  });

  it("matches the protocol's limits", () => {
    // Copied, like the error text limits, because the SDK cannot import the
    // private protocol package at runtime.
    const accepts = (fields: string[]): boolean =>
      errorSchema.safeParse({ message: "m", fields }).success;
    expect(
      accepts(Array.from({ length: MAX_ERROR_FIELDS }, () => "x".repeat(MAX_ERROR_FIELD_LENGTH)))
    ).toBe(true);
    expect(accepts(Array.from({ length: MAX_ERROR_FIELDS + 1 }, () => "x"))).toBe(false);
    expect(accepts(["x".repeat(MAX_ERROR_FIELD_LENGTH + 1)])).toBe(false);
  });
});

const base = {
  apiKey: "wsk_test",
  serviceName: "demo-worker",
  environment: "development"
};

/** Every event the recorder sends, through a real HTTP server, and every diagnostic. */
async function capture(
  run: (recorder: Recorder) => Promise<void> | void
): Promise<{ events: Record<string, unknown>[]; diagnostics: Diagnostic[] }> {
  const events: Record<string, unknown>[] = [];
  const server = createServer((incoming, response) => {
    let body = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk: string) => {
      body += chunk;
    });
    incoming.on("end", () => {
      const parsed = JSON.parse(body) as { events: { event: Record<string, unknown> }[] };
      events.push(...parsed.events.map((entry) => entry.event));
      response.writeHead(202, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ data: { results: parsed.events.map(() => ({ status: "accepted" })) } })
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const diagnostics: Diagnostic[] = [];
  const recorder = createRecorder({
    ...base,
    endpoint: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    onDiagnostic: (d) => diagnostics.push(d)
  });
  try {
    await run(recorder);
    await recorder.shutdown({ timeoutMs: 5_000 });
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
  return { events, diagnostics };
}

const journeyIn = (recorder: Recorder): Journey =>
  recorder.startJourney({ entity: { type: "customer", id: "0018Z00002ABC" } });

describe("an error's fields on the wire (ADR-072)", () => {
  it("records the fields of a thrown error", async () => {
    const rejected = Object.assign(new Error("A phone number is required."), {
      code: "phone_required",
      fields: ["phone", "BillingAddress.PostalCode"]
    });
    const { events } = await capture((recorder) => {
      journeyIn(recorder).fail("move-message-to-dead-letter", rejected);
    });
    expect(events[0]?.["error"]).toEqual({
      message: "A phone number is required.",
      type: "Error",
      code: "phone_required",
      fields: ["phone", "BillingAddress.PostalCode"]
    });
  });

  it("records the fields of an error passed to record()", async () => {
    const { events } = await capture((recorder) => {
      journeyIn(recorder).record({
        operation: "delivered",
        name: "deliver-customer-to-target",
        error: {
          message: 'Property "status" has the value "former customer".',
          code: "invalid_property_value",
          fields: ["status"]
        }
      });
    });
    expect(events[0]?.["error"]).toEqual({
      message: 'Property "status" has the value "former customer".',
      code: "invalid_property_value",
      fields: ["status"]
    });
  });

  it("records the fields an isFailure reason names", async () => {
    const { events } = await capture(async (recorder) => {
      await journeyIn(recorder).deliver(
        "deliver-customer-to-target",
        { externalId: "0018Z00002ABC", phone: null },
        () => Promise.resolve({ status: 422 }),
        { isFailure: (result) => (result.status === 422 ? { fields: ["phone"] } : false) }
      );
    });
    expect(events[0]?.["error"]).toEqual({
      message: "deliver-customer-to-target reported a failed result.",
      code: "result_failed",
      fields: ["phone"]
    });
  });

  it("sends only what the server accepts", async () => {
    const { events } = await capture((recorder) => {
      journeyIn(recorder).fail(
        "move-message-to-dead-letter",
        Object.assign(new Error("rejected"), { fields: ["", 42, "x".repeat(250), ...LINES] })
      );
    });
    expect((events[0]?.["error"] as { fields: unknown }).fields).toEqual([
      "x".repeat(200),
      ...LINES.slice(0, 19)
    ]);
  });

  it("leaves fields off when nothing survives", async () => {
    const values: unknown[] = ["phone", [], ["", 7], { phone: true }];
    const { events } = await capture((recorder) => {
      const journey = journeyIn(recorder);
      for (const fields of values) {
        journey.fail(
          "move-message-to-dead-letter",
          Object.assign(new Error("rejected"), { fields })
        );
      }
    });
    expect(events.map((event) => event["error"])).toEqual(
      values.map(() => ({ message: "rejected", type: "Error" }))
    );
  });

  it("never lets a fields getter or a revoked list escape into the host", async () => {
    const throwing = new Error("A phone number is required.");
    Object.defineProperty(throwing, "fields", {
      get(): never {
        throw new Error("host bug");
      }
    });
    const revocable = Proxy.revocable<string[]>([], {});
    revocable.revoke();
    const revoked = Object.assign(new Error("A phone number is required."), {
      fields: revocable.proxy
    });
    const recorded = {
      message: "rejected",
      get fields(): string[] {
        throw new Error("host bug");
      }
    };

    const { events, diagnostics } = await capture((recorder) => {
      const journey = journeyIn(recorder);
      journey.fail("move-message-to-dead-letter", throwing);
      journey.fail("move-message-to-dead-letter", revoked);
      journey.record({
        operation: "delivered",
        name: "deliver-customer-to-target",
        error: recorded
      });
    });

    expect(events.map((event) => event["error"])).toEqual([
      { message: "A phone number is required.", type: "Error" },
      { message: "A phone number is required.", type: "Error" },
      { message: "rejected" }
    ]);
    expect(diagnostics.some((diagnostic) => diagnostic.kind === "capture_error")).toBe(true);
  });
});
