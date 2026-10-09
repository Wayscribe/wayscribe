import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JourneyListRow } from "../../../src/lib/api";
import { SESSION_COOKIE_NAME, signSession } from "../../../src/lib/session";
import JourneysPage from "./page";

/**
 * The public demo (ADR-069) folds the Journeys filters behind a closed
 * "Filters" disclosure, so a visitor sees the list first, as the Search page
 * does. Outside the demo the form is laid out in full, as before.
 */

const { cookiesMock, redirectMock, listProjectsMock, listJourneysMock } = vi.hoisted(() => ({
  cookiesMock: vi.fn(),
  redirectMock: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  listProjectsMock: vi.fn(),
  listJourneysMock: vi.fn()
}));

vi.mock("next/headers", () => ({ cookies: cookiesMock }));
vi.mock("next/navigation", () => ({ redirect: redirectMock, usePathname: () => "/journeys" }));
vi.mock("../../../src/lib/api", async (original) => ({
  ...(await original<typeof import("../../../src/lib/api")>()),
  listProjects: listProjectsMock,
  listJourneys: listJourneysMock
}));

const ADMIN_TOKEN = "admin-token-for-tests-00000000000000";
const READ_TOKEN = "read-token-for-tests-000000000000000";

const ROW: JourneyListRow = {
  journeyId: "jrn_1",
  entity: { type: "customer", id: "0018Z00005PIN01" },
  status: "failed",
  eventCount: 3,
  startedAt: "2026-09-15T10:31:02.000Z",
  lastEventAt: "2026-09-15T10:34:38.000Z",
  environment: "production",
  label: "Dana Whitfield",
  lastStep: "transform",
  displayableAliases: []
};

const signedInAs = (token: string): void => {
  const cookie = signSession(token, { projectId: "proj_1", expiresAt: Date.now() + 60_000 });
  cookiesMock.mockResolvedValue({
    get: (name: string) => (name === SESSION_COOKIE_NAME ? { value: cookie } : undefined)
  });
  listProjectsMock.mockResolvedValue([
    { id: "proj_1", name: "proj_1", slug: "proj_1", environments: ["production"] }
  ]);
  listJourneysMock.mockResolvedValue({ items: [ROW], nextCursor: null });
};

const admin = (): void => {
  vi.stubEnv("ADMIN_TOKEN", ADMIN_TOKEN);
  vi.stubEnv("ADMIN_TOKEN_FILE", undefined);
  signedInAs(ADMIN_TOKEN);
};

const demo = (): void => {
  vi.stubEnv("WEB_ANONYMOUS_READ_ONLY", "true");
  vi.stubEnv("ADMIN_TOKEN", "");
  vi.stubEnv("ADMIN_TOKEN_FILE", undefined);
  vi.stubEnv("READ_TOKEN", READ_TOKEN);
  signedInAs(READ_TOKEN);
};

const visit = async (params: Record<string, string>): Promise<void> => {
  render(await JourneysPage({ searchParams: Promise.resolve(params) }));
};

const filters = (): HTMLElement => screen.getByRole("search", { name: "Filter journeys" });
const fold = (): HTMLDetailsElement | null =>
  filters().closest<HTMLDetailsElement>("details.journey-filters-fold");

afterEach(() => {
  vi.unstubAllEnvs();
  redirectMock.mockClear();
  listProjectsMock.mockReset();
  listJourneysMock.mockReset();
});

describe("the Journeys page outside the demo", () => {
  it("lays the filters out in full, with no disclosure", async () => {
    admin();
    await visit({});
    expect(fold()).toBeNull();
    expect(screen.getByRole("main").querySelector("details")).toBeNull();
    expect(screen.getByLabelText("Status")).toBeVisible();
    expect(screen.getByRole("table")).toBeTruthy();
  });

  it("still has no disclosure when filters are set", async () => {
    admin();
    await visit({ status: "failed", service: "sync" });
    expect(fold()).toBeNull();
  });
});

describe("the Journeys page in the demo", () => {
  it("folds the filters away, closed, and shows the list straight after", async () => {
    demo();
    await visit({});
    const details = fold();
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toBe("Filters");
    expect(details?.contains(screen.getByLabelText("Contains"))).toBe(true);
    // The heading, the All / Failures links and the list stay outside it.
    expect(details?.contains(screen.getByRole("heading", { level: 1, name: "Journeys" }))).toBe(
      false
    );
    expect(details?.contains(screen.getByRole("link", { name: "Failures" }))).toBe(false);
    expect(details?.contains(screen.getByRole("table"))).toBe(false);
  });

  it("stays closed when only the Failures link set status", async () => {
    demo();
    await visit({ status: "failed" });
    expect(fold()?.open).toBe(false);
    expect(screen.getByRole("link", { name: "Failures" }).getAttribute("aria-current")).toBe(
      "true"
    );
  });

  it.each([
    ["contains", { q: "dana" }],
    ["time", { window: "7d" }],
    ["entity type", { entityType: "customer" }],
    ["environment", { environment: "production" }],
    ["service", { service: "sync" }],
    ["span threshold", { minDurationMs: "500" }],
    ["step threshold", { minStepDurationMs: "500" }],
    ["inactivity threshold", { inactiveForMs: "60000" }],
    ["custom range", { window: "custom", since: "2026-09-14T00:00" }],
    ["a filter beside status", { status: "failed", service: "sync" }]
  ])("opens when the URL sets %s", async (_name, params) => {
    demo();
    await visit(params);
    expect(fold()?.open).toBe(true);
  });
});
