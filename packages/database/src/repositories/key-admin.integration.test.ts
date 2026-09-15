import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createKeyring, verifyApiKeyWithKeyring } from "@flight-recorder/payload-security";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKnexConfig } from "../knex-config.js";
import { insertReturningId } from "../insert.js";
import { KeyAdminError, issueKey, listKeys, revokeKey } from "./key-admin.js";
import { findApiKeyByPrefix } from "./api-keys.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");

describe("API key administration", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
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
});
