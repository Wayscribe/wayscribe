import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createKeyring,
  encryptValue,
  decryptValue,
  searchTokens
} from "@wayscribe/payload-security";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { startContainer, startPostgres, type TestDatabase } from "./testing/postgres.js";
import { createKnexConfig } from "./knex-config.js";
import { seedLocal } from "./seed-local.js";
import { findJourneyDetail } from "./repositories/journey-reads.js";
import { normalizeBackupConnection, prepareToolEnvironment } from "./backup/connection.js";
import { createBackup } from "./backup/archive.js";
import { restoreBackup, withRestoredDatabase } from "./backup/restore.js";
import { verifyBackup, verifyRestoredDatabase } from "./backup/verify.js";
import { createDestination, listDestinations } from "./repositories/replay.js";
import { runBackupCommand } from "./backup/command.js";
const exec = promisify(execFile);
const KEY = "backup_key_sentinel_12345678901234";
const OLD_KEY = "old_backup_key_1234567890123456789";
const PAYLOAD = "PAYLOAD_SENTINEL_BACKUP";
const ring = createKeyring(KEY, OLD_KEY);
const timeoutMs = 15_000;
// pg_restore 17+ sends `SET transaction_timeout`, which 15 and 16 reject, so
// restore and verify refuse those servers; create still works on them.
const serverMajor = Number(/^postgres:(\d+)/.exec(inject("postgresImage"))?.[1]);
const restoreSupported = serverMajor >= 17;

describe.runIf(!restoreSupported)("backup on a PostgreSQL server older than 17", () => {
  let container: TestDatabase | undefined;
  let dir: string;
  let databaseUrl: string;
  let input: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "wayscribe-backup-old-server-"));
    container = await startPostgres({ dedicated: true });
    databaseUrl = container.getConnectionUri();
    const db = knex(createKnexConfig(databaseUrl));
    try {
      await db.migrate.latest();
    } finally {
      await db.destroy();
    }
    input = join(dir, "source.dump");
  });
  afterAll(async () => {
    await Promise.all([container?.stop(), dir ? rm(dir, { recursive: true, force: true }) : 0]);
  });

  it("creates a backup, then refuses restore and verify before creating any database", async () => {
    await createBackup({ databaseUrl, output: input, timeoutMs });
    expect((await stat(input)).size).toBeGreaterThan(0);
    await expect(
      restoreBackup({ databaseUrl, input, database: "wayscribe_restored_old", timeoutMs })
    ).rejects.toMatchObject({ code: "server_version" });
    await expect(
      verifyBackup({ databaseUrl, input, timeoutMs, keyring: ring })
    ).rejects.toMatchObject({ code: "server_version" });
    const db = knex(createKnexConfig(databaseUrl));
    try {
      const { rows } = await db.raw<{ rows: { datname: string }[] }>(
        "select datname from pg_database where datname like 'wayscribe_rest%'"
      );
      expect(rows).toEqual([]);
    } finally {
      await db.destroy();
    }
  });
});

describe.runIf(restoreSupported)("private archive and owned restore on PostgreSQL", () => {
  let container: TestDatabase | undefined;
  let db: Knex;
  let dir: string;
  let databaseUrl: string;
  let input: string;
  let projectId: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "wayscribe-backup-integration-"));
    container = await startPostgres({ dedicated: true });
    databaseUrl = container.getConnectionUri();
    db = knex(createKnexConfig(databaseUrl));
    await db.migrate.latest();
    const seed = await seedLocal(db, ring);
    projectId = seed.projectId;
    await db("journeys").insert({
      id: "jrn_backup",
      project_id: projectId,
      environment_id: seed.environmentId,
      entity_type: "customer",
      primary_entity_id_hash: searchTokens(ring, "entity-backup")[0],
      encrypted_primary_entity_id: encryptValue(ring, "entity-backup"),
      status: "active",
      started_at: new Date(),
      last_event_at: new Date(),
      event_count: 1
    });
    await db("entity_aliases").insert({
      project_id: projectId,
      journey_id: "jrn_backup",
      alias_type: "crm",
      // Written under the previous key, so its token is the previous key's.
      alias_value_hash: searchTokens(ring, "old-key-alias")[1],
      encrypted_display_value: encryptValue(createKeyring(OLD_KEY), "old-key-alias")
    });
    await db("journey_events").insert({
      id: "evt_backup",
      project_id: projectId,
      environment_id: seed.environmentId,
      journey_id: "jrn_backup",
      protocol_version: "0.1",
      content_hash: "synthetic",
      operation: "transformed",
      name: "map",
      service: "backup-test",
      event_timestamp: new Date(),
      input_payload: JSON.stringify({ value: PAYLOAD }),
      output_payload: JSON.stringify({ value: "changed" }),
      payload_diff: JSON.stringify([{ path: "value", before: PAYLOAD, after: "changed" }])
    });
    await createDestination(db, ring, {
      projectId,
      name: "synthetic",
      baseUrl: "http://127.0.0.1:9",
      environmentType: "development",
      headers: { authorization: "DESTINATION_SENTINEL" }
    });
    input = join(dir, "source.dump");
    await createBackup({ databaseUrl, output: input, timeoutMs });
  });
  afterAll(async () => {
    const results = await Promise.allSettled([
      // Unset when beforeAll failed before connecting.
      Promise.resolve().then(() => (db as Knex | undefined)?.destroy()),
      Promise.resolve().then(() => container?.stop()),
      Promise.resolve().then(() => (dir ? rm(dir, { recursive: true, force: true }) : undefined))
    ]);
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures, "Owned integration cleanup failed");
  });
  const exists = async (name: string): Promise<boolean> =>
    (await db("pg_database").where({ datname: name })).length > 0;
  it("restores repository queries, aliases, transformations and both encryption generations", async () => {
    expect((await stat(input)).mode & 0o777).toBe(0o600);
    await restoreBackup({ databaseUrl, input, database: "restored_copy", timeoutMs });
    const url = new URL(databaseUrl);
    url.pathname = "/restored_copy";
    const restored = knex(createKnexConfig(url.toString()));
    try {
      const detail = await findJourneyDetail(restored, { projectId }, "jrn_backup");
      expect(await listDestinations(restored, projectId)).toEqual(
        await listDestinations(db, projectId)
      );
      expect(detail).toEqual(await findJourneyDetail(db, { projectId }, "jrn_backup"));
      expect(decryptValue(ring, detail?.encryptedPrimaryEntityId ?? "")).toBe("entity-backup");
      expect(decryptValue(ring, detail?.aliases[0]?.encryptedDisplayValue ?? "")).toBe(
        "old-key-alias"
      );
      expect(
        await restored("journey_events").select("input_payload", "output_payload", "payload_diff")
      ).toEqual(
        await db("journey_events").select("input_payload", "output_payload", "payload_diff")
      );
    } finally {
      await restored.destroy();
    }
    expect(await exists("restored_copy")).toBe(true);
    await expect(
      restoreBackup({ databaseUrl, input, database: "restored_copy", timeoutMs })
    ).rejects.toMatchObject({ code: "database_exists" });
    expect(await exists("restored_copy")).toBe(true);
    await db.raw('DROP DATABASE "restored_copy"');
  });
  it("always removes the generated inspection database, including callback failure and timeout", async () => {
    let generated = "";
    const readName = async (copy: Knex): Promise<string> => {
      const result = await copy.raw<{ rows: { name: string }[] }>(
        "select current_database() as name"
      );
      generated = result.rows[0]?.name ?? "";
      return generated;
    };
    expect(await withRestoredDatabase({ databaseUrl, input, timeoutMs }, readName)).toMatch(
      /^wayscribe_restore_check_[a-f0-9]+$/
    );
    expect(await exists(generated)).toBe(false);
    const original = new Error("inspect sentinel");
    await expect(
      withRestoredDatabase({ databaseUrl, input, timeoutMs }, async (copy) => {
        await readName(copy);
        throw original;
      })
    ).rejects.toBe(original);
    expect(await exists(generated)).toBe(false);
    generated = "";
    await expect(
      withRestoredDatabase({ databaseUrl, input, timeoutMs: 1500 }, async (copy) => {
        await readName(copy);
        await copy.raw("select pg_sleep(10)");
      })
    ).rejects.toBeDefined();
    expect(generated).toMatch(/^wayscribe_restore_check_/);
    expect(await exists(generated)).toBe(false);
  });
  const temporaryRestoreNames = async (): Promise<string[]> =>
    (
      await db("pg_database").select("datname").whereLike("datname", "wayscribe_restore_check_%")
    ).map((r: { datname: string }) => r.datname);
  const sourceSnapshot = async (): Promise<unknown> =>
    Promise.all(
      [
        "projects",
        "environments",
        "api_keys",
        "journeys",
        "entity_aliases",
        "journey_events",
        "replay_destinations",
        "replay_runs",
        "audit_events",
        "knex_migrations"
      ].map(async (table) => ({ table, rows: await db(table).select("*").orderBy("id") }))
    );
  it("verifies both encryption generations without changing the source and always removes the copy", async () => {
    const before = await sourceSnapshot();
    const result = await verifyBackup({ databaseUrl, input, timeoutMs: 30_000, keyring: ring });
    expect(result).toMatchObject({ ok: true, failures: [], encryptedValuesExamined: 3 });
    expect(result.tables).toHaveLength(9);
    expect(await sourceSnapshot()).toEqual(before);
    expect(await temporaryRestoreNames()).toEqual([]);
    for (const keyring of [
      createKeyring(KEY),
      createKeyring("wrong_backup_key_12345678901234567")
    ]) {
      expect(await verifyBackup({ databaseUrl, input, timeoutMs, keyring })).toMatchObject({
        ok: false,
        failures: ["encrypted_values_unreadable"],
        encryptedValuesExamined: 3
      });
      expect(await temporaryRestoreNames()).toEqual([]);
    }
  });
  it("authenticates a corrupt middle value across batches larger than 500 with valid endpoints", async () => {
    const corrupt = join(dir, "corrupt.dump");
    await withRestoredDatabase({ databaseUrl, input, timeoutMs }, async (copy) => {
      const rows = Array.from({ length: 503 }, (_, n) => ({
        id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
        project_id: projectId,
        journey_id: "jrn_backup",
        alias_type: "batch",
        alias_value_hash: searchTokens(ring, `batch-${String(n)}`)[0],
        encrypted_display_value:
          n === 251
            ? encryptValue(ring, "SECRET").slice(0, -4) + "AAAA"
            : encryptValue(ring, `batch-${String(n)}`)
      }));
      await copy("entity_aliases").insert(rows);
      const name =
        ((await copy.raw("select current_database() as name")).rows as { name: string }[])[0]
          ?.name ?? "";
      const url = new URL(databaseUrl);
      url.pathname = `/${name}`;
      await createBackup({ databaseUrl: url.toString(), output: corrupt, timeoutMs });
    });
    const before = await sourceSnapshot();
    const result = await verifyBackup({
      databaseUrl,
      input: corrupt,
      timeoutMs: 30_000,
      keyring: ring
    });
    expect(result).toMatchObject({
      ok: false,
      encryptedValuesExamined: 506,
      failures: ["encrypted_values_unreadable"]
    });
    expect(result.encryptedValuesExamined).toBeGreaterThan(500);
    expect(JSON.stringify(result)).not.toMatch(/SECRET|batch-251|old-key-alias/);
    expect(await sourceSnapshot()).toEqual(before);
    expect(await temporaryRestoreNames()).toEqual([]);
  });
  it.each(["missing", "pending", "unknown"])(
    "refuses %s migration metadata before reading application tables",
    async (kind) => {
      await withRestoredDatabase({ databaseUrl, input, timeoutMs }, async (copy) => {
        if (kind === "missing") await copy.schema.dropTable("knex_migrations");
        if (kind === "pending") await copy("knex_migrations").where("id", 1).del();
        if (kind === "unknown")
          await copy("knex_migrations").insert({
            name: "SECRET_UNKNOWN.js",
            batch: 99,
            migration_time: new Date()
          });
        await copy.schema.dropTable("audit_events"); // Must never query this now-missing application table.
        const before = await copy.schema.hasTable("knex_migrations");
        const result = await verifyRestoredDatabase(copy, ring);
        expect(result).toMatchObject({
          ok: false,
          failures: ["schema_mismatch"],
          tables: [],
          encryptedValuesExamined: 0
        });
        expect(JSON.stringify(result)).not.toContain("SECRET_UNKNOWN");
        expect(await copy.schema.hasTable("knex_migrations")).toBe(before);
      });
      expect(await temporaryRestoreNames()).toEqual([]);
    }
  );
  it("accepts an empty migrated database and refuses a non-Wayscribe archive", async () => {
    await withRestoredDatabase({ databaseUrl, input, timeoutMs }, async (copy) => {
      await copy.raw("truncate projects cascade");
      expect(await verifyRestoredDatabase(copy, ring)).toMatchObject({
        ok: true,
        encryptedValuesExamined: 0
      });
      await copy.raw("drop schema public cascade; create schema public");
      const name =
        ((await copy.raw("select current_database() as name")).rows as { name: string }[])[0]
          ?.name ?? "";
      const url = new URL(databaseUrl);
      url.pathname = `/${name}`;
      const empty = join(dir, "non-wayscribe.dump");
      await createBackup({ databaseUrl: url.toString(), output: empty, timeoutMs });
      expect(
        await verifyBackup({ databaseUrl, input: empty, timeoutMs, keyring: ring })
      ).toMatchObject({ ok: false, failures: ["schema_mismatch"] });
    });
    expect(await temporaryRestoreNames()).toEqual([]);
  });
  it.each([
    "orphan",
    "environment",
    "journey",
    "malformed",
    "stated-alias",
    "journey-token",
    "alias-token"
  ])("reports safe integrity failure for %s in an altered owned database", async (kind) => {
    await withRestoredDatabase({ databaseUrl, input, timeoutMs }, async (copy) => {
      if (kind === "orphan") {
        await copy.raw("alter table environments drop constraint environments_project_id_foreign");
        await copy("environments").insert({
          name: "orphan",
          project_id: "ffffffff-ffff-4fff-8fff-ffffffffffff"
        });
      }
      if (kind === "environment")
        await copy("journey_events").update({
          environment_id: "ffffffff-ffff-4fff-8fff-ffffffffffff"
        });
      if (kind === "journey") {
        await copy.raw(
          "alter table entity_aliases drop constraint entity_aliases_project_id_journey_id_foreign"
        );
        await copy("entity_aliases").update({ journey_id: "SECRET_ORPHAN" });
      }
      if (kind === "stated-alias")
        await copy("journey_events").update({
          stated_alias_ids: ["ffffffff-ffff-4fff-8fff-ffffffffffff"]
        });
      if (kind === "malformed")
        await copy("journeys").update({ encrypted_primary_entity_id: "SECRET_MALFORMED" });
      // A token that no longer matches its decrypted value makes the row unfindable by search.
      if (kind === "journey-token")
        await copy("journeys").update({ primary_entity_id_hash: "SECRET_TOKEN" });
      if (kind === "alias-token")
        await copy("entity_aliases").update({
          alias_value_hash: searchTokens(ring, "SECRET_OTHER")[0]
        });
      const result = await verifyRestoredDatabase(copy, ring);
      expect(result).toMatchObject({
        ok: false,
        failures: [
          kind === "malformed"
            ? "encrypted_values_unreadable"
            : kind.endsWith("-token")
              ? "search_tokens_mismatch"
              : "integrity_failed"
        ]
      });
      expect(JSON.stringify(result)).not.toContain("SECRET");
    });
    expect(await temporaryRestoreNames()).toEqual([]);
  });
  it("enforces a read-only inspection transaction and safely cleans inspector SQL failures", async () => {
    await withRestoredDatabase({ databaseUrl, input, timeoutMs }, async (copy) => {
      await copy.schema.dropTable("audit_events");
      await copy.raw(
        "create function synthetic_write() returns integer language plpgsql as $$ begin insert into projects (name,slug) values ('SECRET_WRITE','secret-write'); return 1; end $$"
      );
      await copy.raw("create view audit_events as select synthetic_write() as id");
      await expect(verifyRestoredDatabase(copy, ring)).rejects.toMatchObject({
        code: "inspection_failed",
        message: "inspection_failed"
      });
      expect(await copy("projects").where({ slug: "secret-write" })).toEqual([]);
    });
    expect(await temporaryRestoreNames()).toEqual([]);
  });
  it("cancels verification during the owned restore and removes its database", async () => {
    const delayed = join(dir, "verify-delay.dump");
    await withRestoredDatabase({ databaseUrl, input, timeoutMs }, async (copy) => {
      const name =
        ((await copy.raw("select current_database() as name")).rows as { name: string }[])[0]
          ?.name ?? "";
      // A NOT VALID constraint is restored after the data and never runs; an inline CHECK
      // runs on every restored row, and sleeps only outside the database it was written in.
      await copy.raw(
        `create function synthetic_delay() returns boolean language plpgsql as $$ begin if current_database() <> '${name}' then perform pg_sleep(10); end if; return true; end $$`
      );
      await copy.raw("create table synthetic_delayed (value integer check (synthetic_delay()))");
      await copy("synthetic_delayed").insert({ value: 1 });
      const url = new URL(databaseUrl);
      url.pathname = `/${name}`;
      await createBackup({ databaseUrl: url.toString(), output: delayed, timeoutMs });
    });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, 1000);
    try {
      await expect(
        verifyBackup({
          databaseUrl,
          input: delayed,
          timeoutMs,
          keyring: ring,
          signal: controller.signal
        })
      ).rejects.toMatchObject({ code: "aborted" });
    } finally {
      clearTimeout(timer);
    }
    expect(await temporaryRestoreNames()).toEqual([]);
  });
  it("runs verification as a real subprocess outside the implicit dotenv path", async () => {
    const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
    const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
    const env = {
      PATH: process.env.PATH,
      NODE_OPTIONS: "--conditions=development",
      DATABASE_URL: databaseUrl,
      ENCRYPTION_KEY: KEY,
      ENCRYPTION_KEY_PREVIOUS: OLD_KEY
    };
    const run = await exec(tsx, [cli, "backup:verify", "--input", input], { cwd: dir, env });
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain("backup_verified");
    await expect(
      exec(tsx, [cli, "backup:verify", "--input", input], {
        cwd: dir,
        env: { ...env, ENCRYPTION_KEY: "", ENCRYPTION_KEY_PREVIOUS: "" }
      })
    ).rejects.toMatchObject({ code: 1, stderr: "backup_failed keys_required\n" });
    expect(await temporaryRestoreNames()).toEqual([]);
  });
  it("cleans a failed restore and preserves existing output", async () => {
    const malformed = join(dir, "malformed.dump");
    await writeFile(malformed, "PGDMPmalformed");
    await expect(
      restoreBackup({ databaseUrl, input: malformed, database: "failed_copy", timeoutMs })
    ).rejects.toMatchObject({ code: "tool_failed" });
    expect(await exists("failed_copy")).toBe(false);
    const before = await readFile(input);
    await expect(createBackup({ databaseUrl, output: input, timeoutMs })).rejects.toMatchObject({
      code: "output_exists"
    });
    expect(await readFile(input)).toEqual(before);
  });
  it("cleans owned databases when restore itself times out or is canceled", async () => {
    await db.raw(
      `CREATE FUNCTION synthetic_restore_delay() RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN IF current_database() IN ('restore_timeout_copy', 'restore_abort_copy') THEN PERFORM pg_sleep(20); END IF; RETURN true; END $$`
    );
    await db.raw("CREATE TABLE synthetic_delay (value integer CHECK (synthetic_restore_delay()))");
    await db("synthetic_delay").insert({ value: 1 });
    const delayed = join(dir, "delayed.dump");
    try {
      await createBackup({ databaseUrl, output: delayed, timeoutMs });
      const start = Date.now();
      await expect(
        restoreBackup({
          databaseUrl,
          input: delayed,
          database: "restore_timeout_copy",
          timeoutMs: 1000
        })
      ).rejects.toMatchObject({ code: "timeout" });
      expect(Date.now() - start).toBeLessThan(6000);
      expect(await exists("restore_timeout_copy")).toBe(false);
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, 1000);
      try {
        await expect(
          restoreBackup({
            databaseUrl,
            input: delayed,
            database: "restore_abort_copy",
            timeoutMs,
            signal: controller.signal
          })
        ).rejects.toMatchObject({ code: "aborted" });
      } finally {
        clearTimeout(timer);
      }
      expect(await exists("restore_abort_copy")).toBe(false);
      expect(await db("synthetic_delay").select("value")).toEqual([{ value: 1 }]);
    } finally {
      await db.raw("DROP TABLE synthetic_delay");
      await db.raw("DROP FUNCTION synthetic_restore_delay()");
    }
  });
  it("reports only safe summaries on success and failure", async () => {
    const lines: string[] = [];
    const options = {
      databaseUrl,
      env: { ...process.env, ENCRYPTION_KEY: KEY },
      stdout: (line: string) => lines.push(line),
      stderr: (line: string) => lines.push(line)
    };
    expect(
      await runBackupCommand("backup:create", ["--output", join(dir, "cli.dump")], options)
    ).toBe(0);
    expect(await runBackupCommand("backup:create", ["--output", input], options)).toBe(1);
    const bad = new URL(databaseUrl);
    bad.password = "PASSWORD_SENTINEL_BACKUP";
    expect(
      await runBackupCommand("backup:create", ["--output", join(dir, "auth.dump")], {
        ...options,
        databaseUrl: bad.toString()
      })
    ).toBe(1);
    const output = lines.join("\n");
    for (const sentinel of [KEY, OLD_KEY, PAYLOAD, "PASSWORD_SENTINEL_BACKUP", databaseUrl])
      expect(output).not.toContain(sentinel);
  });
  it("refuses unusable tools/connections before creating a database", async () => {
    await expect(
      restoreBackup({
        databaseUrl,
        input,
        database: "not_created",
        timeoutMs,
        env: { PATH: "/not-installed" }
      })
    ).rejects.toMatchObject({ code: "tool_unavailable" });
    await expect(
      restoreBackup({
        databaseUrl: `${databaseUrl}?dbname=postgres`,
        input,
        database: "not_created",
        timeoutMs
      })
    ).rejects.toMatchObject({ code: "connection_unsupported" });
    expect(await exists("not_created")).toBe(false);
  });

  describe("TLS full verification parity", () => {
    let tlsContainer: Awaited<ReturnType<typeof startContainer>> | undefined;
    let tlsUrl: string;
    let root: string;
    let wrong: string;
    let tlsHost: string;
    let wrongHost: string;
    beforeAll(async () => {
      // The certificate names the host testcontainers publishes ports on:
      // localhost on a workstation, the `docker` service under CI's docker:dind,
      // where localhost reaches nothing. The wrong-host case connects to that
      // host's address, which reaches the same server under a name the
      // certificate does not carry, so it fails on the name and not on routing.
      const published = new URL(databaseUrl).hostname;
      tlsHost = isIP(published) === 0 ? published : "localhost";
      wrongHost = (await lookup(tlsHost, { family: 4 })).address;
      root = join(dir, "ca.crt");
      wrong = join(dir, "wrong.crt");
      for (const name of ["ca", "wrong"])
        await exec("openssl", [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-days",
          "1",
          "-subj",
          `/CN=${name}`,
          "-keyout",
          join(dir, `${name}.key`),
          "-out",
          join(dir, `${name}.crt`)
        ]);
      await exec("openssl", [
        "req",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-subj",
        `/CN=${tlsHost}`,
        "-keyout",
        join(dir, "server.key"),
        "-out",
        join(dir, "server.csr")
      ]);
      await writeFile(
        join(dir, "extensions"),
        `subjectAltName=DNS:${tlsHost}\nextendedKeyUsage=serverAuth\n`
      );
      await exec("openssl", [
        "x509",
        "-req",
        "-in",
        join(dir, "server.csr"),
        "-CA",
        root,
        "-CAkey",
        join(dir, "ca.key"),
        "-CAcreateserial",
        "-days",
        "1",
        "-extfile",
        join(dir, "extensions"),
        "-out",
        join(dir, "server.crt")
      ]);
      tlsContainer = await startContainer(inject("postgresImage"), (container) =>
        container
          .withCopyFilesToContainer([
            { source: join(dir, "server.key"), target: "/tmp/server.key" },
            { source: join(dir, "server.crt"), target: "/tmp/server.crt" }
          ])
          .withCommand([
            "sh",
            "-c",
            "chown postgres:postgres /tmp/server.key && chmod 600 /tmp/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key"
          ])
      );
      const url = new URL(tlsContainer.getConnectionUri());
      url.hostname = tlsHost;
      url.searchParams.set("sslmode", "verify-full");
      url.searchParams.set("sslrootcert", root);
      tlsUrl = url.toString();
    });
    afterAll(async () => {
      await tlsContainer?.stop();
    });
    it("accepts the explicit CA and hostname through pg and libpq", async () => {
      const output = join(dir, "tls.dump");
      await createBackup({ databaseUrl: tlsUrl, output, timeoutMs });
      expect(
        await withRestoredDatabase(
          { databaseUrl: tlsUrl, input: output, timeoutMs },
          async (copy) => {
            const result = await copy.raw<{ rows: { ssl: boolean }[] }>(
              "select ssl from pg_stat_ssl where pid = pg_backend_pid()"
            );
            return result.rows[0]?.ssl;
          }
        )
      ).toBe(true);
    });
    it("snapshots private CA bytes and suppresses implicit local trust/client files", async () => {
      const connection = normalizeBackupConnection(tlsUrl);
      const trust = await prepareToolEnvironment(connection);
      try {
        expect(await readFile(trust.env.PGSSLROOTCERT ?? "")).toEqual(connection.ca);
        expect((await stat(trust.env.PGSSLROOTCERT ?? "")).mode & 0o777).toBe(0o600);
        await expect(stat(trust.env.PGSSLCRL ?? "")).rejects.toMatchObject({ code: "ENOENT" });
        expect(trust.env.PGSSLCRLDIR).toBeUndefined();
      } finally {
        await trust.close();
      }
      const home = join(dir, "synthetic-home");
      await mkdir(join(home, ".postgresql"), { recursive: true });
      await writeFile(
        join(home, ".postgresql", "postgresql.crt"),
        "unusable implicit client certificate"
      );
      await writeFile(join(home, ".postgresql", "postgresql.key"), "unusable implicit key");
      // A loadable cert in the CRL location turns on OpenSSL CRL_CHECK if discovered.
      await writeFile(join(home, ".postgresql", "root.crl"), await readFile(root));
      await expect(
        createBackup({
          databaseUrl: tlsUrl,
          output: join(dir, "implicit-files.dump"),
          timeoutMs,
          env: { ...process.env, HOME: home }
        })
      ).resolves.toMatchObject({ bytes: expect.any(Number) });
    });
    it.each(["wrong-ca", "wrong-host", "non-tls"])(
      "refuses %s in both consumers without downgrade",
      async (failure) => {
        const url = new URL(failure === "non-tls" ? databaseUrl : tlsUrl);
        url.searchParams.set("sslmode", "verify-full");
        url.searchParams.set("sslrootcert", failure === "wrong-ca" ? wrong : root);
        if (failure === "wrong-host") url.hostname = wrongHost;
        await expect(
          createBackup({
            databaseUrl: url.toString(),
            output: join(dir, `${failure}.dump`),
            timeoutMs
          })
        ).rejects.toMatchObject({ code: "tool_failed" });
        await expect(
          restoreBackup({ databaseUrl: url.toString(), input, database: "tls_refused", timeoutMs })
        ).rejects.toMatchObject({ code: "database_failed" });
      }
    );
  });
});
