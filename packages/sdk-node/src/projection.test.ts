import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { Counters, Diagnostic } from "./diagnostics.js";
import { createRecorder, type Journey, type JourneyContext } from "./index.js";

/**
 * A wrapper can capture a view of what it wraps, and still hand the host the
 * real thing.
 *
 * A step that returns a PDF buffer should record its size, not a megabyte of
 * `{"type": "Buffer", "data": [...]}`, and before these options a host had to
 * write its own wrapper to say so, giving up the wrappers' guarantees.
 */

interface Captured {
  events: Record<string, unknown>[];
  diagnostics: Diagnostic[];
  counters: Counters;
}

async function capture(record: (journey: Journey) => Promise<void> | void): Promise<Captured> {
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
  try {
    const recorder = createRecorder({
      endpoint: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
      apiKey: "fr_test",
      serviceName: "svc",
      environment: "development",
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });
    await record(recorder.startJourney({ entity: { type: "invoice", id: "inv_1" } }));
    const counters = await recorder.shutdown({ timeoutMs: 5_000 });
    return { events, diagnostics, counters };
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}

const pdf = Buffer.from("%PDF-1.7 not really a pdf");

describe("captureOutput", () => {
  it("records the projection and returns the real value, synchronously", async () => {
    let returned: unknown;
    const { events } = await capture((journey) => {
      returned = journey.transform("render-pdf", { invoiceId: "inv_1" }, () => pdf, {
        captureOutput: (buffer) => ({ bytes: buffer.length })
      });
    });
    expect(returned).toBe(pdf);
    expect(events[0]?.["output"]).toEqual({ bytes: pdf.length });
    expect(events[0]?.["input"]).toEqual({ invoiceId: "inv_1" });
  });

  it("records the projection of a resolved value and resolves to the real one", async () => {
    let returned: unknown;
    const { events } = await capture(async (journey) => {
      returned = await journey.deliver("upload", {}, () => Promise.resolve(pdf), {
        captureOutput: (buffer) => ({ bytes: buffer.length })
      });
    });
    expect(returned).toBe(pdf);
    expect(events[0]?.["output"]).toEqual({ bytes: pdf.length });
  });

  it("passes the journey's context, so one projection can serve many journeys", async () => {
    const seen: JourneyContext[] = [];
    await capture((journey) => {
      journey.persist("save", {}, () => 1, {
        captureOutput: (value, context) => {
          seen.push(context);
          return value;
        }
      });
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.entity).toEqual({ type: "invoice", id: "inv_1" });
    expect(seen[0]?.journeyId).toMatch(/^jrn_/);
  });

  it("is not called when the callback throws, and the error is still recorded", async () => {
    let called = false;
    const thrown = new Error("render failed");
    const { events } = await capture((journey) => {
      expect(() =>
        journey.transform(
          "render-pdf",
          {},
          (): Buffer => {
            throw thrown;
          },
          {
            captureOutput: () => {
              called = true;
              return null;
            }
          }
        )
      ).toThrow(thrown);
    });
    expect(called).toBe(false);
    expect(events[0]?.["error"]).toMatchObject({ message: "render failed" });
  });
});

describe("captureInput", () => {
  it("runs before the callback, so it sees the input as it went in", async () => {
    const order = { id: "ord_1", lines: [1, 2, 3] };
    const { events } = await capture((journey) => {
      journey.transform(
        "consume-lines",
        order,
        () => {
          order.lines.length = 0;
          return order.id;
        },
        { captureInput: (input) => ({ lineCount: input.lines.length }) }
      );
    });
    expect(events[0]?.["input"]).toEqual({ lineCount: 3 });
    expect(events[0]?.["output"]).toBe("ord_1");
  });

  it("records the projection as it was at the call, even when the callback changes what it shares", async () => {
    // The projection returns part of the input rather than a copy, which is
    // the ordinary way to write one; the callback then changes that part.
    const order = { id: "ord_1", items: ["a"] };
    const { events } = await capture(async (journey) => {
      await journey.transform(
        "add-items",
        order,
        () => {
          order.items.push("b", "c");
          return Promise.resolve(order.items.length);
        },
        { captureInput: (input) => ({ items: input.items }) }
      );
    });
    expect(events[0]?.["input"]).toEqual({ items: ["a"] });
    expect(events[0]?.["output"]).toBe(3);
  });

  it("snapshots a projection that returns the input itself", async () => {
    const shared = { items: ["a"] };
    const events: Record<string, unknown>[] = [];
    const recorded = await capture((journey) => {
      journey.persist(
        "write",
        shared,
        () => {
          shared.items.push("b");
          return true;
        },
        { captureInput: (input) => input }
      );
    });
    events.push(...recorded.events);
    expect(events[0]?.["input"]).toEqual({ items: ["a"] });
  });

  it("applies on the failure path too", async () => {
    const { events } = await capture((journey) => {
      expect(() =>
        journey.deliver(
          "send",
          { secretish: "x".repeat(10) },
          () => {
            throw new Error("down");
          },
          { captureInput: () => "a view" }
        )
      ).toThrow("down");
    });
    expect(events[0]?.["input"]).toBe("a view");
  });
});

describe("a projection that fails", () => {
  it("records a marker, reports it, and leaves the host's value alone", async () => {
    let returned: unknown;
    const { events, diagnostics, counters } = await capture((journey) => {
      returned = journey.transform("t", { a: 1 }, () => pdf, {
        captureOutput: () => {
          throw new Error("projection bug");
        }
      });
    });
    expect(returned).toBe(pdf);
    expect(events).toHaveLength(1);
    expect(events[0]?.["output"]).toBe("[UNCAPTURABLE]");
    expect(events[0]?.["input"]).toEqual({ a: 1 });
    expect(counters.payloadsOmitted).toBe(1);
    expect(counters.captureErrors).toBe(0);
    const omitted = diagnostics.find((d) => d.kind === "payload_omitted");
    expect(omitted).toMatchObject({ code: "projection_failed", detail: { field: "output" } });
    // The projection's own message can carry payload data, so it is not in the
    // reason that logDiagnostics would print.
    expect(omitted?.reason).not.toContain("projection bug");
  });

  it("does not change what the host's error is", async () => {
    const thrown = new Error("the real failure");
    await capture(async (journey) => {
      await expect(
        journey.deliver("d", {}, () => Promise.reject(thrown), {
          captureInput: () => {
            throw new Error("projection bug");
          }
        })
      ).rejects.toBe(thrown);
    });
  });

  it("treats a projection that returns a promise as a failure, without an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      const { events } = await capture((journey) => {
        journey.transform("t", {}, () => 1, {
          captureInput: () => Promise.reject(new Error("async projection")),
          captureOutput: () => Promise.resolve("later")
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(events[0]?.["input"]).toBe("[UNCAPTURABLE]");
      expect(events[0]?.["output"]).toBe("[UNCAPTURABLE]");
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });
});

describe("types", () => {
  it("keeps the callback's own return type, and gives the projection the resolved value", () => {
    const journey = createRecorder({
      endpoint: "http://127.0.0.1:1",
      apiKey: "fr_test",
      serviceName: "svc",
      environment: "development"
    }).startJourney({ entity: { type: "invoice", id: "1" } });

    const sync = journey.transform("t", {}, () => pdf, {
      captureOutput: (value) => {
        expectTypeOf(value).toEqualTypeOf<typeof pdf>();
        return value.length;
      },
      isFailure: (value) => {
        expectTypeOf(value).toEqualTypeOf<typeof pdf>();
        return false;
      }
    });
    expectTypeOf(sync).toEqualTypeOf<typeof pdf>();

    const later = journey.persist("p", {}, () => Promise.resolve({ id: 1 }), {
      captureOutput: (value) => {
        expectTypeOf(value).toEqualTypeOf<{ id: number }>();
        return value.id;
      }
    });
    expectTypeOf(later).toEqualTypeOf<Promise<{ id: number }>>();
    void later;
  });
});
