import type { ApiKeyContext } from "@flight-recorder/database";
import { apiKeyRecordFor, createKeyring, issueApiKey } from "@flight-recorder/payload-security";
import { describe, expect, it } from "vitest";
import { resolveApiKey, type ApiKeyAuthenticator } from "./auth.js";

const KEY_A = "0123456789abcdef0123456789abcdef";
const KEY_B = "fedcba9876543210fedcba9876543210";
const keyringA = createKeyring(KEY_A);
/** Rotated: B is current and A is still readable. */
const rotated = createKeyring(KEY_B, KEY_A);

const generated = issueApiKey(keyringA);

const baseContext: ApiKeyContext = {
  id: "key_1",
  projectId: "proj_1",
  environmentId: "env_1",
  environmentName: "development",
  keyHash: generated.verifier,
  keyHashKeyId: generated.keyHashKeyId,
  revokedAt: null,
  captureMode: "redacted-payload",
  redactionPaths: [],
  captureAllowlist: []
};

interface Replacement {
  id: string;
  expectedKeyHash: string;
  next: { keyHash: string; keyHashKeyId: string };
}

interface Harness {
  authenticator: ApiKeyAuthenticator;
  replacements: Replacement[];
  failures: unknown[];
}

function harness(
  keyring = keyringA,
  context: ApiKeyContext = baseContext,
  replace: () => Promise<unknown> = () => Promise.resolve(true)
): Harness {
  const replacements: Replacement[] = [];
  const failures: unknown[] = [];
  return {
    replacements,
    failures,
    authenticator: {
      keyring,
      find: (prefix) => Promise.resolve(prefix === generated.keyPrefix ? context : undefined),
      replaceVerifier: (id, expectedKeyHash, next) => {
        replacements.push({ id, expectedKeyHash, next });
        return replace();
      },
      onReplaceFailure: (error) => failures.push(error)
    }
  };
}

const bearer = (key: string): string => `Bearer ${key}`;

describe("resolveApiKey", () => {
  it("accepts a valid bearer key", async () => {
    const { authenticator, replacements } = harness();
    const result = await resolveApiKey(bearer(generated.apiKey), authenticator);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.context.projectId).toBe("proj_1");
    // Already current and labelled: nothing to write on the hot path.
    expect(replacements).toEqual([]);
  });

  it("rejects a missing header", async () => {
    const result = await resolveApiKey(undefined, harness().authenticator);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("rejects a non-bearer scheme", async () => {
    const result = await resolveApiKey(`Basic ${generated.apiKey}`, harness().authenticator);
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown key", async () => {
    const other = issueApiKey(keyringA);
    const result = await resolveApiKey(bearer(other.apiKey), harness().authenticator);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("rejects a key whose material does not verify", async () => {
    const forged = `${generated.keyPrefix}tampered-remainder-value`;
    const result = await resolveApiKey(bearer(forged), harness().authenticator);
    expect(result.ok).toBe(false);
  });

  it("rejects a revoked key", async () => {
    const { authenticator } = harness(keyringA, { ...baseContext, revokedAt: new Date() });
    const result = await resolveApiKey(bearer(generated.apiKey), authenticator);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  describe("during a rotation", () => {
    it("accepts a key issued under the previous key and moves its verifier to the current one", async () => {
      const { authenticator, replacements } = harness(rotated);
      const result = await resolveApiKey(bearer(generated.apiKey), authenticator);

      expect(result.ok).toBe(true);
      // The presented key is the only plaintext that can produce a verifier
      // under the new pepper, so the rewrite happens in this request.
      const expected = apiKeyRecordFor(createKeyring(KEY_B), generated.apiKey);
      expect(replacements).toEqual([
        {
          id: "key_1",
          expectedKeyHash: generated.verifier,
          next: { keyHash: expected.verifier, keyHashKeyId: expected.keyHashKeyId }
        }
      ]);
    });

    it("still authenticates when moving the verifier fails, and reports the failure", async () => {
      const failure = new Error("connection reset");
      const { authenticator, failures } = harness(rotated, baseContext, () =>
        Promise.reject(failure)
      );
      const result = await resolveApiKey(bearer(generated.apiKey), authenticator);
      expect(result.ok).toBe(true);
      expect(failures).toEqual([failure]);
    });

    it("refuses a wrong key with the same response as an unknown one", async () => {
      const forged = `${generated.keyPrefix}tampered-remainder-value`;
      const { authenticator, replacements } = harness(rotated);
      const wrong = await resolveApiKey(bearer(forged), authenticator);
      const unknown = await resolveApiKey(
        bearer(issueApiKey(rotated).apiKey),
        harness(rotated).authenticator
      );
      expect(wrong).toEqual(unknown);
      expect(replacements).toEqual([]);
    });
  });

  it("records the current key's id on a key issued before ids were stored", async () => {
    const { authenticator, replacements } = harness(keyringA, {
      ...baseContext,
      keyHashKeyId: null
    });
    const result = await resolveApiKey(bearer(generated.apiKey), authenticator);
    expect(result.ok).toBe(true);
    expect(replacements).toEqual([
      {
        id: "key_1",
        expectedKeyHash: generated.verifier,
        next: { keyHash: generated.verifier, keyHashKeyId: keyringA.current.id }
      }
    ]);
  });
});
