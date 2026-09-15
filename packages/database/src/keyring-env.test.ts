import { ConfigError } from "@flight-recorder/config";
import { createKeyring } from "@flight-recorder/payload-security";
import { describe, expect, it } from "vitest";
import { keyringFromEnvironment } from "./keyring-env.js";

const KEY_A = "0123456789abcdef0123456789abcdef";
const KEY_B = "fedcba9876543210fedcba9876543210";

describe("keyringFromEnvironment", () => {
  it("holds only the current key outside a rotation", () => {
    const keyring = keyringFromEnvironment({ ENCRYPTION_KEY: KEY_A });
    expect(keyring.current.id).toBe(createKeyring(KEY_A).current.id);
    expect(keyring.previous).toBeNull();
  });

  it("holds the previous key during a rotation", () => {
    const keyring = keyringFromEnvironment({
      ENCRYPTION_KEY: KEY_B,
      ENCRYPTION_KEY_PREVIOUS: KEY_A
    });
    expect(keyring.current.id).toBe(createKeyring(KEY_B).current.id);
    expect(keyring.previous?.id).toBe(createKeyring(KEY_A).current.id);
  });

  it("treats a blank previous key as no rotation", () => {
    // Compose passes an unset ENCRYPTION_KEY_PREVIOUS through as "".
    expect(
      keyringFromEnvironment({ ENCRYPTION_KEY: KEY_A, ENCRYPTION_KEY_PREVIOUS: "" }).previous
    ).toBeNull();
  });

  it("refuses the same key in both variables, even with a trailing newline", () => {
    expect(() =>
      keyringFromEnvironment({ ENCRYPTION_KEY: KEY_A, ENCRYPTION_KEY_PREVIOUS: `${KEY_A}\n` })
    ).toThrow(/same key/);
  });

  it("names the variable when the current key is missing", () => {
    expect(() => keyringFromEnvironment({})).toThrow(ConfigError);
  });
});
