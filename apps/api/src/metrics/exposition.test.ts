import { describe, expect, it } from "vitest";
import { Registry, escapeHelp, escapeLabelValue, formatNumber } from "./exposition.js";

describe("Prometheus text exposition", () => {
  it("writes HELP, TYPE, and one line per series", async () => {
    const registry = new Registry();
    const counter = registry.counter("jobs_total", "Jobs run.", ["outcome"]);
    counter.inc({ outcome: "ok" });
    counter.inc({ outcome: "ok" }, 2);
    counter.inc({ outcome: "failed" });

    expect(await registry.render()).toBe(
      [
        "# HELP jobs_total Jobs run.",
        "# TYPE jobs_total counter",
        'jobs_total{outcome="ok"} 3',
        'jobs_total{outcome="failed"} 1',
        ""
      ].join("\n")
    );
  });

  it("writes an unlabelled metric as 0 before anything records it", async () => {
    const registry = new Registry();
    registry.counter("deleted_total", "Deleted.");
    registry.gauge("last_seconds", "Last.");
    expect(await registry.render()).toContain("\ndeleted_total 0\n");
    expect(await registry.render()).toContain("\nlast_seconds 0\n");
  });

  it("writes a labelled metric with no series as its HELP and TYPE alone", async () => {
    const registry = new Registry();
    registry.counter("timeouts_total", "Timeouts.", ["route"]);
    expect(await registry.render()).toBe(
      "# HELP timeouts_total Timeouts.\n# TYPE timeouts_total counter\n"
    );
  });

  it("escapes backslash, double quote, and line feed in label values", async () => {
    expect(escapeLabelValue('a\\b"c\nd')).toBe('a\\\\b\\"c\\nd');

    const registry = new Registry();
    registry.gauge("g", "G.", ["v"]).set({ v: 'x"\\\n' }, 1);
    expect(await registry.render()).toContain('g{v="x\\"\\\\\\n"} 1');
  });

  it("escapes backslash and line feed in HELP, and leaves double quotes", () => {
    expect(escapeHelp('one\\two\n"three"')).toBe('one\\\\two\\n"three"');
  });

  it("writes cumulative buckets, +Inf, _sum, and _count for a histogram", async () => {
    const registry = new Registry();
    const histogram = registry.histogram("latency_seconds", "Latency.", [0.1, 1, 0.5], ["route"]);
    for (const value of [0.05, 0.1, 0.3, 0.7, 2]) histogram.observe({ route: "/a" }, value);

    const lines = (await registry.render()).split("\n");
    expect(lines).toEqual([
      "# HELP latency_seconds Latency.",
      "# TYPE latency_seconds histogram",
      // `le` is inclusive, so 0.1 lands in the 0.1 bucket; the buckets were
      // given out of order and are written sorted.
      'latency_seconds_bucket{route="/a",le="0.1"} 2',
      'latency_seconds_bucket{route="/a",le="0.5"} 3',
      'latency_seconds_bucket{route="/a",le="1"} 4',
      'latency_seconds_bucket{route="/a",le="+Inf"} 5',
      'latency_seconds_sum{route="/a"} 3.15',
      'latency_seconds_count{route="/a"} 5',
      ""
    ]);
  });

  it("writes an unlabelled histogram's buckets with le alone", async () => {
    const registry = new Registry();
    registry.histogram("h", "H.", [1]).observe({}, 0.5);
    const text = await registry.render();
    expect(text).toContain('h_bucket{le="1"} 1\n');
    expect(text).toContain('h_bucket{le="+Inf"} 1\n');
    expect(text).toContain("h_sum 0.5\nh_count 1\n");
  });

  it("ignores a NaN observation rather than poisoning the sum", async () => {
    const registry = new Registry();
    const histogram = registry.histogram("h", "H.", [1]);
    histogram.observe({}, Number.NaN);
    histogram.observe({}, 0.25);
    expect(await registry.render()).toContain("h_sum 0.25\nh_count 1\n");
  });

  it("formats special values as Prometheus spells them", () => {
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe("+Inf");
    expect(formatNumber(Number.NEGATIVE_INFINITY)).toBe("-Inf");
    expect(formatNumber(Number.NaN)).toBe("NaN");
    expect(formatNumber(42)).toBe("42");
    expect(formatNumber(0.005)).toBe("0.005");
  });

  it("runs collectors before rendering, for values read at scrape time", async () => {
    const registry = new Registry();
    const gauge = registry.gauge("pool", "Pool.", ["state"]);
    let used = 0;
    registry.onCollect(async () => {
      await Promise.resolve();
      used += 1;
      gauge.set({ state: "used" }, used);
    });
    expect(await registry.render()).toContain('pool{state="used"} 1');
    expect(await registry.render()).toContain('pool{state="used"} 2');
  });

  it("refuses a missing label, a decreasing counter, and bad names", () => {
    const registry = new Registry();
    const counter = registry.counter("c_total", "C.", ["a", "b"]);
    expect(() => {
      counter.inc({ a: "x" } as unknown as { a: string; b: string });
    }).toThrow(/needs label b/);
    expect(() => {
      counter.inc({ a: "x", b: "y" }, -1);
    }).toThrow(/cannot decrease/);
    expect(() => registry.counter("c_total", "Again.")).toThrow(/twice/);
    expect(() => registry.counter("bad-name", "Bad.")).toThrow(/Invalid metric name/);
    expect(() => registry.histogram("h", "H.", [1], ["le"])).toThrow(/Invalid label name/);
    expect(() => registry.histogram("h2", "H.", [])).toThrow(/buckets/);
  });
});
