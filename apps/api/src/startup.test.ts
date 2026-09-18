import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareStartup } from "./startup.js";

const KEY_A = "0123456789abcdef0123456789abcdef";
const KEY_B = "fedcba9876543210fedcba9876543210";

const env = {
  DATABASE_URL: "postgresql://wayscribe:wayscribe@localhost:5432/wayscribe",
  APP_URL: "http://localhost:3000",
  API_URL: "http://localhost:8080",
  ENCRYPTION_KEY: KEY_B,
  ADMIN_TOKEN: "fedcba9876543210fedcba9876543210",
  REPLAY_ALLOWED_HOSTS: "localhost"
};

/** A file holding `contents`, in a directory of this test's own. */
const fileHolding = (contents: string, name = "secret"): string => {
  const path = join(mkdtempSync(join(tmpdir(), "wayscribe-startup-")), name);
  writeFileSync(path, contents, "utf8");
  return path;
};

describe("prepareStartup", () => {
  it("returns the configuration and a keyring holding both keys during a rotation", () => {
    const startup = prepareStartup({ ...env, ENCRYPTION_KEY_PREVIOUS: KEY_A });
    if (!startup.ok) throw new Error(startup.message);
    expect(startup.env.DATABASE_URL).toBe(env.DATABASE_URL);
    expect(startup.keyring.previous).not.toBeNull();
    expect(startup.keyring.current.id).not.toBe(startup.keyring.previous?.id);
  });

  it("refuses one key set as both current and previous with a message rather than a throw", () => {
    // A throw here escaped as an uncaught exception: a stack trace in the
    // container log instead of a sentence saying which variable to change.
    const startup = prepareStartup({ ...env, ENCRYPTION_KEY_PREVIOUS: KEY_B });
    expect(startup).toEqual({
      ok: false,
      message:
        "Wayscribe API cannot start:\n" +
        "  ENCRYPTION_KEY_PREVIOUS is the same key as ENCRYPTION_KEY; set it to the key being rotated out."
    });
  });

  it("starts with the key and the token read from the files their _FILE settings name", () => {
    const directory = mkdtempSync(join(tmpdir(), "wayscribe-startup-"));
    const keyFile = join(directory, "encryption-key");
    const tokenFile = join(directory, "admin-token");
    // A trailing newline, the way `kubectl create secret --from-file` and an
    // editor both leave one.
    writeFileSync(keyFile, `${KEY_B}\n`, "utf8");
    writeFileSync(tokenFile, `${env.ADMIN_TOKEN}\n`, "utf8");

    const startup = prepareStartup({
      ...env,
      ENCRYPTION_KEY: undefined,
      ADMIN_TOKEN: undefined,
      ENCRYPTION_KEY_FILE: keyFile,
      ADMIN_TOKEN_FILE: tokenFile
    });
    if (!startup.ok) throw new Error(startup.message);
    expect(startup.env.ADMIN_TOKEN).toBe(env.ADMIN_TOKEN);
    // The same key as the variable would have given: the newline is gone, so
    // the key's fingerprint, and every verifier under it, is unchanged.
    const fromTheVariable = prepareStartup(env);
    expect(startup.keyring.current.id).toBe(
      fromTheVariable.ok ? fromTheVariable.keyring.current.id : "(refused)"
    );
  });

  it("refuses a setting given both ways, naming it and printing no value", () => {
    const directory = mkdtempSync(join(tmpdir(), "wayscribe-startup-"));
    const keyFile = join(directory, "encryption-key");
    writeFileSync(keyFile, KEY_B, "utf8");

    const startup = prepareStartup({ ...env, ENCRYPTION_KEY_FILE: keyFile });
    expect(startup.ok).toBe(false);
    if (startup.ok) return;
    expect(startup.message).toContain("ENCRYPTION_KEY and ENCRYPTION_KEY_FILE are both set");
    expect(startup.message).not.toContain(KEY_B);
  });

  it("refuses an empty secret file rather than starting without the setting", () => {
    const directory = mkdtempSync(join(tmpdir(), "wayscribe-startup-"));
    const tokenFile = join(directory, "admin-token");
    writeFileSync(tokenFile, "\n", "utf8");

    const startup = prepareStartup({ ...env, ADMIN_TOKEN: undefined, ADMIN_TOKEN_FILE: tokenFile });
    expect(startup.ok).toBe(false);
    if (startup.ok) return;
    expect(startup.message).toContain("ADMIN_TOKEN_FILE names a file with nothing in it");
  });

  it("warns at boot about a published default that reached it through a file", () => {
    // The warning used to be looked for in process.env, where a setting read
    // from a file never appears, so a stack pointed at a file holding the
    // published default started in silence. It is looked for in the values the
    // API runs on instead.
    const published = "replace-for-local-development-0000";
    const startup = prepareStartup({
      ...env,
      ENCRYPTION_KEY: undefined,
      ADMIN_TOKEN: undefined,
      ENCRYPTION_KEY_FILE: fileHolding(`${published}\n`, "encryption-key"),
      ADMIN_TOKEN_FILE: fileHolding(published, "admin-token")
    });
    if (!startup.ok) throw new Error(startup.message);
    expect(startup.insecureDefaults.map((finding) => finding.variable).sort()).toEqual([
      "ADMIN_TOKEN",
      "ENCRYPTION_KEY"
    ]);
  });

  it("finds the same defaults whether they arrive as variables or as files", () => {
    const published = "replace-for-local-development-0000";
    const fromVariables = prepareStartup({
      ...env,
      ENCRYPTION_KEY: published,
      ADMIN_TOKEN: published
    });
    const fromFiles = prepareStartup({
      ...env,
      ENCRYPTION_KEY: undefined,
      ADMIN_TOKEN: undefined,
      ENCRYPTION_KEY_FILE: fileHolding(published, "encryption-key"),
      ADMIN_TOKEN_FILE: fileHolding(published, "admin-token")
    });
    if (!fromVariables.ok || !fromFiles.ok) throw new Error("expected both to start");
    expect(fromFiles.insecureDefaults).toEqual(fromVariables.insecureDefaults);
  });

  it("warns about nothing when the configured values are the operator's own", () => {
    const startup = prepareStartup(env);
    if (!startup.ok) throw new Error(startup.message);
    expect(startup.insecureDefaults).toEqual([]);
  });

  it("refuses an invalid environment with the variables named", () => {
    const startup = prepareStartup({ ...env, ENCRYPTION_KEY: "short" });
    expect(startup.ok).toBe(false);
    if (startup.ok) return;
    // Each invalid variable sits under the configuration header, not beside it.
    expect(startup.message).toMatch(
      /^Wayscribe API cannot start:\n {2}Invalid environment configuration:\n {4}ENCRYPTION_KEY: /
    );
  });
});
