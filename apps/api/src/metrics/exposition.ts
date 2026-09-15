/**
 * Prometheus text exposition (format 0.0.4), for counters, gauges, and
 * histograms, written here rather than taken from a client library (ADR-047).
 *
 * The format is a few lines per series and has been stable for years; a
 * dependency for it would be another advisory feed to track in a process that
 * handles every captured payload. What it does not do is what this API does
 * not need: summaries, exemplars, OpenMetrics negotiation, and push.
 */

type LabelValues<L extends string> = Readonly<Record<L, string>>;

interface Metric {
  render(lines: string[]): void;
}

/** A metric name as Prometheus accepts it. Checked once, at registration. */
const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
/** A label name; `le` is reserved for histogram buckets. */
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export class Registry {
  private readonly metrics: Metric[] = [];
  private readonly names = new Set<string>();
  private readonly collectors: (() => void | Promise<void>)[] = [];

  counter<L extends string = never>(
    name: string,
    help: string,
    labelNames: readonly L[] = []
  ): Counter<L> {
    return this.add(name, labelNames, new Counter(name, help, labelNames));
  }

  gauge<L extends string = never>(
    name: string,
    help: string,
    labelNames: readonly L[] = []
  ): Gauge<L> {
    return this.add(name, labelNames, new Gauge(name, help, labelNames));
  }

  histogram<L extends string = never>(
    name: string,
    help: string,
    buckets: readonly number[],
    labelNames: readonly L[] = []
  ): Histogram<L> {
    return this.add(name, labelNames, new Histogram(name, help, buckets, labelNames));
  }

  /** Run before every render, for values read at scrape time rather than recorded as they happen. */
  onCollect(collect: () => void | Promise<void>): void {
    this.collectors.push(collect);
  }

  async render(): Promise<string> {
    for (const collect of this.collectors) await collect();
    const lines: string[] = [];
    for (const metric of this.metrics) metric.render(lines);
    return `${lines.join("\n")}\n`;
  }

  private add<M extends Metric>(name: string, labelNames: readonly string[], metric: M): M {
    if (!METRIC_NAME.test(name)) throw new Error(`Invalid metric name: ${name}`);
    if (this.names.has(name)) throw new Error(`Metric registered twice: ${name}`);
    for (const label of labelNames) {
      if (!LABEL_NAME.test(label) || label === "le")
        throw new Error(`Invalid label name: ${label}`);
    }
    this.names.add(name);
    this.metrics.push(metric);
    return metric;
  }
}

/** Series keyed by their label values in declaration order. */
abstract class Labelled<L extends string, S> implements Metric {
  protected readonly series = new Map<string, { labels: string[]; state: S }>();

  constructor(
    protected readonly name: string,
    private readonly help: string,
    private readonly type: "counter" | "gauge" | "histogram",
    private readonly labelNames: readonly L[]
  ) {}

  render(lines: string[]): void {
    lines.push(`# HELP ${this.name} ${escapeHelp(this.help)}`);
    lines.push(`# TYPE ${this.name} ${this.type}`);
    // A metric without labels always has its one series, so a counter that has
    // never moved reads 0 rather than being absent, which an alert on
    // `increase()` cannot tell from a process that never registered it.
    if (this.labelNames.length === 0 && this.series.size === 0) this.state([]);
    for (const { labels, state } of this.series.values()) this.renderSeries(lines, labels, state);
  }

  protected abstract initial(): S;
  protected abstract renderSeries(lines: string[], labels: string[], state: S): void;

  protected state(values: string[]): S {
    const key = JSON.stringify(values);
    let entry = this.series.get(key);
    if (entry === undefined) {
      entry = { labels: values, state: this.initial() };
      this.series.set(key, entry);
    }
    return entry.state;
  }

  protected valuesOf(labels: LabelValues<L>): string[] {
    return this.labelNames.map((name) => {
      const value = (labels as Partial<Record<L, string>>)[name];
      // A missing label would silently start a second series under an empty value.
      if (value === undefined) throw new Error(`${this.name} needs label ${name}`);
      return value;
    });
  }

  protected labelText(values: readonly string[], extra: string[] = []): string {
    const pairs = this.labelNames.map(
      (name, index) => `${name}="${escapeLabelValue(values[index] ?? "")}"`
    );
    const all = [...pairs, ...extra];
    return all.length === 0 ? "" : `{${all.join(",")}}`;
  }
}

export class Counter<L extends string> extends Labelled<L, { value: number }> {
  constructor(name: string, help: string, labelNames: readonly L[]) {
    super(name, help, "counter", labelNames);
  }

  inc(labels: LabelValues<L>, amount = 1): void {
    if (!(amount >= 0)) throw new Error(`${this.name} cannot decrease`);
    this.state(this.valuesOf(labels)).value += amount;
  }

  protected initial(): { value: number } {
    return { value: 0 };
  }

  protected renderSeries(lines: string[], labels: string[], state: { value: number }): void {
    lines.push(`${this.name}${this.labelText(labels)} ${formatNumber(state.value)}`);
  }
}

export class Gauge<L extends string> extends Labelled<L, { value: number }> {
  constructor(name: string, help: string, labelNames: readonly L[]) {
    super(name, help, "gauge", labelNames);
  }

  set(labels: LabelValues<L>, value: number): void {
    this.state(this.valuesOf(labels)).value = value;
  }

  protected initial(): { value: number } {
    return { value: 0 };
  }

  protected renderSeries(lines: string[], labels: string[], state: { value: number }): void {
    lines.push(`${this.name}${this.labelText(labels)} ${formatNumber(state.value)}`);
  }
}

interface HistogramState {
  /** Per bucket, not cumulative; made cumulative when rendered. */
  counts: number[];
  sum: number;
  count: number;
}

export class Histogram<L extends string> extends Labelled<L, HistogramState> {
  private readonly buckets: readonly number[];

  constructor(name: string, help: string, buckets: readonly number[], labelNames: readonly L[]) {
    super(name, help, "histogram", labelNames);
    const sorted = [...buckets].sort((a, b) => a - b);
    if (
      sorted.length === 0 ||
      sorted.some((bound, i) => !Number.isFinite(bound) || bound === sorted[i - 1])
    ) {
      throw new Error(`${name} needs distinct finite buckets`);
    }
    this.buckets = sorted;
  }

  observe(labels: LabelValues<L>, value: number): void {
    // A NaN would poison `_sum` for the life of the process.
    if (Number.isNaN(value)) return;
    const state = this.state(this.valuesOf(labels));
    // The first bucket whose upper bound holds the value; `le` is inclusive.
    const index = this.buckets.findIndex((bound) => value <= bound);
    if (index !== -1) state.counts[index] = (state.counts[index] ?? 0) + 1;
    state.sum += value;
    state.count += 1;
  }

  protected initial(): HistogramState {
    return { counts: this.buckets.map(() => 0), sum: 0, count: 0 };
  }

  protected renderSeries(lines: string[], labels: string[], state: HistogramState): void {
    let cumulative = 0;
    this.buckets.forEach((bound, index) => {
      cumulative += state.counts[index] ?? 0;
      lines.push(
        `${this.name}_bucket${this.labelText(labels, [`le="${formatNumber(bound)}"`])} ${formatNumber(cumulative)}`
      );
    });
    lines.push(
      `${this.name}_bucket${this.labelText(labels, ['le="+Inf"'])} ${formatNumber(state.count)}`
    );
    lines.push(`${this.name}_sum${this.labelText(labels)} ${formatNumber(state.sum)}`);
    lines.push(`${this.name}_count${this.labelText(labels)} ${formatNumber(state.count)}`);
  }
}

/** Backslash, double quote, and line feed are the three characters a label value escapes. */
export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** HELP text escapes backslash and line feed, and not the double quote. */
export function escapeHelp(help: string): string {
  return help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

export function formatNumber(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  return String(value);
}
