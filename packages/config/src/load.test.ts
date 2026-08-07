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
