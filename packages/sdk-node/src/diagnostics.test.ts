import { describe, expect, it, vi } from "vitest";
import { createDiagnostics, type Diagnostic } from "./diagnostics.js";

const QUEUE_FULL: Diagnostic = {
  kind: "dropped",
  code: "queue_full",
  reason: "The queue was full.",
  detail: {}
};

const FETCH_FAILED: Diagnostic = {
  kind: "transport_error",
  code: "request_failed",
  reason: "fetch failed",
  detail: {}
};

describe("diagnostics", () => {
  it("counts events by kind", () => {
    const diagnostics = createDiagnostics();
    diagnostics.report(QUEUE_FULL);
    diagnostics.report(QUEUE_FULL);
    diagnostics.report({
      kind: "transport_error",
      code: "request_failed",
      reason: "timeout",
      detail: {}
    });

    expect(diagnostics.counters().dropped).toBe(2);
    expect(diagnostics.counters().transportErrors).toBe(1);
  });

  it("invokes the callback when one is supplied", () => {
    const onDiagnostic = vi.fn();
    createDiagnostics(onDiagnostic).report(QUEUE_FULL);
    expect(onDiagnostic).toHaveBeenCalledOnce();
  });

  it("never throws when the callback throws", () => {
    // A diagnostics callback that throws must not become the failure it reports.
    const diagnostics = createDiagnostics(() => {
      throw new Error("callback exploded");
    });
    expect(() => {
      diagnostics.report(QUEUE_FULL);
    }).not.toThrow();
    expect(diagnostics.counters().dropped).toBe(1);
  });

  it("does not write to the console", () => {
    // SECURITY.md section 12: a recorder that logs every failed flush becomes
    // the incident during an outage.
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    createDiagnostics().report({
      kind: "transport_error",
      code: "request_failed",
      reason: "boom",
      detail: {}
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("counts an omitted payload apart from dropped events", () => {
    const diagnostics = createDiagnostics();
    diagnostics.report({
      kind: "payload_omitted",
      code: "too_large",
      reason: "A payload was not captured.",
      detail: { field: "input" }
    });
    expect(diagnostics.counters()).toMatchObject({ payloadsOmitted: 1, dropped: 0 });
  });

  it("counts every kind in reports, key_dropped included", () => {
    // One unit for every counter: a report. How many keys a report left off is
    // in its detail, not in the counter.
    const diagnostics = createDiagnostics();
    diagnostics.report({
      kind: "key_dropped",
      code: "alias_invalid",
      reason: "3 entries left off the event's aliases.",
      detail: { field: "aliases", keys: 3 }
    });
    diagnostics.report({
      kind: "breaker_opened",
      code: "consecutive_failures",
      reason: "Sends pause.",
      detail: { failures: 5, cooldownMs: 30_000 }
    });
    expect(diagnostics.counters()).toMatchObject({ keysDropped: 1, breakerOpened: 1 });
  });

  it("counts recorded events apart from every diagnostic", () => {
    const diagnostics = createDiagnostics();
    diagnostics.countRecorded();
    diagnostics.countRecorded();
    diagnostics.report(QUEUE_FULL);
    expect(diagnostics.counters()).toMatchObject({ recorded: 2, dropped: 1 });
  });

  it("returns a copy of its counters", () => {
    const diagnostics = createDiagnostics();
    const first = diagnostics.counters();
    diagnostics.report(QUEUE_FULL);
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
      code: "request_failed",
      reason: "fetch failed",
      detail: {}
    });
    restore();
    expect(lines).toEqual(["[wayscribe] transport_error: fetch failed"]);
  });

  it("prints one line per kind per minute and counts what it suppressed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { lines, restore } = logged();
    const diagnostics = createDiagnostics(undefined, { log: true });

    for (let i = 0; i < 5; i += 1) {
      diagnostics.report(FETCH_FAILED);
    }
    // A different kind has its own window: an outage's transport errors must
    // not hide the one rejection that explains it.
    diagnostics.report({
      kind: "rejected",
      code: "event_refused",
      reason: "invalid_event: no",
      detail: {}
    });
    expect(lines).toHaveLength(2);

    vi.setSystemTime(1_000_000 + MINUTE - 1);
    diagnostics.report(FETCH_FAILED);
    expect(lines).toHaveLength(2);

    vi.setSystemTime(1_000_000 + MINUTE);
    diagnostics.report(FETCH_FAILED);
    restore();
    vi.useRealTimers();

    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe(
      "[wayscribe] transport_error: fetch failed (5 repeats suppressed since the last line)"
    );
    // Printing is rate-limited; counting is not.
    expect(diagnostics.counters().transportErrors).toBe(7);
  });

  it("reports repeats still suppressed when flushed", () => {
    const { lines, restore } = logged();
    const diagnostics = createDiagnostics(undefined, { log: true });
    diagnostics.report(QUEUE_FULL);
    diagnostics.report(QUEUE_FULL);
    diagnostics.report(QUEUE_FULL);
    diagnostics.flushLog();
    // Nothing new since, so a second flush has nothing to say.
    diagnostics.flushLog();
    restore();
    expect(lines).toEqual([
      "[wayscribe] dropped: The queue was full.",
      "[wayscribe] dropped: 2 repeats suppressed since the last line"
    ]);
  });

  it("always prints delivered_first", () => {
    const { lines, restore } = logged();
    const diagnostics = createDiagnostics(undefined, { log: true });
    diagnostics.report({
      kind: "delivered_first",
      code: "first_delivery",
      reason: "Connected: http://localhost:8080 accepted 3 events.",
      detail: { endpoint: "http://localhost:8080", accepted: 3 }
    });
    restore();
    expect(lines).toEqual([
      "[wayscribe] delivered_first: Connected: http://localhost:8080 accepted 3 events."
    ]);
  });

  it("prints the reason as one masked, bounded line and never the detail", () => {
    const { lines, restore } = logged();
    createDiagnostics(undefined, { log: true }).report({
      kind: "capture_error",
      code: "unexpected_error",
      reason: `connect postgres://app:hunter2@db:5432\n\u001b[31mred${"x".repeat(5_000)}`,
      detail: { error: { payload: "never printed" } }
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
      code: "unexpected_error",
      reason: `a${[...controls, ...isolates].join("b")}c`,
      detail: {}
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
      {
        kind: "rejected",
        code: "event_refused",
        reason: "invalid_event: Value dana@example.com is not allowed.",
        detail: {}
      },
      "invalid_event (the server's message goes to onDiagnostic)"
    );
    restore();
    expect(lines).toEqual([
      "[wayscribe] rejected: invalid_event (the server's message goes to onDiagnostic)"
    ]);
    expect(seen).toEqual(["invalid_event: Value dana@example.com is not allowed."]);
  });

  it("does not count delivered_first as a failure", () => {
    const diagnostics = createDiagnostics();
    diagnostics.report({
      kind: "delivered_first",
      code: "first_delivery",
      reason: "Connected.",
      detail: { endpoint: "http://localhost:8080", accepted: 1 }
    });
    expect(diagnostics.counters()).toEqual({
      recorded: 0,
      dropped: 0,
      rejected: 0,
      transportErrors: 0,
      captureErrors: 0,
      breakerOpened: 0,
      payloadsOmitted: 0,
      payloadsTruncated: 0,
      keysDropped: 0,
      configurationErrors: 0,
      rejectedSettings: [],
      rejectedOptions: [],
      unredactedSecretNames: 0,
      personalDataInPublicValues: 0,
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
      diagnostics.report(QUEUE_FULL);
      diagnostics.report(QUEUE_FULL);
      diagnostics.flushLog();
    }).not.toThrow();
    spy.mockRestore();
  });
});
