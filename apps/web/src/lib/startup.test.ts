import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { refuseToStartMisconfigured } from "./startup";

const TOKEN = "admin-token-for-tests-0000000000";
const valid = { ADMIN_TOKEN: TOKEN, API_URL: "http://api:8080" };

const tokenFile = (): string => {
  const path = join(mkdtempSync(join(tmpdir(), "wayscribe-web-startup-")), "admin-token");
  writeFileSync(path, `${TOKEN}\n`, "utf8");
  return path;
};

/** What the check did to the process: the exit code it asked for and what it wrote. */
function run(source: Record<string, string | undefined>): {
  started: boolean;
  exits: number[];
  written: string[];
} {
  const exits: number[] = [];
  const written: string[] = [];
  const started = refuseToStartMisconfigured(source, {
    exit: (code) => {
      exits.push(code);
    },
    error: (message) => {
      written.push(message);
    }
  });
  return { started, exits, written };
}

describe("refuseToStartMisconfigured", () => {
  it("lets a valid configuration start, and says nothing", () => {
    expect(run(valid)).toEqual({ started: true, exits: [], written: [] });
    const { ADMIN_TOKEN: _omitted, ...withoutToken } = valid;
    expect(run({ ...withoutToken, ADMIN_TOKEN_FILE: tokenFile() })).toEqual({
      started: true,
      exits: [],
      written: []
    });
  });

  // F-030's two misconfigurations. Before this check each one started a server
  // Docker called healthy, and the first sign was a 500 on sign-in.
  it("exits 1 when ADMIN_TOKEN and ADMIN_TOKEN_FILE are both set, with the specific message and no value", () => {
    const other = "a-different-admin-token-000000000000";
    const result = run({ ...valid, ADMIN_TOKEN: other, ADMIN_TOKEN_FILE: tokenFile() });

    expect(result.started).toBe(false);
    expect(result.exits).toEqual([1]);
    expect(result.written).toHaveLength(1);
    expect(result.written[0]).toContain("ADMIN_TOKEN and ADMIN_TOKEN_FILE are both set");
    expect(result.written[0]).not.toContain(other);
    expect(result.written[0]).not.toContain(TOKEN);
  });

  it("exits 1 when ADMIN_TOKEN_FILE names no file, naming the path", () => {
    const { ADMIN_TOKEN: _omitted, ...withoutToken } = valid;
    const missing = join(tmpdir(), "wayscribe-web-startup-no-such-file");
    const result = run({ ...withoutToken, ADMIN_TOKEN_FILE: missing });

    expect(result.started).toBe(false);
    expect(result.exits).toEqual([1]);
    expect(result.written[0]).toContain(`ADMIN_TOKEN_FILE names a file that could not be read`);
    expect(result.written[0]).toContain(missing);
  });

  it("exits 1 on a missing variable, naming it", () => {
    const { API_URL: _omitted, ...withoutUrl } = valid;
    const result = run(withoutUrl);

    expect(result.exits).toEqual([1]);
    expect(result.written[0]).toMatch(/Invalid web configuration:\n {2}API_URL/);
  });

  // The message is the whole report: a stack trace of minified chunk names
  // under it is what F-030 found in the log, and it says nothing an operator
  // can act on.
  it("writes the message without a stack trace", () => {
    const { API_URL: _omitted, ...withoutUrl } = valid;
    expect(run(withoutUrl).written[0]).not.toMatch(/\n\s+at /);
  });
});
