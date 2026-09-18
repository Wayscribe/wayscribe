import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadWebConfig, sessionAdminToken } from "./config";

const valid = { ADMIN_TOKEN: "admin-token-for-tests-0000000000", API_URL: "http://api:8080" };

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

  it("rejects a malformed API URL", () => {
    expect(() => loadWebConfig({ ...valid, API_URL: "not-a-url" })).toThrow(/API_URL/);
  });

  describe("ADMIN_TOKEN_FILE", () => {
    const fileHolding = (contents: string): string => {
      const path = join(mkdtempSync(join(tmpdir(), "wayscribe-web-config-")), "admin-token");
      writeFileSync(path, contents, "utf8");
      return path;
    };

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

    it("gives the auth gate the token from the file, and '' for anything it cannot resolve", () => {
      const token = valid.ADMIN_TOKEN;
      expect(sessionAdminToken({ ADMIN_TOKEN_FILE: fileHolding(`${token}\n`) })).toBe(token);
      expect(sessionAdminToken({ ADMIN_TOKEN: token })).toBe(token);
      expect(sessionAdminToken({})).toBe("");
      // Misconfigured: no token, so no session verifies and the page redirects
      // to the login, exactly as an unset ADMIN_TOKEN already did.
      expect(sessionAdminToken({ ADMIN_TOKEN: token, ADMIN_TOKEN_FILE: fileHolding(token) })).toBe(
        ""
      );
      expect(sessionAdminToken({ ADMIN_TOKEN_FILE: join(tmpdir(), "wayscribe-no-such") })).toBe("");
    });

    it("refuses a file it cannot read", () => {
      const { ADMIN_TOKEN: _omitted, ...withoutToken } = valid;
      expect(() =>
        loadWebConfig({ ...withoutToken, ADMIN_TOKEN_FILE: join(tmpdir(), "wayscribe-no-such") })
      ).toThrow(/ADMIN_TOKEN_FILE/);
    });
  });
});
