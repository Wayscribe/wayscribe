import { describe, expect, it } from "vitest";
import { ConfigError, loadEncryptionKeys, loadServerEnv, loadStatementTimeoutMs } from "./load.js";

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
    // Wayscribe expects you to bring your own database, so an unset
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

  it("leaves ENCRYPTION_KEY_PREVIOUS unset when it is absent", () => {
    expect(loadServerEnv(validEnv).ENCRYPTION_KEY_PREVIOUS).toBeUndefined();
  });

  it("accepts ENCRYPTION_KEY_PREVIOUS during a rotation", () => {
    const previous = "fedcba9876543210fedcba9876543210";
    const config = loadServerEnv({ ...validEnv, ENCRYPTION_KEY_PREVIOUS: previous });
    expect(config.ENCRYPTION_KEY_PREVIOUS).toBe(previous);
  });

  it("rejects an ENCRYPTION_KEY_PREVIOUS that is too short", () => {
    const message = attempt({ ...validEnv, ENCRYPTION_KEY_PREVIOUS: "short" });
    expect(message).toContain("ENCRYPTION_KEY_PREVIOUS");
  });

  it("treats an empty or whitespace-only ENCRYPTION_KEY_PREVIOUS as unset", () => {
    // Compose passes an unset variable through as an empty string, and a secrets
    // file can hold a lone newline. Either is "no rotation in progress", not a
    // key too short to use.
    for (const blank of ["", "   ", "\n"]) {
      const config = loadServerEnv({ ...validEnv, ENCRYPTION_KEY_PREVIOUS: blank });
      expect(config.ENCRYPTION_KEY_PREVIOUS).toBeUndefined();
    }
  });

  it("trims whitespace around both encryption keys", () => {
    // A trailing newline from a secrets file would otherwise make the same key
    // look different, so the keyring's same-key check could not catch it.
    const config = loadServerEnv({
      ...validEnv,
      ENCRYPTION_KEY: `  ${validEnv.ENCRYPTION_KEY}\n`,
      ENCRYPTION_KEY_PREVIOUS: "fedcba9876543210fedcba9876543210\n"
    });
    expect(config.ENCRYPTION_KEY).toBe(validEnv.ENCRYPTION_KEY);
    expect(config.ENCRYPTION_KEY_PREVIOUS).toBe("fedcba9876543210fedcba9876543210");
  });

  it("measures an encryption key's length after trimming", () => {
    const padded = `${"a".repeat(31)}\n\n`;
    expect(() => loadServerEnv({ ...validEnv, ENCRYPTION_KEY: padded })).toThrow(/ENCRYPTION_KEY/);
    const message = attempt({ ...validEnv, ENCRYPTION_KEY_PREVIOUS: padded });
    expect(message).toContain("ENCRYPTION_KEY_PREVIOUS");
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

describe("loadEncryptionKeys", () => {
  // The database CLI and the demo bootstrap read the keys without the rest of
  // the server's environment. They must normalise them exactly as the API does,
  // or a key:create run beside a rotated API would disagree about the keys.
  it("reads the keys alone, normalised as the server reads them", () => {
    const keys = loadEncryptionKeys({
      ENCRYPTION_KEY: `${validEnv.ENCRYPTION_KEY}\n`,
      ENCRYPTION_KEY_PREVIOUS: " "
    });
    expect(keys).toEqual({ ENCRYPTION_KEY: validEnv.ENCRYPTION_KEY });
  });

  it("names the variable when the current key is missing", () => {
    expect(() => loadEncryptionKeys({})).toThrow(ConfigError);
    expect(() => loadEncryptionKeys({})).toThrow(/ENCRYPTION_KEY/);
  });
});

describe("DATABASE_STATEMENT_TIMEOUT_MS", () => {
  it("defaults to fifteen seconds", () => {
    expect(loadServerEnv(validEnv).DATABASE_STATEMENT_TIMEOUT_MS).toBe(15_000);
  });

  it("treats blank as unset, as Compose passes an unset variable", () => {
    for (const blank of ["", "  "]) {
      const config = loadServerEnv({ ...validEnv, DATABASE_STATEMENT_TIMEOUT_MS: blank });
      expect(config.DATABASE_STATEMENT_TIMEOUT_MS).toBe(15_000);
    }
  });

  it("accepts 0, which disables the timeout", () => {
    const config = loadServerEnv({ ...validEnv, DATABASE_STATEMENT_TIMEOUT_MS: "0" });
    expect(config.DATABASE_STATEMENT_TIMEOUT_MS).toBe(0);
  });

  it.each(["-1", "1.5", "soon", "2147483648"])("rejects %s, naming the variable", (value) => {
    expect(attempt({ ...validEnv, DATABASE_STATEMENT_TIMEOUT_MS: value })).toContain(
      "DATABASE_STATEMENT_TIMEOUT_MS"
    );
  });

  it("is readable on its own, for doctor", () => {
    expect(loadStatementTimeoutMs({})).toBe(15_000);
    expect(loadStatementTimeoutMs({ DATABASE_STATEMENT_TIMEOUT_MS: "250" })).toBe(250);
    expect(() => loadStatementTimeoutMs({ DATABASE_STATEMENT_TIMEOUT_MS: "x" })).toThrow(
      /DATABASE_STATEMENT_TIMEOUT_MS/
    );
  });
});

describe("METRICS_PORT", () => {
  it("is unset by default, so no metrics listener starts", () => {
    expect(loadServerEnv(validEnv).METRICS_PORT).toBeUndefined();
  });

  it("treats blank as unset", () => {
    expect(loadServerEnv({ ...validEnv, METRICS_PORT: "" }).METRICS_PORT).toBeUndefined();
  });

  it("accepts a port", () => {
    expect(loadServerEnv({ ...validEnv, METRICS_PORT: "9464" }).METRICS_PORT).toBe(9464);
  });

  it.each(["0", "65536", "http", "94.64"])("rejects %s, naming the variable", (value) => {
    expect(attempt({ ...validEnv, METRICS_PORT: value })).toContain("METRICS_PORT");
  });

  it("refuses the API's own port, so metrics never sit beside ingestion", () => {
    const message = attempt({ ...validEnv, PORT: "8080", METRICS_PORT: "8080" });
    expect(message).toContain("METRICS_PORT");
    expect(message).toContain("must differ from PORT");
  });
});

describe("TRUSTED_PROXY_COUNT", () => {
  it("defaults to 0, so X-Forwarded-For is ignored unless an operator says otherwise", () => {
    expect(loadServerEnv(validEnv).TRUSTED_PROXY_COUNT).toBe(0);
    expect(loadServerEnv({ ...validEnv, TRUSTED_PROXY_COUNT: "" }).TRUSTED_PROXY_COUNT).toBe(0);
  });

  it("accepts a hop count", () => {
    expect(loadServerEnv({ ...validEnv, TRUSTED_PROXY_COUNT: "2" }).TRUSTED_PROXY_COUNT).toBe(2);
  });

  it("refuses a negative, fractional, or absurd count, naming the variable", () => {
    for (const value of ["-1", "1.5", "abc", "11"]) {
      expect(attempt({ ...validEnv, TRUSTED_PROXY_COUNT: value }), value).toMatch(
        /TRUSTED_PROXY_COUNT/
      );
    }
  });
});
