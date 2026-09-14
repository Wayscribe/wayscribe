# Phase 1b: Authenticated Idempotent Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A developer can `curl` a protocol event into `POST /v1/events` with an API key and see a journey, an event, and its aliases appear — idempotently, project-scoped, and with secrets stripped before persistence.

**Architecture:** `payload-diff` and capture policy land as pure libraries. Database access moves into repositories that all take `projectId` first. `apps/api` gains an auth hook and an ingestion service that runs one transaction per event, shared by the single and batch routes.

**Tech Stack:** TypeScript 5.9, Fastify 5, Zod 4, Knex, PostgreSQL 17, node:crypto, Vitest 4, Testcontainers.

**Source spec:** `docs/superpowers/specs/2026-08-07-phase-1b-ingestion-design.md`

---

## Conventions

Every command needs Node 24 on PATH:

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
```

Migrations are plain ESM JavaScript at `packages/database/migrations/` (ADR-027).
Packages carry `tsconfig.json` (tests included, drives typecheck) and
`tsconfig.build.json` (tests excluded, drives build).

**Run `pnpm lint` and `pnpm typecheck` before every commit.** Both were skipped twice in
Phase 1a and both times the commit had to be amended.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/payload-diff/src/diff.ts` | Structural comparison |
| `packages/payload-security/src/content-hash.ts` | Canonical serialization + SHA-256 |
| `packages/payload-security/src/capture.ts` | Capture-mode application |
| `packages/payload-security/src/default-secrets.ts` | Built-in secret path list |
| `packages/database/migrations/010_capture_config.js` | redaction_paths, capture_allowlist |
| `packages/database/src/repositories/api-keys.ts` | Key lookup by prefix |
| `packages/database/src/repositories/journeys.ts` | Journey upsert and summary |
| `packages/database/src/repositories/events.ts` | Event insert, duplicate detection |
| `packages/database/src/repositories/aliases.ts` | Alias upsert |
| `apps/api/src/auth.ts` | Bearer key resolution hook |
| `apps/api/src/ingestion/ingest-event.ts` | Per-event transaction |
| `apps/api/src/routes/events.ts` | POST /v1/events and /v1/events/batch |

---

## Task 1: payload-diff

**Files:**
- Create: `packages/payload-diff/src/diff.ts`
- Modify: `packages/payload-diff/src/index.ts`
- Test: `packages/payload-diff/src/diff.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { diffPayloads } from "./diff.js";

describe("diffPayloads", () => {
  it("reports a changed scalar", () => {
    const result = diffPayloads({ phone: "+1 919 555 1234" }, { phone: null });
    expect(result.changes).toEqual([
      { path: "phone", kind: "changed", before: "+1 919 555 1234", after: null }
    ]);
  });

  it("reports added and removed keys", () => {
    const result = diffPayloads({ a: 1 }, { b: 2 });
    expect(result.changes).toContainEqual({ path: "a", kind: "removed", before: 1 });
    expect(result.changes).toContainEqual({ path: "b", kind: "added", after: 2 });
  });

  it("reports nothing for equal values", () => {
    expect(diffPayloads({ a: { b: 1 } }, { a: { b: 1 } }).changes).toEqual([]);
  });

  it("uses dotted paths for nested changes", () => {
    const result = diffPayloads({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } });
    expect(result.changes).toEqual([{ path: "a.b.c", kind: "changed", before: 1, after: 2 }]);
  });

  it("compares arrays by index", () => {
    const result = diffPayloads({ xs: [1, 2] }, { xs: [1, 3] });
    expect(result.changes).toEqual([{ path: "xs[1]", kind: "changed", before: 2, after: 3 }]);
  });

  it("reports a reordered array as changed, per ADR-025", () => {
    // Documented limitation: no subsequence matching in V0.
    const result = diffPayloads({ xs: [1, 2] }, { xs: [2, 1] });
    expect(result.changes.length).toBe(2);
  });

  it("reports array length differences", () => {
    expect(diffPayloads({ xs: [1] }, { xs: [1, 2] }).changes).toEqual([
      { path: "xs[1]", kind: "added", after: 2 }
    ]);
  });

  it("treats a type change as changed", () => {
    const result = diffPayloads({ a: 1 }, { a: "1" });
    expect(result.changes).toEqual([{ path: "a", kind: "changed", before: 1, after: "1" }]);
  });

  it("truncates rather than walking an unbounded structure", () => {
    const wide = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${String(i)}`, i]));
    const result = diffPayloads({}, wide, { maxChanges: 10 });
    expect(result.changes.length).toBe(10);
    expect(result.truncated).toBe(true);
  });

  it("handles null and undefined inputs", () => {
    expect(diffPayloads(null, null).changes).toEqual([]);
    expect(diffPayloads(undefined, { a: 1 }).changes).toContainEqual({
      path: "",
      kind: "changed",
      before: undefined,
      after: { a: 1 }
    });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/payload-diff`
Expected: FAIL, cannot resolve `./diff.js`.

- [ ] **Step 3: Implement**

```typescript
export type ChangeKind = "added" | "removed" | "changed";

export interface Change {
  path: string;
  kind: ChangeKind;
  before?: unknown;
  after?: unknown;
}

export interface DiffResult {
  changes: Change[];
  truncated: boolean;
}

export interface DiffOptions {
  maxChanges?: number;
  maxDepth?: number;
}

const DEFAULT_MAX_CHANGES = 500;
const DEFAULT_MAX_DEPTH = 32;

/**
 * Structural comparison of two JSON-compatible values.
 *
 * Arrays compare element-wise by index (ADR-025): a reordered array reads as
 * broadly changed. Subsequence matching is O(n*m) against a specification that
 * demands explicit complexity limits.
 *
 * Callers pass values that have already been redacted, so a redacted field
 * compares "[REDACTED]" against "[REDACTED]" and reads as unchanged. That is
 * intended — a diff must never be a channel for a secret — but it means a diff
 * cannot prove a credential did not rotate.
 */
export function diffPayloads(
  before: unknown,
  after: unknown,
  options: DiffOptions = {}
): DiffResult {
  const maxChanges = options.maxChanges ?? DEFAULT_MAX_CHANGES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const changes: Change[] = [];
  const truncated = walk(before, after, "", changes, maxChanges, maxDepth, 0);
  return { changes, truncated };
}

/** Returns true when the change budget or depth limit was hit. */
function walk(
  before: unknown,
  after: unknown,
  path: string,
  changes: Change[],
  maxChanges: number,
  maxDepth: number,
  depth: number
): boolean {
  if (changes.length >= maxChanges) return true;
  if (depth > maxDepth) return true;
  if (Object.is(before, after)) return false;

  if (isPlainObject(before) && isPlainObject(after)) {
    return walkObject(before, after, path, changes, maxChanges, maxDepth, depth);
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    return walkArray(before, after, path, changes, maxChanges, maxDepth, depth);
  }

  if (!deepEqual(before, after)) {
    changes.push({ path, kind: "changed", before, after });
  }
  return changes.length >= maxChanges;
}

function walkObject(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  path: string,
  changes: Change[],
  maxChanges: number,
  maxDepth: number,
  depth: number
): boolean {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (changes.length >= maxChanges) return true;
    const childPath = path === "" ? key : `${path}.${key}`;
    const inBefore = key in before;
    const inAfter = key in after;

    if (inBefore && !inAfter) {
      changes.push({ path: childPath, kind: "removed", before: before[key] });
    } else if (!inBefore && inAfter) {
      changes.push({ path: childPath, kind: "added", after: after[key] });
    } else if (
      walk(before[key], after[key], childPath, changes, maxChanges, maxDepth, depth + 1)
    ) {
      return true;
    }
  }
  return changes.length >= maxChanges;
}

function walkArray(
  before: unknown[],
  after: unknown[],
  path: string,
  changes: Change[],
  maxChanges: number,
  maxDepth: number,
  depth: number
): boolean {
  const length = Math.max(before.length, after.length);
  for (let index = 0; index < length; index += 1) {
    if (changes.length >= maxChanges) return true;
    const childPath = `${path}[${String(index)}]`;

    if (index >= after.length) {
      changes.push({ path: childPath, kind: "removed", before: before[index] });
    } else if (index >= before.length) {
      changes.push({ path: childPath, kind: "added", after: after[index] });
    } else if (
      walk(before[index], after[index], childPath, changes, maxChanges, maxDepth, depth + 1)
    ) {
      return true;
    }
  }
  return changes.length >= maxChanges;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
```

`packages/payload-diff/src/index.ts`:

```typescript
export {
  diffPayloads,
  type Change,
  type ChangeKind,
  type DiffOptions,
  type DiffResult
} from "./diff.js";
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `pnpm vitest run packages/payload-diff`
Expected: PASS, 10 tests.

- [ ] **Step 5: Add the development export condition**

`packages/payload-diff/package.json` exports must include `"development": "./src/index.ts"`
alongside `types` and `default`, matching the other packages. Without it, importing this
package requires a build first.

- [ ] **Step 6: Lint, typecheck, commit**

```bash
pnpm lint && pnpm typecheck
git add packages/payload-diff
git commit -m "feat(payload-diff): add index-based structural comparison"
```

---

## Task 2: Content hash

**Files:**
- Create: `packages/payload-security/src/content-hash.ts`
- Modify: `packages/payload-security/src/index.ts`
- Test: `packages/payload-security/src/content-hash.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { contentHash } from "./content-hash.js";

describe("contentHash", () => {
  it("is stable regardless of key order", () => {
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
  });

  it("is stable for nested key order", () => {
    expect(contentHash({ o: { a: 1, b: 2 } })).toBe(contentHash({ o: { b: 2, a: 1 } }));
  });

  it("differs when a value changes", () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });

  it("distinguishes a number from its string form", () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: "1" }));
  });

  it("preserves array order", () => {
    expect(contentHash([1, 2])).not.toBe(contentHash([2, 1]));
  });

  it("returns lowercase hex of fixed length", () => {
    expect(contentHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("handles null and empty structures", () => {
    expect(contentHash(null)).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHash({})).not.toBe(contentHash([]));
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/payload-security`
Expected: FAIL, cannot resolve `./content-hash.js`.

- [ ] **Step 3: Implement**

```typescript
import { createHash } from "node:crypto";

/**
 * Stable hash of a JSON-compatible value.
 *
 * Object keys are sorted recursively so that two semantically identical events
 * serialized with different key order produce the same hash. Array order is
 * preserved, because it is meaningful.
 *
 * Ingestion computes this over the event *as received*, before redaction:
 * ADR-021 exists to catch a client reusing an event ID for different content, so
 * hashing redacted output would let a server-side policy change alter the hash
 * of an unchanged input and manufacture conflicts.
 */
export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`);
    return `{${entries.join(",")}}`;
  }

  if (value === undefined) return "undefined";
  return JSON.stringify(value) ?? "null";
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `pnpm vitest run packages/payload-security`
Expected: PASS, 50 tests (43 existing plus 7).

- [ ] **Step 5: Export, lint, typecheck, commit**

Add to `packages/payload-security/src/index.ts`:

```typescript
export { contentHash } from "./content-hash.js";
```

```bash
pnpm lint && pnpm typecheck
git add packages/payload-security
git commit -m "feat(payload-security): add canonical content hash"
```

---

## Task 3: Default secrets and capture policy

**Files:**
- Create: `packages/payload-security/src/default-secrets.ts`, `packages/payload-security/src/capture.ts`
- Modify: `packages/payload-security/src/index.ts`
- Test: `packages/payload-security/src/capture.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { applyCapture } from "./capture.js";
import { REDACTED } from "./redact.js";

const payload = {
  authorization: "Bearer secret",
  customer: { name: "Jorge", ssn: "111-22-3333" },
  phone: "+1 919 555 1234"
};

describe("applyCapture", () => {
  it("drops payloads entirely in metadata-only mode", () => {
    expect(applyCapture(payload, { mode: "metadata-only" })).toBeUndefined();
  });

  it("keeps only allowlisted paths in allowlisted-fields mode", () => {
    const result = applyCapture(payload, {
      mode: "allowlisted-fields",
      allowlist: ["phone"]
    }) as Record<string, unknown>;
    expect(result).toEqual({ phone: "+1 919 555 1234" });
  });

  it("redacts configured paths in redacted-payload mode", () => {
    const result = applyCapture(payload, {
      mode: "redacted-payload",
      redactionPaths: ["customer.ssn"]
    }) as Record<string, unknown>;
    const customer = result["customer"] as Record<string, unknown>;
    expect(customer["ssn"]).toBe(REDACTED);
    expect(customer["name"]).toBe("Jorge");
  });

  it("still redacts built-in secrets under full-payload", () => {
    // SECURITY.md section 3: full-payload must never mean skip secret detection.
    const result = applyCapture(payload, { mode: "full-payload" }) as Record<string, unknown>;
    expect(result["authorization"]).toBe(REDACTED);
    expect(result["phone"]).toBe("+1 919 555 1234");
  });

  it("applies built-in secrets in every payload-bearing mode", () => {
    for (const mode of ["redacted-payload", "full-payload"] as const) {
      const result = applyCapture(payload, { mode }) as Record<string, unknown>;
      expect(result["authorization"]).toBe(REDACTED);
    }
  });

  it("returns undefined for an undefined payload", () => {
    expect(applyCapture(undefined, { mode: "full-payload" })).toBeUndefined();
  });

  it("keeps nested allowlisted paths", () => {
    const result = applyCapture(payload, {
      mode: "allowlisted-fields",
      allowlist: ["customer.name"]
    }) as Record<string, unknown>;
    expect(result).toEqual({ customer: { name: "Jorge" } });
  });

  it("returns an empty object when nothing is allowlisted", () => {
    expect(applyCapture(payload, { mode: "allowlisted-fields", allowlist: [] })).toEqual({});
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/payload-security`
Expected: FAIL, cannot resolve `./capture.js`.

- [ ] **Step 3: Implement the default secret list**

`packages/payload-security/src/default-secrets.ts`:

```typescript
/**
 * Redaction paths applied in every payload-bearing capture mode.
 *
 * This list cannot be disabled. SECURITY.md section 3 requires that
 * `full-payload` never mean "skip secret detection", so these apply even when an
 * operator has explicitly asked for full capture.
 *
 * Matching is case-insensitive, and `*.name` matches that key at any single
 * level, so `headers.authorization` and `request.authorization` are both covered.
 */
export const DEFAULT_SECRET_PATHS: readonly string[] = [
  "authorization",
  "*.authorization",
  "proxy-authorization",
  "*.proxy-authorization",
  "cookie",
  "*.cookie",
  "set-cookie",
  "*.set-cookie",
  "x-api-key",
  "*.x-api-key",
  "password",
  "*.password",
  "access_token",
  "*.access_token",
  "refresh_token",
  "*.refresh_token",
  "client_secret",
  "*.client_secret",
  "api_key",
  "*.api_key",
  "secret",
  "*.secret"
];
```

- [ ] **Step 4: Implement capture policy**

`packages/payload-security/src/capture.ts`:

```typescript
import { DEFAULT_SECRET_PATHS } from "./default-secrets.js";
import { redact } from "./redact.js";

export type CaptureMode =
  | "metadata-only"
  | "allowlisted-fields"
  | "redacted-payload"
  | "full-payload";

export interface CapturePolicy {
  mode: CaptureMode;
  redactionPaths?: readonly string[];
  allowlist?: readonly string[];
}

/**
 * Apply an environment's capture policy to a payload.
 *
 * Server policy may capture less than the SDK requested; it never captures more.
 * Built-in secret paths are appended to whatever the operator configured, and
 * are applied in every mode that stores a payload at all.
 */
export function applyCapture(payload: unknown, policy: CapturePolicy): unknown {
  if (payload === undefined) return undefined;

  if (policy.mode === "metadata-only") return undefined;

  if (policy.mode === "allowlisted-fields") {
    return pickAllowlisted(payload, policy.allowlist ?? []);
  }

  return redact(payload, [...(policy.redactionPaths ?? []), ...DEFAULT_SECRET_PATHS]);
}

function pickAllowlisted(payload: unknown, allowlist: readonly string[]): unknown {
  if (typeof payload !== "object" || payload === null) return {};

  const result: Record<string, unknown> = {};
  for (const path of allowlist) {
    const value = readPath(payload, path.split("."));
    if (value !== undefined) writePath(result, path.split("."), value);
  }
  // Built-in secrets still apply: an operator can allowlist a path that happens
  // to hold a token, and the allowlist must not override secret filtering.
  return redact(result, DEFAULT_SECRET_PATHS);
}

function readPath(source: unknown, segments: string[]): unknown {
  let current: unknown = source;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function writePath(target: Record<string, unknown>, segments: string[], value: unknown): void {
  let current = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i] ?? "";
    const existing = current[segment];
    if (typeof existing !== "object" || existing === null) current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  }
  const last = segments[segments.length - 1] ?? "";
  current[last] = value;
}
```

- [ ] **Step 5: Run, export, lint, typecheck, commit**

Run: `pnpm vitest run packages/payload-security`
Expected: PASS, 58 tests.

Add to `packages/payload-security/src/index.ts`:

```typescript
export { applyCapture, type CaptureMode, type CapturePolicy } from "./capture.js";
export { DEFAULT_SECRET_PATHS } from "./default-secrets.js";
```

```bash
pnpm lint && pnpm typecheck
git add packages/payload-security
git commit -m "feat(payload-security): add capture policy with undisableable secret list"
```

---

## Task 4: Migration 010 — capture configuration

**Files:**
- Create: `packages/database/migrations/010_capture_config.js`
- Modify: `packages/database/src/migration-status.integration.test.ts`

- [ ] **Step 1: Write the migration**

```javascript
/**
 * Two columns the original schema omitted.
 *
 * capture_mode permitted 'allowlisted-fields' with nowhere to store the
 * allowlist, so that mode could not be implemented as specified. And
 * SECURITY.md makes server-side redaction authoritative without giving it any
 * configured paths to be authoritative with.
 *
 * Both default to an empty array: an environment that configures neither still
 * receives the built-in secret list, which is applied in code and cannot be
 * disabled.
 *
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function up(knex) {
  await knex.schema.alterTable("environments", (table) => {
    table.jsonb("redaction_paths").notNullable().defaultTo("[]");
    table.jsonb("capture_allowlist").notNullable().defaultTo("[]");
  });
}

/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function down(knex) {
  await knex.schema.alterTable("environments", (table) => {
    table.dropColumn("redaction_paths");
    table.dropColumn("capture_allowlist");
  });
}
```

- [ ] **Step 2: Update the pending-migration count**

In `packages/database/src/migration-status.integration.test.ts`, change the expected
count from 9 to 10.

- [ ] **Step 3: Run and commit**

```bash
pnpm test:integration
pnpm lint && pnpm typecheck
git add packages/database
git commit -m "feat(database): add redaction_paths and capture_allowlist"
```

---

## Task 5: API key repository

**Files:**
- Create: `packages/database/src/repositories/api-keys.ts`
- Test: `packages/database/src/repositories/api-keys.integration.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { deriveSubkeys, generateApiKey } from "@flight-recorder/payload-security";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertReturningId } from "../insert.js";
import { createKnexConfig } from "../knex-config.js";
import { findApiKeyByPrefix } from "./api-keys.js";

const subkeys = deriveSubkeys("0123456789abcdef0123456789abcdef");

describe("findApiKeyByPrefix", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let projectId: string;
  let environmentId: string;
  let generated: ReturnType<typeof generateApiKey>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();

    projectId = await insertReturningId(db, "projects", { name: "P", slug: "p" });
    environmentId = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: "development"
    });
    generated = generateApiKey(subkeys.apiKey);
    await db("api_keys").insert({
      project_id: projectId,
      environment_id: environmentId,
      name: "k",
      key_prefix: generated.keyPrefix,
      key_hash: generated.verifier
    });
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  it("returns the key with its project and environment context", async () => {
    const row = await findApiKeyByPrefix(db, generated.keyPrefix);
    expect(row).toBeDefined();
    expect(row?.projectId).toBe(projectId);
    expect(row?.environmentId).toBe(environmentId);
    expect(row?.environmentName).toBe("development");
    expect(row?.keyHash).toBe(generated.verifier);
    expect(row?.revokedAt).toBeNull();
  });

  it("returns the environment capture policy", async () => {
    const row = await findApiKeyByPrefix(db, generated.keyPrefix);
    expect(row?.captureMode).toBe("redacted-payload");
    expect(row?.redactionPaths).toEqual([]);
    expect(row?.captureAllowlist).toEqual([]);
  });

  it("returns undefined for an unknown prefix", async () => {
    expect(await findApiKeyByPrefix(db, "fr_nosuchkey")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm test:integration`
Expected: FAIL, cannot resolve `./api-keys.js`.

- [ ] **Step 3: Implement**

```typescript
import type { Knex } from "knex";

export interface ApiKeyContext {
  id: string;
  projectId: string;
  environmentId: string;
  environmentName: string;
  keyHash: string;
  revokedAt: Date | null;
  captureMode: string;
  redactionPaths: string[];
  captureAllowlist: string[];
}

/**
 * Resolve an API key by its public prefix.
 *
 * Joins the environment so authentication is a single indexed read that returns
 * everything ingestion needs: project scope, environment scope, and the capture
 * policy. The caller verifies the key material; this function only locates the
 * row, and deliberately does not filter on revoked_at so the caller can
 * distinguish "unknown key" from "revoked key".
 */
export async function findApiKeyByPrefix(
  db: Knex,
  keyPrefix: string
): Promise<ApiKeyContext | undefined> {
  const row: unknown = await db("api_keys")
    .join("environments", "api_keys.environment_id", "environments.id")
    .where("api_keys.key_prefix", keyPrefix)
    .first(
      "api_keys.id as id",
      "api_keys.project_id as projectId",
      "api_keys.environment_id as environmentId",
      "api_keys.key_hash as keyHash",
      "api_keys.revoked_at as revokedAt",
      "environments.name as environmentName",
      "environments.capture_mode as captureMode",
      "environments.redaction_paths as redactionPaths",
      "environments.capture_allowlist as captureAllowlist"
    );

  return row === undefined ? undefined : (row as ApiKeyContext);
}

/**
 * Record key usage. Called outside the request path: a failure here must never
 * fail ingestion.
 */
export async function touchApiKey(db: Knex, id: string): Promise<void> {
  await db("api_keys").where({ id }).update({ last_used_at: db.fn.now() });
}
```

- [ ] **Step 4: Run, lint, typecheck, commit**

```bash
pnpm test:integration
pnpm lint && pnpm typecheck
git add packages/database
git commit -m "feat(database): add API key repository"
```

---

## Task 6: Journey, event, and alias repositories

**Files:**
- Create: `packages/database/src/repositories/journeys.ts`, `events.ts`, `aliases.ts`
- Modify: `packages/database/src/index.ts`
- Test: `packages/database/src/repositories/journeys.integration.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertReturningId } from "../insert.js";
import { createKnexConfig } from "../knex-config.js";
import { applyJourneyEvent, findJourney } from "./journeys.js";

describe("journey summary", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let projectId: string;
  let environmentId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();
    projectId = await insertReturningId(db, "projects", { name: "P", slug: "p" });
    environmentId = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: "development"
    });
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  const base = {
    entityType: "customer",
    primaryEntityIdHash: "hash",
    encryptedPrimaryEntityId: "cipher"
  };

  it("creates a journey on first event", async () => {
    await applyJourneyEvent(db, projectId, {
      ...base,
      journeyId: "jrn_a",
      environmentId,
      eventTimestamp: new Date("2026-08-06T10:00:00Z"),
      operation: "received",
      hasError: false
    });

    const journey = await findJourney(db, projectId, "jrn_a");
    expect(journey?.eventCount).toBe(1);
    expect(journey?.status).toBe("active");
  });

  it("uses the minimum timestamp for startedAt and the maximum for lastEventAt", async () => {
    await applyJourneyEvent(db, projectId, {
      ...base,
      journeyId: "jrn_a",
      environmentId,
      eventTimestamp: new Date("2026-08-06T12:00:00Z"),
      operation: "transformed",
      hasError: false
    });
    // Arrives later but happened earlier.
    await applyJourneyEvent(db, projectId, {
      ...base,
      journeyId: "jrn_a",
      environmentId,
      eventTimestamp: new Date("2026-08-06T08:00:00Z"),
      operation: "received",
      hasError: false
    });

    const journey = await findJourney(db, projectId, "jrn_a");
    expect(journey?.startedAt.toISOString()).toBe("2026-08-06T08:00:00.000Z");
    expect(journey?.lastEventAt.toISOString()).toBe("2026-08-06T12:00:00.000Z");
    expect(journey?.eventCount).toBe(3);
  });

  it("marks the journey failed when an event carries an error", async () => {
    await applyJourneyEvent(db, projectId, {
      ...base,
      journeyId: "jrn_a",
      environmentId,
      eventTimestamp: new Date("2026-08-06T13:00:00Z"),
      operation: "delivered",
      hasError: true
    });
    expect((await findJourney(db, projectId, "jrn_a"))?.status).toBe("failed");
  });

  it("does not let a late-arriving older event change status", async () => {
    await applyJourneyEvent(db, projectId, {
      ...base,
      journeyId: "jrn_a",
      environmentId,
      eventTimestamp: new Date("2026-08-06T09:00:00Z"),
      operation: "completed",
      hasError: false
    });
    // Older than lastEventAt, so it must not override the newer failure.
    expect((await findJourney(db, projectId, "jrn_a"))?.status).toBe("failed");
  });

  it("marks completed when the newest event is a completion", async () => {
    await applyJourneyEvent(db, projectId, {
      ...base,
      journeyId: "jrn_a",
      environmentId,
      eventTimestamp: new Date("2026-08-06T14:00:00Z"),
      operation: "completed",
      hasError: false
    });
    expect((await findJourney(db, projectId, "jrn_a"))?.status).toBe("completed");
  });

  it("scopes lookups to the project", async () => {
    const other = await insertReturningId(db, "projects", { name: "O", slug: "o" });
    expect(await findJourney(db, other, "jrn_a")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm test:integration`
Expected: FAIL, cannot resolve `./journeys.js`.

- [ ] **Step 3: Implement the journey repository**

```typescript
import type { Knex } from "knex";

export interface JourneyEventFacts {
  journeyId: string;
  environmentId: string;
  entityType: string;
  primaryEntityIdHash: string;
  encryptedPrimaryEntityId: string | null;
  eventTimestamp: Date;
  operation: string;
  hasError: boolean;
}

export interface JourneySummary {
  id: string;
  status: string;
  eventCount: number;
  startedAt: Date;
  lastEventAt: Date;
}

export async function findJourney(
  db: Knex,
  projectId: string,
  journeyId: string
): Promise<JourneySummary | undefined> {
  const row: unknown = await db("journeys")
    .where({ project_id: projectId, id: journeyId })
    .first("id", "status", "event_count as eventCount", "started_at as startedAt", "last_event_at as lastEventAt");
  return row === undefined ? undefined : (row as JourneySummary);
}

/**
 * Create or update the journey summary for one newly stored event.
 *
 * started_at takes the minimum timestamp and last_event_at the maximum, because
 * events arrive late and out of order and last-write-wins would corrupt both.
 *
 * Status follows the newest event by *event timestamp*, not arrival, for
 * `completed` transitions: the update only applies when the incoming timestamp
 * is at least the current last_event_at, which is evaluated before
 * last_event_at is advanced. That keeps a late-arriving older `completed` event
 * from clobbering a newer status without needing an extra column. A `failed`
 * event registers unconditionally, regardless of timestamp (ADR-031).
 *
 * The insert uses ON CONFLICT DO NOTHING so two events racing to create the same
 * journey do not fail each other.
 */
export async function applyJourneyEvent(
  db: Knex,
  projectId: string,
  facts: JourneyEventFacts
): Promise<void> {
  await db("journeys")
    .insert({
      id: facts.journeyId,
      project_id: projectId,
      environment_id: facts.environmentId,
      entity_type: facts.entityType,
      primary_entity_id_hash: facts.primaryEntityIdHash,
      encrypted_primary_entity_id: facts.encryptedPrimaryEntityId,
      status: "active",
      started_at: facts.eventTimestamp,
      last_event_at: facts.eventTimestamp,
      event_count: 0
    })
    .onConflict(["project_id", "id"])
    .ignore();

  const status = deriveStatus(facts);

  await db.raw(
    `
    update journeys set
      event_count = event_count + 1,
      started_at = least(started_at, :timestamp),
      last_event_at = greatest(last_event_at, :timestamp),
      status = case
        when :timestamp >= last_event_at and :status::text is not null then :status::text
        else status
      end,
      completed_at = case
        when :timestamp >= last_event_at and :status::text = 'completed' then :timestamp
        else completed_at
      end,
      updated_at = now()
    where project_id = :projectId and id = :journeyId
    `,
    {
      projectId,
      journeyId: facts.journeyId,
      timestamp: facts.eventTimestamp,
      status
    }
  );
}

/** Null means this event does not affect status. */
function deriveStatus(facts: JourneyEventFacts): string | null {
  if (facts.hasError || facts.operation === "failed") return "failed";
  if (facts.operation === "completed") return "completed";
  return null;
}
```

- [ ] **Step 4: Implement the event repository**

`packages/database/src/repositories/events.ts`:

```typescript
import type { Knex } from "knex";

export interface EventRow {
  id: string;
  environmentId: string;
  journeyId: string;
  parentEventId: string | null;
  protocolVersion: string;
  contentHash: string;
  operation: string;
  name: string;
  service: string;
  eventTimestamp: Date;
  durationMs: number | null;
  traceId: string | null;
  spanId: string | null;
  messageId: string | null;
  correlationId: string | null;
  inputPayload: unknown;
  outputPayload: unknown;
  payloadDiff: unknown;
  error: unknown;
  runtimeMetadata: unknown;
  deploymentMetadata: unknown;
  customMetadata: unknown;
}

export type InsertOutcome =
  | { kind: "inserted" }
  | { kind: "duplicate" }
  | { kind: "conflict" };

/**
 * Insert an event, reporting whether it was new, an identical resubmission, or a
 * reuse of an existing ID with different content (ADR-021).
 *
 * ON CONFLICT DO NOTHING then a hash comparison, rather than a read followed by
 * a write: the read-then-write ordering has a race where two identical events
 * both see "absent" and one insert fails.
 */
export async function insertEvent(
  db: Knex,
  projectId: string,
  event: EventRow
): Promise<InsertOutcome> {
  const inserted = await db("journey_events")
    .insert({
      id: event.id,
      project_id: projectId,
      environment_id: event.environmentId,
      journey_id: event.journeyId,
      parent_event_id: event.parentEventId,
      protocol_version: event.protocolVersion,
      content_hash: event.contentHash,
      operation: event.operation,
      name: event.name,
      service: event.service,
      event_timestamp: event.eventTimestamp,
      duration_ms: event.durationMs,
      trace_id: event.traceId,
      span_id: event.spanId,
      message_id: event.messageId,
      correlation_id: event.correlationId,
      input_payload: toJson(event.inputPayload),
      output_payload: toJson(event.outputPayload),
      payload_diff: toJson(event.payloadDiff),
      error: toJson(event.error),
      runtime_metadata: toJson(event.runtimeMetadata),
      deployment_metadata: toJson(event.deploymentMetadata),
      custom_metadata: toJson(event.customMetadata)
    })
    .onConflict(["project_id", "id"])
    .ignore()
    .returning("id");

  if (Array.isArray(inserted) && inserted.length > 0) return { kind: "inserted" };

  const existing: unknown = await db("journey_events")
    .where({ project_id: projectId, id: event.id })
    .first("content_hash as contentHash");

  const existingHash = (existing as { contentHash?: string } | undefined)?.contentHash;
  return existingHash === event.contentHash ? { kind: "duplicate" } : { kind: "conflict" };
}

function toJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}
```

- [ ] **Step 5: Implement the alias repository**

`packages/database/src/repositories/aliases.ts`:

```typescript
import type { Knex } from "knex";

export interface AliasRow {
  journeyId: string;
  aliasType: string;
  aliasValueHash: string;
  encryptedDisplayValue: string | null;
}

/**
 * Store aliases for a journey.
 *
 * Re-sending the same alias is a no-op rather than an error: an SDK that repeats
 * `identify()` on every event is behaving reasonably, and the unique constraint
 * is there to deduplicate, not to reject.
 */
export async function upsertAliases(
  db: Knex,
  projectId: string,
  aliases: readonly AliasRow[]
): Promise<void> {
  if (aliases.length === 0) return;

  await db("entity_aliases")
    .insert(
      aliases.map((alias) => ({
        project_id: projectId,
        journey_id: alias.journeyId,
        alias_type: alias.aliasType,
        alias_value_hash: alias.aliasValueHash,
        encrypted_display_value: alias.encryptedDisplayValue
      }))
    )
    .onConflict(["project_id", "journey_id", "alias_type", "alias_value_hash"])
    .ignore();
}
```

- [ ] **Step 6: Export, run, lint, typecheck, commit**

Add to `packages/database/src/index.ts` — note `insertReturningId`, which Phase 1a
created but never exported, and which the Task 10 integration tests import by package
name:

```typescript
export { insertReturningId } from "./insert.js";
export { findApiKeyByPrefix, touchApiKey, type ApiKeyContext } from "./repositories/api-keys.js";
export { upsertAliases, type AliasRow } from "./repositories/aliases.js";
export { insertEvent, type EventRow, type InsertOutcome } from "./repositories/events.js";
export {
  applyJourneyEvent,
  findJourney,
  type JourneyEventFacts,
  type JourneySummary
} from "./repositories/journeys.js";
```

```bash
pnpm test:integration
pnpm lint && pnpm typecheck
git add packages/database
git commit -m "feat(database): add journey, event, and alias repositories"
```

---

## Task 7: Authentication hook

**Files:**
- Create: `apps/api/src/auth.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/src/auth.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { deriveSubkeys, generateApiKey } from "@flight-recorder/payload-security";
import { describe, expect, it } from "vitest";
import { resolveApiKey } from "./auth.js";

const subkeys = deriveSubkeys("0123456789abcdef0123456789abcdef");
const generated = generateApiKey(subkeys.apiKey);

const context = {
  id: "key_1",
  projectId: "proj_1",
  environmentId: "env_1",
  environmentName: "development",
  keyHash: generated.verifier,
  revokedAt: null,
  captureMode: "redacted-payload",
  redactionPaths: [],
  captureAllowlist: []
};

const lookup = (prefix: string) =>
  Promise.resolve(prefix === generated.keyPrefix ? context : undefined);

describe("resolveApiKey", () => {
  it("accepts a valid bearer key", async () => {
    const result = await resolveApiKey(`Bearer ${generated.apiKey}`, subkeys.apiKey, lookup);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.context.projectId).toBe("proj_1");
  });

  it("rejects a missing header", async () => {
    const result = await resolveApiKey(undefined, subkeys.apiKey, lookup);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("rejects a non-bearer scheme", async () => {
    const result = await resolveApiKey(`Basic ${generated.apiKey}`, subkeys.apiKey, lookup);
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown key", async () => {
    const other = generateApiKey(subkeys.apiKey);
    const result = await resolveApiKey(`Bearer ${other.apiKey}`, subkeys.apiKey, lookup);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("rejects a key whose material does not verify", async () => {
    const forged = `${generated.keyPrefix}tampered-remainder-value`;
    const result = await resolveApiKey(`Bearer ${forged}`, subkeys.apiKey, lookup);
    expect(result.ok).toBe(false);
  });

  it("rejects a revoked key", async () => {
    const revokedLookup = () => Promise.resolve({ ...context, revokedAt: new Date() });
    const result = await resolveApiKey(
      `Bearer ${generated.apiKey}`,
      subkeys.apiKey,
      revokedLookup
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/api`
Expected: FAIL, cannot resolve `./auth.js`.

- [ ] **Step 3: Implement**

```typescript
import { API_KEY_PREFIX_LENGTH, verifyApiKey } from "@flight-recorder/payload-security";
import type { ApiKeyContext } from "@flight-recorder/database";

export type AuthResult =
  | { ok: true; context: ApiKeyContext }
  | { ok: false; status: 401 | 403; code: string; message: string };

export type ApiKeyLookup = (keyPrefix: string) => Promise<ApiKeyContext | undefined>;

const UNAUTHORIZED = {
  ok: false as const,
  status: 401 as const,
  code: "unauthorized",
  message: "A valid API key is required."
};

/**
 * Resolve a bearer API key to its project and environment context.
 *
 * Every failure returns the same message. Distinguishing "unknown key" from
 * "revoked key" or "bad signature" in the response would let an attacker probe
 * which prefixes exist.
 */
export async function resolveApiKey(
  authorizationHeader: string | undefined,
  pepper: Buffer,
  lookup: ApiKeyLookup
): Promise<AuthResult> {
  if (authorizationHeader === undefined) return UNAUTHORIZED;

  const [scheme, presented] = authorizationHeader.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || presented === undefined) return UNAUTHORIZED;

  const context = await lookup(presented.slice(0, API_KEY_PREFIX_LENGTH));
  if (context === undefined) return UNAUTHORIZED;
  if (context.revokedAt !== null) return UNAUTHORIZED;
  if (!verifyApiKey(pepper, presented, context.keyHash)) return UNAUTHORIZED;

  return { ok: true, context };
}

/**
 * An API key is scoped to one environment; the event names its own. A mismatch
 * is 403 rather than 401 — the caller authenticated successfully, but is not
 * authorized for that environment.
 */
export function authorizeEnvironment(context: ApiKeyContext, eventEnvironment: string): AuthResult {
  if (context.environmentName !== eventEnvironment) {
    return {
      ok: false,
      status: 403,
      code: "unauthorized_environment",
      message: `This key is not authorized for environment ${eventEnvironment}.`
    };
  }
  return { ok: true, context };
}
```

- [ ] **Step 4: Run, lint, typecheck, commit**

```bash
pnpm vitest run apps/api
pnpm lint && pnpm typecheck
git add apps/api
git commit -m "feat(api): add bearer API key resolution"
```

---

## Task 8: Ingestion service

**Files:**
- Create: `apps/api/src/ingestion/ingest-event.ts`
- Test: covered by the route integration tests in Task 10

- [ ] **Step 1: Implement**

```typescript
import type { ApiKeyContext } from "@flight-recorder/database";
import { applyJourneyEvent, insertEvent, upsertAliases } from "@flight-recorder/database";
import { diffPayloads } from "@flight-recorder/payload-diff";
import {
  DEFAULT_LIMITS,
  applyCapture,
  checkLimits,
  contentHash,
  encryptField,
  searchToken,
  type CaptureMode,
  type Subkeys
} from "@flight-recorder/payload-security";
import { PROTOCOL_ERROR_CODES, parseEnvelope } from "@flight-recorder/protocol";
import type { Knex } from "knex";
import { authorizeEnvironment } from "../auth.js";

export interface IngestResult {
  eventId: string | null;
  journeyId: string | null;
  status: "accepted" | "rejected";
  duplicate?: boolean;
  code?: string;
  message?: string;
  httpStatus: number;
}

/**
 * Ingest one event inside a single transaction (ARCHITECTURE.md section 8).
 *
 * Ordering matters: limits are enforced before anything walks the payload, the
 * content hash is taken over the event as received (before redaction, per
 * ADR-021), and the diff is computed after redaction so a stored diff can never
 * carry a secret.
 */
export async function ingestEvent(
  db: Knex,
  subkeys: Subkeys,
  context: ApiKeyContext,
  body: unknown
): Promise<IngestResult> {
  const limits = checkLimits(body, DEFAULT_LIMITS);
  if (!limits.ok) {
    return reject(400, limits.reason, "The event exceeded a configured limit.");
  }

  const parsed = parseEnvelope(body);
  if (!parsed.ok) {
    return reject(400, parsed.code, parsed.message);
  }

  const event = parsed.event;

  const environment = authorizeEnvironment(context, event.environment);
  if (!environment.ok) {
    return reject(403, environment.code, environment.message);
  }

  const hash = contentHash(event);

  const policy = {
    mode: context.captureMode as CaptureMode,
    redactionPaths: context.redactionPaths,
    allowlist: context.captureAllowlist
  };
  const input = applyCapture(event.input, policy);
  const output = applyCapture(event.output, policy);
  const diff =
    input !== undefined && output !== undefined ? diffPayloads(input, output) : undefined;

  return db.transaction(async (trx) => {
    const outcome = await insertEvent(trx, context.projectId, {
      id: event.id,
      environmentId: context.environmentId,
      journeyId: event.journeyId,
      parentEventId: event.parentEventId ?? null,
      protocolVersion: "0.1",
      contentHash: hash,
      operation: event.operation,
      name: event.name,
      service: event.service,
      eventTimestamp: new Date(event.timestamp),
      durationMs: event.durationMs ?? null,
      traceId: event.traceId ?? null,
      spanId: event.spanId ?? null,
      messageId: event.messageId ?? null,
      correlationId: event.correlationId ?? null,
      inputPayload: input,
      outputPayload: output,
      payloadDiff: diff,
      error: event.error,
      runtimeMetadata: event.runtime,
      deploymentMetadata: event.deployment,
      customMetadata: event.metadata
    });

    if (outcome.kind === "conflict") {
      return reject(
        409,
        PROTOCOL_ERROR_CODES.eventIdConflict,
        "This event ID already exists with different content."
      );
    }

    if (outcome.kind === "duplicate") {
      // Idempotent: derived updates are not repeated, so the count stays right.
      return {
        eventId: event.id,
        journeyId: event.journeyId,
        status: "accepted" as const,
        duplicate: true,
        httpStatus: 202
      };
    }

    await applyJourneyEvent(trx, context.projectId, {
      journeyId: event.journeyId,
      environmentId: context.environmentId,
      entityType: event.entity.type,
      primaryEntityIdHash: searchToken(subkeys.searchToken, event.entity.type, event.entity.id),
      encryptedPrimaryEntityId: encryptField(subkeys.fieldEncryption, event.entity.id),
      eventTimestamp: new Date(event.timestamp),
      operation: event.operation,
      hasError: event.error !== undefined
    });

    await upsertAliases(
      trx,
      context.projectId,
      Object.entries(event.aliases ?? {}).map(([aliasType, value]) => ({
        journeyId: event.journeyId,
        aliasType,
        aliasValueHash: searchToken(subkeys.searchToken, aliasType, value),
        encryptedDisplayValue: encryptField(subkeys.fieldEncryption, value)
      }))
    );

    return {
      eventId: event.id,
      journeyId: event.journeyId,
      status: "accepted" as const,
      duplicate: false,
      httpStatus: 202
    };
  });
}

function reject(httpStatus: number, code: string, message: string): IngestResult {
  return { eventId: null, journeyId: null, status: "rejected", code, message, httpStatus };
}
```

- [ ] **Step 2: Add the workspace dependencies**

`apps/api` currently depends only on `config` and `database`. Ingestion needs three more.
Add to `apps/api/package.json` dependencies:

```json
    "@flight-recorder/payload-diff": "workspace:*",
    "@flight-recorder/payload-security": "workspace:*",
    "@flight-recorder/protocol": "workspace:*",
```

Then run `pnpm install` so the workspace links resolve.

- [ ] **Step 3: Lint, typecheck, commit**

```bash
pnpm install
pnpm lint && pnpm typecheck
git add apps/api
git commit -m "feat(api): add per-event ingestion transaction"
```

---

## Task 9: Routes

**Files:**
- Create: `apps/api/src/routes/events.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/src/server.ts`

- [ ] **Step 1: Implement the routes**

```typescript
import type { Subkeys } from "@flight-recorder/payload-security";
import { findApiKeyByPrefix } from "@flight-recorder/database";
import type { FastifyInstance } from "fastify";
import { resolveApiKey } from "../auth.js";
import { ingestEvent } from "../ingestion/ingest-event.js";

const MAX_BATCH_SIZE = 100;

export function registerEventRoutes(app: FastifyInstance, subkeys: Subkeys): void {
  app.post("/v1/events", async (request, reply) => {
    const auth = await resolveApiKey(request.headers.authorization, subkeys.apiKey, (prefix) =>
      findApiKeyByPrefix(app.db, prefix)
    );
    if (!auth.ok) {
      return reply.code(auth.status).send(errorBody(auth.code, auth.message, request.id));
    }

    const result = await ingestEvent(app.db, subkeys, auth.context, request.body);
    if (result.status === "rejected") {
      return reply
        .code(result.httpStatus)
        .send(errorBody(result.code ?? "invalid_event", result.message ?? "", request.id));
    }

    return reply.code(202).send({
      data: {
        eventId: result.eventId,
        journeyId: result.journeyId,
        status: "accepted",
        duplicate: result.duplicate ?? false
      }
    });
  });

  app.post("/v1/events/batch", async (request, reply) => {
    const auth = await resolveApiKey(request.headers.authorization, subkeys.apiKey, (prefix) =>
      findApiKeyByPrefix(app.db, prefix)
    );
    if (!auth.ok) {
      return reply.code(auth.status).send(errorBody(auth.code, auth.message, request.id));
    }

    const body = request.body as { events?: unknown[] } | undefined;
    const events = body?.events;
    if (!Array.isArray(events)) {
      return reply
        .code(400)
        .send(errorBody("invalid_event", "Body must contain an events array.", request.id));
    }
    if (events.length > MAX_BATCH_SIZE) {
      // Rejected before any event is processed, per SECURITY.md section 11.
      return reply
        .code(400)
        .send(
          errorBody(
            "payload_too_large",
            `A batch may contain at most ${String(MAX_BATCH_SIZE)} events.`,
            request.id
          )
        );
    }

    const results = [];
    for (const event of events) {
      // Sequential and independent: one event's failure never affects another's.
      const result = await ingestEvent(app.db, subkeys, auth.context, event);
      results.push(
        result.status === "accepted"
          ? { eventId: result.eventId, status: "accepted", duplicate: result.duplicate ?? false }
          : {
              eventId: result.eventId,
              status: "rejected",
              error: { code: result.code, message: result.message }
            }
      );
    }

    return reply.code(202).send({ data: { results } });
  });
}

function errorBody(code: string, message: string, requestId: string): unknown {
  return { error: { code, message, requestId } };
}
```

- [ ] **Step 2: Wire into the app**

In `apps/api/src/app.ts`, extend `BuildAppOptions` with `subkeys: Subkeys` and call
`registerEventRoutes(app, options.subkeys)` after `registerHealthRoutes`.

In `apps/api/src/server.ts`, derive subkeys from configuration and pass them:

```typescript
const subkeys = deriveSubkeys(env.ENCRYPTION_KEY);
const app = buildApp({ db, subkeys, logLevel: env.LOG_LEVEL });
```

Existing health tests construct `buildApp` without `subkeys`; update them to pass
`deriveSubkeys("0123456789abcdef0123456789abcdef")`.

- [ ] **Step 3: Lint, typecheck, commit**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add apps/api
git commit -m "feat(api): add single and batch ingestion routes"
```

---

## Task 10: Ingestion integration tests

**Files:**
- Test: `apps/api/src/routes/events.integration.test.ts`

- [ ] **Step 1: Write the tests**

```typescript
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createKnexConfig, insertReturningId } from "@flight-recorder/database";
import { deriveSubkeys, generateApiKey } from "@flight-recorder/payload-security";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const subkeys = deriveSubkeys("0123456789abcdef0123456789abcdef");

function event(overrides: Record<string, unknown> = {}): unknown {
  return {
    protocolVersion: "0.1",
    event: {
      id: "evt_1",
      journeyId: "jrn_1",
      environment: "development",
      service: "customer-integration",
      entity: { type: "customer", id: "0018Z00002ABC" },
      operation: "transformed",
      name: "transform-salesforce-account",
      timestamp: "2026-08-06T18:31:04.120Z",
      aliases: { salesforceAccountId: "0018Z00002ABC" },
      input: { phone: "+1 919 555 1234", authorization: "Bearer secret" },
      output: { phone: null, authorization: "Bearer secret" },
      ...overrides
    }
  };
}

describe("POST /v1/events", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let app: FastifyInstance;
  let apiKey: string;
  let projectId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();

    projectId = await insertReturningId(db, "projects", { name: "P", slug: "p" });
    const environmentId = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: "development"
    });
    const generated = generateApiKey(subkeys.apiKey);
    apiKey = generated.apiKey;
    await db("api_keys").insert({
      project_id: projectId,
      environment_id: environmentId,
      name: "k",
      key_prefix: generated.keyPrefix,
      key_hash: generated.verifier
    });

    app = buildApp({ db, subkeys, logLevel: "silent" });
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await container.stop();
  });

  const send = (payload: unknown, key = apiKey) =>
    app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${key}` },
      payload: payload as object
    });

  it("accepts a valid event and creates the journey", async () => {
    const response = await send(event());
    expect(response.statusCode).toBe(202);
    expect(response.json().data.duplicate).toBe(false);

    const journey = await db("journeys").where({ project_id: projectId, id: "jrn_1" }).first();
    expect(journey.event_count).toBe(1);
  });

  it("redacts built-in secrets before persistence", async () => {
    const row = await db("journey_events").where({ project_id: projectId, id: "evt_1" }).first();
    expect(row.input_payload.authorization).toBe("[REDACTED]");
    expect(row.input_payload.phone).toBe("+1 919 555 1234");
  });

  it("stores a diff identifying the changed field", async () => {
    const row = await db("journey_events").where({ project_id: projectId, id: "evt_1" }).first();
    expect(row.payload_diff.changes).toContainEqual({
      path: "phone",
      kind: "changed",
      before: "+1 919 555 1234",
      after: null
    });
  });

  it("stores the alias once even when resent", async () => {
    await send(event());
    const count = await db("entity_aliases")
      .where({ project_id: projectId, journey_id: "jrn_1" })
      .count({ n: "*" })
      .first();
    expect(count).toEqual({ n: "1" });
  });

  it("is idempotent for an identical resubmission", async () => {
    const response = await send(event());
    expect(response.json().data.duplicate).toBe(true);

    const journey = await db("journeys").where({ project_id: projectId, id: "jrn_1" }).first();
    expect(journey.event_count).toBe(1);
  });

  it("rejects the same event id with different content", async () => {
    const response = await send(event({ name: "different-name" }));
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("event_id_conflict");
  });

  it("rejects a missing key", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: event() as object
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects an unknown key", async () => {
    expect((await send(event(), "fr_totallyfakekeyvalue")).statusCode).toBe(401);
  });

  it("rejects an event naming another environment", async () => {
    const response = await send(event({ id: "evt_env", environment: "production" }));
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("unauthorized_environment");
  });

  it("rejects a malformed event with field details", async () => {
    const response = await send({ protocolVersion: "0.1", event: { id: "evt_bad" } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_event");
  });

  it("rejects an unsupported protocol version", async () => {
    const response = await send({ protocolVersion: "9.9", event: {} });
    expect(response.json().error.code).toBe("unsupported_protocol_version");
  });

  it("returns per-event results for a partially invalid batch", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/events/batch",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        events: [
          event({ id: "evt_batch_ok", journeyId: "jrn_batch" }),
          { protocolVersion: "0.1", event: { id: "evt_batch_bad" } }
        ]
      } as object
    });

    expect(response.statusCode).toBe(202);
    const results = response.json().data.results;
    expect(results[0].status).toBe("accepted");
    expect(results[1].status).toBe("rejected");

    const stored = await db("journey_events")
      .where({ project_id: projectId, id: "evt_batch_ok" })
      .first();
    expect(stored).toBeDefined();
  });

  it("rejects an oversized batch before processing any event", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/events/batch",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { events: Array.from({ length: 101 }, () => event()) } as object
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("payload_too_large");
  });

  it("does not let one project reach another's journeys", async () => {
    const otherProject = await insertReturningId(db, "projects", { name: "O", slug: "o" });
    const otherEnv = await insertReturningId(db, "environments", {
      project_id: otherProject,
      name: "development"
    });
    const otherKey = generateApiKey(subkeys.apiKey);
    await db("api_keys").insert({
      project_id: otherProject,
      environment_id: otherEnv,
      name: "other",
      key_prefix: otherKey.keyPrefix,
      key_hash: otherKey.verifier
    });

    // Same journey id, different project: must create a separate journey.
    await send(event({ id: "evt_other", journeyId: "jrn_1" }), otherKey.apiKey);

    const rows = await db("journeys").where({ id: "jrn_1" });
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r: { project_id: string }) => r.project_id)).size).toBe(2);
  });
});
```

- [ ] **Step 2: Run them**

Run: `pnpm test:integration`
Expected: PASS. This suite adds 14 tests.

- [ ] **Step 3: Commit**

```bash
pnpm lint && pnpm typecheck
git add apps/api
git commit -m "test(api): cover ingestion, idempotency, isolation, and batch handling"
```

---

## Task 11: Verify Phase 1b

**Files:** none — verification only.

- [ ] **Step 1: Clean-clone pipeline**

```bash
CLEAN=$(mktemp -d)/fr && git clone -q --branch phase-1b-ingestion . "$CLEAN" && cd "$CLEAN"
pnpm install --frozen-lockfile
for s in format:check lint typecheck test build; do
  pnpm "$s" >/dev/null 2>&1 && echo "$s OK" || echo "$s FAIL"
done
pnpm test:integration
```

Expected: every stage OK. Working-tree success is not evidence — in Phase 0 and 1a,
most defects appeared only on a fresh checkout.

- [ ] **Step 2: End-to-end against the Compose stack**

```bash
docker compose -f infrastructure/compose.yaml down -v
docker compose -f infrastructure/compose.yaml up -d --build
DATABASE_URL=postgresql://flight:flight@localhost:5432/flight pnpm db:migrate
DATABASE_URL=postgresql://flight:flight@localhost:5432/flight \
  ENCRYPTION_KEY=replace-for-local-development-0000 pnpm db:seed
```

Take the printed key and send a real event:

```bash
curl -s -X POST localhost:8080/v1/events \
  -H "Authorization: Bearer <printed-key>" \
  -H "content-type: application/json" \
  -d '{"protocolVersion":"0.1","event":{"id":"evt_manual_1","journeyId":"jrn_manual_1","environment":"development","service":"demo","entity":{"type":"customer","id":"0018Z00002ABC"},"operation":"transformed","name":"transform","timestamp":"2026-08-07T10:00:00.000Z","input":{"phone":"+1 919 555 1234"},"output":{"phone":null}}}'
```

Expected: `202` with `"duplicate":false`. Sending it again returns `"duplicate":true`.

- [ ] **Step 3: Confirm the pipeline, merge, tag**

```bash
git checkout main && git merge --no-ff phase-1b-ingestion
git push origin main
glab ci list --per-page 1
```

Wait for all six jobs to succeed, then:

```bash
git tag -a phase-1b-complete -m "Phase 1b: authenticated idempotent ingestion"
git push origin phase-1b-complete
```

---

## Definition of done

Every checkbox above, Task 11 passing in full, and a green CI pipeline.

**Not in this phase:** search, journey and event reads, the timeline interface, the SDK,
propagation, the demo services, replay, and retention.
