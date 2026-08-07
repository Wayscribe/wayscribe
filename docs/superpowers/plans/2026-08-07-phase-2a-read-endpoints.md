# Phase 2a: Read Endpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the four read endpoints so a developer can search an identifier over HTTP, open the matching journey, page through its events in deterministic order, and inspect one event with its payloads and diff.

**Architecture:** Three repository modules alongside the existing `search.ts`, then one route module wiring all four endpoints through the API-key auth already used by ingestion. Decryption and masking happen in the route layer, not the repository, so repositories stay free of key material.

**Tech Stack:** TypeScript 5.9, Fastify 5, Knex, PostgreSQL 17, Vitest 4, Testcontainers.

**Source spec:** `docs/superpowers/specs/2026-08-07-phase-2a-query-api-design.md`

**Already done and merged:** ADR-028 token fix, migration 011, `cursors.ts`, `mask.ts`,
`search.ts` and its 13 integration tests.

---

## Conventions

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
```

**Run `pnpm lint` and `pnpm typecheck` before every commit.** This was skipped four times
across Phases 1a and 1b and required an amend every time.

Repository functions take `projectId` first. Scoping goes inside the query, never as a
filter on results.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/database/src/repositories/journey-reads.ts` | Journey detail, aliases, services |
| `packages/database/src/repositories/event-reads.ts` | Event list (paginated) and event detail |
| `apps/api/src/routes/queries.ts` | The four HTTP endpoints |
| `apps/api/src/routes/present.ts` | Decrypt and mask for the wire |

---

## Task 1: Journey read repository

**Files:**
- Create: `packages/database/src/repositories/journey-reads.ts`
- Test: `packages/database/src/repositories/journey-reads.integration.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertReturningId } from "../insert.js";
import { createKnexConfig } from "../knex-config.js";
import { findJourneyDetail } from "./journey-reads.js";

describe("findJourneyDetail", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let projectId: string;
  let environmentId: string;
  let otherProjectId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();

    projectId = await insertReturningId(db, "projects", { name: "P", slug: "p" });
    otherProjectId = await insertReturningId(db, "projects", { name: "O", slug: "o" });
    environmentId = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: "development"
    });

    await db("journeys").insert({
      id: "jrn_1",
      project_id: projectId,
      environment_id: environmentId,
      entity_type: "customer",
      primary_entity_id_hash: "hash",
      encrypted_primary_entity_id: "cipher",
      status: "failed",
      started_at: "2026-08-06T10:00:00Z",
      last_event_at: "2026-08-06T12:00:00Z",
      event_count: 2
    });

    await db("entity_aliases").insert([
      {
        project_id: projectId,
        journey_id: "jrn_1",
        alias_type: "salesforceAccountId",
        alias_value_hash: "h1",
        encrypted_display_value: "cipher1"
      },
      {
        project_id: projectId,
        journey_id: "jrn_1",
        alias_type: "internalCustomerId",
        alias_value_hash: "h2",
        encrypted_display_value: "cipher2"
      }
    ]);

    const event = (id: string, service: string, at: string) => ({
      id,
      project_id: projectId,
      environment_id: environmentId,
      journey_id: "jrn_1",
      protocol_version: "0.1",
      content_hash: "h",
      operation: "received",
      name: "n",
      service,
      event_timestamp: at
    });
    await db("journey_events").insert([
      event("evt_1", "webhook-api", "2026-08-06T10:00:00Z"),
      event("evt_2", "sync-worker", "2026-08-06T12:00:00Z"),
      event("evt_3", "webhook-api", "2026-08-06T11:00:00Z")
    ]);
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  it("returns the journey summary", async () => {
    const detail = await findJourneyDetail(db, projectId, "jrn_1");
    expect(detail?.status).toBe("failed");
    expect(detail?.eventCount).toBe(2);
    expect(detail?.entityType).toBe("customer");
    expect(detail?.encryptedPrimaryEntityId).toBe("cipher");
  });

  it("returns aliases with their types", async () => {
    const detail = await findJourneyDetail(db, projectId, "jrn_1");
    expect(detail?.aliases.map((a) => a.aliasType).sort()).toEqual([
      "internalCustomerId",
      "salesforceAccountId"
    ]);
  });

  it("returns distinct services, not one entry per event", async () => {
    const detail = await findJourneyDetail(db, projectId, "jrn_1");
    expect(detail?.services.sort()).toEqual(["sync-worker", "webhook-api"]);
  });

  it("returns undefined for another project's journey", async () => {
    expect(await findJourneyDetail(db, otherProjectId, "jrn_1")).toBeUndefined();
  });

  it("returns undefined for an unknown journey", async () => {
    expect(await findJourneyDetail(db, projectId, "jrn_nope")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run --config vitest.integration.config.ts packages/database/src/repositories/journey-reads`
Expected: FAIL, cannot resolve `./journey-reads.js`.

- [ ] **Step 3: Implement**

```typescript
import type { Knex } from "knex";

export interface JourneyAlias {
  aliasType: string;
  encryptedDisplayValue: string | null;
}

export interface JourneyDetail {
  journeyId: string;
  entityType: string;
  encryptedPrimaryEntityId: string | null;
  status: string;
  eventCount: number;
  startedAt: Date;
  completedAt: Date | null;
  lastEventAt: Date;
  aliases: JourneyAlias[];
  services: string[];
}

/**
 * One journey with its aliases and the distinct services that touched it.
 *
 * Three queries rather than one join: joining aliases and events to the journey
 * row multiplies it by both, and the caller would have to de-duplicate summary
 * fields that the database had already fanned out.
 *
 * Returns undefined rather than throwing when the journey belongs to another
 * project, so the route can answer 404 — confirming existence to an
 * unauthorized caller is itself a disclosure.
 */
export async function findJourneyDetail(
  db: Knex,
  projectId: string,
  journeyId: string
): Promise<JourneyDetail | undefined> {
  const row: unknown = await db("journeys")
    .where({ project_id: projectId, id: journeyId })
    .first(
      "id as journeyId",
      "entity_type as entityType",
      "encrypted_primary_entity_id as encryptedPrimaryEntityId",
      "status",
      "event_count as eventCount",
      "started_at as startedAt",
      "completed_at as completedAt",
      "last_event_at as lastEventAt"
    );

  if (row === undefined) return undefined;

  const aliases: unknown = await db("entity_aliases")
    .where({ project_id: projectId, journey_id: journeyId })
    .select("alias_type as aliasType", "encrypted_display_value as encryptedDisplayValue")
    .orderBy("alias_type");

  const services: unknown = await db("journey_events")
    .where({ project_id: projectId, journey_id: journeyId })
    .distinct("service")
    .orderBy("service");

  return {
    ...(row as Omit<JourneyDetail, "aliases" | "services">),
    aliases: aliases as JourneyAlias[],
    services: (services as { service: string }[]).map((s) => s.service)
  };
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `pnpm vitest run --config vitest.integration.config.ts packages/database/src/repositories/journey-reads`
Expected: PASS, 5 tests.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
pnpm lint && pnpm typecheck
git add packages/database
git commit -m "feat(database): add journey detail repository"
```

---

## Task 2: Event read repository

**Files:**
- Create: `packages/database/src/repositories/event-reads.ts`
- Test: `packages/database/src/repositories/event-reads.integration.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertReturningId } from "../insert.js";
import { createKnexConfig } from "../knex-config.js";
import { findEventDetail, listJourneyEvents } from "./event-reads.js";

describe("event reads", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let projectId: string;
  let otherProjectId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();

    projectId = await insertReturningId(db, "projects", { name: "P", slug: "p" });
    otherProjectId = await insertReturningId(db, "projects", { name: "O", slug: "o" });
    const environmentId = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: "development"
    });

    await db("journeys").insert({
      id: "jrn_1",
      project_id: projectId,
      environment_id: environmentId,
      entity_type: "customer",
      primary_entity_id_hash: "hash",
      status: "active",
      started_at: "2026-08-06T10:00:00Z",
      last_event_at: "2026-08-06T12:00:00Z",
      event_count: 4
    });

    const event = (
      id: string,
      at: string,
      receivedAt: string,
      extra: Record<string, unknown> = {}
    ) => ({
      id,
      project_id: projectId,
      environment_id: environmentId,
      journey_id: "jrn_1",
      protocol_version: "0.1",
      content_hash: "h",
      operation: "transformed",
      name: "n",
      service: "s",
      event_timestamp: at,
      received_at: receivedAt,
      ...extra
    });

    await db("journey_events").insert([
      event("evt_c", "2026-08-06T11:00:00Z", "2026-08-06T11:00:01Z"),
      event("evt_a", "2026-08-06T10:00:00Z", "2026-08-06T10:00:01Z", {
        input_payload: JSON.stringify({ phone: "+1 919 555 1234" }),
        output_payload: JSON.stringify({ phone: null }),
        payload_diff: JSON.stringify({ changes: [{ path: "phone", kind: "changed" }] }),
        error: JSON.stringify({ message: "boom" })
      }),
      // Same timestamp as evt_a: the tie must break on received_at, then id.
      event("evt_b", "2026-08-06T10:00:00Z", "2026-08-06T10:00:02Z"),
      event("evt_d", "2026-08-06T12:00:00Z", "2026-08-06T12:00:01Z")
    ]);
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  it("orders by timestamp, then received_at, then id", async () => {
    const page = await listJourneyEvents(db, projectId, "jrn_1", 25);
    expect(page.items.map((e) => e.id)).toEqual(["evt_a", "evt_b", "evt_c", "evt_d"]);
  });

  it("reports payload presence without returning payloads", async () => {
    const page = await listJourneyEvents(db, projectId, "jrn_1", 25);
    const first = page.items[0];
    expect(first?.hasInput).toBe(true);
    expect(first?.hasOutput).toBe(true);
    expect(first?.hasError).toBe(true);
    expect(first).not.toHaveProperty("inputPayload");
  });

  it("paginates deterministically with a keyset cursor", async () => {
    const first = await listJourneyEvents(db, projectId, "jrn_1", 2);
    expect(first.items.map((e) => e.id)).toEqual(["evt_a", "evt_b"]);
    expect(first.nextCursor).not.toBeNull();

    const second = await listJourneyEvents(
      db,
      projectId,
      "jrn_1",
      2,
      first.nextCursor ?? undefined
    );
    expect(second.items.map((e) => e.id)).toEqual(["evt_c", "evt_d"]);
    expect(second.nextCursor).toBeNull();
  });

  it("returns no events for another project", async () => {
    const page = await listJourneyEvents(db, otherProjectId, "jrn_1", 25);
    expect(page.items).toEqual([]);
  });

  it("returns full detail for one event", async () => {
    const detail = await findEventDetail(db, projectId, "evt_a");
    expect(detail?.inputPayload).toEqual({ phone: "+1 919 555 1234" });
    expect(detail?.payloadDiff).toEqual({ changes: [{ path: "phone", kind: "changed" }] });
    expect(detail?.error).toEqual({ message: "boom" });
  });

  it("returns undefined for another project's event", async () => {
    expect(await findEventDetail(db, otherProjectId, "evt_a")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run --config vitest.integration.config.ts packages/database/src/repositories/event-reads`
Expected: FAIL, cannot resolve `./event-reads.js`.

- [ ] **Step 3: Implement**

```typescript
import type { Knex } from "knex";
import { decodeEventCursor, encodeCursor } from "./cursors.js";

export interface EventListItem {
  id: string;
  operation: string;
  name: string;
  service: string;
  eventTimestamp: Date;
  durationMs: number | null;
  hasInput: boolean;
  hasOutput: boolean;
  hasError: boolean;
}

export interface EventPage {
  items: EventListItem[];
  nextCursor: string | null;
}

export interface EventDetail extends EventListItem {
  journeyId: string;
  parentEventId: string | null;
  protocolVersion: string;
  receivedAt: Date;
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

/**
 * One page of a journey's timeline.
 *
 * Ordering is (event_timestamp, received_at, id) per ARCHITECTURE.md section 9.
 * All three matter: clocks on different services collide, and without the final
 * tiebreak two events sharing a timestamp and arrival could swap between pages,
 * which would show a developer a different history on every scroll.
 *
 * The list reports payload *presence* rather than payload contents. A timeline
 * of 500 events would otherwise transfer every captured body to render a list
 * that displays none of them.
 */
export async function listJourneyEvents(
  db: Knex,
  projectId: string,
  journeyId: string,
  limit: number,
  cursor?: string
): Promise<EventPage> {
  const after = cursor === undefined ? undefined : decodeEventCursor(cursor);

  const rows: unknown = await db("journey_events")
    .where({ project_id: projectId, journey_id: journeyId })
    .modify((builder) => {
      if (after !== undefined) {
        void builder.whereRaw(
          "(event_timestamp, received_at, id) > (?::timestamptz, ?::timestamptz, ?)",
          [after.eventTimestamp, after.receivedAt, after.id]
        );
      }
    })
    .select(
      "id",
      "operation",
      "name",
      "service",
      "event_timestamp as eventTimestamp",
      "received_at as receivedAt",
      "duration_ms as durationMs",
      db.raw("input_payload is not null as \"hasInput\""),
      db.raw("output_payload is not null as \"hasOutput\""),
      db.raw("error is not null as \"hasError\"")
    )
    .orderBy([{ column: "event_timestamp" }, { column: "received_at" }, { column: "id" }])
    .limit(limit + 1);

  const all = rows as (EventListItem & { receivedAt: Date })[];
  const hasMore = all.length > limit;
  const page = hasMore ? all.slice(0, limit) : all;
  const last = page.at(-1);

  return {
    items: page.map(({ receivedAt: _omitted, ...item }) => item),
    nextCursor:
      hasMore && last !== undefined
        ? encodeCursor({
            eventTimestamp: last.eventTimestamp.toISOString(),
            receivedAt: last.receivedAt.toISOString(),
            id: last.id
          })
        : null
  };
}

export async function findEventDetail(
  db: Knex,
  projectId: string,
  eventId: string
): Promise<EventDetail | undefined> {
  const row: unknown = await db("journey_events")
    .where({ project_id: projectId, id: eventId })
    .first(
      "id",
      "journey_id as journeyId",
      "parent_event_id as parentEventId",
      "protocol_version as protocolVersion",
      "operation",
      "name",
      "service",
      "event_timestamp as eventTimestamp",
      "received_at as receivedAt",
      "duration_ms as durationMs",
      "trace_id as traceId",
      "span_id as spanId",
      "message_id as messageId",
      "correlation_id as correlationId",
      "input_payload as inputPayload",
      "output_payload as outputPayload",
      "payload_diff as payloadDiff",
      "error",
      "runtime_metadata as runtimeMetadata",
      "deployment_metadata as deploymentMetadata",
      "custom_metadata as customMetadata",
      db.raw("input_payload is not null as \"hasInput\""),
      db.raw("output_payload is not null as \"hasOutput\""),
      db.raw("error is not null as \"hasError\"")
    );

  return row === undefined ? undefined : (row as EventDetail);
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `pnpm vitest run --config vitest.integration.config.ts packages/database/src/repositories/event-reads`
Expected: PASS, 6 tests.

- [ ] **Step 5: Export, lint, typecheck, commit**

Add to `packages/database/src/index.ts`:

```typescript
export {
  findEventDetail,
  listJourneyEvents,
  type EventDetail,
  type EventListItem,
  type EventPage
} from "./repositories/event-reads.js";
export {
  findJourneyDetail,
  type JourneyAlias,
  type JourneyDetail
} from "./repositories/journey-reads.js";
```

```bash
pnpm lint && pnpm typecheck
git add packages/database
git commit -m "feat(database): add event list and event detail repositories"
```

---

## Task 3: Presentation layer

**Files:**
- Create: `apps/api/src/routes/present.ts`
- Test: `apps/api/src/routes/present.test.ts`

Decryption and masking live in the route layer so repositories never touch key material.

- [ ] **Step 1: Write the failing test**

```typescript
import { deriveSubkeys, encryptField } from "@flight-recorder/payload-security";
import { describe, expect, it } from "vitest";
import { presentAliases, presentEntityId } from "./present.js";

const subkeys = deriveSubkeys("0123456789abcdef0123456789abcdef");
const key = subkeys.fieldEncryption;

describe("presentEntityId", () => {
  it("returns the entity id in full", () => {
    // The caller just searched for this value; returning it discloses nothing new.
    expect(presentEntityId(key, encryptField(key, "0018Z00002ABC"))).toBe("0018Z00002ABC");
  });

  it("returns null when nothing was stored", () => {
    expect(presentEntityId(key, null)).toBeNull();
  });

  it("returns null rather than throwing on undecryptable data", () => {
    expect(presentEntityId(key, "not-real-ciphertext")).toBeNull();
  });
});

describe("presentAliases", () => {
  it("masks alias display values", () => {
    const result = presentAliases(key, [
      { aliasType: "salesforceAccountId", encryptedDisplayValue: encryptField(key, "0018Z00002ABC") }
    ]);
    expect(result).toEqual([{ type: "salesforceAccountId", displayValue: "0018…ABC" }]);
  });

  it("fully masks short values", () => {
    const result = presentAliases(key, [
      { aliasType: "shortId", encryptedDisplayValue: encryptField(key, "12345") }
    ]);
    expect(result[0]?.displayValue).toBe("…");
  });

  it("returns a null display value when nothing was stored", () => {
    const result = presentAliases(key, [{ aliasType: "t", encryptedDisplayValue: null }]);
    expect(result[0]?.displayValue).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/api`
Expected: FAIL, cannot resolve `./present.js`.

- [ ] **Step 3: Implement**

```typescript
import { maskDisplayValue, type JourneyAlias } from "@flight-recorder/database";
import { decryptField } from "@flight-recorder/payload-security";

export interface PresentedAlias {
  type: string;
  displayValue: string | null;
}

/**
 * Decrypt the primary entity identifier for display, in full.
 *
 * Unmasked deliberately: this is the value the caller searched for, so returning
 * it reveals nothing they did not already hold. Alias values get masked because
 * they are *other* identifiers the caller may not be entitled to see.
 *
 * Undecryptable data returns null rather than throwing. A row encrypted under a
 * rotated key should degrade one field, not fail the whole request.
 */
export function presentEntityId(key: Buffer, encrypted: string | null): string | null {
  if (encrypted === null) return null;
  try {
    return decryptField(key, encrypted);
  } catch {
    return null;
  }
}

export function presentAliases(key: Buffer, aliases: readonly JourneyAlias[]): PresentedAlias[] {
  return aliases.map((alias) => ({
    type: alias.aliasType,
    displayValue:
      alias.encryptedDisplayValue === null
        ? null
        : safeMask(key, alias.encryptedDisplayValue)
  }));
}

function safeMask(key: Buffer, encrypted: string): string | null {
  try {
    return maskDisplayValue(decryptField(key, encrypted));
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run, lint, typecheck, commit**

```bash
pnpm vitest run apps/api
pnpm lint && pnpm typecheck
git add apps/api
git commit -m "feat(api): add decryption and masking for read responses"
```

---

## Task 4: The four routes

**Files:**
- Create: `apps/api/src/routes/queries.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Implement**

```typescript
import {
  InvalidCursorError,
  findApiKeyByPrefix,
  findEventDetail,
  findJourneyDetail,
  listJourneyEvents,
  searchJourneys
} from "@flight-recorder/database";
import { searchToken, type Subkeys } from "@flight-recorder/payload-security";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { resolveApiKey } from "../auth.js";
import { presentAliases, presentEntityId } from "./present.js";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export function registerQueryRoutes(app: FastifyInstance, subkeys: Subkeys): void {
  const authenticate = async (request: FastifyRequest, reply: FastifyReply) =>
    resolveApiKey(request.headers.authorization, subkeys.apiKey, (prefix) =>
      findApiKeyByPrefix(app.db, prefix)
    ).then((auth) => {
      if (!auth.ok) {
        void reply.code(auth.status).send(errorBody(auth.code, auth.message, request.id));
        return undefined;
      }
      return auth.context;
    });

  app.get("/v1/search", async (request, reply) => {
    const context = await authenticate(request, reply);
    if (context === undefined) return reply;

    const query = (request.query as { q?: string }).q;
    if (query === undefined || query.trim() === "") {
      return reply.code(400).send(errorBody("invalid_query", "q is required.", request.id));
    }

    const limit = parseLimit(request.query);
    const cursor = (request.query as { cursor?: string }).cursor;

    try {
      const page = await searchJourneys(
        app.db,
        { projectId: context.projectId, environmentId: context.environmentId },
        query.trim(),
        searchToken(subkeys.searchToken, query.trim()),
        limit,
        cursor
      );

      return reply.send({
        data: {
          items: page.items.map((hit) => ({
            journeyId: hit.journeyId,
            entity: {
              type: hit.entityType,
              id: presentEntityId(subkeys.fieldEncryption, hit.encryptedPrimaryEntityId)
            },
            status: hit.status,
            eventCount: hit.eventCount,
            startedAt: hit.startedAt.toISOString(),
            lastEventAt: hit.lastEventAt.toISOString()
          })),
          nextCursor: page.nextCursor
        }
      });
    } catch (error) {
      return cursorError(error, reply, request.id);
    }
  });

  app.get("/v1/journeys/:journeyId", async (request, reply) => {
    const context = await authenticate(request, reply);
    if (context === undefined) return reply;

    const { journeyId } = request.params as { journeyId: string };
    const detail = await findJourneyDetail(app.db, context.projectId, journeyId);
    // 404 rather than 403: confirming existence to an unauthorized caller is
    // itself a disclosure.
    if (detail === undefined) {
      return reply.code(404).send(errorBody("not_found", "Journey not found.", request.id));
    }

    return reply.send({
      data: {
        journeyId: detail.journeyId,
        entity: {
          type: detail.entityType,
          id: presentEntityId(subkeys.fieldEncryption, detail.encryptedPrimaryEntityId)
        },
        status: detail.status,
        aliases: presentAliases(subkeys.fieldEncryption, detail.aliases),
        services: detail.services,
        eventCount: detail.eventCount,
        startedAt: detail.startedAt.toISOString(),
        completedAt: detail.completedAt?.toISOString() ?? null,
        lastEventAt: detail.lastEventAt.toISOString()
      }
    });
  });

  app.get("/v1/journeys/:journeyId/events", async (request, reply) => {
    const context = await authenticate(request, reply);
    if (context === undefined) return reply;

    const { journeyId } = request.params as { journeyId: string };
    const journey = await findJourneyDetail(app.db, context.projectId, journeyId);
    if (journey === undefined) {
      return reply.code(404).send(errorBody("not_found", "Journey not found.", request.id));
    }

    try {
      const page = await listJourneyEvents(
        app.db,
        context.projectId,
        journeyId,
        parseLimit(request.query),
        (request.query as { cursor?: string }).cursor
      );

      return reply.send({
        data: {
          items: page.items.map((item) => ({
            ...item,
            eventTimestamp: item.eventTimestamp.toISOString()
          })),
          nextCursor: page.nextCursor
        }
      });
    } catch (error) {
      return cursorError(error, reply, request.id);
    }
  });

  app.get("/v1/events/:eventId", async (request, reply) => {
    const context = await authenticate(request, reply);
    if (context === undefined) return reply;

    const { eventId } = request.params as { eventId: string };
    const detail = await findEventDetail(app.db, context.projectId, eventId);
    if (detail === undefined) {
      return reply.code(404).send(errorBody("not_found", "Event not found.", request.id));
    }

    return reply.send({
      data: {
        ...detail,
        eventTimestamp: detail.eventTimestamp.toISOString(),
        receivedAt: detail.receivedAt.toISOString()
      }
    });
  });
}

function parseLimit(query: unknown): number {
  const raw = (query as { limit?: string }).limit;
  const parsed = raw === undefined ? DEFAULT_LIMIT : Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function cursorError(error: unknown, reply: FastifyReply, requestId: string): FastifyReply {
  if (error instanceof InvalidCursorError) {
    return reply.code(400).send(errorBody("invalid_cursor", error.message, requestId));
  }
  throw error;
}

function errorBody(code: string, message: string, requestId: string): unknown {
  return { error: { code, message, requestId } };
}
```

- [ ] **Step 2: Wire into the app**

In `apps/api/src/app.ts`, import `registerQueryRoutes` and call it after
`registerEventRoutes(app, options.subkeys)`.

- [ ] **Step 3: Lint, typecheck, commit**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add apps/api
git commit -m "feat(api): add search, journey, events, and event detail endpoints"
```

---

## Task 5: Route integration tests

**Files:**
- Test: `apps/api/src/routes/queries.integration.test.ts`

- [ ] **Step 1: Write the tests**

Build the fixture by ingesting through `POST /v1/events`, so the test exercises the real
write path rather than hand-inserted rows that could drift from what ingestion produces.

```typescript
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createKnexConfig, insertReturningId } from "@flight-recorder/database";
import { deriveSubkeys, generateApiKey } from "@flight-recorder/payload-security";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const subkeys = deriveSubkeys("0123456789abcdef0123456789abcdef");

describe("query endpoints", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let app: FastifyInstance;
  let apiKey: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();

    const projectId = await insertReturningId(db, "projects", { name: "P", slug: "p" });
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

    const ingest = (id: string, at: string, extra: Record<string, unknown> = {}) =>
      app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { authorization: `Bearer ${apiKey}` },
        payload: {
          protocolVersion: "0.1",
          event: {
            id,
            journeyId: "jrn_q",
            environment: "development",
            service: "customer-integration",
            entity: { type: "customer", id: "0018Z00002ABC" },
            operation: "transformed",
            name: "transform-salesforce-account",
            timestamp: at,
            // A value distinct from entity.id, so a search for it can only
            // succeed through the alias path.
            aliases: { salesforceAccountId: "SF-ALIAS-99001" },
            ...extra
          }
        } as object
      });

    await ingest("evt_q1", "2026-08-06T10:00:00.000Z", {
      input: { phone: "+1 919 555 1234" },
      output: { phone: null },
      traceId: "trace-q"
    });
    await ingest("evt_q2", "2026-08-06T11:00:00.000Z");
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await container.stop();
  });

  const get = (url: string, key = apiKey) =>
    app.inject({ method: "GET", url, headers: { authorization: `Bearer ${key}` } });

  it("finds the journey by entity id", async () => {
    const response = await get("/v1/search?q=0018Z00002ABC");
    expect(response.statusCode).toBe(200);
    expect(response.json().data.items[0].journeyId).toBe("jrn_q");
  });

  it("finds the journey by alias value without its type", async () => {
    // The alias value differs from entity.id, so this can only match via the
    // alias path — which is the ADR-028 property.
    const response = await get("/v1/search?q=SF-ALIAS-99001");
    expect(response.json().data.items[0].journeyId).toBe("jrn_q");
  });

  it("finds the journey by trace id", async () => {
    expect((await get("/v1/search?q=trace-q")).json().data.items[0].journeyId).toBe("jrn_q");
  });

  it("returns the entity id in full", async () => {
    const item = (await get("/v1/search?q=0018Z00002ABC")).json().data.items[0];
    expect(item.entity.id).toBe("0018Z00002ABC");
  });

  it("requires a query string", async () => {
    expect((await get("/v1/search")).statusCode).toBe(400);
  });

  it("rejects a malformed cursor", async () => {
    const response = await get("/v1/search?q=0018Z00002ABC&cursor=garbage");
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_cursor");
  });

  it("requires authentication", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/search?q=x" });
    expect(response.statusCode).toBe(401);
  });

  it("returns the journey with masked aliases and distinct services", async () => {
    const data = (await get("/v1/journeys/jrn_q")).json().data;
    expect(data.entity.id).toBe("0018Z00002ABC");
    expect(data.aliases[0]).toEqual({ type: "salesforceAccountId", displayValue: "SF-A…001" });
    expect(data.services).toEqual(["customer-integration"]);
    expect(data.eventCount).toBe(2);
  });

  it("returns 404 for an unknown journey", async () => {
    expect((await get("/v1/journeys/jrn_nope")).statusCode).toBe(404);
  });

  it("lists events in deterministic order", async () => {
    const items = (await get("/v1/journeys/jrn_q/events")).json().data.items;
    expect(items.map((e: { id: string }) => e.id)).toEqual(["evt_q1", "evt_q2"]);
  });

  it("reports payload presence in the list without sending payloads", async () => {
    const first = (await get("/v1/journeys/jrn_q/events")).json().data.items[0];
    expect(first.hasInput).toBe(true);
    expect(first.inputPayload).toBeUndefined();
  });

  it("returns event detail with payloads and diff", async () => {
    const data = (await get("/v1/events/evt_q1")).json().data;
    expect(data.inputPayload).toEqual({ phone: "+1 919 555 1234" });
    expect(data.payloadDiff.changes[0].path).toBe("phone");
  });

  it("returns 404 for an event in another project", async () => {
    const otherProject = await insertReturningId(db, "projects", { name: "O2", slug: "o2" });
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

    expect((await get("/v1/events/evt_q1", otherKey.apiKey)).statusCode).toBe(404);
    expect((await get("/v1/journeys/jrn_q", otherKey.apiKey)).statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run, lint, typecheck, commit**

```bash
pnpm test:integration
pnpm lint && pnpm typecheck
git add apps/api
git commit -m "test(api): cover search, journey, event list, and detail endpoints"
```

---

## Task 6: Verify Phase 2a

- [ ] **Step 1: Clean-clone pipeline**

```bash
CLEAN=$(mktemp -d)/fr && git clone -q --branch phase-2a-reads . "$CLEAN" && cd "$CLEAN"
pnpm install --frozen-lockfile
for s in format:check lint typecheck test build; do
  pnpm "$s" >/dev/null 2>&1 && echo "$s OK" || echo "$s FAIL"
done
pnpm test:integration
```

- [ ] **Step 2: End-to-end against Compose**

Bring the stack up, migrate, seed, ingest one event with the seeded key, then:

```bash
curl -s "localhost:8080/v1/search?q=0018Z00002ABC" -H "Authorization: Bearer <key>"
```

Expected: the journey, with `entity.id` in full.

- [ ] **Step 3: Merge, confirm CI, tag**

```bash
git checkout main && git merge --no-ff phase-2a-reads
git push origin main
glab ci list --per-page 1
git tag -a phase-2a-complete -m "Phase 2a: query API"
git push origin phase-2a-complete
```

---

## Definition of done

Every checkbox, Task 6 passing, CI green.

**Not in this phase:** the web interface, admin-token sessions, the diff viewer, and
Playwright — all Phase 2b.
