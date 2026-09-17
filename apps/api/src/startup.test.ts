import { describe, expect, it } from "vitest";
import { prepareStartup } from "./startup.js";

const KEY_A = "0123456789abcdef0123456789abcdef";
const KEY_B = "fedcba9876543210fedcba9876543210";

const env = {
  DATABASE_URL: "postgresql://flight:flight@localhost:5432/flight",
  APP_URL: "http://localhost:3000",
  API_URL: "http://localhost:8080",
  ENCRYPTION_KEY: KEY_B,
  ADMIN_TOKEN: "fedcba9876543210fedcba9876543210",
  REPLAY_ALLOWED_HOSTS: "localhost"
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
