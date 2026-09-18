import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "./config-error.js";
import { resolveSecretFiles } from "./secret-files.js";

const KEY = "an-encryption-key-of-enough-length-00";
const TOKEN = "an-admin-token-of-enough-length-00000";

/** A file holding `contents`, in a directory of this test's own. */
const fileHolding = (contents: string, name = "secret"): string => {
  const path = join(mkdtempSync(join(tmpdir(), "wayscribe-secret-files-")), name);
  writeFileSync(path, contents, "utf8");
  return path;
};

describe("resolveSecretFiles", () => {
  it("leaves an environment with no file variables alone", () => {
    const source = { ENCRYPTION_KEY: KEY, ADMIN_TOKEN: TOKEN, PORT: "8080" };
    expect(resolveSecretFiles(source)).toEqual(source);
  });

  it.each([
    ["ENCRYPTION_KEY", KEY],
    ["ENCRYPTION_KEY_PREVIOUS", KEY],
    ["ADMIN_TOKEN", TOKEN]
  ])("reads %s from the file its _FILE variable names", (name, value) => {
    const resolved = resolveSecretFiles({ [`${name}_FILE`]: fileHolding(value) });
    expect(resolved[name]).toBe(value);
  });

  it("trims whitespace at the end, which a secrets file and `kubectl create secret` both add", () => {
    const resolved = resolveSecretFiles({ ENCRYPTION_KEY_FILE: fileHolding(`${KEY}\n`) });
    expect(resolved["ENCRYPTION_KEY"]).toBe(KEY);
  });

  it("refuses an empty file, naming the setting", () => {
    const path = fileHolding("\n  \n");
    expect(() => resolveSecretFiles({ ADMIN_TOKEN_FILE: path })).toThrow(ConfigError);
    expect(() => resolveSecretFiles({ ADMIN_TOKEN_FILE: path })).toThrow(/ADMIN_TOKEN_FILE/);
  });

  it("refuses a file it cannot read, naming the setting and the path", () => {
    const path = join(tmpdir(), "wayscribe-no-such-secret-file");
    expect(() => resolveSecretFiles({ ENCRYPTION_KEY_FILE: path })).toThrow(ConfigError);
    expect(() => resolveSecretFiles({ ENCRYPTION_KEY_FILE: path })).toThrow(
      new RegExp(`ENCRYPTION_KEY_FILE[\\s\\S]*${path}`)
    );
  });

  it("refuses both the variable and its file, naming the setting", () => {
    const attempt = (): unknown =>
      resolveSecretFiles({ ENCRYPTION_KEY: KEY, ENCRYPTION_KEY_FILE: fileHolding(KEY) });
    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(/ENCRYPTION_KEY and ENCRYPTION_KEY_FILE are both set/);
  });

  it("never puts a value in the message, whichever way it refuses", () => {
    const cases = [
      { ENCRYPTION_KEY: KEY, ENCRYPTION_KEY_FILE: fileHolding(KEY) },
      { ADMIN_TOKEN_FILE: fileHolding("") },
      { ADMIN_TOKEN: TOKEN, ADMIN_TOKEN_FILE: fileHolding(TOKEN) }
    ];
    for (const source of cases) {
      let message = "";
      try {
        resolveSecretFiles(source);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(KEY);
      expect(message).not.toContain(TOKEN);
    }
  });

  it("treats a blank variable as unset, so an empty Compose value is not a conflict", () => {
    const resolved = resolveSecretFiles({
      ENCRYPTION_KEY_PREVIOUS: "",
      ENCRYPTION_KEY_PREVIOUS_FILE: fileHolding(KEY)
    });
    expect(resolved["ENCRYPTION_KEY_PREVIOUS"]).toBe(KEY);
  });

  it("treats a blank _FILE as unset, for the same reason", () => {
    const resolved = resolveSecretFiles({ ENCRYPTION_KEY: KEY, ENCRYPTION_KEY_FILE: "  " });
    expect(resolved["ENCRYPTION_KEY"]).toBe(KEY);
  });

  it("reports every setting that is wrong, not only the first", () => {
    const attempt = (): unknown =>
      resolveSecretFiles({
        ENCRYPTION_KEY: KEY,
        ENCRYPTION_KEY_FILE: fileHolding(KEY),
        ADMIN_TOKEN: TOKEN,
        ADMIN_TOKEN_FILE: fileHolding(TOKEN)
      });
    expect(attempt).toThrow(/ENCRYPTION_KEY_FILE/);
    expect(attempt).toThrow(/ADMIN_TOKEN_FILE/);
  });

  it("resolves an already-resolved environment to the same thing", () => {
    // Doctor resolves once for its own checks and hands the result to the
    // keyring, which resolves again. Leaving the _FILE variable in place would
    // make that second pass read the setting as given both ways.
    const source = { ENCRYPTION_KEY_FILE: fileHolding(KEY), ADMIN_TOKEN_FILE: fileHolding(TOKEN) };
    const once = resolveSecretFiles(source);
    expect(resolveSecretFiles(once)).toEqual(once);
    expect(once["ENCRYPTION_KEY_FILE"]).toBe("");
  });

  it("does not leave the file path where the value is expected", () => {
    const path = fileHolding(KEY);
    expect(resolveSecretFiles({ ENCRYPTION_KEY_FILE: path })["ENCRYPTION_KEY"]).not.toBe(path);
  });
});
