import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadWebConfig, sessionAdminToken } from "./config";

const valid = { ADMIN_TOKEN: "admin-token-for-tests-0000000000", API_URL: "http://api:8080" };

/** A file holding `contents`, in a directory of this test's own. */
const fileHolding = (contents: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), "wayscribe-web-config-")), "admin-token");
  writeFileSync(path, contents, "utf8");
  return path;
};

describe("loadWebConfig", () => {
  it("parses a valid environment", () => {
    expect(loadWebConfig(valid).API_URL).toBe("http://api:8080");
  });

  it("names a missing variable", () => {
    const { API_URL: _omitted, ...without } = valid;
    expect(() => loadWebConfig(without)).toThrow(/API_URL/);
  });

  it("rejects a short admin token", () => {
    expect(() => loadWebConfig({ ...valid, ADMIN_TOKEN: "short" })).toThrow(/ADMIN_TOKEN/);
  });

  it("defaults TRUSTED_PROXY_COUNT to 0 and refuses a count that is not one", () => {
    expect(loadWebConfig(valid).TRUSTED_PROXY_COUNT).toBe(0);
    expect(loadWebConfig({ ...valid, TRUSTED_PROXY_COUNT: "" }).TRUSTED_PROXY_COUNT).toBe(0);
    expect(loadWebConfig({ ...valid, TRUSTED_PROXY_COUNT: "1" }).TRUSTED_PROXY_COUNT).toBe(1);
    for (const value of ["-1", "1.5", "x", "11"]) {
      expect(() => loadWebConfig({ ...valid, TRUSTED_PROXY_COUNT: value }), value).toThrow(
        /TRUSTED_PROXY_COUNT/
      );
    }
  });

  // The API trims ADMIN_TOKEN in packages/config; this app has to trim it the
  // same way. The API compares the value against the Authorization header and
  // this app signs its sessions with it, so a token file with a byte-order mark
  // or a leading space must not leave the two holding different strings.
  it.each([
    ["a trailing newline", (token: string): string => `${token}\n`],
    ["surrounding spaces", (token: string): string => `  ${token}  `],
    ["a byte-order mark", (token: string): string => `\uFEFF${token}`]
  ])("trims a token with %s, from the variable and from a file alike", (_case, decorate) => {
    const token = valid.ADMIN_TOKEN;
    const { ADMIN_TOKEN: _omitted, ...withoutToken } = valid;
    const fromVariable = { ...valid, ADMIN_TOKEN: decorate(token) };
    const fromFile = { ...withoutToken, ADMIN_TOKEN_FILE: fileHolding(decorate(token)) };

    expect(loadWebConfig(fromVariable).ADMIN_TOKEN).toBe(token);
    expect(loadWebConfig(fromFile).ADMIN_TOKEN).toBe(token);
    // And the auth gate verifies against exactly what the login route signs
    // with, which is the value above.
    expect(sessionAdminToken(fromVariable)).toBe(token);
    expect(sessionAdminToken(fromFile)).toBe(token);
  });

  it("rejects a malformed API URL", () => {
    expect(() => loadWebConfig({ ...valid, API_URL: "not-a-url" })).toThrow(/API_URL/);
  });

  describe("ADMIN_TOKEN_FILE", () => {
    it("reads the token from the file, trimming the newline a secrets file ends with", () => {
      const { ADMIN_TOKEN: token, ...withoutToken } = valid;
      const config = loadWebConfig({
        ...withoutToken,
        ADMIN_TOKEN_FILE: fileHolding(`${token}\n`)
      });
      // Byte for byte the API's value: the web app derives its session signing
      // key from it, so a kept newline would sign sessions the API refuses.
      expect(config.ADMIN_TOKEN).toBe(token);
    });

    it("refuses the variable and the file together, naming the setting and printing no value", () => {
      const attempt = (): unknown =>
        loadWebConfig({ ...valid, ADMIN_TOKEN_FILE: fileHolding(valid.ADMIN_TOKEN) });
      expect(attempt).toThrow(/ADMIN_TOKEN and ADMIN_TOKEN_FILE are both set/);
      let message = "";
      try {
        attempt();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).not.toContain(valid.ADMIN_TOKEN);
    });

    it("refuses an empty file rather than starting with no token", () => {
      const { ADMIN_TOKEN: _omitted, ...withoutToken } = valid;
      expect(() => loadWebConfig({ ...withoutToken, ADMIN_TOKEN_FILE: fileHolding("\n") })).toThrow(
        /ADMIN_TOKEN_FILE/
      );
    });

    it("gives the auth gate the token from the file", () => {
      const token = valid.ADMIN_TOKEN;
      expect(sessionAdminToken({ ADMIN_TOKEN_FILE: fileHolding(`${token}\n`) })).toBe(token);
      expect(sessionAdminToken({ ADMIN_TOKEN: token })).toBe(token);
    });

    it.each([
      ["unset", (): Record<string, string | undefined> => ({})],
      ["blank", (): Record<string, string | undefined> => ({ ADMIN_TOKEN: "   " })],
      [
        "a file that cannot be read",
        (): Record<string, string | undefined> => ({
          ADMIN_TOKEN_FILE: join(tmpdir(), "wayscribe-no-such")
        })
      ],
      [
        "an empty file",
        (): Record<string, string | undefined> => ({ ADMIN_TOKEN_FILE: fileHolding("\n") })
      ],
      [
        "both the variable and the file",
        (): Record<string, string | undefined> => ({
          ADMIN_TOKEN: valid.ADMIN_TOKEN,
          ADMIN_TOKEN_FILE: fileHolding(valid.ADMIN_TOKEN)
        })
      ]
    ])("is null, never an empty string, when the token is %s", (_name, source) => {
      // null rather than "": a caller verifying a cookie against an empty key
      // admits a cookie signed with an empty key, so a misconfiguration would
      // become a way in. The callers redirect on null without verifying.
      expect(sessionAdminToken(source())).toBeNull();
    });

    it("refuses a path that is not a regular file, before opening it", () => {
      const { ADMIN_TOKEN: _omitted, ...withoutToken } = valid;
      const directory = mkdtempSync(join(tmpdir(), "wayscribe-web-config-"));
      expect(() => loadWebConfig({ ...withoutToken, ADMIN_TOKEN_FILE: directory })).toThrow(
        /ADMIN_TOKEN_FILE does not name a regular file/
      );
    });

    it("refuses a file larger than the cap", () => {
      const { ADMIN_TOKEN: _omitted, ...withoutToken } = valid;
      expect(() =>
        loadWebConfig({ ...withoutToken, ADMIN_TOKEN_FILE: fileHolding("x".repeat(65_537)) })
      ).toThrow(/ADMIN_TOKEN_FILE names a file of 65537 bytes/);
    });

    it("refuses a file it cannot read", () => {
      const { ADMIN_TOKEN: _omitted, ...withoutToken } = valid;
      expect(() =>
        loadWebConfig({ ...withoutToken, ADMIN_TOKEN_FILE: join(tmpdir(), "wayscribe-no-such") })
      ).toThrow(/ADMIN_TOKEN_FILE/);
    });
  });
});
