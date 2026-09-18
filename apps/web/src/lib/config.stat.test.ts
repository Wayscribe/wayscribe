import type { Stats } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * What `ADMIN_TOKEN_FILE` may point at.
 *
 * The same check, and the same test, as `packages/config`'s
 * `secret-files.stat.test.ts`: the two implementations have to stay identical,
 * so they are held to the same thing. A guard written as `isDirectory()` would
 * pass a directory-based test and still let a named pipe through, where
 * `readFileSync` blocks until something writes and the web container hangs
 * before it has logged anything.
 */

const { readFileSyncMock, statSyncMock } = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(() => {
    throw new Error("readFileSync was called on a path that is not a regular file");
  }),
  statSyncMock: vi.fn()
}));

vi.mock("node:fs", () => ({ readFileSync: readFileSyncMock, statSync: statSyncMock }));

const { loadWebConfig, sessionAdminToken } = await import("./config");

const TOKEN = "admin-token-for-tests-0000000000";

/** A stat whose only true `is*` predicate is the one named. */
const statOf = (kind: string, size = 64): Stats =>
  ({
    size,
    isFile: () => kind === "file",
    isDirectory: () => kind === "directory",
    isFIFO: () => kind === "fifo",
    isSocket: () => kind === "socket",
    isCharacterDevice: () => kind === "characterDevice",
    isBlockDevice: () => kind === "blockDevice",
    isSymbolicLink: () => false
  }) as Stats;

const source = { API_URL: "http://api:8080", ADMIN_TOKEN_FILE: "/run/secrets/admin_token" };

afterEach(() => {
  readFileSyncMock.mockClear();
  statSyncMock.mockReset();
});

describe("what ADMIN_TOKEN_FILE may be", () => {
  it.each(["fifo", "socket", "characterDevice", "blockDevice", "directory"])(
    "refuses a %s without opening it",
    (kind) => {
      statSyncMock.mockReturnValue(statOf(kind));

      expect(() => loadWebConfig(source)).toThrow(/ADMIN_TOKEN_FILE does not name a regular file/);
      expect(readFileSyncMock).not.toHaveBeenCalled();
      // And the auth gate treats it as having no token at all, rather than
      // verifying a cookie against "".
      expect(sessionAdminToken(source)).toBeNull();
    }
  );

  it("opens a regular file", () => {
    statSyncMock.mockReturnValue(statOf("file"));
    readFileSyncMock.mockReturnValue(`${TOKEN}\n` as never);

    expect(loadWebConfig(source).ADMIN_TOKEN).toBe(TOKEN);
    expect(sessionAdminToken(source)).toBe(TOKEN);
  });

  it("refuses an oversized regular file without opening it", () => {
    statSyncMock.mockReturnValue(statOf("file", 65_537));

    expect(() => loadWebConfig(source)).toThrow(/ADMIN_TOKEN_FILE names a file of 65537 bytes/);
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });
});
