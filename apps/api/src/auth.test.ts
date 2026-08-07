import type { ApiKeyContext } from "@flight-recorder/database";
import { deriveSubkeys, generateApiKey } from "@flight-recorder/payload-security";
import { describe, expect, it } from "vitest";
import { resolveApiKey } from "./auth.js";

const subkeys = deriveSubkeys("0123456789abcdef0123456789abcdef");
const generated = generateApiKey(subkeys.apiKey);

const context: ApiKeyContext = {
  id: "key_1",
  projectId: "proj_1",
  environmentId: "env_1",
  environmentName: "development",
  keyHash: generated.verifier,
  revokedAt: null,
  captureMode: "redacted-payload",
  redactionPaths: [],
  captureAllowlist: []
};

const lookup = (prefix: string): Promise<ApiKeyContext | undefined> =>
  Promise.resolve(prefix === generated.keyPrefix ? context : undefined);

describe("resolveApiKey", () => {
  it("accepts a valid bearer key", async () => {
    const result = await resolveApiKey(`Bearer ${generated.apiKey}`, subkeys.apiKey, lookup);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.context.projectId).toBe("proj_1");
  });

  it("rejects a missing header", async () => {
    const result = await resolveApiKey(undefined, subkeys.apiKey, lookup);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("rejects a non-bearer scheme", async () => {
    const result = await resolveApiKey(`Basic ${generated.apiKey}`, subkeys.apiKey, lookup);
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown key", async () => {
    const other = generateApiKey(subkeys.apiKey);
    const result = await resolveApiKey(`Bearer ${other.apiKey}`, subkeys.apiKey, lookup);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("rejects a key whose material does not verify", async () => {
    const forged = `${generated.keyPrefix}tampered-remainder-value`;
    const result = await resolveApiKey(`Bearer ${forged}`, subkeys.apiKey, lookup);
    expect(result.ok).toBe(false);
  });

  it("rejects a revoked key", async () => {
    const revokedLookup = (): Promise<ApiKeyContext> =>
      Promise.resolve({ ...context, revokedAt: new Date() });
    const result = await resolveApiKey(`Bearer ${generated.apiKey}`, subkeys.apiKey, revokedLookup);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });
});
