# Phase 5: Demo Services Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A developer runs one Compose command and one trigger command, then sees a
ten-event journey across two services showing exactly where a phone number was lost.

**Architecture:** One workspace package, `apps/demo`, with five entry points — `source`,
`integration`, `worker`, `target`, and a one-shot `bootstrap`. Compose runs the same image
five times with different commands. ElasticMQ provides a real queue with a real redrive
policy, so the retries and the dead-letter transition are genuine rather than simulated.

**Tech Stack:** Fastify 5, `@aws-sdk/client-sqs`, knex/pg, ElasticMQ, Vitest 4.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/payload-security/src/api-key.ts` | gains `apiKeyRecord` — the stored form of a caller-supplied key |
| `packages/database/src/seed-demo.ts` | registers the demo project, environment, and fixed key |
| `packages/database/src/cli.ts` | gains the `seed-demo` command |
| `apps/demo/src/env.ts` | environment reading |
| `apps/demo/src/account.ts` | the Salesforce fixture and its type |
| `apps/demo/src/transform.ts` | the transformation, defect included |
| `apps/demo/src/customers.ts` | the demo customer table |
| `apps/demo/src/queue.ts` | SQS client and queue URLs |
| `apps/demo/src/recorder.ts` | recorder construction shared by the instrumented services |
| `apps/demo/src/bootstrap.ts` | one-shot: migrations, demo key, demo database |
| `apps/demo/src/source.ts` | port 3100 |
| `apps/demo/src/integration.ts` | port 3200 |
| `apps/demo/src/worker.ts` | queue consumer and dead-letter watcher |
| `apps/demo/src/target.ts` | port 3300 |
| `apps/demo/src/demo.e2e.test.ts` | the release gate |
| `infrastructure/elasticmq.conf` | queue definitions and the redrive policy |
| `infrastructure/compose.demo.yaml` | ElasticMQ plus five demo services |
| `scripts/demo-trigger.mjs` | `pnpm demo:trigger` |

---

### Task 1: A stored record for a key the caller already holds

**Files:**

- Modify: `packages/payload-security/src/api-key.ts`
- Modify: `packages/payload-security/src/index.ts`
- Test: `packages/payload-security/src/api-key.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/payload-security/src/api-key.test.ts`:

```typescript
describe("apiKeyRecord", () => {
  const pepper = Buffer.alloc(32, 7);

  it("produces a record that verifies the same key", () => {
    const record = apiKeyRecord(pepper, "fr_demo00000000000000000000000000000");
    expect(verifyApiKey(pepper, "fr_demo00000000000000000000000000000", record.verifier)).toBe(
      true
    );
  });

  it("rejects a different key", () => {
    const record = apiKeyRecord(pepper, "fr_demo00000000000000000000000000000");
    expect(verifyApiKey(pepper, "fr_other0000000000000000000000000000", record.verifier)).toBe(
      false
    );
  });

  it("takes the prefix from the key itself", () => {
    expect(apiKeyRecord(pepper, "fr_demo00000000000000000000000000000").keyPrefix).toBe(
      "fr_demo00000"
    );
  });
});
```

Add `apiKeyRecord` to the existing import from `./api-key.js` at the top of that file.

- [ ] **Step 2: Run it and watch it fail**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm vitest run packages/payload-security/src/api-key.test.ts
```

Expected: fails, `apiKeyRecord is not a function`.

- [ ] **Step 3: Implement**

In `packages/payload-security/src/api-key.ts`, add above `generateApiKey`:

```typescript
export interface StoredApiKey {
  /** Stored for lookup and safe display. */
  keyPrefix: string;
  /** Stored verifier. */
  verifier: string;
}

/**
 * The stored form of a key the caller already holds.
 *
 * `generateApiKey` is the entry point everywhere a key is issued to a person:
 * it supplies the entropy, which a caller-chosen key does not. This exists for
 * the demo, whose services need a key fixed in advance because there is nobody
 * to read one off a terminal.
 */
export function apiKeyRecord(pepper: Buffer, apiKey: string): StoredApiKey {
  return {
    keyPrefix: apiKey.slice(0, API_KEY_PREFIX_LENGTH),
    verifier: computeVerifier(pepper, apiKey)
  };
}
```

Then rewrite `generateApiKey` in terms of it:

```typescript
export function generateApiKey(pepper: Buffer): GeneratedApiKey {
  const apiKey = `fr_${randomBytes(KEY_BYTES).toString("base64url")}`;
  return { apiKey, ...apiKeyRecord(pepper, apiKey) };
}
```

Export `apiKeyRecord` and `StoredApiKey` from `packages/payload-security/src/index.ts`
alongside the existing api-key exports.

- [ ] **Step 4: Run the whole security suite**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm vitest run packages/payload-security
```

Expected: all pass.

- [ ] **Step 5: Lint, then commit**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm lint && pnpm format:check && pnpm typecheck
git add packages/payload-security
git commit -m "feat(payload-security): store a caller-supplied API key"
```

---

### Task 2: Seed the demo project with a fixed key

**Files:**

- Create: `packages/database/src/seed-demo.ts`
- Modify: `packages/database/src/cli.ts`
- Modify: `packages/database/src/index.ts`
- Test: `packages/database/src/seed-demo.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/database/src/seed-demo.integration.test.ts`. Copy the container setup
from `seed-local.integration.test.ts` — read that file first and mirror its
`beforeAll`/`afterAll` exactly, then use this body:

```typescript
describe("seedDemo", () => {
  const key = "fr_demo00000000000000000000000000000";

  it("registers a key that verifies", async () => {
    const result = await seedDemo(db, MASTER_KEY, key);
    const row = (await db("api_keys").where({ key_prefix: "fr_demo00000" }).first()) as {
      key_hash: string;
    };
    expect(verifyApiKey(deriveSubkeys(MASTER_KEY).apiKey, key, row.key_hash)).toBe(true);
    expect(result.projectId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("is idempotent", async () => {
    const first = await seedDemo(db, MASTER_KEY, key);
    const second = await seedDemo(db, MASTER_KEY, key);
    expect(second.projectId).toBe(first.projectId);
    expect(second.environmentId).toBe(first.environmentId);

    const count = (await db("api_keys").where({ key_prefix: "fr_demo00000" }).count(
      "* as n"
    )) as [{ n: string }];
    // A second `up` must not stack duplicate keys with the same prefix, which
    // would make lookup by prefix ambiguous.
    expect(Number(count[0].n)).toBe(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm vitest run --config vitest.integration.config.ts packages/database/src/seed-demo.integration.test.ts
```

Expected: fails to resolve `./seed-demo.js`.

- [ ] **Step 3: Implement**

Create `packages/database/src/seed-demo.ts`:

```typescript
import { apiKeyRecord, deriveSubkeys } from "@flight-recorder/payload-security";
import type { Knex } from "knex";
import { insertReturningId } from "./insert.js";

export interface DemoSeedResult {
  projectId: string;
  environmentId: string;
  keyPrefix: string;
}

const PROJECT_SLUG = "demo";
const ENVIRONMENT_NAME = "development";

/**
 * Create the demo project, environment, and its fixed API key.
 *
 * Fully idempotent, including the key: `docker compose up` runs this on every
 * start, and a second run must not leave two rows sharing a prefix, because
 * authentication looks a key up by prefix and would then find an arbitrary one.
 */
export async function seedDemo(
  db: Knex,
  masterKey: string,
  apiKey: string
): Promise<DemoSeedResult> {
  const subkeys = deriveSubkeys(masterKey);

  const project = await findOrInsert(
    db,
    "projects",
    { slug: PROJECT_SLUG },
    { name: "Demo", slug: PROJECT_SLUG }
  );

  const environment = await findOrInsert(
    db,
    "environments",
    { project_id: project.id, name: ENVIRONMENT_NAME },
    {
      project_id: project.id,
      name: ENVIRONMENT_NAME,
      retention_days: 7,
      capture_mode: "redacted-payload"
    }
  );

  const record = apiKeyRecord(subkeys.apiKey, apiKey);
  const existing = (await db("api_keys").where({ key_prefix: record.keyPrefix }).first()) as
    | { id: string }
    | undefined;

  if (existing === undefined) {
    await db("api_keys").insert({
      project_id: project.id,
      environment_id: environment.id,
      name: "demo",
      key_prefix: record.keyPrefix,
      key_hash: record.verifier
    });
  } else {
    // The encryption key may have been rotated between runs, which changes the
    // verifier for the same key string.
    await db("api_keys").where({ id: existing.id }).update({
      project_id: project.id,
      environment_id: environment.id,
      key_hash: record.verifier,
      revoked_at: null
    });
  }

  return {
    projectId: project.id,
    environmentId: environment.id,
    keyPrefix: record.keyPrefix
  };
}

async function findOrInsert(
  db: Knex,
  table: string,
  match: Record<string, unknown>,
  insert: Record<string, unknown>
): Promise<{ id: string }> {
  const existing = (await db(table).where(match).first()) as { id: string } | undefined;
  if (existing !== undefined) return existing;

  return { id: await insertReturningId(db, table, insert) };
}
```

Export it from `packages/database/src/index.ts`:

```typescript
export { seedDemo, type DemoSeedResult } from "./seed-demo.js";
```

Add the CLI command in `packages/database/src/cli.ts`, after the existing `seed` case:

```typescript
    case "seed-demo": {
      const masterKey = process.env["ENCRYPTION_KEY"];
      const apiKey = process.env["DEMO_API_KEY"];
      if (masterKey === undefined || masterKey === "") {
        console.error("ENCRYPTION_KEY is not set.");
        process.exitCode = 1;
        break;
      }
      if (apiKey === undefined || apiKey === "") {
        console.error("DEMO_API_KEY is not set.");
        process.exitCode = 1;
        break;
      }
      const { seedDemo } = await import("./seed-demo.js");
      const result = await seedDemo(db, masterKey, apiKey);
      console.log(`Demo seed applied for project ${result.projectId} (${result.keyPrefix}).`);
      break;
    }
```

Update the usage line in the `default` case to
`"Usage: tsx src/cli.ts <migrate|rollback|seed|seed-demo>"`.

- [ ] **Step 4: Run the test**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm vitest run --config vitest.integration.config.ts packages/database/src/seed-demo.integration.test.ts
```

Expected: both pass.

- [ ] **Step 5: Lint, then commit**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm lint && pnpm format:check && pnpm typecheck
git add packages/database
git commit -m "feat(database): seed the demo project with a fixed API key"
```

---

### Task 3: The `apps/demo` package skeleton

**Files:**

- Create: `apps/demo/package.json`, `apps/demo/tsconfig.json`, `apps/demo/tsconfig.build.json`
- Create: `apps/demo/src/env.ts`

- [ ] **Step 1: Write `apps/demo/package.json`**

```json
{
  "name": "@flight-recorder/demo",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@aws-sdk/client-sqs": "^3",
    "@flight-recorder/database": "workspace:*",
    "@flight-recorder/sdk-node": "workspace:*",
    "fastify": "^5",
    "knex": "^3",
    "pg": "^8"
  }
}
```

- [ ] **Step 2: Write the two tsconfigs**

`apps/demo/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"]
}
```

`apps/demo/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["src/**/*.test.ts", "src/**/*.integration.test.ts", "src/**/*.e2e.test.ts"]
}
```

- [ ] **Step 3: Write `apps/demo/src/env.ts`**

```typescript
export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set.`);
  }
  return value;
}

export function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}
```

- [ ] **Step 4: Install and verify the workspace resolves**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm install && pnpm --filter @flight-recorder/demo typecheck
```

Expected: install succeeds, typecheck passes with no output.

- [ ] **Step 5: Add the SDK alias to both Vitest configs**

In `vitest.config.ts` and `vitest.integration.config.ts`, add to the `alias` map after
the `payload-diff` entry (in `vitest.config.ts`) and after `database` (in
`vitest.integration.config.ts`):

```typescript
      "@flight-recorder/sdk-node": packageSource("sdk-node")
```

- [ ] **Step 6: Commit**

```bash
git add apps/demo pnpm-lock.yaml vitest.config.ts vitest.integration.config.ts
git commit -m "chore(demo): add the demo application package"
```

---

### Task 4: The account fixture and the defective transformation

**Files:**

- Create: `apps/demo/src/account.ts`, `apps/demo/src/transform.ts`
- Test: `apps/demo/src/transform.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/demo/src/transform.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { TEST_ACCOUNT } from "./account.js";
import { transformAccount } from "./transform.js";

describe("transformAccount", () => {
  it("carries the fields it maps correctly", () => {
    const customer = transformAccount(TEST_ACCOUNT);
    expect(customer.externalId).toBe("0018Z00002ABC");
    expect(customer.name).toBe("Jorge Polanco");
    expect(customer.status).toBe("active");
  });

  it("loses the phone number, which is the demo's defect", () => {
    // DEMO_SCENARIO.md section 4. The account carries `Phone`; the mapping reads
    // `Phone__c`. Fixing this breaks the demo and the Phase 6 replay comparison,
    // so this test exists to make that break loud.
    expect(TEST_ACCOUNT.Phone).toBe("+1 919 555 1234");
    expect(transformAccount(TEST_ACCOUNT).phone).toBeNull();
  });

  it("keeps the phone when the source really does use Phone__c", () => {
    // Proves the null above comes from the field name, not from the mapping
    // discarding phones outright.
    const withCustomField = { ...TEST_ACCOUNT, Phone__c: "+1 919 555 9999" };
    expect(transformAccount(withCustomField).phone).toBe("+1 919 555 9999");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm vitest run apps/demo/src/transform.test.ts
```

Expected: fails, cannot resolve `./account.js`.

- [ ] **Step 3: Implement both files**

`apps/demo/src/account.ts`:

```typescript
/**
 * The Salesforce account shape, as `DEMO_SCENARIO.md` section 3 defines it.
 *
 * `Phone__c` is optional and absent from the fixture on purpose: it is the field
 * the transformation mistakenly reads.
 */
export interface SalesforceAccount {
  Id: string;
  Name: string;
  Phone: string;
  Status__c: string;
  Phone__c?: string;
}

export const TEST_ACCOUNT: SalesforceAccount = {
  Id: "0018Z00002ABC",
  Name: "Jorge Polanco",
  Phone: "+1 919 555 1234",
  Status__c: "Active"
};
```

`apps/demo/src/transform.ts`:

```typescript
import type { SalesforceAccount } from "./account.js";

export interface Customer {
  externalId: string;
  name: string;
  phone: string | null;
  status: string;
}

/**
 * Map a Salesforce account onto the internal customer.
 *
 * **The `Phone__c` read is the demo's intentional defect** (`DEMO_SCENARIO.md`
 * section 4). The payload that arrives carries `Phone`, so the phone number
 * becomes null and the target rejects the customer. Do not correct it: the
 * demo, the end-to-end test, and the Phase 6 replay comparison all depend on
 * this being wrong.
 */
export function transformAccount(account: SalesforceAccount): Customer {
  return {
    externalId: account.Id,
    name: account.Name,
    phone: account.Phone__c ?? null,
    status: account.Status__c.toLowerCase()
  };
}
```

- [ ] **Step 4: Run the test**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm vitest run apps/demo/src/transform.test.ts
```

Expected: three tests pass.

- [ ] **Step 5: Commit**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm lint && pnpm format:check
git add apps/demo
git commit -m "feat(demo): the Salesforce account fixture and its defective transformation"
```

---

### Task 5: The customer table and the recorder factory

**Files:**

- Create: `apps/demo/src/customers.ts`, `apps/demo/src/recorder.ts`

- [ ] **Step 1: Write `apps/demo/src/customers.ts`**

```typescript
import knex, { type Knex } from "knex";
import { requiredEnv } from "./env.js";
import type { Customer } from "./transform.js";

export function demoDatabase(): Knex {
  return knex({ client: "pg", connection: requiredEnv("DEMO_DATABASE_URL") });
}

/**
 * Create the demo's own customer table.
 *
 * The sequence starts at 18492 so the first customer gets the internal ID that
 * `DEMO_SCENARIO.md` section 5 uses in its alias list and section 9 uses as a
 * search case. A demo whose identifiers match its own documentation is worth
 * one line of SQL.
 */
export async function ensureCustomerTable(db: Knex): Promise<void> {
  await db.raw(`
    create table if not exists customers (
      id bigint primary key generated by default as identity (start with 18492),
      external_id text not null unique,
      name text not null,
      phone text,
      status text not null,
      created_at timestamptz not null default now()
    )
  `);
}

/** Returns the internal customer ID. Upserts, so re-triggering the demo is safe. */
export async function upsertCustomer(db: Knex, customer: Customer): Promise<number> {
  const rows: unknown = await db("customers")
    .insert({
      external_id: customer.externalId,
      name: customer.name,
      phone: customer.phone,
      status: customer.status
    })
    .onConflict("external_id")
    .merge(["name", "phone", "status"])
    .returning("id");

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("Upserting the customer returned no rows.");
  }
  const id: unknown = (rows[0] as Record<string, unknown>)["id"];
  // pg returns bigint as a string to avoid precision loss.
  return Number(id);
}
```

- [ ] **Step 2: Write `apps/demo/src/recorder.ts`**

```typescript
import { createRecorder, type Recorder } from "@flight-recorder/sdk-node";
import { optionalEnv, requiredEnv } from "./env.js";

/**
 * The recorder every instrumented demo service uses.
 *
 * `batchSize: 1` is a demo setting, not a recommendation. Somebody is watching
 * the interface while the journey runs, and the default one-second batching
 * would make the timeline lag the terminal by longer than the journey takes.
 * Real services should keep the defaults.
 */
export function demoRecorder(serviceName: string): Recorder {
  return createRecorder({
    endpoint: optionalEnv("FLIGHT_ENDPOINT", "http://api:8080"),
    apiKey: requiredEnv("FLIGHT_API_KEY"),
    serviceName,
    environment: optionalEnv("FLIGHT_ENVIRONMENT", "development"),
    batchSize: 1,
    flushIntervalMs: 250,
    onDiagnostic: (diagnostic) => {
      console.warn(`[flight-recorder] ${diagnostic.kind}: ${diagnostic.message}`);
    }
  });
}
```

- [ ] **Step 3: Typecheck**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm --filter @flight-recorder/demo typecheck
```

Expected: passes. If `Diagnostic` has no `message` field, read
`packages/sdk-node/src/diagnostics.ts` and log the fields it actually has.

- [ ] **Step 4: Commit**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm lint && pnpm format:check
git add apps/demo
git commit -m "feat(demo): customer persistence and the shared recorder"
```

---

### Task 6: `demo-target`

**Files:**

- Create: `apps/demo/src/target.ts`

- [ ] **Step 1: Write it**

```typescript
import Fastify from "fastify";

/**
 * Stands in for HubSpot.
 *
 * Deliberately not instrumented: this is a system the team using Flight
 * Recorder does not own, and a timeline covering only your own services is the
 * honest picture.
 */
const app = Fastify({ logger: true });

app.get("/health", () => ({ status: "ok" }));

app.post("/contacts", (request, reply) => {
  const body = request.body as { externalId?: string; phone?: string | null };

  if (body.phone === null || body.phone === undefined || body.phone === "") {
    return reply.code(422).send({
      error: { code: "phone_required", message: "A phone number is required." }
    });
  }

  return reply.code(201).send({ id: `contact_${body.externalId ?? "unknown"}` });
});

await app.listen({ host: "0.0.0.0", port: 3300 });
```

- [ ] **Step 2: Typecheck and commit**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm --filter @flight-recorder/demo typecheck && pnpm lint && pnpm format:check
git add apps/demo
git commit -m "feat(demo): the target service that rejects a missing phone"
```

---

### Task 7: The queue helpers

**Files:**

- Create: `apps/demo/src/queue.ts`

- [ ] **Step 1: Write it**

```typescript
import { SQSClient } from "@aws-sdk/client-sqs";
import { optionalEnv, requiredEnv } from "./env.js";

/**
 * Queue URLs come from the environment rather than `GetQueueUrl`.
 *
 * ElasticMQ returns URLs built from its configured `node-address`, and having
 * one authority for the address — Compose — avoids a class of failure where the
 * broker hands back a hostname the caller cannot resolve.
 */
export function queueUrl(): string {
  return requiredEnv("QUEUE_URL");
}

export function deadLetterQueueUrl(): string {
  return requiredEnv("DLQ_URL");
}

export function sqsClient(): SQSClient {
  return new SQSClient({
    region: optionalEnv("AWS_REGION", "us-east-1"),
    endpoint: requiredEnv("QUEUE_ENDPOINT"),
    credentials: { accessKeyId: "local", secretAccessKey: "local" }
  });
}

export interface CustomerMessage {
  customer: { externalId: string; name: string; phone: string | null; status: string };
  internalCustomerId: number;
}
```

- [ ] **Step 2: Typecheck and commit**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm --filter @flight-recorder/demo typecheck && pnpm lint && pnpm format:check
git add apps/demo
git commit -m "feat(demo): SQS client and queue configuration"
```

---

### Task 8: `demo-integration`

**Files:**

- Create: `apps/demo/src/integration.ts`

- [ ] **Step 1: Write it**

```typescript
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import Fastify from "fastify";
import type { SalesforceAccount } from "./account.js";
import { demoDatabase, upsertCustomer } from "./customers.js";
import { queueUrl, sqsClient, type CustomerMessage } from "./queue.js";
import { demoRecorder } from "./recorder.js";
import { transformAccount } from "./transform.js";

const recorder = demoRecorder("demo-integration");
const db = demoDatabase();
const sqs = sqsClient();

const app = Fastify({ logger: true });

app.get("/health", () => ({ status: "ok" }));

app.post("/webhooks/salesforce", async (request, reply) => {
  const account = request.body as SalesforceAccount;

  const journey = recorder.startJourney({ entity: { type: "customer", id: account.Id } });
  journey.record({
    operation: "received",
    name: "receive-salesforce-webhook",
    input: account
  });

  const customer = await journey.transform("transform-salesforce-account", account, () =>
    transformAccount(account)
  );

  const internalCustomerId = await journey.persist("persist-customer", customer, () =>
    upsertCustomer(db, customer)
  );

  // After the insert, not before: the internal ID does not exist until the row
  // does, and DEMO_SCENARIO.md section 9 requires searching by it.
  journey.identify({
    salesforceAccountId: account.Id,
    internalCustomerId: String(internalCustomerId)
  });

  const message: CustomerMessage = { customer, internalCustomerId };

  await journey.publish("publish-customer-updated", message, async () => {
    const sent = await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl(),
        MessageBody: JSON.stringify(message),
        MessageAttributes: recorder.toQueueAttributes(journey.context())
      })
    );
    return { messageId: sent.MessageId };
  });

  return reply.code(202).send({ journeyId: journey.context().journeyId });
});

await app.listen({ host: "0.0.0.0", port: 3200 });
```

- [ ] **Step 2: Typecheck and commit**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm --filter @flight-recorder/demo typecheck && pnpm lint && pnpm format:check
git add apps/demo
git commit -m "feat(demo): the integration service"
```

---

### Task 9: `demo-worker`

**Files:**

- Create: `apps/demo/src/worker.ts`

- [ ] **Step 1: Write it**

```typescript
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type Message
} from "@aws-sdk/client-sqs";
import { optionalEnv } from "./env.js";
import {
  deadLetterQueueUrl,
  queueUrl,
  sqsClient,
  type CustomerMessage
} from "./queue.js";
import { demoRecorder } from "./recorder.js";

const recorder = demoRecorder("demo-worker");
const sqs = sqsClient();
const targetUrl = optionalEnv("TARGET_URL", "http://demo-target:3300");

/**
 * Attempt counts, keyed by message ID.
 *
 * `ApproximateReceiveCount` is the value a real worker should use, and it is
 * read first. ElasticMQ does not always return it, and the worker is a single
 * process that sees every redelivery, so an in-process tally is a sound
 * fallback here in a way it would not be in production.
 */
const attempts = new Map<string, number>();

interface DeliveryResult {
  status: number;
  body: unknown;
}

async function deliver(message: CustomerMessage): Promise<DeliveryResult> {
  const response = await fetch(`${targetUrl}/contacts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message.customer)
  });
  return { status: response.status, body: await response.json() };
}

function attemptFor(message: Message): number {
  const messageId = message.MessageId ?? "unknown";
  const reported = Number(message.Attributes?.["ApproximateReceiveCount"]);
  if (Number.isInteger(reported) && reported > 0) return reported;

  const next = (attempts.get(messageId) ?? 0) + 1;
  attempts.set(messageId, next);
  return next;
}

async function handleMain(message: Message): Promise<void> {
  const body = JSON.parse(message.Body ?? "{}") as CustomerMessage;
  const context = recorder.fromQueueAttributes(message.MessageAttributes);
  const journey = recorder.consume({
    context,
    // The default propagation level omits the entity ID (SECURITY.md section
    // 10), so the consumer supplies the one it already has from the body.
    entityFallback: { type: "customer", id: body.customer.externalId }
  });

  const attempt = attemptFor(message);

  if (attempt === 1) {
    journey.record({
      operation: "consumed",
      name: "consume-customer-updated",
      input: body,
      metadata: { messageId: message.MessageId }
    });
  }

  const result = await journey.deliver(
    attempt === 1 ? "deliver-customer-to-target" : "retry-customer-delivery",
    body.customer,
    () => deliver(body),
    {
      // A 422 is a failure the target reports rather than throws, which is
      // exactly what `isFailure` exists for.
      isFailure: (value) => (value as DeliveryResult).status >= 400,
      attempt,
      metadata: { targetStatus: undefined }
    }
  );

  if (result.status < 400) {
    // Only a success deletes. A failure leaves the message to be redelivered
    // after the visibility timeout, which is what drives the retries.
    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl(),
        ReceiptHandle: message.ReceiptHandle
      })
    );
    attempts.delete(message.MessageId ?? "unknown");
    journey.finish({ status: "completed" });
  }
}

async function handleDeadLetter(message: Message): Promise<void> {
  const body = JSON.parse(message.Body ?? "{}") as CustomerMessage;
  const context = recorder.fromQueueAttributes(message.MessageAttributes);
  const journey = recorder.consume({
    context,
    entityFallback: { type: "customer", id: body.customer.externalId }
  });

  journey.fail(
    "move-message-to-dead-letter",
    new Error("Delivery failed on every attempt; the message moved to the dead-letter queue."),
    { queue: "customer-updates-dlq", messageId: message.MessageId }
  );

  await sqs.send(
    new DeleteMessageCommand({
      QueueUrl: deadLetterQueueUrl(),
      ReceiptHandle: message.ReceiptHandle
    })
  );
}

async function poll(url: string, handle: (message: Message) => Promise<void>): Promise<void> {
  for (;;) {
    try {
      const response = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: url,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 2,
          MessageAttributeNames: ["All"],
          AttributeNames: ["ApproximateReceiveCount"]
        })
      );
      for (const message of response.Messages ?? []) {
        await handle(message);
      }
    } catch (error) {
      // The queue may not be up yet, or may be restarting. Keep polling.
      console.warn(`[demo-worker] poll failed: ${String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

console.log("[demo-worker] polling");
await Promise.all([poll(queueUrl(), handleMain), poll(deadLetterQueueUrl(), handleDeadLetter)]);
```

- [ ] **Step 2: Remove the placeholder metadata**

The `metadata: { targetStatus: undefined }` line above is a leftover — delete it. The
delivery event already carries the response body as its output, and an undefined value
adds nothing.

- [ ] **Step 3: Typecheck and commit**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm --filter @flight-recorder/demo typecheck && pnpm lint && pnpm format:check
git add apps/demo
git commit -m "feat(demo): the worker, its retries, and the dead-letter watcher"
```

---

### Task 10: `demo-source` and the trigger command

**Files:**

- Create: `apps/demo/src/source.ts`, `scripts/demo-trigger.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write `apps/demo/src/source.ts`**

```typescript
import Fastify from "fastify";
import { TEST_ACCOUNT } from "./account.js";
import { optionalEnv } from "./env.js";

/**
 * Stands in for Salesforce. Not instrumented, for the same reason
 * `demo-target` is not: it is not a service the team owns.
 */
const app = Fastify({ logger: true });
const integrationUrl = optionalEnv("INTEGRATION_URL", "http://demo-integration:3200");

app.get("/health", () => ({ status: "ok" }));

app.post("/trigger", async (_request, reply) => {
  const response = await fetch(`${integrationUrl}/webhooks/salesforce`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(TEST_ACCOUNT)
  });

  const body: unknown = await response.json();
  return reply.code(response.status).send(body);
});

await app.listen({ host: "0.0.0.0", port: 3100 });
```

- [ ] **Step 2: Write `scripts/demo-trigger.mjs`**

```javascript
const SOURCE_URL = process.env.DEMO_SOURCE_URL ?? "http://localhost:3100";
const WEB_URL = process.env.DEMO_WEB_URL ?? "http://localhost:3000";

const response = await fetch(`${SOURCE_URL}/trigger`, { method: "POST" });

if (!response.ok) {
  console.error(`The demo source responded ${response.status}.`);
  console.error("Is the demo stack running? See docs/LOCAL_DEVELOPMENT.md.");
  process.exit(1);
}

const { journeyId } = await response.json();

console.log("Journey started.\n");
console.log(`  ${WEB_URL}/journeys/${journeyId}`);
console.log("\nOr sign in and search:\n");
console.log("  0018Z00002ABC\n");
console.log("The journey takes about ten seconds to reach its dead-letter state.");
```

- [ ] **Step 3: Add the script**

In the root `package.json` scripts, after `test:e2e`:

```json
    "test:demo": "vitest run --config vitest.demo.config.ts",
    "demo:trigger": "node scripts/demo-trigger.mjs"
```

- [ ] **Step 4: Commit**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm --filter @flight-recorder/demo typecheck && pnpm lint && pnpm format:check
git add apps/demo scripts package.json
git commit -m "feat(demo): the source service and the trigger command"
```

---

### Task 11: The bootstrap entry point

**Files:**

- Create: `apps/demo/src/bootstrap.ts`

- [ ] **Step 1: Write it**

```typescript
import { createKnexConfig, seedDemo } from "@flight-recorder/database";
import knex from "knex";
import { demoDatabase, ensureCustomerTable } from "./customers.js";
import { requiredEnv } from "./env.js";

/**
 * Everything the demo needs before any service starts, in one place.
 *
 * Compose runs this once and waits for it to exit, so the services that follow
 * can assume a migrated schema, a registered API key, and a customer table.
 * Every step is idempotent: `up` runs it again on every start.
 */
const flight = knex(createKnexConfig(requiredEnv("DATABASE_URL")));

try {
  const [, applied] = (await flight.migrate.latest()) as [number, string[]];
  console.log(
    applied.length === 0
      ? "[bootstrap] schema already up to date"
      : `[bootstrap] applied ${String(applied.length)} migrations`
  );

  const seeded = await seedDemo(
    flight,
    requiredEnv("ENCRYPTION_KEY"),
    requiredEnv("FLIGHT_API_KEY")
  );
  console.log(`[bootstrap] demo project ${seeded.projectId} ready`);

  await createDemoDatabase(flight);
} finally {
  await flight.destroy();
}

const demo = demoDatabase();
try {
  await ensureCustomerTable(demo);
  console.log("[bootstrap] customer table ready");
} finally {
  await demo.destroy();
}

/**
 * `CREATE DATABASE` cannot run inside a transaction and has no `IF NOT EXISTS`
 * in the version of PostgreSQL this targets, so existence is checked first.
 */
async function createDemoDatabase(db: typeof flight): Promise<void> {
  const name = requiredEnv("DEMO_DATABASE_NAME");
  const existing: unknown = await db.raw("select 1 from pg_database where datname = ?", [name]);
  const rows = (existing as { rows?: unknown[] }).rows ?? [];
  if (rows.length > 0) {
    console.log(`[bootstrap] database ${name} already exists`);
    return;
  }
  // The name comes from Compose, not from a request. Identifiers cannot be
  // parameterised, so it is quoted rather than bound.
  await db.raw(`create database "${name.replace(/"/g, '""')}"`);
  console.log(`[bootstrap] created database ${name}`);
}
```

- [ ] **Step 2: Move the function above its use**

Top-level `await` runs before a function declaration is needed only if hoisting applies —
it does for `function` declarations, so the order above works. Verify with a typecheck;
if `no-use-before-define` fires in ESLint, move `createDemoDatabase` above the top-level
statements.

- [ ] **Step 3: Typecheck and commit**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm --filter @flight-recorder/demo typecheck && pnpm lint && pnpm format:check
git add apps/demo
git commit -m "feat(demo): one-shot bootstrap for schema, key, and demo database"
```

---

### Task 12: The image, the queue configuration, and Compose

**Files:**

- Create: `apps/demo/Dockerfile`, `infrastructure/elasticmq.conf`
- Modify: `infrastructure/compose.demo.yaml`

- [ ] **Step 1: Write `apps/demo/Dockerfile`**

```dockerfile
# Build context is the repository root: this is a pnpm workspace and the demo
# depends on packages/database and packages/sdk-node by workspace protocol.
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @flight-recorder/demo... build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
# No CMD: Compose runs this image five times with five different commands.
```

- [ ] **Step 2: Write `infrastructure/elasticmq.conf`**

```hocon
include classpath("application.conf")

node-address {
  protocol = http
  host = elasticmq
  port = 9324
  context-path = ""
}

rest-sqs {
  enabled = true
  bind-port = 9324
  bind-hostname = "0.0.0.0"
  sqs-limits = strict
}

queues {
  customer-updates {
    # Seconds, not the minutes a production queue would use. DEMO_SCENARIO.md
    # section 6 shows 30- and 60-second gaps, which are realistic and useless
    # for a demo somebody is watching: the whole journey should finish in about
    # ten seconds.
    defaultVisibilityTimeout = 3 seconds
    deadLettersQueue {
      name = "customer-updates-dlq"
      # One delivery and two retries, matching section 6's timeline.
      maxReceiveCount = 3
    }
  }

  customer-updates-dlq { }
}
```

- [ ] **Step 3: Rewrite `infrastructure/compose.demo.yaml`**

```yaml
# Demo profile. Adds the SQS-compatible queue and the demo services that prove
# the reference journey. Layer it over the core stack:
#
#   docker compose -f infrastructure/compose.yaml \
#                  -f infrastructure/compose.demo.yaml up --build
#
# Then: pnpm demo:trigger
#
# ADR-015 keeps this separate from compose.yaml so PostgreSQL remains the core
# stack's only backing service.

name: flight-recorder

x-demo: &demo
  image: flight-recorder-demo:local
  build:
    context: ..
    dockerfile: apps/demo/Dockerfile
  environment: &demo-env
    FLIGHT_ENDPOINT: http://api:8080
    # A placeholder, and safe to commit: it authorises writing demo events to a
    # local stack and nothing else. A real deployment issues keys with
    # `pnpm db:seed`.
    FLIGHT_API_KEY: ${DEMO_API_KEY:-fr_demo00000000000000000000000000000}
    FLIGHT_ENVIRONMENT: development
    QUEUE_ENDPOINT: http://elasticmq:9324
    QUEUE_URL: http://elasticmq:9324/000000000000/customer-updates
    DLQ_URL: http://elasticmq:9324/000000000000/customer-updates-dlq
    AWS_REGION: us-east-1
    DEMO_DATABASE_URL: postgresql://flight:flight@postgres:5432/demo
    TARGET_URL: http://demo-target:3300
    INTEGRATION_URL: http://demo-integration:3200

services:
  elasticmq:
    image: softwaremill/elasticmq-native:latest
    volumes:
      - ./elasticmq.conf:/opt/elasticmq.conf:ro
    ports:
      - "127.0.0.1:9324:9324"

  demo-bootstrap:
    <<: *demo
    environment:
      <<: *demo-env
      DATABASE_URL: postgresql://flight:flight@postgres:5432/flight
      DEMO_DATABASE_NAME: demo
      ENCRYPTION_KEY: ${ENCRYPTION_KEY:-replace-for-local-development-0000}
    command: ["node", "apps/demo/dist/bootstrap.js"]
    restart: "no"
    depends_on:
      postgres:
        condition: service_healthy

  demo-target:
    <<: *demo
    command: ["node", "apps/demo/dist/target.js"]
    ports:
      - "127.0.0.1:3300:3300"

  demo-integration:
    <<: *demo
    command: ["node", "apps/demo/dist/integration.js"]
    ports:
      - "127.0.0.1:3200:3200"
    depends_on:
      demo-bootstrap:
        condition: service_completed_successfully
      api:
        condition: service_started
      elasticmq:
        condition: service_started

  demo-worker:
    <<: *demo
    command: ["node", "apps/demo/dist/worker.js"]
    depends_on:
      demo-bootstrap:
        condition: service_completed_successfully
      api:
        condition: service_started
      elasticmq:
        condition: service_started
      demo-target:
        condition: service_started

  demo-source:
    <<: *demo
    command: ["node", "apps/demo/dist/source.js"]
    ports:
      - "127.0.0.1:3100:3100"
    depends_on:
      demo-integration:
        condition: service_started
```

- [ ] **Step 4: Validate the Compose files parse**

```bash
docker compose -f infrastructure/compose.yaml -f infrastructure/compose.demo.yaml config >/dev/null && echo OK
```

Expected: `OK`. If the merge keys are rejected, replace each `<<: *demo` with the literal
fields; correctness beats brevity here.

- [ ] **Step 5: Commit**

```bash
git add apps/demo/Dockerfile infrastructure
git commit -m "feat(demo): image, queue configuration, and Compose profile"
```

---

### Task 13: Run it and fix what running reveals

This task has no fixed code, because its purpose is to find the gap between the plan and
reality. Every prior phase found one.

- [ ] **Step 1: Bring the stack up**

```bash
docker compose -f infrastructure/compose.yaml -f infrastructure/compose.demo.yaml up --build -d
```

- [ ] **Step 2: Wait for the bootstrap to complete**

```bash
docker compose -f infrastructure/compose.yaml -f infrastructure/compose.demo.yaml logs demo-bootstrap
```

Expected: `customer table ready` and exit code 0.

- [ ] **Step 3: Trigger**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm demo:trigger
```

Expected: a journey URL.

- [ ] **Step 4: Verify the queue actually redrove the message, and that attributes survived**

```bash
docker compose -f infrastructure/compose.yaml -f infrastructure/compose.demo.yaml logs demo-worker
```

**This is the check the spec promised.** Confirm the dead-letter event carries the same
journey ID as the delivery events. If ElasticMQ dropped the message attributes across
redrive, the DLQ handler will have started a fresh journey — visible as a second journey
with one event. In that case:

1. Change the worker to record `move-message-to-dead-letter` from the main queue on the
   final attempt (`attempt >= 3`), and delete the message so it is not redriven.
2. Update section 4 of `docs/superpowers/specs/2026-08-07-phase-5-demo-design.md` to say
   ElasticMQ does not preserve attributes across redrive and what was done instead.

- [ ] **Step 5: Read the journey through the API**

```bash
curl -s -H "authorization: Bearer local-admin-token-000000000000000" \
  "http://localhost:8080/v1/search?q=0018Z00002ABC" | head -40
```

Expected: one hit, `status` of `failed`, `eventCount` of 10.

- [ ] **Step 6: Read it in the interface**

Open `http://localhost:3000`, sign in, search `0018Z00002ABC`, open the journey, and open
the `transform-salesforce-account` event. The diff must show `Phone` leaving with a value
and `phone` arriving null.

- [ ] **Step 7: Commit whatever the run required**

```bash
git add -A
git commit -m "fix(demo): corrections found running the stack"
```

---

### Task 14: The end-to-end test

**Files:**

- Create: `vitest.demo.config.ts`, `apps/demo/src/demo.e2e.test.ts`

- [ ] **Step 1: Write `vitest.demo.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

/**
 * The demo suite needs the full Compose stack, not a process, so it has its own
 * configuration rather than joining the unit or integration runs. `pnpm test`
 * and `pnpm test:integration` must stay runnable on a laptop with nothing up.
 */
export default defineConfig({
  test: {
    include: ["apps/demo/src/**/*.e2e.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false
  }
});
```

- [ ] **Step 2: Write the failing test**

`apps/demo/src/demo.e2e.test.ts`:

```typescript
import { beforeAll, describe, expect, it } from "vitest";

const API = process.env["FLIGHT_API_URL"] ?? "http://localhost:8080";
const SOURCE = process.env["DEMO_SOURCE_URL"] ?? "http://localhost:3100";
const ADMIN = process.env["ADMIN_TOKEN"] ?? "local-admin-token-000000000000000";

const EXPECTED_SEQUENCE = [
  ["received", "receive-salesforce-webhook"],
  ["transformed", "transform-salesforce-account"],
  ["persisted", "persist-customer"],
  ["identified", "identify"],
  ["published", "publish-customer-updated"],
  ["consumed", "consume-customer-updated"],
  ["delivered", "deliver-customer-to-target"],
  ["retried", "retry-customer-delivery"],
  ["retried", "retry-customer-delivery"],
  ["failed", "move-message-to-dead-letter"]
];

interface EventItem {
  id: string;
  operation: string;
  name: string;
  service: string;
  hasError: boolean;
}

async function get(path: string): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${ADMIN}` }
  });
  const body = (await response.json()) as { data?: Record<string, unknown> };
  return { status: response.status, data: body.data ?? {} };
}

let journeyId = "";
let events: EventItem[] = [];

describe("the reference journey", () => {
  beforeAll(async () => {
    const triggered = await fetch(`${SOURCE}/trigger`, { method: "POST" });
    expect(triggered.status).toBe(202);
    journeyId = ((await triggered.json()) as { journeyId: string }).journeyId;

    // The queue's visibility timeout drives the retries, so the journey takes
    // about ten seconds. Poll for the terminal state rather than sleeping.
    const deadline = Date.now() + 90_000;
    for (;;) {
      const { data } = await get(`/v1/journeys/${journeyId}/events`);
      events = (data["items"] ?? []) as EventItem[];
      if (events.some((event) => event.name === "move-message-to-dead-letter")) break;
      if (Date.now() > deadline) {
        throw new Error(
          `The journey never dead-lettered. Saw: ${events.map((e) => e.name).join(", ")}`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  });

  it("records every step, in order, across both owned services", () => {
    expect(events.map((event) => [event.operation, event.name])).toEqual(EXPECTED_SEQUENCE);
    expect(new Set(events.map((event) => event.service))).toEqual(
      new Set(["demo-integration", "demo-worker"])
    );
  });

  it("ends failed", async () => {
    const { data } = await get(`/v1/journeys/${journeyId}`);
    expect(data["status"]).toBe("failed");
    expect(data["eventCount"]).toBe(10);
  });

  it("shows the phone leaving with a value and arriving null", async () => {
    const transformed = events.find((event) => event.name === "transform-salesforce-account");
    expect(transformed).toBeDefined();

    const { data } = await get(`/v1/events/${transformed?.id ?? ""}`);
    const diff = data["payloadDiff"] as { path: string; before?: unknown; after?: unknown }[];

    // ADR-030: the transformation renames every field, so the defect reads as a
    // pair rather than as one field changing value.
    expect(diff.find((entry) => entry.path === "Phone")?.before).toBe("+1 919 555 1234");
    expect(diff.find((entry) => entry.path === "phone")?.after).toBeNull();
    // The control: a field that survived the mapping intact.
    expect(diff.find((entry) => entry.path === "name")?.after).toBe("Jorge Polanco");
  });

  it("records the target's rejection on every delivery attempt", async () => {
    const deliveries = events.filter((event) =>
      ["deliver-customer-to-target", "retry-customer-delivery"].includes(event.name)
    );
    expect(deliveries).toHaveLength(3);
    expect(deliveries.every((event) => event.hasError)).toBe(true);

    const { data } = await get(`/v1/events/${deliveries[0]?.id ?? ""}`);
    const output = data["outputPayload"] as { status: number; body: { error: { code: string } } };
    expect(output.status).toBe(422);
    expect(output.body.error.code).toBe("phone_required");
  });

  it("is findable by the Salesforce ID and by the internal customer ID", async () => {
    const bySalesforce = await get("/v1/search?q=0018Z00002ABC");
    expect((bySalesforce.data["items"] as { journeyId: string }[]).map((h) => h.journeyId)).toContain(
      journeyId
    );

    // DEMO_SCENARIO.md section 9. This is the alias, not the primary entity, so
    // it proves alias search works rather than re-testing entity search.
    const byInternal = await get("/v1/search?q=18492");
    expect((byInternal.data["items"] as { journeyId: string }[]).map((h) => h.journeyId)).toContain(
      journeyId
    );
  });
});
```

- [ ] **Step 3: Run it against the running stack**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm test:demo
```

Expected: five tests pass. If the internal customer ID is not 18492 — because the table
already existed from an earlier run — drop the demo database and re-run the bootstrap
before re-testing:

```bash
docker compose -f infrastructure/compose.yaml -f infrastructure/compose.demo.yaml down -v
```

- [ ] **Step 4: Add the CI job**

In `.gitlab-ci.yml`, add `demo` to the `stages` list after `browser`, then append:

```yaml
# The demo is the product acceptance test (DEMO_SCENARIO.md section 1). It needs
# Docker Compose rather than a process, so it runs manually alongside the browser
# suite rather than on every push, for the reason recorded on the e2e job.
demo:
  stage: demo
  image: docker:27-cli
  services:
    - docker:dind
  variables:
    DOCKER_HOST: tcp://docker:2375
    DOCKER_TLS_CERTDIR: ""
  before_script:
    - apk add --no-cache nodejs npm
    - corepack enable
    - pnpm config set store-dir "$PNPM_STORE_DIR"
    - pnpm install --frozen-lockfile
  when: manual
  allow_failure: true
  script:
    - docker compose -f infrastructure/compose.yaml -f infrastructure/compose.demo.yaml up --build -d
    - npx wait-on http://localhost:8080/health http://localhost:3100/health
    - pnpm test:demo
  after_script:
    - docker compose -f infrastructure/compose.yaml -f infrastructure/compose.demo.yaml down -v
```

- [ ] **Step 5: Commit**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm lint && pnpm format:check
git add vitest.demo.config.ts apps/demo .gitlab-ci.yml
git commit -m "test(demo): the end-to-end reference journey"
```

---

### Task 15: Documentation

**Files:**

- Modify: `README.md`, `docs/LOCAL_DEVELOPMENT.md`, `docs/TASKS.md`

- [ ] **Step 1: README**

Add a "Try the demo" section after the existing quick start, showing the two commands from
section 7 of the spec and what to search for. Keep it to the commands, one sentence about
what they will see, and a link to `docs/DEMO_SCENARIO.md`.

- [ ] **Step 2: `docs/LOCAL_DEVELOPMENT.md`**

Add a section covering: the five demo services and their ports; that the bootstrap runs
migrations and creates the `demo` database, so the demo profile needs no manual
`pnpm db:migrate`; the fixed demo API key and that it is a placeholder; and
`pnpm test:demo` requiring the stack to be up.

- [ ] **Step 3: `docs/TASKS.md`**

Tick the Epic covering the demo services and note the E2E test as delivered.

- [ ] **Step 4: Commit**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm format:check
git add README.md docs
git commit -m "docs: how to run the demo"
```

---

### Task 16: Clean-clone verification and merge

- [ ] **Step 1: Verify on a clean clone**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
rm -rf /tmp/fr-verify && git clone -q . /tmp/fr-verify && cd /tmp/fr-verify \
  && git checkout -q phase-5-demo-services \
  && pnpm install --frozen-lockfile \
  && pnpm format:check && pnpm lint && pnpm typecheck && pnpm build && pnpm test
```

Expected: every command succeeds. The working tree passing is not evidence the clone
does — that has been the source of most defects in this project.

- [ ] **Step 2: Run the integration suite**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
cd /tmp/fr-verify && pnpm test:integration
```

- [ ] **Step 3: Merge, tag, and push**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
cd /Users/jorgepolanco/workspace/flight-recorder
git checkout main && git merge --no-ff phase-5-demo-services -m "Phase 5: demo services"
git tag phase-5-complete
git push origin main --tags
```

- [ ] **Step 4: Confirm CI**

```bash
glab ci status --live 2>/dev/null || echo "check https://gitlab.com/jojithedev/flight-recorder/-/pipelines"
```

Expected: format, lint, typecheck, unit, database, and build all pass.

---

## Self-Review

**Spec coverage.** Section 2's four services are Tasks 6, 8, 9, 10; the one-package
decision is Task 3; the bootstrap is Task 11. Section 3's defect is Task 4. Section 4's
dead-letter queue is Tasks 9 and 12, and the promised verification is Task 13 step 4.
Section 5's demo database is Tasks 5, 11, 12; the short visibility timeout is Task 12;
the fixed key is Tasks 1, 2, 12. Section 6's dependencies are Task 3. Section 7's commands
are Tasks 10 and 15. Section 8's sequence is asserted in Task 14. Section 9's unit test is
Task 4 and the end-to-end test is Task 14. Section 10's criteria map to Tasks 13, 14,
and 16.

**Placeholders.** One found and removed: Task 9 originally passed
`metadata: { targetStatus: undefined }` to `deliver`, which contributes nothing. Task 9
step 2 deletes it — better to leave the trail than to silently rewrite the step.

**Type consistency.** `CustomerMessage` is defined in Task 7 and consumed with the same
shape in Tasks 8 and 9. `Customer` comes from Task 4 and is used in Tasks 5, 7, and 8.
`apiKeyRecord` returns `{ keyPrefix, verifier }` in Task 1 and is destructured that way in
Task 2. `demoRecorder(serviceName)` from Task 5 is called in Tasks 8 and 9.

**One risk worth naming.** Task 9 passes both `MessageAttributeNames` and `AttributeNames`
to `ReceiveMessageCommand`; the latter is deprecated in the AWS SDK but serialises to the
parameter ElasticMQ understands. If the SDK has removed it, use
`MessageSystemAttributeNames` and confirm during Task 13 that the count still arrives —
the in-process fallback covers the case where it does not.
