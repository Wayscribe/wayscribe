import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createKeyring, verifyApiKeyWithKeyring } from "@wayscribe/payload-security";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createKnexConfig } from "../knex-config.js";
import { insertReturningId } from "../insert.js";
import { KeyAdminError, issueKey, listKeys, revokeKey } from "./key-admin.js";
import { findApiKeyByPrefix } from "./api-keys.js";
import { listAudit } from "./audit.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");

describe("API key administration", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(inject("postgresImage")).start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();
    await insertReturningId(db, "projects", { name: "Local", slug: "local" });
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  it("issues a key that authenticates", async () => {
    const issued = await issueKey(db, keyring, {
      projectSlug: "local",
      environmentName: "development",
      name: "first"
    });

    const context = await findApiKeyByPrefix(db, issued.keyPrefix);
    expect(context).toBeDefined();
    // The end-to-end property: what the CLI printed verifies against what was
    // stored. This is the step SQL cannot perform, because the verifier is an
    // HMAC under a subkey of ENCRYPTION_KEY.
    // `migrate: null` also proves the row is labelled with the current key, so
    // rotation status counts it as current rather than unknown.
    expect(
      verifyApiKeyWithKeyring(keyring, issued.apiKey, {
        keyHash: context?.keyHash ?? "",
        keyHashKeyId: context?.keyHashKeyId ?? null
      })
    ).toEqual({ ok: true, migrate: null });
  });

  it("creates the environment when it does not exist yet", async () => {
    const issued = await issueKey(db, keyring, {
      projectSlug: "local",
      environmentName: "staging",
      name: "staging-worker"
    });
    const context = await findApiKeyByPrefix(db, issued.keyPrefix);
    expect(context?.environmentName).toBe("staging");
  });

  it("issues distinct keys for two environments of one project", async () => {
    // The case that had no supported path at all: a team running staging and
    // development needs two keys, and ingestion 403s when the key's environment
    // does not match the event's.
    const dev = await listKeys(db, "local");
    const environments = new Set(dev.map((key) => key.environmentName));
    expect(environments.has("development")).toBe(true);
    expect(environments.has("staging")).toBe(true);
  });

  it("revokes a key, and authentication then refuses it", async () => {
    const issued = await issueKey(db, keyring, {
      projectSlug: "local",
      environmentName: "development",
      name: "doomed"
    });
    expect((await findApiKeyByPrefix(db, issued.keyPrefix))?.revokedAt).toBeNull();

    await revokeKey(db, issued.keyPrefix);
    expect((await findApiKeyByPrefix(db, issued.keyPrefix))?.revokedAt).not.toBeNull();
  });

  it("refuses to revoke twice", async () => {
    const issued = await issueKey(db, keyring, {
      projectSlug: "local",
      environmentName: "development",
      name: "once"
    });
    await revokeKey(db, issued.keyPrefix);
    await expect(revokeKey(db, issued.keyPrefix)).rejects.toThrow(KeyAdminError);
  });

  it("names the known projects when the slug is wrong", async () => {
    // A CLI that says "not found" and stops makes the operator go read the
    // schema. Naming what does exist usually ends the problem on the spot.
    await expect(
      issueKey(db, keyring, {
        projectSlug: "typo",
        environmentName: "development",
        name: "x"
      })
    ).rejects.toThrow(/local/);
  });

  it("never returns a stored key value in a listing", async () => {
    const listing = await listKeys(db);
    expect(listing.length).toBeGreaterThan(0);
    for (const key of listing) {
      expect(Object.keys(key)).not.toContain("keyHash");
      expect(key.keyPrefix).toHaveLength(12);
    }
  });

  describe("the audit trail (SECURITY.md section 13)", () => {
    const projectId = async (): Promise<string> => {
      const row: unknown = await db("projects").where({ slug: "local" }).first("id");
      return (row as { id: string }).id;
    };
    const rowsFor = async (action: string, resourceId: string) =>
      (await listAudit(db, await projectId(), 1000)).filter(
        (row) => row.action === action && row.resourceId === resourceId
      );

    it("records an issued key, by prefix and never by value, in the key's own transaction", async () => {
      const issued = await issueKey(db, keyring, {
        projectSlug: "local",
        environmentName: "audited",
        name: "audited-worker"
      });

      const rows = await rowsFor("api_key.created", issued.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor: "cli",
        resourceType: "api_key",
        metadata: {
          keyPrefix: issued.keyPrefix,
          name: "audited-worker",
          environment: "audited",
          environmentCreated: true
        }
      });
      // The key itself is the one thing the row must not hold, in any field.
      expect(JSON.stringify(rows[0])).not.toContain(issued.apiKey);

      const second = await issueKey(db, keyring, {
        projectSlug: "local",
        environmentName: "audited",
        name: "audited-second"
      });
      expect((await rowsFor("api_key.created", second.id))[0]?.metadata).toMatchObject({
        environmentCreated: false
      });
    });

    it("records a revocation once, and nothing for a refused one", async () => {
      const issued = await issueKey(db, keyring, {
        projectSlug: "local",
        environmentName: "development",
        name: "audited-revoke"
      });
      await revokeKey(db, issued.keyPrefix);
      await expect(revokeKey(db, issued.keyPrefix)).rejects.toThrow(KeyAdminError);

      const rows = await rowsFor("api_key.revoked", issued.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor: "cli",
        resourceType: "api_key",
        metadata: {
          keyPrefix: issued.keyPrefix,
          name: "audited-revoke",
          environment: "development"
        }
      });
    });

    it("writes no key and no row when the project does not exist", async () => {
      const before = await db("audit_events").count({ n: "*" });
      const keysBefore = await db("api_keys").count({ n: "*" });
      await expect(
        issueKey(db, keyring, { projectSlug: "absent", environmentName: "x", name: "x" })
      ).rejects.toThrow(KeyAdminError);
      expect(await db("audit_events").count({ n: "*" })).toEqual(before);
      expect(await db("api_keys").count({ n: "*" })).toEqual(keysBefore);
    });

    it("rolls the key back when its audit row cannot be written", async () => {
      // The property "a key never exists without the record of its issue" is
      // only true if the two share a transaction. Break the audit insert and
      // check the key did not survive it.
      await db.raw(`
        create function refuse_key_audit() returns trigger language plpgsql as $$
        begin
          if new.action = 'api_key.created' then
            raise exception 'audit refused for the test';
          end if;
          return new;
        end $$;
        create trigger refuse_key_audit before insert on audit_events
          for each row execute function refuse_key_audit();
      `);
      try {
        const keysBefore = await db("api_keys").count({ n: "*" });
        await expect(
          issueKey(db, keyring, {
            projectSlug: "local",
            environmentName: "never-created",
            name: "unaudited"
          })
        ).rejects.toThrow(/audit refused/);
        expect(await db("api_keys").count({ n: "*" })).toEqual(keysBefore);
        expect(await db("environments").where({ name: "never-created" }).first()).toBeUndefined();
      } finally {
        await db.raw(
          "drop trigger refuse_key_audit on audit_events; drop function refuse_key_audit();"
        );
      }
    });
  });
});
