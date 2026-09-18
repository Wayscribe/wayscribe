import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { insertReturningId } from "../insert.js";
import { createKnexConfig } from "../knex-config.js";
import { InvalidCursorError, encodeCursor } from "./cursors.js";
import { listJourneys, type JourneyListFilters } from "./journey-list.js";
import type { ReadScope } from "./read-scope.js";

describe("listJourneys", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  /** The admin's view: every environment of the project. */
  let project: ReadScope;
  /** An API key's view: development only. */
  let development: ReadScope;

  const SINCE = new Date("2026-09-15T00:00:00.000Z");

  beforeAll(async () => {
    container = await new PostgreSqlContainer(inject("postgresImage")).start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();

    const projectId = await insertReturningId(db, "projects", { name: "P", slug: "p" });
    const developmentId = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: "development"
    });
    const productionId = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: "production"
    });
    const otherProjectId = await insertReturningId(db, "projects", { name: "O", slug: "o" });
    const otherEnvironmentId = await insertReturningId(db, "environments", {
      project_id: otherProjectId,
      name: "development"
    });

    project = { projectId };
    development = { projectId, environmentId: developmentId };

    const journey = async (
      id: string,
      environmentId: string,
      status: string,
      lastEventAt: string,
      services: readonly string[] = [],
      owner: string = projectId
    ): Promise<void> => {
      await db("journeys").insert({
        id,
        project_id: owner,
        environment_id: environmentId,
        entity_type: "customer",
        primary_entity_id_hash: `hash-${id}`,
        status,
        started_at: lastEventAt,
        last_event_at: lastEventAt,
        event_count: services.length
      });
      for (const [index, service] of services.entries()) {
        await db("journey_events").insert({
          id: `${id}_evt_${String(index)}`,
          project_id: owner,
          environment_id: environmentId,
          journey_id: id,
          protocol_version: "0.1",
          content_hash: "h",
          operation: "received",
          name: "n",
          service,
          event_timestamp: lastEventAt
        });
      }
    };

    await journey("jrn_dev_failed", developmentId, "failed", "2026-09-15T10:00:00Z", [
      "sync-worker",
      "billing"
    ]);
    await journey("jrn_dev_completed", developmentId, "completed", "2026-09-15T11:00:00Z", [
      "billing"
    ]);
    await journey("jrn_dev_active", developmentId, "active", "2026-09-15T12:00:00Z");
    await journey("jrn_prod_failed", productionId, "failed", "2026-09-15T13:00:00Z", [
      "sync-worker"
    ]);
    await journey("jrn_prod_completed", productionId, "completed", "2026-09-15T14:00:00Z", [
      "sync-worker"
    ]);
    // Exactly on the bound, and one millisecond before it.
    await journey("jrn_at_since", developmentId, "failed", "2026-09-15T00:00:00.000Z");
    await journey("jrn_before_since", developmentId, "failed", "2026-09-14T23:59:59.999Z");
    // Another project's failure, newer than everything above.
    await journey(
      "jrn_other_project",
      otherEnvironmentId,
      "failed",
      "2026-09-15T15:00:00Z",
      ["sync-worker"],
      otherProjectId
    );
    // Journey ids are chosen by the client, so another project can reuse one of
    // P's. Its events must not satisfy P's service filter.
    await journey(
      "jrn_dev_active",
      otherEnvironmentId,
      "active",
      "2026-09-15T12:00:00Z",
      ["only-in-other-project"],
      otherProjectId
    );
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  const ids = async (
    scope: ReadScope,
    filters: Partial<JourneyListFilters> = {},
    limit = 25
  ): Promise<string[]> => {
    const page = await listJourneys(db, scope, { since: SINCE, ...filters }, limit);
    return page.items.map((item) => item.journeyId);
  };

  it("lists every status in the window, newest activity first", async () => {
    expect(await ids(project)).toEqual([
      "jrn_prod_completed",
      "jrn_prod_failed",
      "jrn_dev_active",
      "jrn_dev_completed",
      "jrn_dev_failed",
      "jrn_at_since"
    ]);
  });

  it("returns the journey summary with its environment name", async () => {
    const page = await listJourneys(db, project, { since: SINCE, service: "billing" }, 1);
    expect(page.items[0]).toEqual({
      journeyId: "jrn_dev_completed",
      entityType: "customer",
      encryptedPrimaryEntityId: null,
      status: "completed",
      eventCount: 1,
      startedAt: new Date("2026-09-15T11:00:00Z"),
      lastEventAt: new Date("2026-09-15T11:00:00Z"),
      label: null,
      lastStep: null,
      failedStep: null,
      displayableAliases: [],
      environment: "development"
    });
  });

  it("filters by status", async () => {
    expect(await ids(project, { status: "failed" })).toEqual([
      "jrn_prod_failed",
      "jrn_dev_failed",
      "jrn_at_since"
    ]);
    expect(await ids(project, { status: "active" })).toEqual(["jrn_dev_active"]);
  });

  it("filters by environment name", async () => {
    expect(await ids(project, { environment: "production" })).toEqual([
      "jrn_prod_completed",
      "jrn_prod_failed"
    ]);
  });

  it("returns nothing for an environment the project does not have", async () => {
    expect(await ids(project, { environment: "no-such-environment" })).toEqual([]);
  });

  it("filters to journeys with at least one event from the service", async () => {
    expect(await ids(project, { service: "sync-worker" })).toEqual([
      "jrn_prod_completed",
      "jrn_prod_failed",
      "jrn_dev_failed"
    ]);
  });

  it("ignores another project's events on a journey with the same id", async () => {
    expect(await ids(project, { service: "only-in-other-project" })).toEqual([]);
  });

  it("matches the service exactly", async () => {
    expect(await ids(project, { service: "sync" })).toEqual([]);
    expect(await ids(project, { service: "SYNC-WORKER" })).toEqual([]);
  });

  it("combines every filter", async () => {
    expect(
      await ids(project, { status: "failed", environment: "production", service: "sync-worker" })
    ).toEqual(["jrn_prod_failed"]);
    expect(
      await ids(project, { status: "failed", environment: "development", service: "sync-worker" })
    ).toEqual(["jrn_dev_failed"]);
    expect(
      await ids(project, {
        status: "completed",
        environment: "development",
        service: "sync-worker"
      })
    ).toEqual([]);
  });

  it("includes a journey whose last activity is exactly at since", async () => {
    const found = await ids(project, { status: "failed" });
    expect(found).toContain("jrn_at_since");
    expect(found).not.toContain("jrn_before_since");
  });

  it("limits an environment-scoped caller to its own environment", async () => {
    expect(await ids(development)).toEqual([
      "jrn_dev_active",
      "jrn_dev_completed",
      "jrn_dev_failed",
      "jrn_at_since"
    ]);
  });

  it("returns an empty page when a scoped caller asks for another environment", async () => {
    // Search treats scope the same way: outside it, nothing exists.
    expect(await ids(development, { environment: "production" })).toEqual([]);
    // The control: the same filter from the project-wide scope finds rows.
    expect(await ids(project, { environment: "production" })).not.toEqual([]);
  });

  it("never returns another project's journeys", async () => {
    expect(await ids(project, { service: "sync-worker" })).not.toContain("jrn_other_project");
    expect(await ids(project)).not.toContain("jrn_other_project");
  });

  describe("pagination", () => {
    // Before SINCE and in an environment of their own, so these rows never
    // reach the tests above whatever order they run in.
    const TIED_AT = "2026-09-10T09:00:00.000Z";
    const staging = { since: new Date(TIED_AT), environment: "staging" };

    beforeAll(async () => {
      const stagingId = await insertReturningId(db, "environments", {
        project_id: project.projectId,
        name: "staging"
      });
      // Five journeys sharing one last_event_at, so a page boundary falls
      // inside the tie and only the id tiebreaker keeps the order total.
      for (const suffix of ["a", "b", "c", "d", "e"]) {
        await db("journeys").insert({
          id: `jrn_tie_${suffix}`,
          project_id: project.projectId,
          environment_id: stagingId,
          entity_type: "customer",
          primary_entity_id_hash: `hash-tie-${suffix}`,
          status: "active",
          started_at: TIED_AT,
          last_event_at: TIED_AT,
          event_count: 0
        });
      }
    });

    it("walks a tie across page boundaries without skipping or repeating", async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await listJourneys(db, project, staging, 2, cursor);
        seen.push(...page.items.map((item) => item.journeyId));
        cursor = page.nextCursor ?? undefined;
        pages += 1;
      } while (cursor !== undefined && pages < 10);

      expect(seen).toEqual(["jrn_tie_e", "jrn_tie_d", "jrn_tie_c", "jrn_tie_b", "jrn_tie_a"]);
      expect(pages).toBe(3);
    });

    it("returns no cursor when the last page is exactly full", async () => {
      const page = await listJourneys(db, project, staging, 5);
      expect(page.items).toHaveLength(5);
      expect(page.nextCursor).toBeNull();
    });

    it("rejects a malformed cursor rather than silently restarting", async () => {
      await expect(listJourneys(db, project, staging, 2, "not-a-cursor")).rejects.toThrow(
        InvalidCursorError
      );
    });

    it.each(["not-a-date", "1", "March 7", "2026-09-10 09:00:00Z"])(
      "rejects a well-formed cursor whose timestamp is %j",
      async (lastEventAt) => {
        const cursor = encodeCursor({ lastEventAt, id: "jrn_tie_c" });
        await expect(listJourneys(db, project, staging, 2, cursor)).rejects.toThrow(
          InvalidCursorError
        );
      }
    );
  });

  describe("browse filters", () => {
    // In environments of their own and before SINCE, so these rows never reach
    // the tests above, which list from SINCE with no upper bound.
    const WINDOW = {
      since: new Date("2026-09-12T00:00:00.000Z"),
      until: new Date("2026-09-13T12:00:00.000Z")
    };
    const browse = { ...WINDOW, environment: "browse" };
    let browseId: string;
    let hiddenId: string;
    let otherProject: ReadScope;

    interface Alias {
      type: string;
      value: string;
      displayable: boolean;
    }

    const row = async (
      id: string,
      environmentId: string,
      lastEventAt: string,
      fields: {
        label?: string | undefined;
        lastStep?: string;
        entityType?: string;
        entityCiphertext?: string;
        entityHash?: string;
        aliases?: readonly Alias[];
        owner?: string;
      } = {}
    ): Promise<void> => {
      const owner = fields.owner ?? project.projectId;
      await db("journeys").insert({
        id,
        project_id: owner,
        environment_id: environmentId,
        entity_type: fields.entityType ?? "job_posting",
        primary_entity_id_hash: fields.entityHash ?? `hash-${id}`,
        encrypted_primary_entity_id: fields.entityCiphertext ?? null,
        status: "active",
        started_at: lastEventAt,
        last_event_at: lastEventAt,
        event_count: 1,
        label: fields.label ?? null,
        label_at: fields.label === undefined ? null : lastEventAt,
        label_event_id: fields.label === undefined ? null : `${id}_evt`,
        last_step: fields.lastStep ?? null,
        last_step_at: fields.lastStep === undefined ? null : lastEventAt,
        last_step_event_id: fields.lastStep === undefined ? null : `${id}_evt`
      });
      for (const alias of fields.aliases ?? []) {
        await db("entity_aliases").insert({
          project_id: owner,
          journey_id: id,
          alias_type: alias.type,
          // A masked alias is stored as a token and ciphertext only. Here both
          // hold the plain value on purpose, so a match through either column
          // would show up as a hit.
          alias_value_hash: alias.value,
          encrypted_display_value: alias.value,
          displayable: alias.displayable,
          display_value: alias.displayable ? alias.value : null
        });
      }
    };

    const found = async (
      filters: Partial<JourneyListFilters>,
      scope: ReadScope = project
    ): Promise<string[]> => ids(scope, { ...browse, ...filters }, 100);

    beforeAll(async () => {
      browseId = await insertReturningId(db, "environments", {
        project_id: project.projectId,
        name: "browse"
      });
      hiddenId = await insertReturningId(db, "environments", {
        project_id: project.projectId,
        name: "browse-hidden"
      });
      const otherProjectId = await insertReturningId(db, "projects", {
        name: "Browse other",
        slug: "browse-other"
      });
      const otherEnvironmentId = await insertReturningId(db, "environments", {
        project_id: otherProjectId,
        name: "browse"
      });
      otherProject = { projectId: otherProjectId };

      await row("jrn_b_label", browseId, "2026-09-13T11:00:00Z", {
        label: "Mirantis · Senior SWE, AI Infra",
        lastStep: "identify"
      });
      await row("jrn_b_alias", browseId, "2026-09-13T10:00:00Z", {
        aliases: [
          { type: "postingId", value: "greenhouse:4567", displayable: true },
          { type: "recruiterEmail", value: "someone@example.com", displayable: false }
        ]
      });
      // The same text as an entity id, its token, and a masked alias value.
      await row("jrn_b_masked", browseId, "2026-09-13T09:00:00Z", {
        entityCiphertext: "quokka-7",
        entityHash: "quokka-7",
        aliases: [{ type: "accountId", value: "quokka-7", displayable: false }]
      });
      // An id and an entity type are not searched either.
      await row("jrn_b_wombat", browseId, "2026-09-13T08:30:00Z", { entityType: "wombat" });
      await row("jrn_b_percent", browseId, "2026-09-13T08:00:00Z", { label: "100% done" });
      await row("jrn_b_percent_decoy", browseId, "2026-09-13T07:59:00Z", { label: "1000 done" });
      await row("jrn_b_underscore", browseId, "2026-09-13T07:00:00Z", { label: "run a_b" });
      await row("jrn_b_underscore_decoy", browseId, "2026-09-13T06:59:00Z", { label: "run aXb" });
      await row("jrn_b_backslash", browseId, "2026-09-13T06:00:00Z", { label: "back\\slash" });
      await row("jrn_b_backslash_decoy", browseId, "2026-09-13T05:59:00Z", {
        label: "backslash"
      });
      // A backslash before a percent sign, and a decoy an unescaped \%
      // would match.
      await row("jrn_b_backslash_percent", browseId, "2026-09-13T05:30:00Z", {
        label: "rate \\% here"
      });
      await row("jrn_b_backslash_percent_decoy", browseId, "2026-09-13T05:29:00Z", {
        label: "rate % here"
      });
      await row("jrn_b_accent", browseId, "2026-09-13T05:00:00Z", { label: "Café Été" });
      await row("jrn_b_order", browseId, "2026-09-13T04:00:00Z", {
        entityType: "order",
        label: "Order for Mirantis",
        aliases: [
          { type: "zeta", value: "Mirantis zeta", displayable: true },
          { type: "alpha", value: "second", displayable: true },
          { type: "alpha", value: "first", displayable: true },
          { type: "beta", value: "hidden", displayable: false }
        ]
      });
      // Outside the window on either side.
      await row("jrn_b_before", browseId, "2026-09-11T23:59:59.999Z", { label: "Mirantis early" });
      await row("jrn_b_at_until", browseId, "2026-09-13T12:00:00.000Z", {
        label: "Mirantis at until"
      });
      await row("jrn_b_just_before_until", browseId, "2026-09-13T11:59:59.999Z", {
        label: "Mirantis just before until"
      });
      // Another environment of the same project, and another project.
      await row("jrn_b_hidden", hiddenId, "2026-09-13T11:30:00Z", { label: "Mirantis hidden" });
      await row("jrn_b_other", otherEnvironmentId, "2026-09-13T11:30:00Z", {
        label: "Mirantis other project",
        owner: otherProjectId
      });
    });

    it("returns the label, the last step and the displayable values on each row", async () => {
      const page = await listJourneys(db, project, { ...browse, text: "Mirantis" }, 100);
      const byId = new Map(page.items.map((item) => [item.journeyId, item]));
      expect(byId.get("jrn_b_label")).toMatchObject({
        label: "Mirantis · Senior SWE, AI Infra",
        lastStep: "identify",
        displayableAliases: []
      });
      // In alias type order, then by value; the masked alias is left out.
      expect(byId.get("jrn_b_order")).toMatchObject({
        label: "Order for Mirantis",
        lastStep: null,
        displayableAliases: [
          { type: "alpha", value: "first" },
          { type: "alpha", value: "second" },
          { type: "zeta", value: "Mirantis zeta" }
        ]
      });
    });

    it("leaves a masked alias out of the row", async () => {
      const page = await listJourneys(db, project, { ...browse, text: "greenhouse" }, 100);
      expect(page.items.map((item) => [item.journeyId, item.displayableAliases])).toEqual([
        ["jrn_b_alias", [{ type: "postingId", value: "greenhouse:4567" }]]
      ]);
    });

    it("finds by label and by displayable value", async () => {
      expect(await found({ text: "senior swe" })).toEqual(["jrn_b_label"]);
      expect(await found({ text: "house:45" })).toEqual(["jrn_b_alias"]);
      // One row per journey, however many of its values match.
      expect(await found({ text: "Mirantis" })).toEqual([
        "jrn_b_just_before_until",
        "jrn_b_label",
        "jrn_b_order"
      ]);
    });

    it("never matches a masked alias value, an entity id, its token or an entity type", async () => {
      expect(await found({ text: "quokka" })).toEqual([]);
      expect(await found({ text: "example.com" })).toEqual([]);
      expect(await found({ text: "hidden" })).toEqual([]);
      expect(await found({ text: "wombat" })).toEqual([]);
      expect(await found({ text: "jrn_b" })).toEqual([]);
      // The control: the same rows are in the window.
      expect(await found({})).toEqual(expect.arrayContaining(["jrn_b_masked", "jrn_b_wombat"]));
    });

    it.each([
      ["100%", ["jrn_b_percent"]],
      ["a_b", ["jrn_b_underscore"]],
      ["k\\s", ["jrn_b_backslash"]],
      ["\\", ["jrn_b_backslash", "jrn_b_backslash_percent"]],
      ["e \\%", ["jrn_b_backslash_percent"]],
      ["\\%", ["jrn_b_backslash_percent"]],
      ["%%", []],
      ["__", []]
    ])("treats %j literally", async (text, expected) => {
      // A two-character minimum is the route's rule, not this function's.
      expect(await found({ text })).toEqual(expected);
    });

    it("ignores ASCII case", async () => {
      expect(await found({ text: "MIRANTIS · SENIOR" })).toEqual(["jrn_b_label"]);
      expect(await found({ text: "GREENHOUSE" })).toEqual(["jrn_b_alias"]);
    });

    it("ignores the case of an accented letter under the database's collation", async () => {
      // ILIKE lowers both sides with the database's LC_CTYPE. The test image,
      // postgres:17-alpine, is initialised with en_US.utf8, which lowers É to
      // é; a database created with LC_CTYPE C would lower ASCII only.
      const ctype: { rows: { ctype: string }[] } = await db.raw(
        "select datctype as ctype from pg_database where datname = current_database()"
      );
      expect(ctype.rows[0]?.ctype).toBe("en_US.utf8");
      expect(await found({ text: "CAFÉ" })).toEqual(["jrn_b_accent"]);
      expect(await found({ text: "été" })).toEqual(["jrn_b_accent"]);
      // Accents are not folded away: e does not match é.
      expect(await found({ text: "cafe" })).toEqual([]);
    });

    it("bounds the window with until, exclusive, and since, inclusive", async () => {
      expect(await found({ text: "Mirantis" })).not.toContain("jrn_b_at_until");
      expect(await found({ text: "Mirantis" })).toContain("jrn_b_just_before_until");
      expect(await found({ text: "Mirantis early" })).toEqual([]);
      expect(
        await found({ text: "Mirantis early", since: new Date("2026-09-11T23:59:59.999Z") })
      ).toEqual(["jrn_b_before"]);
      // Without until the list runs to the newest journey.
      expect(await found({ text: "Mirantis at", until: undefined })).toEqual(["jrn_b_at_until"]);
    });

    it("filters by entity type exactly", async () => {
      expect(await found({ entityType: "order" })).toEqual(["jrn_b_order"]);
      expect(await found({ entityType: "ORDER" })).toEqual([]);
      expect(await found({ entityType: "ord" })).toEqual([]);
      expect(await found({ entityType: "job_posting", text: "Mirantis" })).toEqual([
        "jrn_b_just_before_until",
        "jrn_b_label"
      ]);
    });

    it("keeps to the caller's scope", async () => {
      const hidden = { projectId: project.projectId, environmentId: hiddenId };
      // Environment scope, with no environment filter.
      expect(
        await ids(hidden, { since: WINDOW.since, until: WINDOW.until, text: "Mirantis" }, 100)
      ).toEqual(["jrn_b_hidden"]);
      const browseScope = { projectId: project.projectId, environmentId: browseId };
      expect(
        await ids(browseScope, { since: WINDOW.since, until: WINDOW.until, text: "hidden" }, 100)
      ).toEqual([]);
      // Another project's journeys are never found, and it never finds P's.
      expect(
        await ids(project, { since: WINDOW.since, until: WINDOW.until, text: "other project" }, 100)
      ).toEqual([]);
      expect(
        await ids(otherProject, { since: WINDOW.since, until: WINDOW.until, text: "Mirantis" }, 100)
      ).toEqual(["jrn_b_other"]);
    });

    it("probes aliases per journey in the window rather than hashing the whole table", async () => {
      // An EXISTS under OR can be planned as a hashed subplan, which reads
      // every alias of every project before the window. The plan must not
      // contain one, whatever text is asked for.
      const statements: { sql: string; bindings: readonly unknown[] }[] = [];
      const capture = (query: { sql: string; bindings: readonly unknown[] }): void => {
        statements.push(query);
      };
      db.on("query", capture);
      try {
        await listJourneys(db, project, { ...browse, text: "nothing matches this" }, 25);
      } finally {
        db.removeListener("query", capture);
      }
      const statement = statements[0];
      expect(statement).toBeDefined();
      const connection = (await db.client.acquireConnection()) as {
        query: (sql: string, values: readonly unknown[]) => Promise<{ rows: unknown[] }>;
      };
      try {
        const plan = await connection.query(
          `explain (format json) ${statement?.sql ?? ""}`,
          statement?.bindings ?? []
        );
        const text = JSON.stringify(plan.rows);
        expect(text).toContain("entity_aliases");
        expect(text).not.toContain("hashed SubPlan");
      } finally {
        await db.client.releaseConnection(connection);
      }
    });

    describe("paging with filters", () => {
      const PAGING = {
        since: new Date("2026-09-11T00:00:00.000Z"),
        until: new Date("2026-09-11T03:00:00.000Z"),
        environment: "browse-paging"
      };
      /** Every row this block inserts, with what the filter below should keep. */
      const expected: string[] = [];

      beforeAll(async () => {
        const pagingId = await insertReturningId(db, "environments", {
          project_id: project.projectId,
          name: "browse-paging"
        });
        // Thirty journeys over three shared timestamps, so page boundaries
        // fall inside ties; a mix of label hits, alias hits and misses, two
        // entity types, and a few past until.
        const stamps = [
          "2026-09-11T01:00:00.000Z",
          "2026-09-11T02:00:00.000Z",
          "2026-09-11T03:00:00.000Z"
        ];
        const rows: { id: string; at: string; keep: boolean }[] = [];
        for (let index = 0; index < 30; index += 1) {
          const id = `jrn_p_${String(index).padStart(2, "0")}`;
          const at = stamps[index % 3] ?? "";
          const entityType = index % 4 === 0 ? "order" : "job_posting";
          const kind = index % 5;
          const label =
            kind === 0 ? `Needle ${String(index)}` : kind === 1 ? "haystack" : undefined;
          const aliases: Alias[] =
            kind === 2
              ? [{ type: "postingId", value: `x-NEEDLE-${String(index)}`, displayable: true }]
              : kind === 3
                ? [{ type: "postingId", value: `needle-${String(index)}`, displayable: false }]
                : [];
          await row(id, pagingId, at, { entityType, label, aliases });
          const matches = kind === 0 || kind === 2;
          rows.push({
            id,
            at,
            keep: matches && entityType === "job_posting" && at < PAGING.until.toISOString()
          });
        }
        rows.sort((a, b) => (a.at === b.at ? b.id.localeCompare(a.id) : b.at.localeCompare(a.at)));
        expected.push(...rows.filter((one) => one.keep).map((one) => one.id));
      });

      const walk = async (
        filters: Partial<JourneyListFilters>,
        limit: number,
        start?: string
      ): Promise<string[]> => {
        const seen: string[] = [];
        let cursor = start;
        for (let pages = 0; pages < 100; pages += 1) {
          const page = await listJourneys(db, project, { ...PAGING, ...filters }, limit, cursor);
          seen.push(...page.items.map((item) => item.journeyId));
          if (page.nextCursor === null) return seen;
          cursor = page.nextCursor;
        }
        throw new Error("paging did not end");
      };

      it.each([1, 2, 3, 7])(
        "returns every matching row exactly once at page size %i",
        async (limit) => {
          expect(expected.length).toBeGreaterThan(3);
          expect(await walk({ text: "needle", entityType: "job_posting" }, limit)).toEqual(
            expected
          );
        }
      );

      it("continues from a cursor's position under whatever filters come with it", async () => {
        // The cursor holds a position only. One taken from the unfiltered list
        // continues the filtered list after that position: no row at or above
        // it, and every matching row below it.
        const first = await listJourneys(db, project, PAGING, 4);
        const last = first.items.at(-1);
        expect(first.nextCursor).not.toBeNull();
        expect(last).toBeDefined();
        const rest = await walk(
          { text: "needle", entityType: "job_posting" },
          2,
          first.nextCursor ?? undefined
        );
        const unfiltered = await walk({}, 100);
        const position = unfiltered.indexOf(last?.journeyId ?? "");
        const below = new Set(unfiltered.slice(position + 1));
        expect(rest).toEqual(expected.filter((id) => below.has(id)));
        expect(rest.length).toBeLessThan(expected.length);
      });
    });
  });
});
