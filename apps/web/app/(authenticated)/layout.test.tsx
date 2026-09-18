import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE_NAME, signSession } from "../../src/lib/session";
import { VersionFooter } from "../components/VersionFooter";
import AuthenticatedLayout from "./layout";

/**
 * The auth gate, against a cookie an attacker can sign.
 *
 * `signSession` derives its key from whatever string it is given, "" included,
 * so a gate that verifies against an empty token admits a cookie signed with an
 * empty token. Every way of having no token has to redirect without verifying
 * anything, not verify against "".
 */

const { cookiesMock, redirectMock } = vi.hoisted(() => ({
  cookiesMock: vi.fn(),
  redirectMock: vi.fn((url: string) => {
    // next/navigation's own redirect throws to unwind the render; this stands
    // in for that, so a gate that did not redirect returns instead of throwing.
    throw new Error(`REDIRECT:${url}`);
  })
}));

vi.mock("next/headers", () => ({ cookies: cookiesMock }));
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

const ADMIN_TOKEN = "admin-token-for-tests-00000000000000";

const fileHolding = (contents: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), "wayscribe-auth-gate-")), "admin-token");
  writeFileSync(path, contents, "utf8");
  return path;
};

const presenting = (cookie: string): void => {
  cookiesMock.mockResolvedValue({
    get: (name: string) => (name === SESSION_COOKIE_NAME ? { value: cookie } : undefined)
  });
};

/** A cookie an attacker can make: signed with the empty token. */
const forged = (): string => signSession("", { projectId: "", expiresAt: Date.now() + 60_000 });

const enter = async (): Promise<string> => {
  try {
    await AuthenticatedLayout({ children: null });
    return "(rendered the authenticated shell)";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

afterEach(() => {
  vi.unstubAllEnvs();
  redirectMock.mockClear();
});

describe("the authenticated layout", () => {
  it.each([
    [
      "ADMIN_TOKEN is unset",
      (): void => {
        vi.stubEnv("ADMIN_TOKEN", undefined);
      }
    ],
    [
      "ADMIN_TOKEN is blank",
      (): void => {
        vi.stubEnv("ADMIN_TOKEN", "   ");
      }
    ],
    [
      "ADMIN_TOKEN_FILE names a file that is not there",
      (): void => {
        vi.stubEnv("ADMIN_TOKEN", undefined);
        vi.stubEnv("ADMIN_TOKEN_FILE", join(tmpdir(), "wayscribe-no-such-token-file"));
      }
    ],
    [
      "ADMIN_TOKEN_FILE names an empty file",
      (): void => {
        vi.stubEnv("ADMIN_TOKEN", undefined);
        vi.stubEnv("ADMIN_TOKEN_FILE", fileHolding("\n"));
      }
    ],
    [
      "the token is given both ways",
      (): void => {
        vi.stubEnv("ADMIN_TOKEN", ADMIN_TOKEN);
        vi.stubEnv("ADMIN_TOKEN_FILE", fileHolding(ADMIN_TOKEN));
      }
    ]
  ])("redirects a forged cookie to /login when %s", async (_case, configure) => {
    configure();
    presenting(forged());

    expect(await enter()).toBe("REDIRECT:/login");
    expect(redirectMock).toHaveBeenCalledWith("/login");
  });

  it("lets a session signed with the configured token through", async () => {
    vi.stubEnv("ADMIN_TOKEN", ADMIN_TOKEN);
    vi.stubEnv("ADMIN_TOKEN_FILE", undefined);
    presenting(signSession(ADMIN_TOKEN, { projectId: "proj_1", expiresAt: Date.now() + 60_000 }));

    await AuthenticatedLayout({ children: null });
    expect(redirectMock).not.toHaveBeenCalled();
  });

  // F-045: the version line is under every signed-in page, so it lives here.
  it("puts the version line under every page it lets through", async () => {
    vi.stubEnv("ADMIN_TOKEN", ADMIN_TOKEN);
    vi.stubEnv("ADMIN_TOKEN_FILE", undefined);
    presenting(signSession(ADMIN_TOKEN, { projectId: "proj_1", expiresAt: Date.now() + 60_000 }));

    const shell = await AuthenticatedLayout({ children: null });
    const children = (shell.props as { children: { type: unknown }[] }).children;
    expect(children.map((child) => (child as { type?: unknown } | null)?.type)).toContain(
      VersionFooter
    );
  });

  it("lets a session through when the token came from a file", async () => {
    vi.stubEnv("ADMIN_TOKEN", undefined);
    vi.stubEnv("ADMIN_TOKEN_FILE", fileHolding(`${ADMIN_TOKEN}\n`));
    presenting(signSession(ADMIN_TOKEN, { projectId: "proj_1", expiresAt: Date.now() + 60_000 }));

    await AuthenticatedLayout({ children: null });
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("redirects a cookie signed with another token", async () => {
    vi.stubEnv("ADMIN_TOKEN", ADMIN_TOKEN);
    vi.stubEnv("ADMIN_TOKEN_FILE", undefined);
    presenting(
      signSession("some-other-token-000000000000000000", {
        projectId: "proj_1",
        expiresAt: Date.now() + 60_000
      })
    );

    expect(await enter()).toBe("REDIRECT:/login");
  });
});
