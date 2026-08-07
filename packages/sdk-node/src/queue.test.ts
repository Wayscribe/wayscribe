import { describe, expect, it } from "vitest";
import { createDiagnostics } from "./diagnostics.js";
import { BoundedQueue } from "./queue.js";

describe("BoundedQueue", () => {
  it("holds items up to its capacity", () => {
    const queue = new BoundedQueue<number>(3, createDiagnostics());
    queue.push(1);
    queue.push(2);
    expect(queue.size()).toBe(2);
  });

  it("drops the oldest item when full", () => {
    // Phase 1b's ingestion creates a journey from whichever event arrives first,
    // so dropping the front orphans nothing, and recent events are the ones
    // still worth having after an outage.
    const queue = new BoundedQueue<number>(2, createDiagnostics());
    queue.push(1);
    queue.push(2);
    queue.push(3);
    expect(queue.drain(10)).toEqual([2, 3]);
  });

  it("counts drops rather than dropping silently", () => {
    const diagnostics = createDiagnostics();
    const queue = new BoundedQueue<number>(1, diagnostics);
    queue.push(1);
    queue.push(2);
    queue.push(3);
    expect(diagnostics.counters().dropped).toBe(2);
  });

  it("drains at most the requested count, oldest first", () => {
    const queue = new BoundedQueue<number>(10, createDiagnostics());
    for (const n of [1, 2, 3, 4]) queue.push(n);
    expect(queue.drain(2)).toEqual([1, 2]);
    expect(queue.drain(10)).toEqual([3, 4]);
  });

  it("returns an empty array when empty", () => {
    expect(new BoundedQueue<number>(5, createDiagnostics()).drain(3)).toEqual([]);
  });

  it("puts a failed batch back at the front, preserving order", () => {
    // A retried batch must not reorder the timeline.
    const queue = new BoundedQueue<number>(10, createDiagnostics());
    queue.push(3);
    queue.requeue([1, 2]);
    expect(queue.drain(10)).toEqual([1, 2, 3]);
  });

  it("drops oldest when a requeue exceeds capacity", () => {
    const diagnostics = createDiagnostics();
    const queue = new BoundedQueue<number>(2, diagnostics);
    queue.push(9);
    queue.requeue([1, 2, 3]);
    expect(queue.size()).toBe(2);
    expect(diagnostics.counters().dropped).toBeGreaterThan(0);
  });
});
