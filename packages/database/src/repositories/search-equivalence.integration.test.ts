import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createKeyring, searchTokens } from "@wayscribe/payload-security";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { insertReturningId } from "../insert.js";
import { createKnexConfig } from "../knex-config.js";
import { orderJourneysAfter, toJourneyPage } from "./journey-keyset.js";
import { journeySummaryColumns } from "./journey-summary.js";
import type { ReadScope } from "./read-scope.js";
import { searchJourneys, type SearchHit, type SearchPage } from "./search.js";

/**
 * The search query as it was before the UNION rewrite, kept verbatim as the
 * definition of what search returns.
 *
 * It walked every journey in the project (1.5 s at 120,000 journeys), which is
 * why it was replaced, but its semantics were the ones the API shipped with.
 * Here it only has to be obviously right, not fast.
 */
async function referenceSearch(
  db: Knex,
  scope: ReadScope,
  query: string,
  tokens: readonly string[],
  limit: number,
  cursor?: string
): Promise<SearchPage> {
  const statement = db
    .with("matches", (builder) => {
      void builder
        .select("j.id")
        .from({ j: "journeys" })
        .where("j.project_id", scope.projectId)
        .modify((scoped) => {
          if (scope.environmentId !== undefined) {
            void scoped.andWhere("j.environment_id", scope.environmentId);
          }
        })
        .andWhere((where) => {
          void where
            .where("j.id", query)
            .orWhereIn("j.primary_entity_id_hash", tokens)
            .orWhereExists((exists) => {
              void exists
                .select(db.raw("1"))
                .from({ a: "entity_aliases" })
                .whereRaw("a.project_id = j.project_id and a.journey_id = j.id")
                .whereIn("a.alias_value_hash", tokens);
            })
            .orWhereExists((exists) => {
              void exists
                .select(db.raw("1"))
                .from({ e: "journey_events" })
                .whereRaw("e.project_id = j.project_id and e.journey_id = j.id")
                .andWhere((technical) => {
                  void technical
                    .where("e.trace_id", query)
                    .orWhere("e.span_id", query)
                    .orWhere("e.message_id", query)
                    .orWhere("e.correlation_id", query);
                });
            });
        });
    })
    .select(...journeySummaryColumns(db))
    .from({ j: "journeys" })
    .join("matches", "matches.id", "j.id")
    .where("j.project_id", scope.projectId);

  const rows: unknown = await orderJourneysAfter(statement, "j", limit, cursor);
  return toJourneyPage(rows as SearchHit[], limit);
}

/**
 * mulberry32: a fixed seed makes a failure reproducible. Math.random would
 * find a different data set on every run, and a failure seen once could not be
 * looked at again.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const SEED = 20_260_915;

const KEY_A = "0123456789abcdef0123456789abcdef";
const KEY_B = "fedcba9876543210fedcba9876543210";
const underA = createKeyring(KEY_A);
const underB = createKeyring(KEY_B);
/** A search during a rotation from A to B matches either key's token. */
const rotating = createKeyring(KEY_B, KEY_A);

/**
 * Values that mean something to SQL or to LIKE. Search compares with `=` and
 * bound parameters, so each must match only itself; a query that ever
 * interpolated or pattern-matched would return more.
 */
const SQL_SIGNIFICANT = [
  "%",
  "_",
  "val-%",
  "O'Brien",
  "' or '1'='1",
  "back\\slash",
  "semi;colon -- comment",
  '"double"',
  "jrn_%"
];

describe("searchJourneys matches the reference query", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  const scopes: { name: string; scope: ReadScope }[] = [];
  const values: string[] = [];
  /** The environment each project's multi-branch journey was recorded in. */
  const multiBranchEnvironment = new Map<string, string>();

  beforeAll(async () => {
    container = await new PostgreSqlContainer(inject("postgresImage")).start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();

    const random = seededRandom(SEED);
    const pick = <T>(items: readonly T[]): T => {
      const item = items[Math.floor(random() * items.length)];
      if (item === undefined) throw new Error("pick from an empty list");
      return item;
    };

    const valuePool = [
      ...Array.from({ length: 30 }, (_, n) => `val-${String(n)}`),
      ...SQL_SIGNIFICANT
    ];
    // Journey ids overlap the value pool on purpose, so a technical identifier
    // or an alias can equal some other journey's id and match through two
    // branches at once.
    const idPool = [
      ...Array.from({ length: 150 }, (_, n) => `jrn_${String(n)}`),
      "jrn_'quote",
      "jrn_%",
      "val-3",
      "%"
    ];
    // Few enough instants that many journeys share one, so page boundaries
    // fall inside ties and only the id tiebreaker keeps the order total.
    const instants = Array.from(
      { length: 12 },
      (_, n) => new Date(Date.UTC(2026, 8, 1, 10, n * 5))
    );

    for (const slug of ["p1", "p2"]) {
      const projectId = await insertReturningId(db, "projects", { name: slug, slug });
      const environmentIds = [
        await insertReturningId(db, "environments", { project_id: projectId, name: "development" }),
        await insertReturningId(db, "environments", { project_id: projectId, name: "staging" })
      ];
      scopes.push({ name: `${slug} project-wide`, scope: { projectId } });
      for (const [index, environmentId] of environmentIds.entries()) {
        scopes.push({
          name: `${slug} environment ${String(index)}`,
          scope: { projectId, environmentId }
        });
      }

      // Both projects draw most of the same ids, so the same journey id exists
      // in each with different values behind it.
      const ids = idPool.filter(() => random() < 0.85);
      let eventNumber = 0;

      for (const id of ids) {
        const environmentId = pick(environmentIds);
        const keyring = random() < 0.5 ? underA : underB;
        const token = (value: string): string => searchTokens(keyring, value)[0] ?? "";
        const at = pick(instants);

        await db("journeys").insert({
          id,
          project_id: projectId,
          environment_id: environmentId,
          entity_type: "customer",
          primary_entity_id_hash: token(pick(valuePool)),
          status: "active",
          started_at: at,
          last_event_at: at,
          event_count: 0
        });

        const aliases = new Map<string, Record<string, unknown>>();
        for (let n = Math.floor(random() * 4); n > 0; n -= 1) {
          const aliasType = pick(["salesforceAccountId", "internalCustomerId"]);
          const hash = token(pick(valuePool));
          aliases.set(`${aliasType}:${hash}`, {
            project_id: projectId,
            journey_id: id,
            alias_type: aliasType,
            alias_value_hash: hash
          });
        }
        if (aliases.size > 0) await db("entity_aliases").insert([...aliases.values()]);

        const technical = (): string | null =>
          random() < 0.5 ? null : random() < 0.7 ? pick(valuePool) : pick(idPool);
        for (let n = Math.floor(random() * 5); n > 0; n -= 1) {
          eventNumber += 1;
          await db("journey_events").insert({
            id: `evt_${String(eventNumber)}`,
            project_id: projectId,
            // Now and then another environment than the journey's: ingestion
            // attaches an event to an existing journey whichever environment
            // sent it, and search has always scoped by the journey's.
            environment_id: random() < 0.1 ? pick(environmentIds) : environmentId,
            journey_id: id,
            protocol_version: "0.1",
            content_hash: "h",
            operation: "received",
            name: "n",
            service: "s",
            event_timestamp: at,
            trace_id: technical(),
            span_id: technical(),
            message_id: technical(),
            correlation_id: technical()
          });
        }
      }

      // Pinned rather than left to chance: one journey found through every
      // branch at once, which must still come back as one row.
      const multiEnvironment = environmentIds[0] ?? "";
      multiBranchEnvironment.set(projectId, multiEnvironment);
      const multi = searchTokens(underA, "multi-branch")[0] ?? "";
      await db("journeys").insert({
        id: "multi-branch",
        project_id: projectId,
        environment_id: multiEnvironment,
        entity_type: "customer",
        primary_entity_id_hash: multi,
        status: "active",
        started_at: instants[0],
        last_event_at: instants[0],
        event_count: 2
      });
      await db("entity_aliases").insert({
        project_id: projectId,
        journey_id: "multi-branch",
        alias_type: "salesforceAccountId",
        alias_value_hash: multi
      });
      await db("journey_events").insert(
        ["a", "b"].map((suffix) => ({
          id: `evt_multi_${suffix}`,
          project_id: projectId,
          environment_id: multiEnvironment,
          journey_id: "multi-branch",
          protocol_version: "0.1",
          content_hash: "h",
          operation: "received",
          name: "n",
          service: "s",
          event_timestamp: instants[0],
          trace_id: "multi-branch",
          span_id: "multi-branch",
          message_id: "multi-branch",
          correlation_id: "multi-branch"
        }))
      );
    }

    values.push(
      ...valuePool,
      ...idPool.filter(() => random() < 0.3),
      "multi-branch",
      "no-such-value"
    );
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  /**
   * Walk every page with the reference query, handing each of its cursors to
   * the rewrite. Equal pages prove equal ordered results; that the rewrite
   * accepts the reference's cursors proves the cursor format did not move.
   */
  const comparePages = async (
    scope: ReadScope,
    value: string,
    tokens: readonly string[],
    limit: number
  ): Promise<string[]> => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const expected = await referenceSearch(db, scope, value, tokens, limit, cursor);
      const actual = await searchJourneys(db, scope, value, tokens, limit, cursor);
      expect(actual).toEqual(expected);
      seen.push(...expected.items.map((item) => item.journeyId));
      if (expected.nextCursor === null) return seen;
      cursor = expected.nextCursor;
    }
  };

  it("returns the same pages for every value, scope, and page size", async () => {
    const random = seededRandom(SEED + 1);
    let compared = 0;
    let nonEmpty = 0;
    let multiPage = 0;
    let previousKeyOnly = 0;

    for (const { scope } of scopes) {
      for (const value of values) {
        const tokens = random() < 0.5 ? searchTokens(underA, value) : searchTokens(rotating, value);
        const limit = [1, 2, 3, 25][Math.floor(random() * 4)] ?? 25;
        const seen = await comparePages(scope, value, tokens, limit);
        compared += 1;
        if (seen.length > 0) nonEmpty += 1;
        if (seen.length > limit) multiPage += 1;

        const [current, previous] = tokens;
        if (current !== undefined && previous !== undefined) {
          const underCurrentAlone = await referenceSearch(db, scope, value, [current], 1_000);
          const foundByCurrent = new Set(underCurrentAlone.items.map((item) => item.journeyId));
          if (seen.some((id) => !foundByCurrent.has(id))) previousKeyOnly += 1;
        }
      }
    }

    // Guards against a generator change that makes the comparison vacuous:
    // two empty pages are equal too.
    expect(compared).toBe(scopes.length * values.length);
    expect(nonEmpty).toBeGreaterThan(compared / 3);
    expect(multiPage).toBeGreaterThan(compared / 10);
    // Some results must depend on the previous key's token, or a rewrite that
    // matched the current token alone would pass: every journey written under
    // key A vanishes for a search during the rotation to B, and no comparison
    // here would have held one.
    expect(previousKeyOnly).toBeGreaterThan(0);
  });

  it("returns a journey found through every branch once", async () => {
    for (const { scope } of scopes) {
      const tokens = searchTokens(underA, "multi-branch");
      const page = await searchJourneys(db, scope, "multi-branch", tokens, 25);
      const visible =
        scope.environmentId === undefined ||
        scope.environmentId === multiBranchEnvironment.get(scope.projectId);
      const expected = visible ? 1 : 0;
      expect(page.items.map((item) => item.journeyId)).toEqual(
        Array.from({ length: expected }, () => "multi-branch")
      );
      expect(await comparePages(scope, "multi-branch", tokens, 25)).toHaveLength(expected);
    }
  });

  it("had journeys sharing an id across projects to tell apart", async () => {
    const shared: unknown = await db("journeys")
      .select("id")
      .groupBy("id")
      .havingRaw("count(distinct project_id) = 2");
    expect((shared as unknown[]).length).toBeGreaterThan(50);
  });
});
