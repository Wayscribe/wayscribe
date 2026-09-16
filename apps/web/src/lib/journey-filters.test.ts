import { describe, expect, it } from "vitest";
import {
  activeFilterList,
  describeJourneyFilters,
  emptyListMessage,
  firstPageHref,
  journeysApiQuery,
  nextPageHref,
  readJourneyFilters,
  recentRedirectHref,
  refusedListMessage,
  statusHref,
  toDateTimeLocal,
  toQueryString
} from "./journey-filters";

const NOW = new Date("2026-09-15T12:00:00.000Z");

const queryOf = (href: string): Record<string, string> =>
  Object.fromEntries(new URLSearchParams(href.split("?")[1] ?? ""));

describe("readJourneyFilters", () => {
  it("defaults to any status in the last 24 hours, everywhere", () => {
    expect(readJourneyFilters({}, NOW)).toEqual({
      q: "",
      status: "",
      window: "24h",
      entityType: "",
      environment: "",
      service: "",
      since: "2026-09-14T12:00:00.000Z",
      until: "",
      sinceInput: "",
      untilInput: "",
      cursor: "",
      notes: []
    });
  });

  it("keeps a known status, and reads an empty one as any without a note", () => {
    expect(readJourneyFilters({ status: "failed" }, NOW).status).toBe("failed");
    expect(readJourneyFilters({ status: "completed" }, NOW).status).toBe("completed");
    const any = readJourneyFilters({ status: "" }, NOW);
    expect(any.status).toBe("");
    expect(any.notes).toEqual([]);
  });

  it("says so when an unknown status widens the list to any, and starts from the top", () => {
    const filters = readJourneyFilters({ status: "any", cursor: "c" }, NOW);
    expect(filters.status).toBe("");
    expect(filters.cursor).toBe("");
    expect(filters.notes).toEqual([
      'Status "any" is not failed, active or completed, so every status is shown.'
    ]);
  });

  it("cuts a long unknown status in its note", () => {
    const filters = readJourneyFilters({ status: "x".repeat(100) }, NOW);
    expect(filters.notes).toEqual([
      `Status "${"x".repeat(32)}…" is not failed, active or completed, so every status is shown.`
    ]);
  });

  it("says so when an unknown time widens or narrows the list", () => {
    const filters = readJourneyFilters({ window: "90d", cursor: "c" }, NOW);
    expect(filters.window).toBe("24h");
    expect(filters.cursor).toBe("");
    expect(filters.notes).toEqual([
      'Time "90d" is not one of the choices, so this shows the last 24 hours.'
    ]);
  });

  it.each([
    "status",
    "window",
    "q",
    "entityType",
    "environment",
    "service",
    "since",
    "until",
    "cursor"
  ])("leaves out %s given more than once, says so, and starts from the top", (key) => {
    const filters = readJourneyFilters(
      { window: "24h", since: "2026-09-14T11:00:00.000Z", cursor: "c", [key]: ["ab", "cd"] },
      NOW
    );
    expect(filters.notes).toContain(`${key} was given more than once, so it was left out.`);
    expect(filters.cursor).toBe("");
    expect(filters.since).toBe("2026-09-14T12:00:00.000Z");
  });

  it.each([
    ["1h", "2026-09-15T11:00:00.000Z"],
    ["24h", "2026-09-14T12:00:00.000Z"],
    ["7d", "2026-09-08T12:00:00.000Z"],
    ["30d", "2026-08-16T12:00:00.000Z"],
    ["", "2026-09-14T12:00:00.000Z"]
  ])("computes since from window %j, with no upper bound", (window, since) => {
    const filters = readJourneyFilters({ window }, NOW);
    expect(filters.since).toBe(since);
    expect(filters.until).toBe("");
    expect(filters.notes).toEqual([]);
  });

  it("ignores the range inputs under a preset, which the form sends empty or stale", () => {
    const filters = readJourneyFilters(
      { window: "7d", since: "2026-09-01T00:00", until: "2026-09-02T00:00" },
      NOW
    );
    expect(filters.since).toBe("2026-09-08T12:00:00.000Z");
    expect(filters.until).toBe("");
    expect(filters.sinceInput).toBe("");
    expect(filters.notes).toEqual([]);
  });

  it("ignores a carried since without a cursor, which the page never writes for a preset", () => {
    // Otherwise `?since=2000-…&window=1h` lists years under "in the last hour".
    expect(readJourneyFilters({ window: "1h", since: "2000-01-01T00:00:00.000Z" }, NOW).since).toBe(
      "2026-09-15T11:00:00.000Z"
    );
  });

  it("keeps the since a next-page link carries, so the window does not move", () => {
    const filters = readJourneyFilters(
      { window: "24h", since: "2026-09-14T11:00:00.000Z", cursor: "abc" },
      NOW
    );
    expect(filters.since).toBe("2026-09-14T11:00:00.000Z");
    expect(filters.cursor).toBe("abc");
  });

  it("recomputes a carried since that is later than now, outside four-digit years, or not its own", () => {
    for (const since of [
      "2026-09-15T12:00:00.001Z",
      "+010000-01-01T00:00:00.000Z",
      "-000001-01-01T00:00:00.000Z",
      "yesterday",
      "2026-09-14",
      "2026-02-30T00:00:00.000Z"
    ]) {
      const filters = readJourneyFilters({ since, cursor: "c" }, NOW);
      expect(filters.since, since).toBe("2026-09-14T12:00:00.000Z");
      // The existing rule: the page still continues rather than erroring.
      expect(filters.cursor, since).toBe("c");
    }
  });

  it("drops an until beside a preset, even from a hand-edited next-page link", () => {
    const filters = readJourneyFilters(
      {
        window: "24h",
        since: "2026-09-14T11:00:00.000Z",
        until: "2026-09-14T11:30:00.000Z",
        cursor: "c"
      },
      NOW
    );
    expect(filters.until).toBe("");
  });

  it("trims the text filters", () => {
    const filters = readJourneyFilters(
      { q: "  acme  ", entityType: " customer ", environment: " production ", service: " sync " },
      NOW
    );
    expect(filters.q).toBe("acme");
    expect(filters.entityType).toBe("customer");
    expect(filters.environment).toBe("production");
    expect(filters.service).toBe("sync");
  });

  describe("contains", () => {
    it("keeps 2 to 200 characters, counted as code points", () => {
      expect(readJourneyFilters({ q: "ab" }, NOW).q).toBe("ab");
      expect(readJourneyFilters({ q: "é".repeat(200) }, NOW).q).toBe("é".repeat(200));
      // 200 astral characters are 400 UTF-16 units and still 200 characters.
      expect(readJourneyFilters({ q: "😀".repeat(200) }, NOW).q).toBe("😀".repeat(200));
    });

    it.each([["a"], ["x".repeat(201)], ["😀".repeat(201)]])(
      "leaves out %j with a note, which the API would refuse",
      (q) => {
        const filters = readJourneyFilters({ q }, NOW);
        expect(filters.q).toBe("");
        expect(filters.notes).toEqual(["Contains needs 2 to 200 characters, so it was left out."]);
      }
    );

    it("reads white space alone as an empty box", () => {
      const filters = readJourneyFilters({ q: "   " }, NOW);
      expect(filters.q).toBe("");
      expect(filters.notes).toEqual([]);
    });
  });

  it("leaves out an entity type longer than any the API stores", () => {
    const filters = readJourneyFilters({ entityType: "t".repeat(129) }, NOW);
    expect(filters.entityType).toBe("");
    expect(filters.notes).toEqual([
      "An entity type is at most 128 characters, so that filter was left out."
    ]);
    expect(readJourneyFilters({ entityType: "t".repeat(128) }, NOW).entityType).toBe(
      "t".repeat(128)
    );
  });

  it("leaves out any text filter holding a null byte, which the API refuses", () => {
    const nul = String.fromCharCode(0);
    for (const key of ["q", "entityType", "environment", "service"]) {
      const filters = readJourneyFilters({ [key]: `ab${nul}cd` }, NOW);
      expect(filters[key as "q"], key).toBe("");
      expect(filters.notes, key).toEqual([
        `The ${key === "q" ? "contains" : key === "entityType" ? "entity type" : key} filter held a character that cannot be searched, so it was left out.`
      ]);
    }
  });

  it("starts from the top when a filter was left out, so a cursor cannot continue another list", () => {
    // The API does not refuse a cursor sent with different filters: it would
    // list the unfiltered rows after that position under a filtered heading.
    const filters = readJourneyFilters({ q: "a", cursor: "abc" }, NOW);
    expect(filters.cursor).toBe("");
  });

  describe("custom range", () => {
    it("reads datetime-local inputs as UTC", () => {
      const filters = readJourneyFilters(
        { window: "custom", since: "2026-09-10T08:00", until: "2026-09-12T17:30" },
        NOW
      );
      expect(filters).toMatchObject({
        window: "custom",
        since: "2026-09-10T08:00:00.000Z",
        until: "2026-09-12T17:30:00.000Z",
        sinceInput: "2026-09-10T08:00",
        untilInput: "2026-09-12T17:30",
        notes: []
      });
    });

    it("accepts seconds and milliseconds, as a browser may send them", () => {
      const filters = readJourneyFilters(
        { window: "custom", since: "2026-09-10T08:00:05", until: "2026-09-10T08:00:05.250" },
        NOW
      );
      expect(filters.since).toBe("2026-09-10T08:00:05.000Z");
      expect(filters.until).toBe("2026-09-10T08:00:05.250Z");
      expect(filters.sinceInput).toBe("2026-09-10T08:00:05");
      expect(filters.untilInput).toBe("2026-09-10T08:00:05.250");
    });

    it("treats an empty end as up to now", () => {
      const filters = readJourneyFilters(
        { window: "custom", since: "2026-09-10T08:00", until: "" },
        NOW
      );
      expect(filters.since).toBe("2026-09-10T08:00:00.000Z");
      expect(filters.until).toBe("");
      expect(filters.notes).toEqual([]);
    });

    it("allows an end after now, which the API accepts", () => {
      const filters = readJourneyFilters(
        { window: "custom", since: "2026-09-10T08:00", until: "2026-12-31T00:00" },
        NOW
      );
      expect(filters.until).toBe("2026-12-31T00:00:00.000Z");
    });

    it("accepts the instants its own next-page link carries", () => {
      const filters = readJourneyFilters(
        {
          window: "custom",
          since: "2026-09-10T08:00:00.000Z",
          until: "2026-09-12T17:30:00.000Z",
          cursor: "c"
        },
        NOW
      );
      expect(filters.since).toBe("2026-09-10T08:00:00.000Z");
      expect(filters.until).toBe("2026-09-12T17:30:00.000Z");
      expect(filters.sinceInput).toBe("2026-09-10T08:00");
      expect(filters.cursor).toBe("c");
    });

    const fallback = (reason: string): string =>
      `The custom range was not used (${reason}), so this shows the last 24 hours.`;

    it.each([
      [{}, "choose a start"],
      [{ since: "" }, "choose a start"],
      [{ since: "yesterday" }, "the start is not a date and time"],
      [{ since: "2026-09-10" }, "the start is not a date and time"],
      [{ since: "2026-02-30T00:00" }, "the start is not a date and time"],
      [{ since: "2026-09-10T24:00" }, "the start is not a date and time"],
      [{ since: "2026-09-10T08:00+02:00" }, "the start is not a date and time"],
      [{ since: "+010000-01-01T00:00" }, "the start is not a date and time"],
      [{ since: "2026-09-15T12:01" }, "the start is in the future"],
      [{ since: "2026-09-10T08:00", until: "soon" }, "the end is not a date and time"],
      [{ since: "2026-09-10T08:00", until: "2026-09-10T08:00" }, "the end must be after the start"],
      [{ since: "2026-09-10T08:00", until: "2026-09-09T08:00" }, "the end must be after the start"],
      [
        { since: "2026-09-10T08:00:00.000Z", until: "2026-09-10T08:00:00.000Z" },
        "the end must be after the start"
      ]
    ] satisfies [Record<string, string | string[]>, string][])(
      "falls back to the last 24 hours for %j",
      (range, reason) => {
        const filters = readJourneyFilters({ window: "custom", ...range, cursor: "c" }, NOW);
        expect(filters.window).toBe("24h");
        expect(filters.since).toBe("2026-09-14T12:00:00.000Z");
        expect(filters.until).toBe("");
        expect(filters.notes).toEqual([fallback(reason)]);
        // A cursor from the custom list must not continue a 24-hour one.
        expect(filters.cursor).toBe("");
      }
    );

    it("echoes what was typed after a fallback, so it can be corrected", () => {
      const filters = readJourneyFilters(
        { window: "custom", since: "2026-09-10T08:00", until: "2026-09-09T08:00" },
        NOW
      );
      expect(filters.sinceInput).toBe("2026-09-10T08:00");
      expect(filters.untilInput).toBe("2026-09-09T08:00");
    });

    it("never yields an until that is not after since", () => {
      // A sweep over start and end pairs around one another, including equal
      // instants written differently and a millisecond apart.
      const values = [
        "",
        "2026-09-10T08:00",
        "2026-09-10T08:00:00",
        "2026-09-10T08:00:00.000",
        "2026-09-10T08:00:00.001",
        "2026-09-10T07:59:59.999",
        "2026-09-10T08:00:00.000Z",
        "2026-09-10T08:00:00.001Z",
        "2026-09-10T08:01",
        "2026-09-15T12:00",
        "2026-09-15T12:00:00.001",
        "2027-01-01T00:00",
        "garbage"
      ];
      for (const since of values) {
        for (const until of values) {
          for (const cursor of ["", "c"]) {
            const filters = readJourneyFilters({ window: "custom", since, until, cursor }, NOW);
            const query = new URLSearchParams(journeysApiQuery(filters));
            const sent = query.get("until");
            const sentSince = query.get("since") ?? "";
            expect(Date.parse(sentSince), `${since} ${until}`).toBeLessThanOrEqual(NOW.getTime());
            if (sent !== null) {
              expect(Date.parse(sent), `${since} ${until}`).toBeGreaterThan(Date.parse(sentSince));
            }
          }
        }
      }
    });
  });
});

describe("toDateTimeLocal", () => {
  it("writes the minutes, and seconds only when there are any", () => {
    expect(toDateTimeLocal("2026-09-10T08:00:00.000Z")).toBe("2026-09-10T08:00");
    expect(toDateTimeLocal("2026-09-10T08:00:05.000Z")).toBe("2026-09-10T08:00:05");
    expect(toDateTimeLocal("2026-09-10T08:00:05.250Z")).toBe("2026-09-10T08:00:05.250");
  });
});

describe("journeysApiQuery", () => {
  it("sends only what is set, and omits status for any", () => {
    const filters = readJourneyFilters({}, NOW);
    expect(journeysApiQuery(filters)).toBe("since=2026-09-14T12%3A00%3A00.000Z");
  });

  it("sends every filter, the range and the cursor", () => {
    const filters = readJourneyFilters(
      {
        q: "acme",
        status: "failed",
        window: "custom",
        entityType: "customer",
        environment: "production",
        service: "sync-worker",
        since: "2026-09-10T08:00:00.000Z",
        until: "2026-09-11T08:00:00.000Z",
        cursor: "abc"
      },
      NOW
    );
    expect(Object.fromEntries(new URLSearchParams(journeysApiQuery(filters)))).toEqual({
      since: "2026-09-10T08:00:00.000Z",
      until: "2026-09-11T08:00:00.000Z",
      status: "failed",
      environment: "production",
      service: "sync-worker",
      entityType: "customer",
      q: "acme",
      cursor: "abc"
    });
  });
});

describe("nextPageHref", () => {
  it("carries every filter, the first page's range, and the new cursor", () => {
    const filters = readJourneyFilters(
      {
        q: "acme",
        status: "failed",
        window: "custom",
        entityType: "customer",
        environment: "production",
        service: "billing",
        since: "2026-09-10T08:00",
        until: "2026-09-11T08:00"
      },
      NOW
    );
    const href = nextPageHref(filters, "next-cursor");
    expect(href.split("?")[0]).toBe("/journeys");
    expect(queryOf(href)).toEqual({
      q: "acme",
      status: "failed",
      window: "custom",
      entityType: "customer",
      environment: "production",
      service: "billing",
      since: "2026-09-10T08:00:00.000Z",
      until: "2026-09-11T08:00:00.000Z",
      cursor: "next-cursor"
    });
  });

  it("carries a preset's since, with an empty until", () => {
    const filters = readJourneyFilters({ window: "7d", service: "billing" }, NOW);
    expect(queryOf(nextPageHref(filters, "c"))).toMatchObject({
      window: "7d",
      since: "2026-09-08T12:00:00.000Z",
      until: "",
      q: "",
      entityType: ""
    });
  });

  it.each([
    [{ status: "active", window: "1h", q: "acme", entityType: "customer" }],
    [{ status: "", window: "30d", environment: "staging", service: "sync" }],
    [
      {
        status: "failed",
        window: "custom",
        q: "Mirantis · Senior",
        entityType: "job_posting",
        since: "2026-09-01T00:00",
        until: "2026-09-02T00:00"
      }
    ],
    [{ window: "custom", since: "2026-09-01T00:00" }]
  ])("round-trips %j to the same list, later", (params) => {
    const first = readJourneyFilters(params, NOW);
    const later = new Date(NOW.getTime() + 10 * 60 * 1000);
    const second = readJourneyFilters(queryOf(nextPageHref(first, "c")), later);
    expect(second).toEqual({ ...first, cursor: "c" });
  });
});

describe("firstPageHref", () => {
  it("keeps a preset's filters and drops the since and cursor, so the window starts from now", () => {
    const filters = readJourneyFilters(
      {
        q: "acme",
        status: "",
        window: "1h",
        entityType: "customer",
        environment: "production",
        since: NOW.toISOString(),
        cursor: "c"
      },
      NOW
    );
    expect(queryOf(firstPageHref(filters))).toEqual({
      q: "acme",
      status: "",
      window: "1h",
      entityType: "customer",
      environment: "production",
      service: ""
    });
  });

  it("keeps a custom range, which is the filter itself", () => {
    const filters = readJourneyFilters(
      { window: "custom", since: "2026-09-10T08:00", until: "2026-09-11T08:00", cursor: "c" },
      NOW
    );
    const query = queryOf(firstPageHref(filters));
    expect(query).toMatchObject({
      window: "custom",
      since: "2026-09-10T08:00:00.000Z",
      until: "2026-09-11T08:00:00.000Z"
    });
    expect(query).not.toHaveProperty("cursor");
    expect(readJourneyFilters(query, NOW)).toEqual({ ...filters, cursor: "" });
  });
});

describe("statusHref", () => {
  it("changes only the status and starts from the top", () => {
    const filters = readJourneyFilters(
      { q: "acme", window: "7d", since: "2026-09-08T12:00:00.000Z", cursor: "c" },
      NOW
    );
    expect(queryOf(statusHref(filters, "failed"))).toEqual({
      ...queryOf(firstPageHref(filters)),
      status: "failed"
    });
    expect(queryOf(statusHref(filters, ""))).toMatchObject({ status: "" });
  });
});

describe("activeFilterList and emptyListMessage", () => {
  it("names every filter that is set", () => {
    const filters = readJourneyFilters(
      {
        q: "acme",
        status: "failed",
        entityType: "customer",
        environment: "production",
        service: "sync"
      },
      NOW
    );
    expect(activeFilterList(filters)).toEqual([
      'contains "acme"',
      "status failed",
      "entity type customer",
      "environment production",
      "service sync",
      "the last 24 hours"
    ]);
  });

  it("names a custom range in UTC", () => {
    expect(
      activeFilterList(
        readJourneyFilters(
          { window: "custom", since: "2026-09-10T08:00", until: "2026-09-11T09:30" },
          NOW
        )
      )
    ).toEqual(["from 2026-09-10 08:00 to 2026-09-11 09:30 UTC"]);
    expect(
      activeFilterList(readJourneyFilters({ window: "custom", since: "2026-09-10T08:00:05" }, NOW))
    ).toEqual(["since 2026-09-10 08:00:05 UTC"]);
  });

  it("says which filters are set when nothing matched", () => {
    expect(emptyListMessage(readJourneyFilters({ q: "acme", status: "failed" }, NOW))).toBe(
      'No journeys match: contains "acme", status failed, the last 24 hours.'
    );
    expect(emptyListMessage(readJourneyFilters({}, NOW))).toBe(
      "No journeys match: the last 24 hours."
    );
  });

  it("says a later page ran out rather than that nothing matched", () => {
    expect(
      emptyListMessage(
        readJourneyFilters({ window: "7d", since: "2026-09-08T12:00:00.000Z", cursor: "c" }, NOW)
      )
    ).toBe("No more journeys.");
  });
});

describe("describeJourneyFilters", () => {
  it("states the default view in words", () => {
    expect(describeJourneyFilters(readJourneyFilters({}, NOW))).toBe(
      "Journeys in the last 24 hours, all environments"
    );
  });

  it("names the status, text, type, environment, service and range", () => {
    expect(
      describeJourneyFilters(
        readJourneyFilters(
          {
            status: "failed",
            window: "1h",
            q: "acme",
            entityType: "customer",
            environment: "production",
            service: "sync-worker"
          },
          NOW
        )
      )
    ).toBe(
      'Failed journeys in the last hour, in production, entity type customer, from sync-worker, containing "acme"'
    );
    expect(
      describeJourneyFilters(
        readJourneyFilters(
          {
            status: "active",
            window: "custom",
            since: "2026-09-10T08:00",
            until: "2026-09-11T08:00"
          },
          NOW
        )
      )
    ).toBe("Active journeys from 2026-09-10 08:00 to 2026-09-11 08:00 UTC, all environments");
    expect(describeJourneyFilters(readJourneyFilters({ window: "30d" }, NOW))).toBe(
      "Journeys in the last 30 days, all environments"
    );
  });
});

describe("toQueryString", () => {
  it("keeps every value of a repeated key, in order", () => {
    expect(toQueryString({ status: ["failed", "active"], q: "a b", skip: undefined })).toBe(
      "status=failed&status=active&q=a+b"
    );
  });
});

describe("refusedListMessage", () => {
  it("calls a refused next-page link stale and offers the newest", () => {
    expect(refusedListMessage(readJourneyFilters({ cursor: "c" }, NOW))).toEqual({
      text: "This page link is no longer valid.",
      offerNewest: true
    });
  });

  it("says the filters were refused when there was no cursor", () => {
    expect(refusedListMessage(readJourneyFilters({ service: "x" }, NOW))).toEqual({
      text: "The API refused these filters. Change them and show again.",
      offerNewest: false
    });
  });
});

describe("recentRedirectHref", () => {
  it("keeps the query string of an old Recent link", () => {
    const href = recentRedirectHref({
      status: "",
      window: "7d",
      environment: "production",
      service: "sync worker",
      since: "2026-09-08T12:00:00.000Z",
      cursor: "abc"
    });
    expect(href.split("?")[0]).toBe("/journeys");
    expect(queryOf(href)).toEqual({
      status: "",
      window: "7d",
      environment: "production",
      service: "sync worker",
      since: "2026-09-08T12:00:00.000Z",
      cursor: "abc"
    });
  });

  it("keeps an explicit status, including any", () => {
    expect(queryOf(recentRedirectHref({ status: "completed" }))).toEqual({ status: "completed" });
    expect(recentRedirectHref({ status: "" })).toBe("/journeys?status=");
  });

  it("keeps what the Recent page meant with no status: failures", () => {
    // Recent defaulted to failed, and its links and bookmarks relied on that.
    expect(recentRedirectHref({})).toBe("/journeys?status=failed");
    expect(recentRedirectHref({ window: "7d" })).toBe("/journeys?window=7d&status=failed");
  });

  it("keeps repeated keys and unknown ones as they came", () => {
    expect(recentRedirectHref({ status: ["failed", "active"], extra: "x y" })).toBe(
      "/journeys?status=failed&status=active&extra=x+y"
    );
  });
});
