import { startPostgres, type TestDatabase } from "@wayscribe/database/testing";
import { createKnexConfig, insertReturningId } from "@wayscribe/database";
import { createKeyring, issueApiKey } from "@wayscribe/payload-security";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");
const ADMIN_TOKEN = "admin-token-for-tests-0000000000";

const HOUR = 60 * 60 * 1000;
/** Relative to the real clock, because since may not be in the future. */
const hoursAgo = (hours: number): string => new Date(Date.now() - hours * HOUR).toISOString();

interface Row {
  journeyId: string;
  environment: string;
  entity: { type: string; id: string | null };
  label: string | null;
  lastStep: string | null;
  displayableAliases: { type: string; value: string }[];
}

/**
 * The browse filters of `GET /v1/journeys` through the real routes: events are
 * ingested for real, so labels, last steps and plain-text alias copies are
 * what ingestion writes, and masked values are real ciphertext and tokens.
 */
describe("GET /v1/journeys browse filters", () => {
  let container: TestDatabase;
  let db: Knex;
  let app: FastifyInstance;
  let projectId: string;
  let browseKey: string;
  let otherKey: string;
  /** Fixed once, so every request in a test lists the same window. */
  let since: string;

  beforeAll(async () => {
    container = await startPostgres();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();

    projectId = await insertReturningId(db, "projects", { name: "P", slug: "p" });
    const storeKey = async (environment: string): Promise<string> => {
      const environmentId = await insertReturningId(db, "environments", {
        project_id: projectId,
        name: environment
      });
      const generated = issueApiKey(keyring);
      await db("api_keys").insert({
        project_id: projectId,
        environment_id: environmentId,
        name: environment,
        key_prefix: generated.keyPrefix,
        key_hash: generated.verifier,
        key_hash_key_id: generated.keyHashKeyId
      });
      return generated.apiKey;
    };
    browseKey = await storeKey("browse");
    otherKey = await storeKey("other");
    app = buildApp({ db, keyring, adminToken: ADMIN_TOKEN, logLevel: "silent" });
    since = hoursAgo(24);

    const ingest = async (
      key: string,
      environment: string,
      event: Record<string, unknown>
    ): Promise<void> => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { authorization: `Bearer ${key}` },
        payload: {
          protocolVersion: "0.1",
          event: {
            environment,
            service: "job-sweep",
            operation: "received",
            name: "sweep-board",
            entity: { type: "job_posting", id: `posting-${String(event["journeyId"])}` },
            ...event
          }
        } as object
      });
      expect(response.statusCode, response.body).toBe(202);
    };

    await ingest(browseKey, "browse", {
      id: "evt_label_1",
      journeyId: "jrn_label",
      timestamp: hoursAgo(5),
      journeyLabel: "Mirantis · Senior SWE, AI Infra"
    });
    // A later event without a label keeps it, and moves the last step on.
    await ingest(browseKey, "browse", {
      id: "evt_label_2",
      journeyId: "jrn_label",
      operation: "identified",
      name: "identify",
      timestamp: hoursAgo(4)
    });
    await ingest(browseKey, "browse", {
      id: "evt_alias",
      journeyId: "jrn_alias",
      timestamp: hoursAgo(3),
      aliases: { postingId: "greenhouse:4567", recruiterEmail: "someone@example.com" },
      displayableAliases: ["postingId"]
    });
    // The same text as the entity id and as a masked alias value.
    await ingest(browseKey, "browse", {
      id: "evt_masked",
      journeyId: "jrn_masked",
      timestamp: hoursAgo(2),
      entity: { type: "customer", id: "quokka-7" },
      aliases: { accountId: "quokka-7" }
    });
    await ingest(browseKey, "browse", {
      id: "evt_accent",
      journeyId: "jrn_accent",
      timestamp: hoursAgo(6),
      journeyLabel: "Café Été"
    });
    await ingest(browseKey, "browse", {
      id: "evt_literal",
      journeyId: "jrn_literal",
      timestamp: hoursAgo(7),
      journeyLabel: "100% a_b back\\slash"
    });
    // A backslash before a percent sign, and one at the very end.
    await ingest(browseKey, "browse", {
      id: "evt_escape",
      journeyId: "jrn_escape",
      timestamp: hoursAgo(8),
      journeyLabel: "rate \\% of total, ends with \\"
    });
    await ingest(browseKey, "browse", {
      id: "evt_escape_decoy",
      journeyId: "jrn_escape_decoy",
      timestamp: hoursAgo(8.5),
      journeyLabel: "rate \\ of total, rate % of total"
    });
    await ingest(browseKey, "browse", {
      id: "evt_decoy",
      journeyId: "jrn_decoy",
      timestamp: hoursAgo(7.5),
      journeyLabel: "1000 aXb backslash"
    });
    await ingest(otherKey, "other", {
      id: "evt_other",
      journeyId: "jrn_other",
      timestamp: hoursAgo(1),
      journeyLabel: "Mirantis in another environment"
    });
    // Before the window.
    await ingest(browseKey, "browse", {
      id: "evt_old",
      journeyId: "jrn_old",
      timestamp: hoursAgo(30),
      journeyLabel: "Mirantis long ago"
    });
    // Twelve journeys to page through, half of them matching, over three
    // shared instants so page boundaries fall inside ties.
    const base = Date.now();
    for (let index = 0; index < 12; index += 1) {
      await ingest(browseKey, "browse", {
        id: `evt_page_${String(index)}`,
        journeyId: `jrn_page_${String(index).padStart(2, "0")}`,
        timestamp: new Date(base - (10 + (index % 3)) * HOUR).toISOString(),
        ...(index % 2 === 0
          ? { journeyLabel: `pager ${String(index)}` }
          : { journeyLabel: `other ${String(index)}` })
      });
    }
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await container.stop();
  });

  const get = (url: string, token: string = browseKey): Promise<LightMyRequestResponse> =>
    app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

  const asAdmin = (url: string): Promise<LightMyRequestResponse> =>
    app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "x-wayscribe-project-id": projectId }
    });

  const list = (query: string): string =>
    `/v1/journeys?since=${encodeURIComponent(since)}${query === "" ? "" : `&${query}`}`;

  const rows = (response: LightMyRequestResponse): Row[] => {
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ data: { items: Row[] } }>().data.items;
  };
  const ids = (response: LightMyRequestResponse): string[] =>
    rows(response).map((row) => row.journeyId);

  const q = (text: string): string => `q=${encodeURIComponent(text)}`;

  describe("validation", () => {
    const NUL = "%00";
    const INSTANT =
      "until must be an ISO-8601 instant with a time zone, such as 2026-08-06T18:00:00Z.";

    it.each([
      // since, which until is checked against
      ["no since at all", "q=abc", /^since is required/],
      // until
      ["a malformed until", "until=tomorrow", INSTANT],
      ["an until with no zone", "until=2026-09-16T00:00:00", INSTANT],
      ["an impossible until", "until=2026-02-30T00:00:00Z", INSTANT],
      [
        "an until holding NUL",
        `until=2099-01-01T00:00:00Z${NUL}`,
        "until must not contain a null byte."
      ],
      [
        "a repeated until",
        "until=2099-01-01T00:00:00Z&until=2099-01-02T00:00:00Z",
        "until must be given once."
      ],
      ["an until equal to since", "until=SINCE", "until must be after since."],
      ["an until before since", "until=2000-01-01T00:00:00Z", "until must be after since."],
      // entityType
      [
        "an entityType holding NUL",
        `entityType=job${NUL}`,
        "entityType must not contain a null byte."
      ],
      [
        "an entityType longer than the protocol allows",
        `entityType=${"t".repeat(129)}`,
        "entityType must be at most 128 characters."
      ],
      ["a repeated entityType", "entityType=a&entityType=b", "entityType must be given once."],
      // q
      ["a one-character q", "q=a", "q must be 2 to 200 characters."],
      ["a q of 201 characters", `q=${"x".repeat(201)}`, "q must be 2 to 200 characters."],
      [
        "a q of 201 astral characters",
        `q=${encodeURIComponent("\u{1D11E}".repeat(201))}`,
        "q must be 2 to 200 characters."
      ],
      ["a q holding NUL", `q=ab${NUL}`, "q must not contain a null byte."],
      ["a repeated q", "q=ab&q=cd", "q must be given once."],
      // An unknown key is a misspelt filter, not one to ignore.
      [
        "an unknown key",
        "entity_type=order",
        "entity_type is not a parameter of this list. Known parameters: since, until, status, environment, service, entityType, q, minDurationMs, minStepDurationMs, inactiveBefore, limit, cursor."
      ],
      [
        "a long unknown key, repeated only in part",
        `${"k".repeat(40)}=1`,
        `${"k".repeat(32)}… is not a parameter of this list. Known parameters: since, until, status, environment, service, entityType, q, minDurationMs, minStepDurationMs, inactiveBefore, limit, cursor.`
      ]
    ])("refuses %s with invalid_query", async (_name, query, message) => {
      const url =
        query === "q=abc"
          ? "/v1/journeys?q=abc"
          : list(query.replace("SINCE", encodeURIComponent(since)));
      const response = await get(url);
      expect(response.statusCode, response.body).toBe(400);
      const body = response.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe("invalid_query");
      if (typeof message === "string") expect(body.error.message).toBe(message);
      else expect(body.error.message).toMatch(message);
    });

    it.each([
      ["a q of exactly 2 characters", "q=ab"],
      ["a q of 200 astral characters", `q=${encodeURIComponent("\u{1D11E}".repeat(200))}`],
      ["an until in the future", "until=2999-01-01T00:00:00Z"],
      ["an entityType of 128 characters", `entityType=${"t".repeat(128)}`],
      ["empty values, as a plain form sends them", "until=&entityType=&q="]
    ])("accepts %s", async (_name, query) => {
      expect((await get(list(query))).statusCode).toBe(200);
    });
  });

  it("returns the label, the last step and only the displayable alias values", async () => {
    const all = rows(await get(list("")));
    const byId = new Map(all.map((row) => [row.journeyId, row]));
    expect(byId.get("jrn_label")).toEqual({
      journeyId: "jrn_label",
      entity: { type: "job_posting", id: "posting-jrn_label" },
      status: "active",
      eventCount: 2,
      startedAt: expect.any(String),
      lastEventAt: expect.any(String),
      label: "Mirantis · Senior SWE, AI Infra",
      lastStep: "identify",
      failedStep: null,
      displayableAliases: [],
      environment: "browse"
    });
    expect(byId.get("jrn_alias")).toMatchObject({
      label: null,
      lastStep: "sweep-board",
      displayableAliases: [{ type: "postingId", value: "greenhouse:4567" }]
    });
    expect(byId.get("jrn_masked")).toMatchObject({ displayableAliases: [] });
    // No masked value reaches a list response in any field.
    expect(JSON.stringify(all)).not.toContain("someone@example.com");
  });

  it("gives a search result the same row fields as the list", async () => {
    // One presenter serves both lists, so a link from either reads the same.
    const response = await get("/v1/search?q=greenhouse:4567");
    expect(response.json<{ data: { items: Row[] } }>().data.items).toEqual([
      expect.objectContaining({
        journeyId: "jrn_alias",
        label: null,
        lastStep: "sweep-board",
        displayableAliases: [{ type: "postingId", value: "greenhouse:4567" }]
      })
    ]);
  });

  it("finds by label and by displayable value, ignoring case", async () => {
    expect(ids(await get(list(q("senior swe"))))).toEqual(["jrn_label"]);
    expect(ids(await get(list(q("HOUSE:45"))))).toEqual(["jrn_alias"]);
  });

  it("does not find by a masked alias value or by the entity id", async () => {
    // quokka-7 is both jrn_masked's entity id and its masked alias value.
    expect(ids(await get(list(q("quokka"))))).toEqual([]);
    expect(ids(await get(list(q("quokka-7"))))).toEqual([]);
    expect(ids(await get(list(q("someone@example"))))).toEqual([]);
    // The control: exact search still finds it by either value, and the list
    // has it in the window.
    const search = await get("/v1/search?q=quokka-7");
    expect(
      search.json<{ data: { items: Row[] } }>().data.items.map((row) => row.journeyId)
    ).toEqual(["jrn_masked"]);
    expect(ids(await get(list("")))).toContain("jrn_masked");
  });

  it.each([
    ["100%", ["jrn_literal"]],
    ["a_b", ["jrn_literal"]],
    ["k\\s", ["jrn_literal"]],
    ["%%", []],
    ["__", []],
    // Unescaped, \% would be read as an escaped percent sign and match "e %".
    ["e \\%", ["jrn_escape"]],
    ["\\%", ["jrn_escape"]],
    // Unescaped, a trailing backslash is an invalid LIKE pattern: an error,
    // not an empty page.
    ["with \\", ["jrn_escape"]],
    ["h \\", ["jrn_escape"]]
  ])("treats %j literally", async (text, expected) => {
    expect(ids(await get(list(q(text))))).toEqual(expected);
  });

  it("folds the case of an accented letter, and does not fold the accent away", async () => {
    // Under the test database's en_US.utf8 LC_CTYPE; see API_SPEC section 6.
    expect(ids(await get(list(q("CAFÉ"))))).toEqual(["jrn_accent"]);
    expect(ids(await get(list(q("éTÉ"))))).toEqual(["jrn_accent"]);
    expect(ids(await get(list(q("cafe"))))).toEqual([]);
  });

  it("never shows an API key another environment's journeys through q", async () => {
    expect(ids(await get(list(q("Mirantis"))))).toEqual(["jrn_label"]);
    expect(ids(await get(list(`${q("Mirantis")}&environment=other`)))).toEqual([]);
    // The controls: the other key, and the admin token, do see it.
    expect(ids(await get(list(q("Mirantis")), otherKey))).toEqual(["jrn_other"]);
    expect(ids(await asAdmin(list(q("Mirantis"))))).toEqual(["jrn_other", "jrn_label"]);
  });

  it("bounds the window with until and filters by entity type", async () => {
    const until = encodeURIComponent(hoursAgo(3.5));
    expect(ids(await get(list(`until=${until}&${q("Mirantis")}`)))).toEqual(["jrn_label"]);
    const earlier = encodeURIComponent(hoursAgo(4.5));
    expect(ids(await get(list(`until=${earlier}&${q("Mirantis")}`)))).toEqual([]);
    expect(ids(await get(list("entityType=customer")))).toEqual(["jrn_masked"]);
    expect(ids(await get(list(`entityType=customer&${q("Mirantis")}`)))).toEqual([]);
    // since still bounds the other side.
    const longAgo = encodeURIComponent(hoursAgo(48));
    expect(
      ids(await get(`/v1/journeys?since=${longAgo}&${q("Mirantis")}&entityType=job_posting`))
    ).toEqual(["jrn_label", "jrn_old"]);
  });

  it("pages a filtered list, returning every match once and nothing else", async () => {
    // Newest instant first, then journey id descending within it.
    const expected = [
      "jrn_page_06",
      "jrn_page_00",
      "jrn_page_10",
      "jrn_page_04",
      "jrn_page_08",
      "jrn_page_02"
    ];
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 20; pages += 1) {
      const response = await get(
        list(
          `${q("PAGER")}&limit=2${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`
        )
      );
      seen.push(...ids(response));
      cursor = response.json<{ data: { nextCursor: string | null } }>().data.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual(expected);
  });

  it("continues a cursor from other filters at its position", async () => {
    // A cursor encodes a position, not the filters. Taken from the unfiltered
    // list after jrn_page_00, it continues the q list below that position.
    const unfiltered = await get(list("limit=100"));
    const all = ids(unfiltered);
    const position = all.indexOf("jrn_page_00");
    const first = await get(list(`limit=${String(position + 1)}`));
    expect(ids(first).at(-1)).toBe("jrn_page_00");
    const cursor = first.json<{ data: { nextCursor: string } }>().data.nextCursor;
    const rest = await get(list(`${q("pager")}&limit=100&cursor=${encodeURIComponent(cursor)}`));
    expect(ids(rest)).toEqual(["jrn_page_10", "jrn_page_04", "jrn_page_08", "jrn_page_02"]);
  });

  it("exposes the label and the last step on the journey read", async () => {
    const response = await get("/v1/journeys/jrn_label");
    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: Record<string, unknown> }>().data).toMatchObject({
      label: "Mirantis · Senior SWE, AI Infra",
      lastStep: "identify"
    });
    const unlabelled = await get("/v1/journeys/jrn_alias");
    expect(unlabelled.json<{ data: Record<string, unknown> }>().data).toMatchObject({
      label: null,
      lastStep: "sweep-board",
      // The masking rule is unchanged on the read.
      aliases: [
        { type: "postingId", displayValue: "greenhouse:4567", displayable: true },
        { type: "recruiterEmail", displayValue: "some…com", displayable: false }
      ]
    });
  });
});
