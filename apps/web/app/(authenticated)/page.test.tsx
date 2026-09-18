import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE_NAME, signSession } from "../../src/lib/session";
import SearchPage from "./page";

/**
 * Signing in lands on the Search page, so it has to render its search box
 * before a project is chosen. It used to call `requireProjectId` on every
 * render for the environment list, and on an installation with two projects
 * signing in landed on the picker instead.
 */

const { cookiesMock, redirectMock, listProjectsMock, searchMock } = vi.hoisted(() => ({
  cookiesMock: vi.fn(),
  redirectMock: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  listProjectsMock: vi.fn(),
  searchMock: vi.fn()
}));

vi.mock("next/headers", () => ({ cookies: cookiesMock }));
vi.mock("next/navigation", () => ({ redirect: redirectMock }));
vi.mock("../../src/lib/api", async (original) => ({
  ...(await original<typeof import("../../src/lib/api")>()),
  listProjects: listProjectsMock,
  search: searchMock
}));

const ADMIN_TOKEN = "admin-token-for-tests-00000000000000";

const project = (id: string, environments: string[]) => ({
  id,
  name: id,
  slug: id,
  environments
});
const TWO = [project("proj_1", ["development", "production"]), project("proj_2", ["staging"])];

const signedIn = (projectId: string): void => {
  vi.stubEnv("ADMIN_TOKEN", ADMIN_TOKEN);
  vi.stubEnv("ADMIN_TOKEN_FILE", undefined);
  const cookie = signSession(ADMIN_TOKEN, { projectId, expiresAt: Date.now() + 60_000 });
  cookiesMock.mockResolvedValue({
    get: (name: string) => (name === SESSION_COOKIE_NAME ? { value: cookie } : undefined)
  });
};

const visit = async (params: Record<string, string>): Promise<string | null> => {
  try {
    render(await SearchPage({ searchParams: Promise.resolve(params) }));
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const environmentOptions = (): string[] =>
  Array.from(screen.getByLabelText<HTMLSelectElement>("Environment").options).map(
    (option) => option.text
  );

afterEach(() => {
  vi.unstubAllEnvs();
  redirectMock.mockClear();
  listProjectsMock.mockReset();
  searchMock.mockReset();
});

describe("the Search page", () => {
  it("shows the search box on two projects with none chosen, rather than the picker", async () => {
    signedIn("");
    listProjectsMock.mockResolvedValue(TWO);

    expect(await visit({})).toBeNull();
    expect(redirectMock).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Search" })).toBeTruthy();
    // No project, so no environments to offer: only "all", and a line saying why.
    expect(environmentOptions()).toEqual(["all"]);
    expect(screen.getByText(/to narrow by environment\./).textContent).toBe(
      "Choose a project to narrow by environment."
    );
    expect(screen.getByRole("link", { name: "Choose a project" }).getAttribute("href")).toBe(
      "/projects?next=%2F"
    );
    expect(listProjectsMock).toHaveBeenCalledTimes(1);
  });

  // A search needs a project, so it goes to the picker and comes back, as it
  // always has.
  it("sends a search on two projects with none chosen to the picker, and back", async () => {
    signedIn("");
    listProjectsMock.mockResolvedValue(TWO);

    expect(await visit({ q: "CUST-1" })).toBe("REDIRECT:/projects?next=%2F%3Fq%3DCUST-1");
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("offers the only project's environments, asking for the list once", async () => {
    signedIn("");
    listProjectsMock.mockResolvedValue([project("proj_1", ["development", "production"])]);
    searchMock.mockResolvedValue([]);

    expect(await visit({ q: "CUST-1" })).toBeNull();
    expect(environmentOptions()).toEqual(["all", "development", "production"]);
    expect(searchMock).toHaveBeenCalledWith("q=CUST-1", "proj_1");
    expect(listProjectsMock).toHaveBeenCalledTimes(1);
  });

  it("offers the chosen project's environments, asking for the list once", async () => {
    signedIn("proj_2");
    listProjectsMock.mockResolvedValue(TWO);
    searchMock.mockResolvedValue([]);

    expect(await visit({ q: "CUST-1", environment: "staging" })).toBeNull();
    expect(environmentOptions()).toEqual(["all", "staging"]);
    expect(searchMock).toHaveBeenCalledWith("q=CUST-1&environment=staging", "proj_2");
    expect(listProjectsMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/to narrow by environment\./)).toBeNull();
  });
});
