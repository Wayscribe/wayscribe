import { describe, expect, it, vi } from "vitest";
import { createDiagnostics } from "./diagnostics.js";

describe("diagnostics", () => {
  it("counts events by kind", () => {
    const diagnostics = createDiagnostics();
    diagnostics.report({ kind: "dropped", reason: "queue_full" });
    diagnostics.report({ kind: "dropped", reason: "queue_full" });
    diagnostics.report({ kind: "transport_error", reason: "timeout" });

    expect(diagnostics.counters().dropped).toBe(2);
    expect(diagnostics.counters().transportErrors).toBe(1);
  });

  it("invokes the callback when one is supplied", () => {
    const onDiagnostic = vi.fn();
    createDiagnostics(onDiagnostic).report({ kind: "dropped", reason: "queue_full" });
    expect(onDiagnostic).toHaveBeenCalledOnce();
  });

  it("never throws when the callback throws", () => {
    // A diagnostics callback that throws must not become the failure it reports.
    const diagnostics = createDiagnostics(() => {
      throw new Error("callback exploded");
    });
    expect(() => {
      diagnostics.report({ kind: "dropped", reason: "queue_full" });
    }).not.toThrow();
    expect(diagnostics.counters().dropped).toBe(1);
  });

  it("does not write to the console", () => {
    // SECURITY.md section 12: a recorder that logs every failed flush becomes
    // the incident during an outage.
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    createDiagnostics().report({ kind: "transport_error", reason: "boom" });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("returns a copy of its counters", () => {
    const diagnostics = createDiagnostics();
    const first = diagnostics.counters();
    diagnostics.report({ kind: "dropped", reason: "queue_full" });
    expect(first.dropped).toBe(0);
  });
});
