import { describe, expect, it } from "vitest";
import { LoginLimiter, type LimiterOptions } from "./login-limiter";

/**
 * The login limiter against a reference written for obviousness, over random
 * sequences of failures, sign-ins, lock checks and passing time. The same
 * method as the API throttle's model test (`apps/api/src/address-throttle.model.test.ts`):
 * recency in an array, a sweep by filtering, and any difference is a bug in the
 * linked list or the sweep. Seeded, so a failure reproduces.
 */

interface RefEntry {
  failures: number[];
  lockedUntil: number;
}

class ReferenceLimiter {
  public readonly order: string[] = [];
  public readonly entries = new Map<string, RefEntry>();
  private lastSweep = Number.NEGATIVE_INFINITY;

  public constructor(
    private readonly options: LimiterOptions,
    private readonly maxTracked: number
  ) {}

  public isLocked(key: string, now: number): boolean {
    const entry = this.entries.get(key);
    return entry !== undefined && entry.lockedUntil > now;
  }

  public recordFailure(key: string, now: number): void {
    this.sweep(now);
    const entry = this.touch(key);
    entry.failures = entry.failures.filter((at) => at > now - this.options.windowMs);
    entry.failures.push(now);
    if (entry.failures.length >= this.options.maxFailures) {
      entry.lockedUntil = now + this.options.cooldownMs;
      entry.failures = [];
    }
  }

  public recordSuccess(key: string): void {
    if (this.entries.has(key)) this.forget(key);
  }

  private touch(key: string): RefEntry {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this.order.splice(this.order.indexOf(key), 1);
      this.order.push(key);
      return existing;
    }
    while (this.entries.size >= this.maxTracked) this.forget(this.order[0] ?? "");
    const created = { failures: [], lockedUntil: 0 };
    this.entries.set(key, created);
    this.order.push(key);
    return created;
  }

  private forget(key: string): void {
    this.entries.delete(key);
    this.order.splice(this.order.indexOf(key), 1);
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < this.options.windowMs) return;
    this.lastSweep = now;
    for (const key of [...this.order]) {
      const entry = this.entries.get(key);
      if (entry === undefined) continue;
      entry.failures = entry.failures.filter((at) => at > now - this.options.windowMs);
      if (entry.failures.length === 0 && entry.lockedUntil <= now) this.forget(key);
    }
  }
}

interface Node {
  key: string;
  failures: number[];
  lockedUntil: number;
  older: Node | undefined;
  newer: Node | undefined;
}

interface Internals {
  state: Map<string, Node>;
  oldest: Node | undefined;
  newest: Node | undefined;
}

function listOf(limiter: LoginLimiter): Node[] {
  const internals = limiter as unknown as Internals;
  const nodes: Node[] = [];
  let previous: Node | undefined;
  let node = internals.oldest;
  while (node !== undefined) {
    if (node.older !== previous) throw new Error(`back link broken at ${node.key}`);
    if (internals.state.get(node.key) !== node) {
      throw new Error(`${node.key} is in the list and not the Map`);
    }
    nodes.push(node);
    if (nodes.length > internals.state.size) throw new Error("the list has a cycle");
    previous = node;
    node = node.newer;
  }
  if (internals.newest !== previous) throw new Error("newest is not the end of the list");
  if (nodes.length !== internals.state.size) {
    throw new Error("the list and the Map differ in size");
  }
  return nodes;
}

function agree(where: string, what: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${where}: ${what} is ${a}, the reference has ${b}`);
}

function random(seed: number): (below: number) => number {
  let state = seed;
  return (below) => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return Math.floor((state / 2_147_483_648) * below);
  };
}

describe("LoginLimiter against a reference model", () => {
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
        const real = new LoginLimiter(options, maxTracked);
        const reference = new ReferenceLimiter(options, maxTracked);
        const keys = Array.from({ length: 1 + next(8) }, (_, i) => `k${String(i)}`);
        let now = next(1_000);

        for (let step = 0; step < 150; step += 1) {
          now += [0, 0, 1, 5, 30, 200][next(6)] ?? 0;
          const key = keys[next(keys.length)] ?? "k0";
          const where = `seed ${String(seed)} run ${String(run)} step ${String(step)}`;
          const operation = next(4);
          if (operation <= 1) {
            real.recordFailure(key, now);
            reference.recordFailure(key, now);
          } else if (operation === 2) {
            real.recordSuccess(key);
            reference.recordSuccess(key);
          } else {
            agree(where, "isLocked", real.isLocked(key, now), reference.isLocked(key, now));
            agree(where, "has", real.has(key), reference.entries.has(key));
          }

          const nodes = listOf(real);
          agree(
            where,
            "held, oldest first",
            nodes.map((node) => node.key),
            reference.order
          );
          for (const node of nodes) {
            agree(
              where,
              node.key,
              { failures: node.failures, lockedUntil: node.lockedUntil },
              reference.entries.get(node.key)
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
