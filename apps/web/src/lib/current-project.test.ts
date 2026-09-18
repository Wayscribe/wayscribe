import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE_NAME, signSession } from "./session";
import { currentProject, requireProjectId } from "./current-project";

/**
 * The project picker verifies the session cookie itself, so it has the same
 * duty as the auth gate: with no admin token to verify against, redirect
 * rather than verify against "", which a cookie signed with "" would pass.
 */

const { cookiesMock, redirectMock, listProjectsMock } = vi.hoisted(() => ({
  cookiesMock: vi.fn(),
  redirectMock: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  listProjectsMock: vi.fn()
}));

vi.mock("next/headers", () => ({ cookies: cookiesMock }));
vi.mock("next/navigation", () => ({ redirect: redirectMock }));
vi.mock("./api", () => ({ listProjects: listProjectsMock }));

const ADMIN_TOKEN = "admin-token-for-tests-00000000000000";

const presenting = (cookie: string): void => {
  cookiesMock.mockResolvedValue({
    get: (name: string) => (name === SESSION_COOKIE_NAME ? { value: cookie } : undefined)
  });
};

const resolve = async (): Promise<string> => {
  try {
    return await requireProjectId();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

afterEach(() => {
  vi.unstubAllEnvs();
  redirectMock.mockClear();
  listProjectsMock.mockReset();
});

describe("requireProjectId", () => {
  it("redirects a cookie signed with the empty token when ADMIN_TOKEN is unset", async () => {
    vi.stubEnv("ADMIN_TOKEN", undefined);
    vi.stubEnv("ADMIN_TOKEN_FILE", undefined);
    presenting(signSession("", { projectId: "proj_forged", expiresAt: Date.now() + 60_000 }));

    expect(await resolve()).toBe("REDIRECT:/login");
    expect(listProjectsMock).not.toHaveBeenCalled();
  });

  it("returns the session's project when the cookie is signed with the configured token", async () => {
    vi.stubEnv("ADMIN_TOKEN", ADMIN_TOKEN);
    vi.stubEnv("ADMIN_TOKEN_FILE", undefined);
    presenting(signSession(ADMIN_TOKEN, { projectId: "proj_1", expiresAt: Date.now() + 60_000 }));

    expect(await resolve()).toBe("proj_1");
  });
});

describe("currentProject", () => {
  const signedIn = (projectId: string): void => {
    vi.stubEnv("ADMIN_TOKEN", ADMIN_TOKEN);
    vi.stubEnv("ADMIN_TOKEN_FILE", undefined);
    presenting(signSession(ADMIN_TOKEN, { projectId, expiresAt: Date.now() + 60_000 }));
  };
  const project = (
    id: string
  ): { id: string; name: string; slug: string; environments: string[] } => ({
    id,
    name: id,
    slug: id,
    environments: ["production"]
  });

  it("returns the session's choice without asking the API for the list", async () => {
    signedIn("proj_1");
    expect(await currentProject()).toEqual({ kind: "chosen", projectId: "proj_1", projects: null });
    expect(listProjectsMock).not.toHaveBeenCalled();
  });

  it("resolves the only project, and hands back the list it fetched", async () => {
    signedIn("");
    listProjectsMock.mockResolvedValue([project("proj_1")]);
    expect(await currentProject()).toEqual({
      kind: "only",
      projectId: "proj_1",
      projects: [project("proj_1")]
    });
    expect(listProjectsMock).toHaveBeenCalledTimes(1);
  });

  // Where requireProjectId sends the reader to the picker, this says so and
  // lets the page decide: the Search page still shows its search box.
  it("says none is chosen when there are two, without redirecting", async () => {
    signedIn("");
    listProjectsMock.mockResolvedValue([project("proj_1"), project("proj_2")]);
    expect(await currentProject()).toEqual({
      kind: "unchosen",
      projects: [project("proj_1"), project("proj_2")]
    });
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("still sends a reader with no valid session to the login page", async () => {
    vi.stubEnv("ADMIN_TOKEN", ADMIN_TOKEN);
    presenting("not-a-session");
    await expect(currentProject()).rejects.toThrow("REDIRECT:/login");
  });
});
