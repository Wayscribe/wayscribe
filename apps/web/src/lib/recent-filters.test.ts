import { describe, expect, it } from "vitest";
import {
  describeRecentFilters,
  emptyListMessage,
  firstPageHref,
  nextPageHref,
  readRecentFilters,
  recentJourneysQuery
} from "./recent-filters";

const NOW = new Date("2026-09-15T12:00:00.000Z");

describe("readRecentFilters", () => {
  it("defaults to failed journeys in the last 24 hours, everywhere", () => {
    expect(readRecentFilters({}, NOW)).toEqual({
      status: "failed",
      window: "24h",
      environment: "",
      service: "",
      since: "2026-09-14T12:00:00.000Z",
      cursor: ""
    });
  });

  it("reads an empty status as any, which is what the form sends for it", () => {
    expect(readRecentFilters({ status: "" }, NOW).status).toBe("");
  });

  it("keeps a known status and falls back to failed for anything else", () => {
    expect(readRecentFilters({ status: "completed" }, NOW).status).toBe("completed");
    expect(readRecentFilters({ status: "any" }, NOW).status).toBe("failed");
    expect(readRecentFilters({ status: ["active", "failed"] }, NOW).status).toBe("failed");
  });

  it.each([
    ["1h", "2026-09-15T11:00:00.000Z"],
    ["24h", "2026-09-14T12:00:00.000Z"],
    ["7d", "2026-09-08T12:00:00.000Z"],
    ["30d", "2026-09-14T12:00:00.000Z"]
  ])("computes since from window %s", (window, since) => {
    expect(readRecentFilters({ window }, NOW).since).toBe(since);
  });

  it("ignores a carried since without a cursor, which the page never writes", () => {
    // Otherwise `?since=2000-…&window=1h` lists years under "in the last hour".
    expect(readRecentFilters({ window: "1h", since: "2000-01-01T00:00:00.000Z" }, NOW).since).toBe(
      "2026-09-15T11:00:00.000Z"
    );
  });

  it("recomputes a carried since later than now, or outside four-digit years", () => {
    for (const since of [
      "2026-09-15T12:00:00.001Z",
      "+010000-01-01T00:00:00.000Z",
      "-000001-01-01T00:00:00.000Z"
    ]) {
      expect(readRecentFilters({ since, cursor: "c" }, NOW).since, since).toBe(
        "2026-09-14T12:00:00.000Z"
      );
    }
  });

  it("keeps the since a next-page link carries, so the window does not move", () => {
    const filters = readRecentFilters(
      { window: "24h", since: "2026-09-14T11:00:00.000Z", cursor: "abc" },
      NOW
    );
    expect(filters.since).toBe("2026-09-14T11:00:00.000Z");
    expect(filters.cursor).toBe("abc");
  });

  it("recomputes a since that is not an instant it could have written", () => {
    for (const since of ["yesterday", "2026-09-14", "2026-02-30T00:00:00.000Z"]) {
      expect(readRecentFilters({ since, cursor: "c" }, NOW).since, since).toBe(
        "2026-09-14T12:00:00.000Z"
      );
    }
  });

  it("trims the environment and service", () => {
    const filters = readRecentFilters({ environment: " production ", service: " sync " }, NOW);
    expect(filters.environment).toBe("production");
    expect(filters.service).toBe("sync");
  });
});

describe("recentJourneysQuery", () => {
  it("sends only what is set, and omits status for any", () => {
    const filters = readRecentFilters({ status: "" }, NOW);
    expect(recentJourneysQuery(filters)).toBe("since=2026-09-14T12%3A00%3A00.000Z");
  });

  it("sends every filter and the cursor", () => {
    const filters = readRecentFilters(
      {
        status: "failed",
        environment: "production",
        service: "sync-worker",
        since: "2026-09-14T11:00:00.000Z",
        cursor: "abc"
      },
      NOW
    );
    expect(new URLSearchParams(recentJourneysQuery(filters))).toEqual(
      new URLSearchParams({
        since: "2026-09-14T11:00:00.000Z",
        status: "failed",
        environment: "production",
        service: "sync-worker",
        cursor: "abc"
      })
    );
  });
});

describe("nextPageHref", () => {
  it("carries every filter, the first page's since, and the new cursor", () => {
    const filters = readRecentFilters({ status: "", window: "7d", service: "billing" }, NOW);
    const href = nextPageHref(filters, "next-cursor");
    const [path, query] = href.split("?");
    expect(path).toBe("/recent");
    expect(Object.fromEntries(new URLSearchParams(query))).toEqual({
      status: "",
      window: "7d",
      environment: "",
      service: "billing",
      since: "2026-09-08T12:00:00.000Z",
      cursor: "next-cursor"
    });
  });

  it("round-trips through readRecentFilters to the same window", () => {
    const first = readRecentFilters({ status: "active", window: "1h" }, NOW);
    const later = new Date(NOW.getTime() + 10 * 60 * 1000);
    const query = new URLSearchParams(nextPageHref(first, "c").split("?")[1]);
    const second = readRecentFilters(Object.fromEntries(query), later);
    expect(second).toEqual({ ...first, cursor: "c" });
  });
});

describe("firstPageHref", () => {
  it("keeps the filters and drops the since and cursor, so the window starts from now", () => {
    const filters = readRecentFilters(
      {
        status: "",
        window: "1h",
        environment: "production",
        since: NOW.toISOString(),
        cursor: "c"
      },
      NOW
    );
    const query = new URLSearchParams(firstPageHref(filters).split("?")[1]);
    expect(Object.fromEntries(query)).toEqual({
      status: "",
      window: "1h",
      environment: "production",
      service: ""
    });
  });
});

describe("emptyListMessage", () => {
  const message = (params: Record<string, string>): string =>
    emptyListMessage(readRecentFilters(params, NOW));

  it("suggests only the widenings still available", () => {
    expect(message({})).toBe("Nothing here. Widen the window or choose any status to see more.");
    expect(message({ status: "" })).toBe("Nothing here. Widen the window to see more.");
    expect(message({ window: "7d" })).toBe("Nothing here. Choose any status to see more.");
    expect(message({ status: "", window: "7d" })).toBe("Nothing here.");
  });

  it("says a later page ran out rather than that nothing matched", () => {
    expect(
      message({ status: "", window: "7d", since: "2026-09-08T12:00:00.000Z", cursor: "c" })
    ).toBe("No more journeys.");
  });
});

describe("describeRecentFilters", () => {
  it("states the default view in words", () => {
    expect(describeRecentFilters(readRecentFilters({}, NOW))).toBe(
      "Failed journeys in the last 24 hours, all environments"
    );
  });

  it("names any status, the environment and the service", () => {
    expect(
      describeRecentFilters(
        readRecentFilters(
          { status: "", window: "1h", environment: "production", service: "sync-worker" },
          NOW
        )
      )
    ).toBe("Journeys in the last hour, in production, from sync-worker");
    expect(describeRecentFilters(readRecentFilters({ status: "active", window: "7d" }, NOW))).toBe(
      "Active journeys in the last 7 days, all environments"
    );
  });
});
