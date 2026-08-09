import { describe, expect, it } from "vitest";
import { ConfigError, loadServerEnv } from "./load.js";

const validEnv = {
  DATABASE_URL: "postgresql://flight:flight@localhost:5432/flight",
  APP_URL: "http://localhost:3000",
  API_URL: "http://localhost:8080",
  ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
  ADMIN_TOKEN: "fedcba9876543210fedcba9876543210",
  REPLAY_ALLOWED_HOSTS: "localhost,host.docker.internal"
};

/** The error text, or a failure if the environment was wrongly accepted. */
function attempt(env: Record<string, string>): string {
  try {
    loadServerEnv(env);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected loadServerEnv to reject this environment");
}

describe("loadServerEnv", () => {
  it("parses a valid environment", () => {
    const config = loadServerEnv(validEnv);
    expect(config.DATABASE_URL).toBe(validEnv.DATABASE_URL);
    expect(config.REPLAY_ALLOWED_HOSTS).toEqual(["localhost", "host.docker.internal"]);
  });

  it("applies documented defaults", () => {
    const config = loadServerEnv(validEnv);
    expect(config.DEFAULT_RETENTION_DAYS).toBe(7);
    expect(config.MAX_EVENT_PAYLOAD_BYTES).toBe(262_144);
    expect(config.ALLOW_FULL_PAYLOAD_CAPTURE).toBe(false);
    expect(config.PORT).toBe(8080);
  });

  it("tells an operator what to do when DATABASE_URL is unset", () => {
    // Flight Recorder expects you to bring your own database, so an unset
    // DATABASE_URL is the most likely first-run mistake. `Invalid URL` is
    // accurate and useless; it does not say the variable is the problem, and it
    // does not mention the overlay that runs one for you.
    const { DATABASE_URL: _omitted, ...withoutDatabaseUrl } = validEnv;
    for (const env of [withoutDatabaseUrl, { ...validEnv, DATABASE_URL: "" }]) {
      const message = attempt(env);
      expect(message).toContain("DATABASE_URL");
      expect(message).toContain("not set");
      expect(message).toContain("compose.bundled.yaml");
    }
  });

  it("says something different when DATABASE_URL is set but wrong", () => {
    // The control: a single message for both cases would send somebody who set
    // a MySQL URL looking for a variable they had already set.
    const message = attempt({ ...validEnv, DATABASE_URL: "mysql://host/db" });
    expect(message).toContain("postgresql://");
    expect(message).not.toContain("not set");
  });

  it("names the missing variable when one is absent", () => {
    const { DATABASE_URL: _omitted, ...withoutDatabaseUrl } = validEnv;
    expect(() => loadServerEnv(withoutDatabaseUrl)).toThrow(ConfigError);
    expect(() => loadServerEnv(withoutDatabaseUrl)).toThrow(/DATABASE_URL/);
  });

  it("rejects an encryption key that is too short", () => {
    expect(() => loadServerEnv({ ...validEnv, ENCRYPTION_KEY: "short" })).toThrow(/ENCRYPTION_KEY/);
  });

  it("rejects a malformed database URL", () => {
    expect(() => loadServerEnv({ ...validEnv, DATABASE_URL: "not-a-url" })).toThrow(/DATABASE_URL/);
  });

  it("rejects an empty replay host allowlist", () => {
    expect(() => loadServerEnv({ ...validEnv, REPLAY_ALLOWED_HOSTS: "" })).toThrow(
      /REPLAY_ALLOWED_HOSTS/
    );
  });

  it("returns a frozen object", () => {
    const config = loadServerEnv(validEnv);
    expect(Object.isFrozen(config)).toBe(true);
  });
});
