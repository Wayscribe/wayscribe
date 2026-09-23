import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeBackupConnection, validateRestoreDatabase } from "./connection.js";
const url = "postgresql://alice:secret@127.0.0.1:5433/source";
afterEach(() => vi.unstubAllEnvs());
describe("backup connection boundary", () => {
  it("normalizes one target for both clients", () => {
    const target = normalizeBackupConnection(url);
    expect(target.toolEnvironment).toMatchObject({
      PGDATABASE: "source",
      PGHOST: "127.0.0.1",
      PGPORT: "5433",
      PGUSER: "alice",
      PGPASSWORD: "secret",
      PGSSLMODE: "disable"
    });
    expect(target.pgConfig).toMatchObject({
      database: "source",
      host: "127.0.0.1",
      port: 5433,
      user: "alice",
      ssl: false
    });
  });
  it.each([
    "dbname=other",
    "host=evil",
    "service=other",
    "options=evil",
    "sslmode=disable&sslmode=disable",
    "sslmode=require",
    "sslmode=prefer",
    "sslmode=verify-full",
    "sslcert=key",
    "unknown=value"
  ])("fails closed for %s", (query) => {
    expect(() => normalizeBackupConnection(`${url}?${query}`)).toThrow();
  });
  it("ignores inherited pg overrides in both consumers", () => {
    for (const key of [
      "PGHOST",
      "PGDATABASE",
      "PGPASSWORD",
      "PGOPTIONS",
      "PGREPLICATION",
      "PGAPPNAME",
      "PGSSLMODE",
      "PGSSLNEGOTIATION",
      "PGCLIENT_ENCODING"
    ])
      vi.stubEnv(key, "hostile");
    const target = normalizeBackupConnection(url, {
      ...process.env,
      PGSERVICE: "evil",
      PGHOSTADDR: "10.0.0.1"
    });
    const client = new pg.Client(target.pgConfig);
    expect(
      (client as unknown as { connectionParameters: object }).connectionParameters
    ).toMatchObject({
      database: "source",
      host: "127.0.0.1",
      ssl: false,
      replication: "false",
      client_encoding: "UTF8",
      sslnegotiation: "postgres"
    });
    expect(target.toolEnvironment.PGSERVICE).toBeUndefined();
    expect(target.toolEnvironment.PGHOSTADDR).toBeUndefined();
    expect(Object.values(target.toolEnvironment)).not.toContain("hostile");
  });
  it("passes only an allowlisted environment to the tools", () => {
    const target = normalizeBackupConnection(url, {
      PATH: "/usr/bin",
      HOME: "/home/alice",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      LC_MESSAGES: "C",
      TZ: "UTC",
      ENCRYPTION_KEY: "key",
      ENCRYPTION_KEY_PREVIOUS: "old-key",
      ADMIN_TOKEN: "admin",
      DATABASE_URL: "postgresql://root:root@db/app",
      AWS_SECRET_ACCESS_KEY: "aws",
      NODE_OPTIONS: "--require evil.js",
      LD_PRELOAD: "evil.so"
    });
    const inherited = Object.keys(target.toolEnvironment).filter((key) => !key.startsWith("PG"));
    expect(inherited.sort()).toEqual(["HOME", "LANG", "LC_ALL", "LC_MESSAGES", "PATH", "TZ"]);
    for (const secret of ["key", "old-key", "admin", "aws", "evil.so"])
      expect(Object.values(target.toolEnvironment)).not.toContain(secret);
    expect(target.toolEnvironment.PGPASSWORD).toBe("secret");
  });
  it("refuses source and system databases", () => {
    for (const database of ["source", "postgres", "template0", "template1", "CAPS", "bad-name"])
      expect(() => {
        validateRestoreDatabase(database, "source");
      }).toThrow();
    expect(() => {
      validateRestoreDatabase("copy", "source");
    }).not.toThrow();
  });
});
it.each([
  "postgresql://alice@localhost/source",
  "postgresql://alice:pass@localhost",
  "postgresql://alice:pass@localhost/source#fragment",
  "postgresql://alice:pass@localhost/source?sslmode=allow",
  "postgresql://alice:pass@localhost/source?sslmode=no-verify",
  "postgresql://alice:pass@localhost/source?sslmode=verify-full&sslrootcert=system",
  "postgresql://alice:pass@localhost/source?sslmode=verify-full&sslrootcert=/missing-ca"
])("rejects unsupported credential/target/TLS form %s", (value) => {
  expect(() => normalizeBackupConnection(value)).toThrow();
});
