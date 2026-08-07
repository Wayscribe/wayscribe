# Phase 1a: Protocol, Schema, and Security Primitives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the three foundation packages Phase 1b's ingestion API will consume — the versioned event protocol, the complete database schema, and the security primitives — each independently testable without an HTTP server.

**Architecture:** Three packages with no dependencies on one another. `protocol` owns Zod schemas and infers its types from them. `database` owns migrations 002–010 plus an idempotent local seed. `payload-security` is a pure crypto library taking keys as parameters, with three purpose-separated subkeys derived from one master via HKDF-SHA256.

**Tech Stack:** TypeScript 5.9, Zod 4, Knex, PostgreSQL 17, node:crypto, Vitest 4, Testcontainers.

**Source spec:** `docs/superpowers/specs/2026-08-07-phase-1a-foundations-design.md`

---

## Conventions carried from Phase 0

Every package already has `tsconfig.json` (includes tests, drives `typecheck`) and
`tsconfig.build.json` (excludes tests, drives `build`). Do not change that split.

Migrations are plain ESM JavaScript with JSDoc types, in
`packages/database/migrations/`, per ADR-027. Never `.ts` — knex records the filename,
and a migration must not be able to have two names.

Run every command with Node 24 on PATH:

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
```

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/protocol/src/version.ts` | `PROTOCOL_VERSION`, supported-version check |
| `packages/protocol/src/errors.ts` | Stable error codes |
| `packages/protocol/src/event.ts` | Zod schemas for event and nested structures |
| `packages/protocol/src/envelope.ts` | Envelope schema and parse entry point |
| `packages/protocol/fixtures/*.json` | Five shared fixtures |
| `packages/payload-security/src/keys.ts` | HKDF subkey derivation |
| `packages/payload-security/src/redact.ts` | Path-based redaction |
| `packages/payload-security/src/search-token.ts` | HMAC search tokens + normalization |
| `packages/payload-security/src/api-key.ts` | Key generation and constant-time verify |
| `packages/payload-security/src/encryption.ts` | AES-256-GCM field encryption |
| `packages/payload-security/src/limits.ts` | Size, depth, key-count, string-length checks |
| `packages/database/migrations/002_*.js` … `009_*.js` | Schema; each index lives with the table it serves |
| `packages/database/src/seed-local.ts` | Idempotent local seed |

---

## Task 1: Protocol version and error codes

**Files:**
- Create: `packages/protocol/src/version.ts`, `packages/protocol/src/errors.ts`
- Test: `packages/protocol/src/version.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, isSupportedProtocolVersion } from "./version.js";

describe("protocol version", () => {
  it("is 0.1", () => {
    expect(PROTOCOL_VERSION).toBe("0.1");
  });

  it("accepts the current version", () => {
    expect(isSupportedProtocolVersion("0.1")).toBe(true);
  });

  it("rejects unknown versions", () => {
    expect(isSupportedProtocolVersion("0.2")).toBe(false);
    expect(isSupportedProtocolVersion("1.0")).toBe(false);
    expect(isSupportedProtocolVersion("")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/protocol`
Expected: FAIL, cannot resolve `./version.js`.

- [ ] **Step 3: Implement**

`packages/protocol/src/version.ts`:

```typescript
export const PROTOCOL_VERSION = "0.1";

const SUPPORTED_VERSIONS = new Set<string>([PROTOCOL_VERSION]);

export function isSupportedProtocolVersion(version: string): boolean {
  return SUPPORTED_VERSIONS.has(version);
}
```

`packages/protocol/src/errors.ts`:

```typescript
/**
 * Stable machine-readable error codes (EVENT_PROTOCOL.md section 12).
 *
 * These are a public contract. Human-readable messages may change freely;
 * these strings may not.
 */
export const PROTOCOL_ERROR_CODES = {
  unsupportedProtocolVersion: "unsupported_protocol_version",
  invalidEvent: "invalid_event",
  missingRequiredField: "missing_required_field",
  payloadTooLarge: "payload_too_large",
  unauthorizedEnvironment: "unauthorized_environment",
  invalidTimestamp: "invalid_timestamp",
  invalidOperation: "invalid_operation",
  eventIdConflict: "event_id_conflict"
} as const;

export type ProtocolErrorCode =
  (typeof PROTOCOL_ERROR_CODES)[keyof typeof PROTOCOL_ERROR_CODES];
```

`event_id_conflict` is included here rather than in the API layer because ADR-021 makes
it part of the ingestion contract the SDK must understand.

- [ ] **Step 4: Run it and confirm it passes**

Run: `pnpm vitest run packages/protocol`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): add version constant and stable error codes"
```

---

## Task 2: Journey event schema

**Files:**
- Create: `packages/protocol/src/event.ts`
- Test: `packages/protocol/src/event.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { journeyEventSchema } from "./event.js";

const minimalEvent = {
  id: "evt_01",
  journeyId: "jrn_01",
  environment: "development",
  service: "customer-integration",
  entity: { type: "customer", id: "18492" },
  operation: "received",
  name: "receive-salesforce-webhook",
  timestamp: "2026-08-06T18:31:02.000Z"
};

describe("journeyEventSchema", () => {
  it("accepts a minimal valid event", () => {
    expect(journeyEventSchema.safeParse(minimalEvent).success).toBe(true);
  });

  it("accepts the identified operation", () => {
    const event = { ...minimalEvent, operation: "identified" };
    expect(journeyEventSchema.safeParse(event).success).toBe(true);
  });

  it("rejects an unknown operation", () => {
    const result = journeyEventSchema.safeParse({ ...minimalEvent, operation: "exploded" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing id and names the field", () => {
    const { id: _omitted, ...withoutId } = minimalEvent;
    const result = journeyEventSchema.safeParse(withoutId);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("id"))).toBe(true);
    }
  });

  it("rejects a non-ISO timestamp", () => {
    const result = journeyEventSchema.safeParse({ ...minimalEvent, timestamp: "yesterday" });
    expect(result.success).toBe(false);
  });

  it("rejects a timestamp without timezone information", () => {
    const result = journeyEventSchema.safeParse({
      ...minimalEvent,
      timestamp: "2026-08-06T18:31:02.000"
    });
    expect(result.success).toBe(false);
  });

  it("accepts optional aliases, payloads, error, and metadata", () => {
    const complete = {
      ...minimalEvent,
      aliases: { salesforceAccountId: "0018Z00002ABC" },
      durationMs: 18,
      parentEventId: "evt_00",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      messageId: "msg_01",
      correlationId: "cor_01",
      input: { phone: "+1 919 555 1234" },
      output: { phone: null },
      error: { type: "ValidationError", message: "phone required", code: "phone_required" },
      runtime: { language: "node", version: "24.19.0", hostname: "worker-1", processId: 42 },
      deployment: { gitCommit: "abc123", version: "1.2.3", image: "app:1.2.3" },
      metadata: { attempt: 2, httpStatus: 422 }
    };
    expect(journeyEventSchema.safeParse(complete).success).toBe(true);
  });

  it("rejects a negative duration", () => {
    const result = journeyEventSchema.safeParse({ ...minimalEvent, durationMs: -1 });
    expect(result.success).toBe(false);
  });

  it("requires a message when an error is present", () => {
    const result = journeyEventSchema.safeParse({ ...minimalEvent, error: { code: "x" } });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/protocol`
Expected: FAIL, cannot resolve `./event.js`.

- [ ] **Step 3: Implement**

```typescript
import { z } from "zod";

export const JOURNEY_OPERATIONS = [
  "received",
  "identified",
  "transformed",
  "validated",
  "persisted",
  "published",
  "consumed",
  "delivered",
  "failed",
  "retried",
  "completed"
] as const;

export const journeyOperationSchema = z.enum(JOURNEY_OPERATIONS);
export type JourneyOperation = z.infer<typeof journeyOperationSchema>;

export const entitySchema = z.object({
  type: z.string().min(1).max(128),
  id: z.string().min(1).max(512)
});

export const errorSchema = z.object({
  type: z.string().max(256).optional(),
  message: z.string().min(1).max(4096),
  code: z.string().max(256).optional(),
  stack: z.string().max(16_384).optional()
});

export const runtimeSchema = z.object({
  language: z.string().max(64).optional(),
  version: z.string().max(64).optional(),
  hostname: z.string().max(256).optional(),
  processId: z.number().int().nonnegative().optional()
});

export const deploymentSchema = z.object({
  gitCommit: z.string().max(128).optional(),
  version: z.string().max(128).optional(),
  image: z.string().max(512).optional()
});

/**
 * ISO 8601 with explicit timezone. A timestamp without an offset is ambiguous
 * across services in different zones, which is exactly the correlation this
 * product depends on, so it is rejected rather than assumed to be UTC.
 */
const isoTimestampSchema = z.iso.datetime({ offset: true });

export const journeyEventSchema = z.object({
  id: z.string().min(1).max(128),
  journeyId: z.string().min(1).max(128),

  environment: z.string().min(1).max(64),
  service: z.string().min(1).max(128),

  entity: entitySchema,

  operation: journeyOperationSchema,
  name: z.string().min(1).max(256),
  timestamp: isoTimestampSchema,

  aliases: z.record(z.string().max(128), z.string().max(512)).optional(),

  durationMs: z.number().int().nonnegative().optional(),
  parentEventId: z.string().max(128).optional(),

  traceId: z.string().max(128).optional(),
  spanId: z.string().max(128).optional(),
  messageId: z.string().max(256).optional(),
  correlationId: z.string().max(256).optional(),

  input: z.unknown().optional(),
  output: z.unknown().optional(),

  error: errorSchema.optional(),
  runtime: runtimeSchema.optional(),
  deployment: deploymentSchema.optional(),
  metadata: z.record(z.string().max(128), z.unknown()).optional()
});

export type JourneyEvent = z.infer<typeof journeyEventSchema>;
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `pnpm vitest run packages/protocol`
Expected: PASS, 12 tests across both files.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): add journey event schema"
```

---

## Task 3: Envelope and parse entry point

**Files:**
- Create: `packages/protocol/src/envelope.ts`
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/src/envelope.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { PROTOCOL_ERROR_CODES } from "./errors.js";
import { parseEnvelope } from "./envelope.js";

const validEnvelope = {
  protocolVersion: "0.1",
  event: {
    id: "evt_01",
    journeyId: "jrn_01",
    environment: "development",
    service: "customer-integration",
    entity: { type: "customer", id: "18492" },
    operation: "received",
    name: "receive-salesforce-webhook",
    timestamp: "2026-08-06T18:31:02.000Z"
  }
};

describe("parseEnvelope", () => {
  it("returns the event for a valid envelope", () => {
    const result = parseEnvelope(validEnvelope);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event.id).toBe("evt_01");
  });

  it("rejects an unsupported version before validating the event", () => {
    const result = parseEnvelope({ protocolVersion: "9.9", event: { garbage: true } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(PROTOCOL_ERROR_CODES.unsupportedProtocolVersion);
    }
  });

  it("reports invalid_event with field details for a malformed event", () => {
    const result = parseEnvelope({ protocolVersion: "0.1", event: { id: "evt_01" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(PROTOCOL_ERROR_CODES.invalidEvent);
      expect(result.details.length).toBeGreaterThan(0);
      expect(result.details[0]).toHaveProperty("path");
      expect(result.details[0]).toHaveProperty("message");
    }
  });

  it("rejects a non-object input", () => {
    expect(parseEnvelope(null).ok).toBe(false);
    expect(parseEnvelope("nope").ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/protocol`
Expected: FAIL, cannot resolve `./envelope.js`.

- [ ] **Step 3: Implement**

```typescript
import { z } from "zod";
import { PROTOCOL_ERROR_CODES, type ProtocolErrorCode } from "./errors.js";
import { journeyEventSchema, type JourneyEvent } from "./event.js";
import { isSupportedProtocolVersion } from "./version.js";

export const envelopeSchema = z.object({
  protocolVersion: z.string().min(1).max(16),
  event: z.unknown()
});

export interface ParseDetail {
  path: string;
  message: string;
}

export type ParseResult =
  | { ok: true; event: JourneyEvent }
  | { ok: false; code: ProtocolErrorCode; message: string; details: ParseDetail[] };

/**
 * Version is checked before the event is validated, so a future protocol
 * version produces `unsupported_protocol_version` rather than a confusing pile
 * of field errors from schemas that never applied to it.
 */
export function parseEnvelope(input: unknown): ParseResult {
  const envelope = envelopeSchema.safeParse(input);
  if (!envelope.success) {
    return {
      ok: false,
      code: PROTOCOL_ERROR_CODES.invalidEvent,
      message: "Request body did not match the event envelope.",
      details: toDetails(envelope.error)
    };
  }

  if (!isSupportedProtocolVersion(envelope.data.protocolVersion)) {
    return {
      ok: false,
      code: PROTOCOL_ERROR_CODES.unsupportedProtocolVersion,
      message: `Protocol version ${envelope.data.protocolVersion} is not supported.`,
      details: []
    };
  }

  const event = journeyEventSchema.safeParse(envelope.data.event);
  if (!event.success) {
    return {
      ok: false,
      code: PROTOCOL_ERROR_CODES.invalidEvent,
      message: "The event did not match protocol version 0.1.",
      details: toDetails(event.error)
    };
  }

  return { ok: true, event: event.data };
}

function toDetails(error: z.ZodError): ParseDetail[] {
  return error.issues.map((issue) => ({
    path: ["event", ...issue.path.map(String)].join("."),
    message: issue.message
  }));
}
```

`packages/protocol/src/index.ts`:

```typescript
export { PROTOCOL_ERROR_CODES, type ProtocolErrorCode } from "./errors.js";
export {
  envelopeSchema,
  parseEnvelope,
  type ParseDetail,
  type ParseResult
} from "./envelope.js";
export {
  JOURNEY_OPERATIONS,
  deploymentSchema,
  entitySchema,
  errorSchema,
  journeyEventSchema,
  journeyOperationSchema,
  runtimeSchema,
  type JourneyEvent,
  type JourneyOperation
} from "./event.js";
export { PROTOCOL_VERSION, isSupportedProtocolVersion } from "./version.js";
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `pnpm vitest run packages/protocol`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): add versioned envelope and parse entry point"
```

---

## Task 4: Shared fixtures

**Files:**
- Create: five files in `packages/protocol/fixtures/`
- Test: `packages/protocol/src/fixtures.test.ts`
- Modify: `packages/protocol/tsconfig.json`, `packages/protocol/package.json`

`TESTING_STRATEGY.md` section 4 names these filenames exactly. The SDK and API suites
both consume them, so they are JSON rather than TypeScript.

- [ ] **Step 1: Create the fixtures**

`packages/protocol/fixtures/v0.1-valid-minimal.json`:

```json
{
  "protocolVersion": "0.1",
  "event": {
    "id": "evt_minimal_01",
    "journeyId": "jrn_minimal_01",
    "environment": "development",
    "service": "customer-integration",
    "entity": { "type": "customer", "id": "18492" },
    "operation": "received",
    "name": "receive-salesforce-webhook",
    "timestamp": "2026-08-06T18:31:02.000Z"
  }
}
```

`packages/protocol/fixtures/v0.1-valid-complete.json`:

```json
{
  "protocolVersion": "0.1",
  "event": {
    "id": "evt_complete_01",
    "journeyId": "jrn_complete_01",
    "environment": "development",
    "service": "customer-integration",
    "entity": { "type": "customer", "id": "0018Z00002ABC" },
    "operation": "transformed",
    "name": "transform-salesforce-account",
    "timestamp": "2026-08-06T18:31:04.120Z",
    "aliases": {
      "salesforceAccountId": "0018Z00002ABC",
      "internalCustomerId": "18492"
    },
    "durationMs": 18,
    "parentEventId": "evt_complete_00",
    "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
    "spanId": "00f067aa0ba902b7",
    "messageId": "msg_complete_01",
    "correlationId": "cor_complete_01",
    "input": { "Id": "0018Z00002ABC", "Name": "Jorge Polanco", "Phone": "+1 919 555 1234" },
    "output": { "externalId": "0018Z00002ABC", "name": "Jorge Polanco", "phone": null },
    "error": {
      "type": "ValidationError",
      "message": "A phone number is required.",
      "code": "phone_required"
    },
    "runtime": { "language": "node", "version": "24.19.0", "hostname": "worker-1", "processId": 42 },
    "deployment": { "gitCommit": "abc123def456", "version": "1.2.3", "image": "app:1.2.3" },
    "metadata": { "attempt": 2, "queue": "customer-updates", "httpStatus": 422 }
  }
}
```

`packages/protocol/fixtures/v0.1-invalid-missing-id.json`:

```json
{
  "protocolVersion": "0.1",
  "event": {
    "journeyId": "jrn_missing_id",
    "environment": "development",
    "service": "customer-integration",
    "entity": { "type": "customer", "id": "18492" },
    "operation": "received",
    "name": "receive-salesforce-webhook",
    "timestamp": "2026-08-06T18:31:02.000Z"
  }
}
```

`packages/protocol/fixtures/v0.1-invalid-operation.json`:

```json
{
  "protocolVersion": "0.1",
  "event": {
    "id": "evt_bad_operation",
    "journeyId": "jrn_bad_operation",
    "environment": "development",
    "service": "customer-integration",
    "entity": { "type": "customer", "id": "18492" },
    "operation": "teleported",
    "name": "receive-salesforce-webhook",
    "timestamp": "2026-08-06T18:31:02.000Z"
  }
}
```

`packages/protocol/fixtures/v0.1-invalid-timestamp.json`:

```json
{
  "protocolVersion": "0.1",
  "event": {
    "id": "evt_bad_timestamp",
    "journeyId": "jrn_bad_timestamp",
    "environment": "development",
    "service": "customer-integration",
    "entity": { "type": "customer", "id": "18492" },
    "operation": "received",
    "name": "receive-salesforce-webhook",
    "timestamp": "06/08/2026 18:31"
  }
}
```

- [ ] **Step 2: Write the test**

`packages/protocol/src/fixtures.test.ts`:

```typescript
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROTOCOL_ERROR_CODES } from "./errors.js";
import { parseEnvelope } from "./envelope.js";

function loadFixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../fixtures/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("protocol fixtures", () => {
  it("v0.1-valid-minimal parses", () => {
    expect(parseEnvelope(loadFixture("v0.1-valid-minimal")).ok).toBe(true);
  });

  it("v0.1-valid-complete parses", () => {
    expect(parseEnvelope(loadFixture("v0.1-valid-complete")).ok).toBe(true);
  });

  it.each([
    "v0.1-invalid-missing-id",
    "v0.1-invalid-operation",
    "v0.1-invalid-timestamp"
  ])("%s is rejected as invalid_event", (name) => {
    const result = parseEnvelope(loadFixture(name));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(PROTOCOL_ERROR_CODES.invalidEvent);
  });
});
```

- [ ] **Step 3: Publish the fixtures from the package**

Add to `packages/protocol/package.json` exports, so the SDK and API can load them by
package path rather than by relative path across the workspace:

```json
  "exports": {
    ".": {
      "development": "./src/index.ts",
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./fixtures/*.json": "./fixtures/*.json"
  },
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run packages/protocol`
Expected: PASS, 21 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): add shared v0.1 fixtures"
```

---

## Task 5: HKDF subkey derivation

**Files:**
- Create: `packages/payload-security/src/keys.ts`
- Test: `packages/payload-security/src/keys.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { deriveSubkeys } from "./keys.js";

const master = "0123456789abcdef0123456789abcdef";

describe("deriveSubkeys", () => {
  it("derives three 32-byte subkeys", () => {
    const keys = deriveSubkeys(master);
    expect(keys.fieldEncryption).toHaveLength(32);
    expect(keys.searchToken).toHaveLength(32);
    expect(keys.apiKey).toHaveLength(32);
  });

  it("derives different keys for different purposes", () => {
    const keys = deriveSubkeys(master);
    expect(keys.fieldEncryption.equals(keys.searchToken)).toBe(false);
    expect(keys.searchToken.equals(keys.apiKey)).toBe(false);
    expect(keys.fieldEncryption.equals(keys.apiKey)).toBe(false);
  });

  it("is deterministic for the same master", () => {
    expect(deriveSubkeys(master).searchToken.equals(deriveSubkeys(master).searchToken)).toBe(
      true
    );
  });

  it("produces different subkeys for a different master", () => {
    const other = deriveSubkeys("fedcba9876543210fedcba9876543210");
    expect(deriveSubkeys(master).searchToken.equals(other.searchToken)).toBe(false);
  });

  it("rejects a master key that is too short", () => {
    expect(() => deriveSubkeys("short")).toThrow(/at least 32/i);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/payload-security`
Expected: FAIL, cannot resolve `./keys.js`.

- [ ] **Step 3: Implement**

```typescript
import { hkdfSync } from "node:crypto";

export interface Subkeys {
  fieldEncryption: Buffer;
  searchToken: Buffer;
  apiKey: Buffer;
}

const SUBKEY_LENGTH = 32;
const MINIMUM_MASTER_LENGTH = 32;

/**
 * Derive purpose-separated subkeys from one master key.
 *
 * Three primitives need key material, and reusing one key across encryption,
 * search tokens, and API-key verification is poor practice. Requiring three
 * environment variables works against the onboarding target, so HKDF splits one
 * configured value into three cryptographically independent keys.
 *
 * Rotating the master rotates all three, which invalidates existing search
 * tokens and API keys. V0 accepts that; see the Phase 1a design.
 */
export function deriveSubkeys(masterKey: string): Subkeys {
  if (masterKey.length < MINIMUM_MASTER_LENGTH) {
    throw new Error(
      `Master key must be at least ${String(MINIMUM_MASTER_LENGTH)} characters.`
    );
  }

  return {
    fieldEncryption: derive(masterKey, "flight-recorder/field-encryption"),
    searchToken: derive(masterKey, "flight-recorder/search-token"),
    apiKey: derive(masterKey, "flight-recorder/api-key")
  };
}

function derive(masterKey: string, info: string): Buffer {
  // Empty salt is acceptable here: the info label provides domain separation and
  // the master key is already high-entropy.
  return Buffer.from(hkdfSync("sha256", masterKey, "", info, SUBKEY_LENGTH));
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `pnpm vitest run packages/payload-security`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/payload-security
git commit -m "feat(payload-security): derive purpose-separated subkeys via HKDF"
```

---

## Task 6: Field encryption

**Files:**
- Create: `packages/payload-security/src/encryption.ts`
- Test: `packages/payload-security/src/encryption.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { decryptField, encryptField } from "./encryption.js";
import { deriveSubkeys } from "./keys.js";

const key = deriveSubkeys("0123456789abcdef0123456789abcdef").fieldEncryption;

describe("field encryption", () => {
  it("round-trips a value", () => {
    expect(decryptField(key, encryptField(key, "0018Z00002ABC"))).toBe("0018Z00002ABC");
  });

  it("round-trips unicode and empty strings", () => {
    expect(decryptField(key, encryptField(key, "café ☕"))).toBe("café ☕");
    expect(decryptField(key, encryptField(key, ""))).toBe("");
  });

  it("produces different ciphertext each time for the same plaintext", () => {
    // A fresh IV per encryption. Equal ciphertexts would leak equality of
    // plaintexts across rows, which for entity IDs is most of the secret.
    expect(encryptField(key, "same")).not.toBe(encryptField(key, "same"));
  });

  it("fails to decrypt with a different key", () => {
    const other = deriveSubkeys("fedcba9876543210fedcba9876543210").fieldEncryption;
    expect(() => decryptField(other, encryptField(key, "secret"))).toThrow();
  });

  it("fails to decrypt tampered ciphertext", () => {
    const encrypted = encryptField(key, "secret");
    const bytes = Buffer.from(encrypted, "base64");
    bytes[bytes.length - 1] ^= 0xff;
    expect(() => decryptField(key, bytes.toString("base64"))).toThrow();
  });

  it("rejects malformed input", () => {
    expect(() => decryptField(key, "not-base64-at-all!!")).toThrow();
    expect(() => decryptField(key, "")).toThrow();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/payload-security`
Expected: FAIL, cannot resolve `./encryption.js`.

- [ ] **Step 3: Implement**

```typescript
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Encrypt a single field value.
 *
 * Layout is base64 of `iv || authTag || ciphertext`, so one text column holds
 * everything needed to decrypt. A fresh random IV per call is essential: GCM
 * catastrophically loses confidentiality if an IV is reused under the same key.
 */
export function encryptField(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

export function decryptField(key: Buffer, encoded: string): string {
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Encrypted value is malformed.");
  }

  const iv = bytes.subarray(0, IV_LENGTH);
  const authTag = bytes.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = bytes.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  // decipher.final() throws when the tag does not verify, which is how tampering
  // and wrong keys surface. Never catch and return partial plaintext.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `pnpm vitest run packages/payload-security`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/payload-security
git commit -m "feat(payload-security): add AES-256-GCM field encryption"
```

---

## Task 7: Search tokens

**Files:**
- Create: `packages/payload-security/src/search-token.ts`
- Test: `packages/payload-security/src/search-token.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { deriveSubkeys } from "./keys.js";
import { normalizeSearchValue, searchToken } from "./search-token.js";

const key = deriveSubkeys("0123456789abcdef0123456789abcdef").searchToken;

describe("normalizeSearchValue", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeSearchValue("  18492  ")).toBe("18492");
  });

  it("lowercases UUIDs", () => {
    expect(normalizeSearchValue("A1B2C3D4-E5F6-7890-ABCD-EF1234567890")).toBe(
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
    );
  });

  it("preserves case in non-UUID identifiers", () => {
    // Salesforce IDs are case-sensitive. Lowercasing them would merge distinct
    // records.
    expect(normalizeSearchValue("0018Z00002ABC")).toBe("0018Z00002ABC");
  });

  it("preserves punctuation", () => {
    expect(normalizeSearchValue("CUST-8841")).toBe("CUST-8841");
  });
});

describe("searchToken", () => {
  it("is deterministic", () => {
    expect(searchToken(key, "internalCustomerId", "18492")).toBe(
      searchToken(key, "internalCustomerId", "18492")
    );
  });

  it("normalizes before hashing", () => {
    expect(searchToken(key, "internalCustomerId", " 18492 ")).toBe(
      searchToken(key, "internalCustomerId", "18492")
    );
  });

  it("differs across alias types for the same value", () => {
    expect(searchToken(key, "internalCustomerId", "18492")).not.toBe(
      searchToken(key, "salesforceAccountId", "18492")
    );
  });

  it("differs across keys", () => {
    const other = deriveSubkeys("fedcba9876543210fedcba9876543210").searchToken;
    expect(searchToken(key, "internalCustomerId", "18492")).not.toBe(
      searchToken(other, "internalCustomerId", "18492")
    );
  });

  it("returns lowercase hex of fixed length", () => {
    expect(searchToken(key, "t", "v")).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/payload-security`
Expected: FAIL, cannot resolve `./search-token.js`.

- [ ] **Step 3: Implement**

```typescript
import { createHmac } from "node:crypto";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Normalize a value before hashing.
 *
 * Deliberately conservative: only whitespace trimming and UUID case folding.
 * External systems issue case-sensitive identifiers — a Salesforce ID is not
 * equal to its lowercase form — so blanket lowercasing would merge distinct
 * entities into one journey.
 */
export function normalizeSearchValue(value: string): string {
  const trimmed = value.trim();
  return UUID_PATTERN.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

/**
 * Deterministic search token for an alias or entity identifier.
 *
 * The alias type is part of the HMAC input (DATABASE_SCHEMA.md section 4), so
 * the same value under two alias types yields different tokens and cannot
 * collide. HMAC rather than a bare hash so that a database leak alone does not
 * let an attacker confirm guessed values offline — these are often low-entropy.
 */
export function searchToken(key: Buffer, aliasType: string, value: string): string {
  return createHmac("sha256", key)
    .update(`${aliasType}:${normalizeSearchValue(value)}`, "utf8")
    .digest("hex");
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `pnpm vitest run packages/payload-security`
Expected: PASS, 20 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/payload-security
git commit -m "feat(payload-security): add HMAC search tokens with normalization"
```

---

## Task 8: API key generation and verification

**Files:**
- Create: `packages/payload-security/src/api-key.ts`
- Test: `packages/payload-security/src/api-key.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { API_KEY_PREFIX_LENGTH, generateApiKey, verifyApiKey } from "./api-key.js";
import { deriveSubkeys } from "./keys.js";

const key = deriveSubkeys("0123456789abcdef0123456789abcdef").apiKey;

describe("generateApiKey", () => {
  it("returns a key, a prefix, and a verifier", () => {
    const generated = generateApiKey(key);
    expect(generated.apiKey.startsWith("fr_")).toBe(true);
    expect(generated.keyPrefix).toHaveLength(API_KEY_PREFIX_LENGTH);
    expect(generated.apiKey.startsWith(generated.keyPrefix)).toBe(true);
    expect(generated.verifier).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never repeats a key", () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey(key).apiKey));
    expect(keys.size).toBe(200);
  });

  it("does not store the key itself in the verifier", () => {
    const generated = generateApiKey(key);
    expect(generated.verifier).not.toContain(generated.apiKey.slice(3));
  });
});

describe("verifyApiKey", () => {
  it("accepts the correct key", () => {
    const generated = generateApiKey(key);
    expect(verifyApiKey(key, generated.apiKey, generated.verifier)).toBe(true);
  });

  it("rejects a different key", () => {
    const generated = generateApiKey(key);
    const other = generateApiKey(key);
    expect(verifyApiKey(key, other.apiKey, generated.verifier)).toBe(false);
  });

  it("rejects a key verified against a different pepper", () => {
    const generated = generateApiKey(key);
    const otherPepper = deriveSubkeys("fedcba9876543210fedcba9876543210").apiKey;
    expect(verifyApiKey(otherPepper, generated.apiKey, generated.verifier)).toBe(false);
  });

  it("rejects a malformed verifier without throwing", () => {
    const generated = generateApiKey(key);
    expect(verifyApiKey(key, generated.apiKey, "")).toBe(false);
    expect(verifyApiKey(key, generated.apiKey, "zzzz")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/payload-security`
Expected: FAIL, cannot resolve `./api-key.js`.

- [ ] **Step 3: Implement**

```typescript
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const KEY_BYTES = 24;
export const API_KEY_PREFIX_LENGTH = 12;

export interface GeneratedApiKey {
  /** Full key. Shown to the user once and never stored. */
  apiKey: string;
  /** Stored for lookup and safe display. */
  keyPrefix: string;
  /** Stored verifier. */
  verifier: string;
}

export function generateApiKey(pepper: Buffer): GeneratedApiKey {
  const apiKey = `fr_${randomBytes(KEY_BYTES).toString("base64url")}`;
  return {
    apiKey,
    keyPrefix: apiKey.slice(0, API_KEY_PREFIX_LENGTH),
    verifier: computeVerifier(pepper, apiKey)
  };
}

/**
 * Constant-time verification.
 *
 * HMAC rather than a slow password hash: we generate these keys with 24 bytes of
 * entropy, so there is no guessing attack for a slow hash to frustrate, and this
 * runs on the ingestion hot path. The pepper means a database-only leak yields
 * nothing an attacker can verify offline.
 */
export function verifyApiKey(pepper: Buffer, presented: string, verifier: string): boolean {
  const expected = Buffer.from(computeVerifier(pepper, presented), "hex");
  const actual = Buffer.from(verifier, "hex");
  // timingSafeEqual throws on length mismatch, so check length first — this
  // comparison is not secret-dependent.
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

function computeVerifier(pepper: Buffer, apiKey: string): string {
  return createHmac("sha256", pepper).update(apiKey, "utf8").digest("hex");
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `pnpm vitest run packages/payload-security`
Expected: PASS, 27 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/payload-security
git commit -m "feat(payload-security): add API key generation and constant-time verify"
```

---

## Task 9: Redaction

**Files:**
- Create: `packages/payload-security/src/redact.ts`
- Test: `packages/payload-security/src/redact.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { REDACTED, redact } from "./redact.js";

describe("redact", () => {
  it("redacts a literal path", () => {
    expect(redact({ customer: { ssn: "111-22-3333", name: "Jorge" } }, ["customer.ssn"])).toEqual({
      customer: { ssn: REDACTED, name: "Jorge" }
    });
  });

  it("redacts a single-level wildcard", () => {
    expect(redact({ a: { password: "x" }, b: { password: "y" } }, ["*.password"])).toEqual({
      a: { password: REDACTED },
      b: { password: REDACTED }
    });
  });

  it("redacts array elements", () => {
    expect(redact({ items: [{ cardNumber: "4111" }, { cardNumber: "5222" }] }, ["items[*].cardNumber"])).toEqual({
      items: [{ cardNumber: REDACTED }, { cardNumber: REDACTED }]
    });
  });

  it("matches header-like names case-insensitively", () => {
    expect(redact({ Authorization: "Bearer x" }, ["authorization"])).toEqual({
      Authorization: REDACTED
    });
  });

  it("preserves evidence that a value existed", () => {
    // SECURITY.md section 4: replace, never delete.
    const result = redact({ token: "secret" }, ["token"]) as Record<string, unknown>;
    expect("token" in result).toBe(true);
    expect(result["token"]).toBe(REDACTED);
  });

  it("leaves non-matching paths untouched", () => {
    expect(redact({ a: 1, b: "keep" }, ["c.d"])).toEqual({ a: 1, b: "keep" });
  });

  it("does not mutate its input", () => {
    const input = { customer: { ssn: "111-22-3333" } };
    redact(input, ["customer.ssn"]);
    expect(input.customer.ssn).toBe("111-22-3333");
  });

  it("redacts deeply nested secrets", () => {
    expect(redact({ a: { b: { c: { password: "x" } } } }, ["a.b.c.password"])).toEqual({
      a: { b: { c: { password: REDACTED } } }
    });
  });

  it("handles cyclic structures without hanging", () => {
    const input: Record<string, unknown> = { token: "secret" };
    input["self"] = input;
    const result = redact(input, ["token"]) as Record<string, unknown>;
    expect(result["token"]).toBe(REDACTED);
    expect(result["self"]).toBe("[CIRCULAR]");
  });

  it("passes primitives through", () => {
    expect(redact("plain", ["a"])).toBe("plain");
    expect(redact(null, ["a"])).toBe(null);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/payload-security`
Expected: FAIL, cannot resolve `./redact.js`.

- [ ] **Step 3: Implement**

```typescript
export const REDACTED = "[REDACTED]";
export const CIRCULAR = "[CIRCULAR]";

type Segment = { kind: "literal"; value: string } | { kind: "any" } | { kind: "arrayAny" };

/**
 * Redact configured paths from a structure.
 *
 * The supported grammar is intentionally small and exhaustive:
 *
 *   customer.ssn          literal segments
 *   *.password            one level of anything
 *   items[*].cardNumber   array elements
 *   authorization         matched case-insensitively
 *
 * Regular-expression paths and conditional rules are out of scope, so operators
 * are never left guessing what a rule will match.
 *
 * Matched values are replaced rather than deleted: SECURITY.md section 4 requires
 * preserving evidence that a value existed.
 */
export function redact(value: unknown, paths: readonly string[]): unknown {
  if (paths.length === 0) return value;
  const parsed = paths.map(parsePath);
  return walk(value, parsed, new WeakSet());
}

function parsePath(path: string): Segment[] {
  return path
    .split(".")
    .flatMap((raw): Segment[] => {
      const arrayMatch = /^(.*)\[\*\]$/.exec(raw);
      if (arrayMatch) {
        const name = arrayMatch[1] ?? "";
        return [toSegment(name), { kind: "arrayAny" }];
      }
      return [toSegment(raw)];
    });
}

function toSegment(raw: string): Segment {
  return raw === "*" ? { kind: "any" } : { kind: "literal", value: raw.toLowerCase() };
}

function walk(value: unknown, paths: Segment[][], seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;

  if (seen.has(value)) return CIRCULAR;
  seen.add(value);

  if (Array.isArray(value)) {
    const remaining = paths
      .filter((path) => path[0]?.kind === "arrayAny")
      .map((path) => path.slice(1));
    return value.map((item) =>
      remaining.length > 0 ? walkOrRedact(item, remaining, seen) : walk(item, [], seen)
    );
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const matching = paths
      .filter((path) => matches(path[0], key))
      .map((path) => path.slice(1));

    result[key] = matching.some((path) => path.length === 0)
      ? REDACTED
      : walkOrRedact(child, matching, seen);
  }
  return result;
}

function walkOrRedact(value: unknown, paths: Segment[][], seen: WeakSet<object>): unknown {
  return paths.some((path) => path.length === 0) ? REDACTED : walk(value, paths, seen);
}

function matches(segment: Segment | undefined, key: string): boolean {
  if (segment === undefined) return false;
  if (segment.kind === "any") return true;
  if (segment.kind === "arrayAny") return false;
  return segment.value === key.toLowerCase();
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `pnpm vitest run packages/payload-security`
Expected: PASS, 37 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/payload-security
git commit -m "feat(payload-security): add path-based redaction"
```

---

## Task 10: Input limits

**Files:**
- Create: `packages/payload-security/src/limits.ts`
- Modify: `packages/payload-security/src/index.ts`
- Test: `packages/payload-security/src/limits.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, checkLimits } from "./limits.js";

describe("checkLimits", () => {
  it("accepts a small payload", () => {
    expect(checkLimits({ a: 1 }, DEFAULT_LIMITS).ok).toBe(true);
  });

  it("rejects a payload over the byte limit", () => {
    const big = { blob: "x".repeat(1_000) };
    const result = checkLimits(big, { ...DEFAULT_LIMITS, maxBytes: 100 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("payload_too_large");
  });

  it("rejects excessive nesting", () => {
    let nested: unknown = "leaf";
    for (let i = 0; i < 40; i += 1) nested = { nested };
    const result = checkLimits(nested, { ...DEFAULT_LIMITS, maxDepth: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("max_depth_exceeded");
  });

  it("rejects too many keys", () => {
    const wide = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${String(i)}`, i]));
    const result = checkLimits(wide, { ...DEFAULT_LIMITS, maxKeys: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("max_keys_exceeded");
  });

  it("rejects an oversized string", () => {
    const result = checkLimits({ s: "x".repeat(200) }, { ...DEFAULT_LIMITS, maxStringLength: 50 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("max_string_length_exceeded");
  });

  it("does not hang on cyclic input", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => checkLimits(cyclic, DEFAULT_LIMITS)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/payload-security`
Expected: FAIL, cannot resolve `./limits.js`.

- [ ] **Step 3: Implement**

```typescript
export interface Limits {
  maxBytes: number;
  maxDepth: number;
  maxKeys: number;
  maxStringLength: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxBytes: 262_144,
  maxDepth: 32,
  maxKeys: 1_000,
  maxStringLength: 65_536
};

export type LimitViolation =
  | "payload_too_large"
  | "max_depth_exceeded"
  | "max_keys_exceeded"
  | "max_string_length_exceeded";

export type LimitResult = { ok: true } | { ok: false; reason: LimitViolation };

/**
 * Structural checks run before the byte check, because serializing a
 * pathologically nested or cyclic value to measure it is itself the attack.
 * SECURITY.md section 11 requires rejecting dangerous payloads before expensive
 * processing.
 */
export function checkLimits(value: unknown, limits: Limits): LimitResult {
  const structural = checkStructure(value, limits, 0, new WeakSet());
  if (!structural.ok) return structural;

  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return { ok: false, reason: "payload_too_large" };
  }
  return bytes > limits.maxBytes ? { ok: false, reason: "payload_too_large" } : { ok: true };
}

function checkStructure(
  value: unknown,
  limits: Limits,
  depth: number,
  seen: WeakSet<object>
): LimitResult {
  if (depth > limits.maxDepth) return { ok: false, reason: "max_depth_exceeded" };

  if (typeof value === "string") {
    return value.length > limits.maxStringLength
      ? { ok: false, reason: "max_string_length_exceeded" }
      : { ok: true };
  }

  if (value === null || typeof value !== "object") return { ok: true };

  // A cycle is not itself a violation here; it is cut so traversal terminates.
  // JSON.stringify below will reject it if it survives to serialization.
  if (seen.has(value)) return { ok: true };
  seen.add(value);

  const entries = Array.isArray(value) ? value : Object.values(value);
  if (!Array.isArray(value) && Object.keys(value).length > limits.maxKeys) {
    return { ok: false, reason: "max_keys_exceeded" };
  }
  if (Array.isArray(value) && value.length > limits.maxKeys) {
    return { ok: false, reason: "max_keys_exceeded" };
  }

  for (const child of entries) {
    const result = checkStructure(child, limits, depth + 1, seen);
    if (!result.ok) return result;
  }
  return { ok: true };
}
```

`packages/payload-security/src/index.ts`:

```typescript
export {
  API_KEY_PREFIX_LENGTH,
  generateApiKey,
  verifyApiKey,
  type GeneratedApiKey
} from "./api-key.js";
export { decryptField, encryptField } from "./encryption.js";
export { deriveSubkeys, type Subkeys } from "./keys.js";
export {
  DEFAULT_LIMITS,
  checkLimits,
  type LimitResult,
  type LimitViolation,
  type Limits
} from "./limits.js";
export { CIRCULAR, REDACTED, redact } from "./redact.js";
export { normalizeSearchValue, searchToken } from "./search-token.js";
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `pnpm vitest run packages/payload-security`
Expected: PASS, 43 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/payload-security
git commit -m "feat(payload-security): add input limit checks"
```

---

## Task 11: Migrations 002–004 — environments, api_keys, journeys

**Files:**
- Create: `packages/database/migrations/002_environments.js`, `003_api_keys.js`, `004_journeys.js`

- [ ] **Step 1: Write the environments migration**

```javascript
/**
 * Capture-mode values use the hyphenated protocol form (ADR-018): the wire
 * contract is authoritative over the database schema.
 *
 * The UNIQUE (id, project_id) is not redundant with the primary key. It is the
 * target of the composite foreign key in 003_api_keys, which is what makes an
 * API key pointing at another project's environment structurally impossible.
 *
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function up(knex) {
  await knex.schema.createTable("environments", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("project_id").notNullable().references("id").inTable("projects").onDelete("CASCADE");
    table.text("name").notNullable();
    table.integer("retention_days").notNullable().defaultTo(7);
    table.text("capture_mode").notNullable().defaultTo("redacted-payload");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.unique(["project_id", "name"]);
    table.unique(["id", "project_id"], { indexName: "environments_id_project_id_unique" });
  });

  await knex.raw(`
    alter table environments
      add constraint environments_retention_days_positive check (retention_days > 0)
  `);

  await knex.raw(`
    alter table environments
      add constraint environments_capture_mode_valid check (
        capture_mode in ('metadata-only', 'allowlisted-fields', 'redacted-payload', 'full-payload')
      )
  `);
}

/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists("environments");
}
```

- [ ] **Step 2: Write the api_keys migration**

`packages/database/migrations/003_api_keys.js`:

```javascript
/**
 * The composite foreign key on (environment_id, project_id) is the point of this
 * table's design: it makes an API key whose environment belongs to a different
 * project unrepresentable, rather than relying on an application check that a
 * future query might forget.
 *
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function up(knex) {
  await knex.schema.createTable("api_keys", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("project_id").notNullable().references("id").inTable("projects").onDelete("CASCADE");
    table.uuid("environment_id").notNullable();
    table.text("name").notNullable();
    table.text("key_prefix").notNullable().unique();
    table.text("key_hash").notNullable();
    table.timestamp("last_used_at", { useTz: true }).nullable();
    table.timestamp("revoked_at", { useTz: true }).nullable();
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table
      .foreign(["environment_id", "project_id"])
      .references(["id", "project_id"])
      .inTable("environments")
      .onDelete("CASCADE");
  });
}

/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists("api_keys");
}
```

- [ ] **Step 3: Write the journeys migration**

`packages/database/migrations/004_journeys.js`:

```javascript
/**
 * Composite primary key (project_id, id) per ADR-020: it provides idempotency
 * without a redundant surrogate index, and makes an accidental cross-project
 * join structurally impossible.
 *
 * The primary entity identifier is stored twice by design — as an HMAC for
 * search, and encrypted for display — because SECURITY.md section 6 forbids
 * storing plaintext searchable low-entropy identifiers.
 *
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function up(knex) {
  await knex.schema.createTable("journeys", (table) => {
    table.text("id").notNullable();
    table.uuid("project_id").notNullable().references("id").inTable("projects").onDelete("CASCADE");
    table.uuid("environment_id").notNullable();
    table.text("entity_type").notNullable();
    table.text("primary_entity_id_hash").notNullable();
    table.text("encrypted_primary_entity_id").nullable();
    table.text("status").notNullable().defaultTo("active");
    table.timestamp("started_at", { useTz: true }).notNullable();
    table.timestamp("completed_at", { useTz: true }).nullable();
    table.timestamp("last_event_at", { useTz: true }).notNullable();
    table.integer("event_count").notNullable().defaultTo(0);
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.primary(["project_id", "id"]);
    table
      .foreign(["environment_id", "project_id"])
      .references(["id", "project_id"])
      .inTable("environments")
      .onDelete("CASCADE");

    table.index(["project_id", "environment_id", "last_event_at"], "journeys_recent_idx");
    table.index(["project_id", "entity_type", "primary_entity_id_hash"], "journeys_entity_idx");
  });

  await knex.raw(`
    alter table journeys
      add constraint journeys_event_count_nonnegative check (event_count >= 0)
  `);

  await knex.raw(`
    alter table journeys
      add constraint journeys_status_valid check (status in ('active', 'completed', 'failed'))
  `);
}

/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists("journeys");
}
```

- [ ] **Step 4: Apply them**

```bash
docker compose -f infrastructure/compose.yaml up -d postgres
DATABASE_URL=postgresql://flight:flight@localhost:5432/flight pnpm db:migrate
```

Expected: batch applies `002_environments.js`, `003_api_keys.js`, `004_journeys.js`.

- [ ] **Step 5: Commit**

```bash
git add packages/database/migrations
git commit -m "feat(database): add environments, api_keys, and journeys tables"
```

---

## Task 12: Migrations 005–006 — entity_aliases and journey_events

**Files:**
- Create: `packages/database/migrations/005_entity_aliases.js`, `006_journey_events.js`

- [ ] **Step 1: Write the entity_aliases migration**

```javascript
/**
 * An alias value may legitimately map to more than one journey over time — the
 * same customer appears in many workflows — so there is no global uniqueness on
 * the value. Uniqueness is per journey and alias type only.
 *
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function up(knex) {
  await knex.schema.createTable("entity_aliases", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("project_id").notNullable();
    table.text("journey_id").notNullable();
    table.text("alias_type").notNullable();
    table.text("alias_value_hash").notNullable();
    table.text("encrypted_display_value").nullable();
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table
      .foreign(["project_id", "journey_id"])
      .references(["project_id", "id"])
      .inTable("journeys")
      .onDelete("CASCADE");

    table.unique(["project_id", "journey_id", "alias_type", "alias_value_hash"]);
    table.index(["project_id", "alias_type", "alias_value_hash"], "entity_aliases_typed_idx");
    table.index(["project_id", "alias_value_hash"], "entity_aliases_value_idx");
  });
}

/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists("entity_aliases");
}
```

- [ ] **Step 2: Write the journey_events migration**

`packages/database/migrations/006_journey_events.js`:

```javascript
/**
 * Event rows are immutable after insert. The composite primary key
 * (project_id, id) provides ingestion idempotency (ADR-020), and content_hash
 * lets ingestion tell an identical resubmission from a genuine ID collision
 * (ADR-021).
 *
 * Technical-identifier indexes are partial: these columns are null on most
 * events, and a full index would be mostly empty pages.
 *
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function up(knex) {
  await knex.schema.createTable("journey_events", (table) => {
    table.text("id").notNullable();
    table.uuid("project_id").notNullable();
    table.uuid("environment_id").notNullable();
    table.text("journey_id").notNullable();
    table.text("parent_event_id").nullable();
    table.text("protocol_version").notNullable();
    table.text("content_hash").notNullable();
    table.text("operation").notNullable();
    table.text("name").notNullable();
    table.text("service").notNullable();
    table.timestamp("event_timestamp", { useTz: true }).notNullable();
    table.timestamp("received_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.integer("duration_ms").nullable();
    table.text("trace_id").nullable();
    table.text("span_id").nullable();
    table.text("message_id").nullable();
    table.text("correlation_id").nullable();
    table.jsonb("input_payload").nullable();
    table.jsonb("output_payload").nullable();
    table.jsonb("payload_diff").nullable();
    table.jsonb("error").nullable();
    table.jsonb("runtime_metadata").nullable();
    table.jsonb("deployment_metadata").nullable();
    table.jsonb("custom_metadata").nullable();
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.primary(["project_id", "id"]);
    table
      .foreign(["project_id", "journey_id"])
      .references(["project_id", "id"])
      .inTable("journeys")
      .onDelete("CASCADE");

    table.index(
      ["project_id", "journey_id", "event_timestamp", "received_at", "id"],
      "journey_events_timeline_idx"
    );
  });

  await knex.raw(`
    alter table journey_events
      add constraint journey_events_duration_nonnegative check (duration_ms is null or duration_ms >= 0)
  `);

  await knex.raw(`
    create index journey_events_trace_idx on journey_events (project_id, trace_id)
      where trace_id is not null
  `);
  await knex.raw(`
    create index journey_events_message_idx on journey_events (project_id, message_id)
      where message_id is not null
  `);
  await knex.raw(`
    create index journey_events_correlation_idx on journey_events (project_id, correlation_id)
      where correlation_id is not null
  `);
}

/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists("journey_events");
}
```

- [ ] **Step 3: Apply and commit**

```bash
DATABASE_URL=postgresql://flight:flight@localhost:5432/flight pnpm db:migrate
git add packages/database/migrations
git commit -m "feat(database): add entity_aliases and journey_events tables"
```

---

## Task 13: Migrations 007–009 — replay and audit tables

**Files:**
- Create: `packages/database/migrations/007_replay_destinations.js`, `008_replay_runs.js`, `009_audit_events.js`

- [ ] **Step 1: Write the replay_destinations migration**

```javascript
/**
 * base_url is an origin with an optional base path (ADR-019). The relative path
 * supplied on a replay request is appended to it, so SSRF validation always runs
 * against a fixed origin approved at creation time.
 *
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function up(knex) {
  await knex.schema.createTable("replay_destinations", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("project_id").notNullable().references("id").inTable("projects").onDelete("CASCADE");
    table.text("name").notNullable();
    table.text("base_url").notNullable();
    table.text("environment_type").notNullable();
    table.text("encrypted_headers").nullable();
    table.boolean("enabled").notNullable().defaultTo(true);
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.unique(["project_id", "name"]);
  });

  // V0 replay is development-only (ADR-008). Enforced here so no future code path
  // can create a production destination.
  await knex.raw(`
    alter table replay_destinations
      add constraint replay_destinations_environment_type_valid check (
        environment_type in ('local', 'development', 'test')
      )
  `);
}

/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists("replay_destinations");
}
```

- [ ] **Step 2: Write the replay_runs migration**

`packages/database/migrations/008_replay_runs.js`:

```javascript
/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function up(knex) {
  await knex.schema.createTable("replay_runs", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("project_id").notNullable().references("id").inTable("projects").onDelete("CASCADE");
    table.text("journey_event_id").notNullable();
    table.uuid("destination_id").notNullable().references("id").inTable("replay_destinations");
    table.text("method").notNullable();
    table.text("request_path").notNullable();
    table.jsonb("request_payload").nullable();
    table.jsonb("request_headers").nullable();
    table.integer("response_status").nullable();
    table.jsonb("response_payload").nullable();
    table.integer("duration_ms").nullable();
    table.text("status").notNullable();
    table.jsonb("error").nullable();
    table.text("initiated_by").notNullable();
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("completed_at", { useTz: true }).nullable();

    table
      .foreign(["project_id", "journey_event_id"])
      .references(["project_id", "id"])
      .inTable("journey_events")
      .onDelete("CASCADE");

    table.index(["project_id", "created_at"], "replay_runs_recent_idx");
  });

  await knex.raw(`
    alter table replay_runs
      add constraint replay_runs_status_valid check (
        status in ('queued', 'running', 'completed', 'failed', 'blocked')
      )
  `);
}

/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists("replay_runs");
}
```

- [ ] **Step 3: Write the audit_events migration**

`packages/database/migrations/009_audit_events.js`:

```javascript
/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function up(knex) {
  await knex.schema.createTable("audit_events", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("project_id").notNullable().references("id").inTable("projects").onDelete("CASCADE");
    table.text("actor").notNullable();
    table.text("action").notNullable();
    table.text("resource_type").notNullable();
    table.text("resource_id").nullable();
    table.jsonb("metadata").nullable();
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(["project_id", "created_at"], "audit_events_recent_idx");
    table.index(["project_id", "action", "created_at"], "audit_events_action_idx");
  });
}

/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists("audit_events");
}
```

- [ ] **Step 4: Apply and commit**

```bash
DATABASE_URL=postgresql://flight:flight@localhost:5432/flight pnpm db:migrate
git add packages/database/migrations
git commit -m "feat(database): add replay destination, replay run, and audit tables"
```

---

## Task 14: Schema integration tests

**Files:**
- Test: `packages/database/src/schema.integration.test.ts`

- [ ] **Step 1: Write the tests**

```typescript
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKnexConfig } from "./knex-config.js";

describe("schema constraints", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let projectId: string;
  let otherProjectId: string;
  let environmentId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();

    [{ id: projectId }] = await db("projects")
      .insert({ name: "Primary", slug: "primary" })
      .returning("id");
    [{ id: otherProjectId }] = await db("projects")
      .insert({ name: "Other", slug: "other" })
      .returning("id");
    [{ id: environmentId }] = await db("environments")
      .insert({ project_id: projectId, name: "development" })
      .returning("id");
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  it("applies all migrations", async () => {
    for (const table of [
      "projects",
      "environments",
      "api_keys",
      "journeys",
      "entity_aliases",
      "journey_events",
      "replay_destinations",
      "replay_runs",
      "audit_events"
    ]) {
      expect(await db.schema.hasTable(table)).toBe(true);
    }
  });

  it("rejects an API key whose environment belongs to another project", async () => {
    // The point of the composite foreign key: this must fail in the database,
    // not in an application check a future query could forget.
    await expect(
      db("api_keys").insert({
        project_id: otherProjectId,
        environment_id: environmentId,
        name: "cross-project",
        key_prefix: "fr_crossproj",
        key_hash: "deadbeef"
      })
    ).rejects.toThrow();
  });

  it("accepts an API key within its own project", async () => {
    await expect(
      db("api_keys").insert({
        project_id: projectId,
        environment_id: environmentId,
        name: "valid",
        key_prefix: "fr_validkey1",
        key_hash: "deadbeef"
      })
    ).resolves.toBeDefined();
  });

  it("rejects an invalid capture mode", async () => {
    await expect(
      db("environments").insert({
        project_id: projectId,
        name: "bad-capture",
        capture_mode: "everything"
      })
    ).rejects.toThrow();
  });

  it("rejects a non-positive retention period", async () => {
    await expect(
      db("environments").insert({ project_id: projectId, name: "bad-retention", retention_days: 0 })
    ).rejects.toThrow();
  });

  it("rejects a production replay destination", async () => {
    await expect(
      db("replay_destinations").insert({
        project_id: projectId,
        name: "prod",
        base_url: "https://api.example.com",
        environment_type: "production"
      })
    ).rejects.toThrow();
  });

  it("enforces event idempotency on (project_id, id)", async () => {
    await db("journeys").insert({
      id: "jrn_dup",
      project_id: projectId,
      environment_id: environmentId,
      entity_type: "customer",
      primary_entity_id_hash: "hash",
      started_at: new Date(),
      last_event_at: new Date()
    });

    const event = {
      id: "evt_dup",
      project_id: projectId,
      environment_id: environmentId,
      journey_id: "jrn_dup",
      protocol_version: "0.1",
      content_hash: "abc",
      operation: "received",
      name: "receive",
      service: "svc",
      event_timestamp: new Date()
    };

    await db("journey_events").insert(event);
    await expect(db("journey_events").insert(event)).rejects.toThrow();
  });

  it("allows the same event id in a different project", async () => {
    const [{ id: otherEnvId }] = await db("environments")
      .insert({ project_id: otherProjectId, name: "development" })
      .returning("id");
    await db("journeys").insert({
      id: "jrn_dup",
      project_id: otherProjectId,
      environment_id: otherEnvId,
      entity_type: "customer",
      primary_entity_id_hash: "hash",
      started_at: new Date(),
      last_event_at: new Date()
    });

    await expect(
      db("journey_events").insert({
        id: "evt_dup",
        project_id: otherProjectId,
        environment_id: otherEnvId,
        journey_id: "jrn_dup",
        protocol_version: "0.1",
        content_hash: "abc",
        operation: "received",
        name: "receive",
        service: "svc",
        event_timestamp: new Date()
      })
    ).resolves.toBeDefined();
  });

  it("rejects a negative event count", async () => {
    await expect(
      db("journeys")
        .where({ project_id: projectId, id: "jrn_dup" })
        .update({ event_count: -1 })
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run them**

Run: `pnpm test:integration`
Expected: PASS. The migration-status suite still passes; the new suite adds 9 tests.

Note: `migration-status.integration.test.ts` asserts an exact pending-migration count.
Update that number from 1 to 9 in the same change, since eight migrations were added.

- [ ] **Step 3: Commit**

```bash
git add packages/database
git commit -m "test(database): cover schema constraints and cross-project isolation"
```

---

## Task 15: Local seed

**Files:**
- Create: `packages/database/src/seed-local.ts`
- Modify: `packages/database/src/cli.ts`
- Test: `packages/database/src/seed-local.integration.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKnexConfig } from "./knex-config.js";
import { seedLocal } from "./seed-local.js";

const MASTER_KEY = "0123456789abcdef0123456789abcdef";

describe("seedLocal", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  it("creates a project, environment, and API key", async () => {
    const result = await seedLocal(db, MASTER_KEY);
    expect(result.apiKey.startsWith("fr_")).toBe(true);
    expect(await db("projects").count({ n: "*" }).first()).toEqual({ n: "1" });
    expect(await db("environments").count({ n: "*" }).first()).toEqual({ n: "1" });
    expect(await db("api_keys").count({ n: "*" }).first()).toEqual({ n: "1" });
  });

  it("is idempotent and does not duplicate rows", async () => {
    await seedLocal(db, MASTER_KEY);
    expect(await db("projects").count({ n: "*" }).first()).toEqual({ n: "1" });
    expect(await db("environments").count({ n: "*" }).first()).toEqual({ n: "1" });
  });

  it("stores only a verifier, never the key itself", async () => {
    const result = await seedLocal(db, MASTER_KEY);
    const row = await db("api_keys").where({ key_prefix: result.keyPrefix }).first();
    expect(row.key_hash).not.toContain(result.apiKey);
    expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm test:integration`
Expected: FAIL, cannot resolve `./seed-local.js`.

- [ ] **Step 3: Implement**

```typescript
import { deriveSubkeys, generateApiKey } from "@flight-recorder/payload-security";
import type { Knex } from "knex";

export interface SeedResult {
  projectId: string;
  environmentId: string;
  apiKey: string;
  keyPrefix: string;
}

const PROJECT_SLUG = "local";
const ENVIRONMENT_NAME = "development";

/**
 * Create the local development project, environment, and API key.
 *
 * Idempotent for the project and environment so re-running after a schema change
 * is safe. A fresh API key is issued on every run: the full key is displayed once
 * and never stored, so there is no way to reprint an existing one.
 */
export async function seedLocal(db: Knex, masterKey: string): Promise<SeedResult> {
  const subkeys = deriveSubkeys(masterKey);

  const project = await upsertReturning(
    db,
    "projects",
    { slug: PROJECT_SLUG },
    { name: "Local", slug: PROJECT_SLUG }
  );

  const environment = await upsertReturning(
    db,
    "environments",
    { project_id: project.id, name: ENVIRONMENT_NAME },
    { project_id: project.id, name: ENVIRONMENT_NAME, retention_days: 7, capture_mode: "redacted-payload" }
  );

  const generated = generateApiKey(subkeys.apiKey);
  await db("api_keys").insert({
    project_id: project.id,
    environment_id: environment.id,
    name: "local-development",
    key_prefix: generated.keyPrefix,
    key_hash: generated.verifier
  });

  return {
    projectId: project.id,
    environmentId: environment.id,
    apiKey: generated.apiKey,
    keyPrefix: generated.keyPrefix
  };
}

async function upsertReturning(
  db: Knex,
  table: string,
  match: Record<string, unknown>,
  insert: Record<string, unknown>
): Promise<{ id: string }> {
  const existing = (await db(table).where(match).first()) as { id: string } | undefined;
  if (existing !== undefined) return existing;
  const [row] = (await db(table).insert(insert).returning("id")) as { id: string }[];
  if (row === undefined) throw new Error(`Failed to insert into ${table}.`);
  return row;
}
```

Add `@flight-recorder/payload-security` to `packages/database/package.json` dependencies
as `"workspace:*"`.

- [ ] **Step 4: Wire the seed into the CLI**

In `packages/database/src/cli.ts`, replace the `seed` case body with:

```typescript
    case "seed": {
      const masterKey = process.env["ENCRYPTION_KEY"];
      if (masterKey === undefined || masterKey === "") {
        console.error("ENCRYPTION_KEY is not set.");
        process.exitCode = 1;
        break;
      }
      const { seedLocal } = await import("./seed-local.js");
      const result = await seedLocal(db, masterKey);
      console.log("Local seed applied.");
      console.log(`  project:     ${result.projectId}`);
      console.log(`  environment: ${result.environmentId}`);
      console.log("");
      console.log("  API key (shown once, not recoverable):");
      console.log(`    ${result.apiKey}`);
      break;
    }
```

- [ ] **Step 5: Run the tests and the CLI**

```bash
pnpm test:integration
DATABASE_URL=postgresql://flight:flight@localhost:5432/flight \
  ENCRYPTION_KEY=0123456789abcdef0123456789abcdef pnpm db:seed
```

Expected: tests pass; the CLI prints a project id, an environment id, and one `fr_` key.

- [ ] **Step 6: Commit**

```bash
git add packages/database
git commit -m "feat(database): add idempotent local seed printing a one-time API key"
```

---

## Task 16: Verify Phase 1a

**Files:** none — verification only.

- [ ] **Step 1: Full pipeline on a clean clone**

```bash
CLEAN=$(mktemp -d)/fr && git clone -q . "$CLEAN" && cd "$CLEAN"
pnpm install --frozen-lockfile
for s in format:check lint typecheck test build; do
  pnpm "$s" >/dev/null 2>&1 && echo "$s OK" || echo "$s FAIL"
done
pnpm test:integration
```

Expected: all stages OK; integration suites pass.

A clean clone matters here specifically. Several Phase 0 defects passed in the working
tree and failed on a fresh checkout.

- [ ] **Step 2: Verify migrations round-trip**

```bash
docker compose -f infrastructure/compose.yaml down -v
docker compose -f infrastructure/compose.yaml up -d postgres
DATABASE_URL=postgresql://flight:flight@localhost:5432/flight pnpm db:migrate
DATABASE_URL=postgresql://flight:flight@localhost:5432/flight pnpm db:rollback
DATABASE_URL=postgresql://flight:flight@localhost:5432/flight pnpm db:migrate
```

Expected: apply, roll back, and re-apply without error.

- [ ] **Step 3: Confirm the CI pipeline passes**

```bash
git push origin main
glab ci list --per-page 1
```

Wait for the pipeline to finish and confirm all six jobs succeed. Local success is not
evidence: the first Phase 0 pipeline failed on a problem local runs structurally could
not see.

- [ ] **Step 4: Tag**

```bash
git tag -a phase-1a-complete -m "Phase 1a: protocol, schema, security primitives"
git push origin phase-1a-complete
```

---

## Definition of done

Every checkbox above is checked, Task 16 passes in full, and the CI pipeline is green.

**Not in this phase:** ingestion endpoints, journey and alias upsert, correlation rules,
batch handling, and `payload-diff` — all Phase 1b.
