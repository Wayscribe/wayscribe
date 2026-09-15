import { describe, expect, it } from "vitest";
import { AuthThrottle, type ThrottleOptions } from "./address-throttle.js";

/**
 * The throttle against a reference written for obviousness, not speed, over
 * random sequences of failures, lock checks and passing time.
 *
 * The reference keeps recency in an array and sweeps by filtering it, so every
 * difference in a result, in which addresses are held, in their order, or in
 * any entry's failures and lock, is a bug in the linked list or the sweep.
 * Seeded, so a failure names a sequence that reproduces.
 */

interface RefEntry {
  failures: number[];
  lockedUntil: number;
}

class ReferenceThrottle {
  public readonly order: string[] = [];
  public readonly entries = new Map<string, RefEntry>();
  private lastSweep = Number.NEGATIVE_INFINITY;

  public constructor(
    private readonly options: ThrottleOptions,
    private readonly maxTracked: number
  ) {}

  public lockedFor(address: string, now: number): number {
    const entry = this.entries.get(address);
    return entry === undefined || entry.lockedUntil <= now ? 0 : entry.lockedUntil - now;
  }

  public recordFailure(address: string, now: number): void {
    this.sweep(now);
    const entry = this.touch(address);
    entry.failures = entry.failures.filter((at) => at > now - this.options.windowMs);
    entry.failures.push(now);
    if (entry.failures.length >= this.options.maxFailures) {
      entry.lockedUntil = now + this.options.cooldownMs;
      entry.failures = [];
    }
  }

  private touch(address: string): RefEntry {
    const existing = this.entries.get(address);
    if (existing !== undefined) {
      this.order.splice(this.order.indexOf(address), 1);
      this.order.push(address);
      return existing;
    }
    while (this.entries.size >= this.maxTracked) this.forget(this.order[0] ?? "");
    const created = { failures: [], lockedUntil: 0 };
    this.entries.set(address, created);
    this.order.push(address);
    return created;
  }

  private forget(address: string): void {
    this.entries.delete(address);
    this.order.splice(this.order.indexOf(address), 1);
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < this.options.windowMs) return;
    this.lastSweep = now;
    for (const address of [...this.order]) {
      const entry = this.entries.get(address);
      if (entry === undefined) continue;
      entry.failures = entry.failures.filter((at) => at > now - this.options.windowMs);
      if (entry.failures.length === 0 && entry.lockedUntil <= now) this.forget(address);
    }
  }
}

interface Node {
  address: string;
  failures: number[];
  lockedUntil: number;
  older: Node | undefined;
  newer: Node | undefined;
}

interface Internals {
  entries: Map<string, Node>;
  oldest: Node | undefined;
  newest: Node | undefined;
}

/** The list from oldest to newest, checked for consistency with itself and the Map. */
function listOf(throttle: AuthThrottle): Node[] {
  const internals = throttle as unknown as Internals;
  const nodes: Node[] = [];
  let previous: Node | undefined;
  let node = internals.oldest;
  while (node !== undefined) {
    if (node.older !== previous) throw new Error(`back link broken at ${node.address}`);
    if (internals.entries.get(node.address) !== node) {
      throw new Error(`${node.address} is in the list and not the Map`);
    }
    nodes.push(node);
    if (nodes.length > internals.entries.size) throw new Error("the list has a cycle");
    previous = node;
    node = node.newer;
  }
  if (internals.newest !== previous) throw new Error("newest is not the end of the list");
  if (nodes.length !== internals.entries.size)
    throw new Error("the list and the Map differ in size");
  return nodes;
}

/** Throws naming the step, rather than an assertion per step, which made the runs slow. */
function agree(where: string, what: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${where}: ${what} is ${a}, the reference has ${b}`);
}

/** A small linear congruential generator: the same seed, the same sequence. */
function random(seed: number): (below: number) => number {
  let state = seed;
  return (below) => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return Math.floor((state / 2_147_483_648) * below);
  };
}

describe("AuthThrottle against a reference model", () => {
  for (const seed of [1, 7, 42, 1_234, 99_991]) {
    it(`agrees on every step of 200 random runs, seed ${String(seed)}`, () => {
      const next = random(seed);
      let steps = 0;
      for (let run = 0; run < 200; run += 1) {
        const options = {
          maxFailures: 1 + next(5),
          windowMs: 10 + next(100),
          cooldownMs: 10 + next(300)
        };
        const maxTracked = 1 + next(5);
        const real = new AuthThrottle(options, maxTracked);
        const reference = new ReferenceThrottle(options, maxTracked);
        const addresses = Array.from({ length: 1 + next(8) }, (_, i) => `a${String(i)}`);
        let now = next(1_000);

        for (let step = 0; step < 150; step += 1) {
          now += [0, 0, 1, 5, 30, 200][next(6)] ?? 0;
          const address = addresses[next(addresses.length)] ?? "a0";
          const where = `seed ${String(seed)} run ${String(run)} step ${String(step)}`;
          if (next(2) === 0) {
            real.recordFailure(address, now);
            reference.recordFailure(address, now);
          } else {
            agree(
              where,
              "lockedFor",
              real.lockedFor(address, now),
              reference.lockedFor(address, now)
            );
            agree(where, "has", real.has(address), reference.entries.has(address));
          }

          const nodes = listOf(real);
          agree(
            where,
            "held, oldest first",
            nodes.map((node) => node.address),
            reference.order
          );
          for (const node of nodes) {
            agree(
              where,
              node.address,
              { failures: node.failures, lockedUntil: node.lockedUntil },
              reference.entries.get(node.address)
            );
          }
          if (real.size > maxTracked) throw new Error(`${where}: over the cap`);
          steps += 1;
        }
      }
      expect(steps).toBe(200 * 150);
    });
  }
});
