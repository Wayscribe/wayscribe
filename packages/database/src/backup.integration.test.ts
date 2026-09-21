import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createKeyring, encryptValue, decryptValue } from "@wayscribe/payload-security";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { startContainer, startPostgres, type TestDatabase } from "./testing/postgres.js";
import { createKnexConfig } from "./knex-config.js";
import { seedLocal } from "./seed-local.js";
import { findJourneyDetail } from "./repositories/journey-reads.js";
import { normalizeBackupConnection, prepareToolEnvironment } from "./backup/connection.js";
import { createBackup } from "./backup/archive.js";
import { restoreBackup, withRestoredDatabase } from "./backup/restore.js";
import { runBackupCommand } from "./backup/command.js";
const exec = promisify(execFile);
const KEY = "backup_key_sentinel_12345678901234";
const OLD_KEY = "old_backup_key_1234567890123456789";
const PAYLOAD = "PAYLOAD_SENTINEL_BACKUP";
const ring = createKeyring(KEY, OLD_KEY);
const timeoutMs = 15_000;

describe("private archive and owned restore on PostgreSQL", () => {
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
      primary_entity_id_hash: "synthetic",
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
      alias_value_hash: "synthetic-alias",
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
    input = join(dir, "source.dump");
    await createBackup({ databaseUrl, output: input, timeoutMs });
  });
  afterAll(async () => {
    await db.destroy();
    await container?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
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
    beforeAll(async () => {
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
        "/CN=localhost",
        "-keyout",
        join(dir, "server.key"),
        "-out",
        join(dir, "server.csr")
      ]);
      await writeFile(
        join(dir, "extensions"),
        "subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n"
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
      url.hostname = "localhost";
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
        if (failure === "wrong-host") url.hostname = "127.0.0.1";
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
