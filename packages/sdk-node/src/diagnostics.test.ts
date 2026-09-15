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

describe("logDiagnostics", () => {
  const MINUTE = 60_000;

  function logged(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    return {
      lines,
      restore: () => {
        spy.mockRestore();
      }
    };
  }

  it("writes one prefixed line for a diagnostic", () => {
    const { lines, restore } = logged();
    createDiagnostics(undefined, { log: true }).report({
      kind: "transport_error",
      reason: "fetch failed"
    });
    restore();
    expect(lines).toEqual(["[flight-recorder] transport_error: fetch failed"]);
  });

  it("prints one line per kind per minute and counts what it suppressed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { lines, restore } = logged();
    const diagnostics = createDiagnostics(undefined, { log: true });

    for (let i = 0; i < 5; i += 1) {
      diagnostics.report({ kind: "transport_error", reason: "fetch failed" });
    }
    // A different kind has its own window: an outage's transport errors must
    // not hide the one rejection that explains it.
    diagnostics.report({ kind: "rejected", reason: "invalid_event: no" });
    expect(lines).toHaveLength(2);

    vi.setSystemTime(1_000_000 + MINUTE - 1);
    diagnostics.report({ kind: "transport_error", reason: "fetch failed" });
    expect(lines).toHaveLength(2);

    vi.setSystemTime(1_000_000 + MINUTE);
    diagnostics.report({ kind: "transport_error", reason: "fetch failed" });
    restore();
    vi.useRealTimers();

    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe(
      "[flight-recorder] transport_error: fetch failed (5 repeats suppressed since the last line)"
    );
    // Printing is rate-limited; counting is not.
    expect(diagnostics.counters().transportErrors).toBe(7);
  });

  it("reports repeats still suppressed when flushed", () => {
    const { lines, restore } = logged();
    const diagnostics = createDiagnostics(undefined, { log: true });
    diagnostics.report({ kind: "dropped", reason: "queue_full" });
    diagnostics.report({ kind: "dropped", reason: "queue_full" });
    diagnostics.report({ kind: "dropped", reason: "queue_full" });
    diagnostics.flushLog();
    // Nothing new since, so a second flush has nothing to say.
    diagnostics.flushLog();
    restore();
    expect(lines).toEqual([
      "[flight-recorder] dropped: queue_full",
      "[flight-recorder] dropped: 2 repeats suppressed since the last line"
    ]);
  });

  it("always prints delivered_first", () => {
    const { lines, restore } = logged();
    const diagnostics = createDiagnostics(undefined, { log: true });
    diagnostics.report({
      kind: "delivered_first",
      reason: "Connected: http://localhost:8080 accepted 3 events.",
      endpoint: "http://localhost:8080",
      accepted: 3
    });
    restore();
    expect(lines).toEqual([
      "[flight-recorder] delivered_first: Connected: http://localhost:8080 accepted 3 events."
    ]);
  });

  it("prints the reason as one masked, bounded line and never the detail", () => {
    const { lines, restore } = logged();
    createDiagnostics(undefined, { log: true }).report({
      kind: "capture_error",
      reason: `connect postgres://app:hunter2@db:5432\n\u001b[31mred${"x".repeat(5_000)}`,
      detail: { payload: "never printed" }
    });
    restore();
    expect(lines).toHaveLength(1);
    const [line = ""] = lines;
    expect(line).not.toContain("hunter2");
    expect(line).not.toContain("\n");
    expect(line).not.toContain("\u001b");
    expect(line).not.toContain("never printed");
    expect(line.length).toBeLessThanOrEqual(600);
  });

  it("replaces bidirectional formatting characters", () => {
    // U+202E reverses what follows in many log viewers, so a reason could make
    // its line read as something it does not say.
    const controls = [
      "\u061c",
      "\u200e",
      "\u200f",
      "\u202a",
      "\u202b",
      "\u202c",
      "\u202d",
      "\u202e"
    ];
    const isolates = ["\u2066", "\u2067", "\u2068", "\u2069"];
    const { lines, restore } = logged();
    createDiagnostics(undefined, { log: true }).report({
      kind: "capture_error",
      reason: `a${[...controls, ...isolates].join("b")}c`
    });
    restore();
    const [line = ""] = lines;
    for (const character of [...controls, ...isolates]) expect(line).not.toContain(character);
    expect(line).toContain("a b");
  });

  it("prints the log line in place of the reason when one is given", () => {
    const seen: string[] = [];
    const { lines, restore } = logged();
    createDiagnostics((d) => seen.push(d.reason), { log: true }).report(
      { kind: "rejected", reason: "invalid_event: Value dana@example.com is not allowed." },
      "invalid_event (the server's message goes to onDiagnostic)"
    );
    restore();
    expect(lines).toEqual([
      "[flight-recorder] rejected: invalid_event (the server's message goes to onDiagnostic)"
    ]);
    expect(seen).toEqual(["invalid_event: Value dana@example.com is not allowed."]);
  });

  it("does not count delivered_first as a failure", () => {
    const diagnostics = createDiagnostics();
    diagnostics.report({
      kind: "delivered_first",
      reason: "Connected.",
      endpoint: "http://localhost:8080",
      accepted: 1
    });
    expect(diagnostics.counters()).toEqual({
      dropped: 0,
      rejected: 0,
      transportErrors: 0,
      captureErrors: 0,
      breakerOpened: 0,
      sent: 0
    });
  });

  it("survives a console that throws", () => {
    // A closed stderr under a supervisor makes console.error throw EPIPE. The
    // recorder must not become the failure it was reporting.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("EPIPE");
    });
    const diagnostics = createDiagnostics(undefined, { log: true });
    expect(() => {
      diagnostics.report({ kind: "dropped", reason: "queue_full" });
      diagnostics.report({ kind: "dropped", reason: "queue_full" });
      diagnostics.flushLog();
    }).not.toThrow();
    spy.mockRestore();
  });
});
