import { afterEach, describe, expect, it, vi } from "vitest";
import LoginPage from "./page";

const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  })
}));

vi.mock("next/navigation", () => ({ redirect: redirectMock }));

const render = async (): Promise<string> => {
  try {
    await LoginPage({ searchParams: Promise.resolve({}) });
    return "(rendered the login form)";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

afterEach(() => {
  vi.unstubAllEnvs();
  redirectMock.mockClear();
});

describe("the login page", () => {
  it("shows the form when the app runs with the admin token", async () => {
    vi.stubEnv("WEB_ANONYMOUS_READ_ONLY", undefined);
    expect(await render()).toBe("(rendered the login form)");
  });

  it("sends a visitor home in anonymous read-only mode, where everyone is already a reader", async () => {
    vi.stubEnv("WEB_ANONYMOUS_READ_ONLY", "true");
    expect(await render()).toBe("REDIRECT:/");
  });
});
