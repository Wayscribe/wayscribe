import type { Diagnostics } from "./diagnostics.js";

/**
 * A bounded FIFO that drops the oldest item when full.
 *
 * Dropping the front sounds destructive, but Phase 1b's ingestion creates a
 * journey from whichever event arrives first — it does not require the
 * `received` event specifically — so nothing is orphaned. On recovery from an
 * outage the recent events are the ones still worth having.
 *
 * Drops are counted. A silent drop turns a gap in a timeline into a mystery.
 */
export class BoundedQueue<T> {
  private items: T[] = [];

  public constructor(
    private readonly capacity: number,
    private readonly diagnostics: Diagnostics
  ) {}

  public push(item: T): void {
    this.items.push(item);
    this.trim();
  }

  /** Return a failed batch to the front, preserving order. */
  public requeue(items: readonly T[]): void {
    this.items.unshift(...items);
    this.trim();
  }

  public drain(count: number): T[] {
    return this.items.splice(0, count);
  }

  public size(): number {
    return this.items.length;
  }

  private trim(): void {
    while (this.items.length > this.capacity) {
      this.items.shift();
      this.diagnostics.report({
        kind: "dropped",
        code: "queue_full",
        reason: "The queue was full, so its oldest event was dropped.",
        detail: {}
      });
    }
  }
}
