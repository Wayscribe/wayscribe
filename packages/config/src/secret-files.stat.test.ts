import type { Stats } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "./config-error.js";

/**
 * What a `_FILE` may point at, decided from the file system's own answer.
 *
 * The other tests stand a directory in for everything that is not a regular
 * file, and a directory is not enough: a guard written as `isDirectory()`
 * passes those and still lets a named pipe through, where `readFileSync` blocks
 * until something writes and the process hangs before it has logged anything.
 * A real pipe cannot be used to prove that here, because a test that reached
 * one would hang its own worker rather than fail if the guard were removed, and
 * a blocked synchronous read cannot be interrupted.
 *
 * So `node:fs` is mocked instead: `statSync` answers with each file type in
 * turn, and `readFileSync` throws if it is called at all. The assertion is the
 * one that matters, that nothing but a regular file is ever opened.
 */

const { readFileSyncMock, statSyncMock } = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(() => {
    throw new Error("readFileSync was called on a path that is not a regular file");
  }),
  statSyncMock: vi.fn()
}));

vi.mock("node:fs", () => ({ readFileSync: readFileSyncMock, statSync: statSyncMock }));

const { resolveSecretFiles } = await import("./secret-files.js");

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

afterEach(() => {
  readFileSyncMock.mockClear();
  statSyncMock.mockReset();
});

describe("what a secret file may be", () => {
  it.each(["fifo", "socket", "characterDevice", "blockDevice", "directory"])(
    "refuses a %s without opening it",
    (kind) => {
      statSyncMock.mockReturnValue(statOf(kind));

      const attempt = (): unknown => resolveSecretFiles({ ENCRYPTION_KEY_FILE: "/dev/whatever" });
      expect(attempt).toThrow(ConfigError);
      expect(attempt).toThrow(/ENCRYPTION_KEY_FILE does not name a regular file/);
      // The point of the whole check: a pipe that was opened would block here
      // for as long as nothing wrote to it.
      expect(readFileSyncMock).not.toHaveBeenCalled();
    }
  );

  it("opens a regular file", () => {
    statSyncMock.mockReturnValue(statOf("file"));
    readFileSyncMock.mockReturnValueOnce("a-key-of-enough-length-000000000000\n" as never);

    expect(resolveSecretFiles({ ENCRYPTION_KEY_FILE: "/run/secrets/key" })["ENCRYPTION_KEY"]).toBe(
      "a-key-of-enough-length-000000000000"
    );
    expect(readFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it("refuses an oversized regular file without opening it", () => {
    statSyncMock.mockReturnValue(statOf("file", 65_537));

    expect(() => resolveSecretFiles({ ADMIN_TOKEN_FILE: "/run/secrets/token" })).toThrow(
      /ADMIN_TOKEN_FILE names a file of 65537 bytes/
    );
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });
});
