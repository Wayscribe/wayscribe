import { deriveSubkeys, keyFingerprint, type Subkeys } from "./keys.js";

/** One master key's derived material, labelled with its fingerprint. */
export interface KeyMaterial extends Subkeys {
  /** The 12-character fingerprint from `keyFingerprint`. */
  id: string;
}

/**
 * The keys a process may read under.
 *
 * New data is always written under `current`. `previous` exists only during a
 * rotation's grace period, so data written under the old key stays readable
 * until it has been re-encrypted. One previous key is deliberate: a rotation
 * completes before the next begins.
 */
export interface Keyring {
  current: KeyMaterial;
  previous: KeyMaterial | null;
}

/**
 * A value names a key the keyring does not hold.
 *
 * Kept distinct from an ordinary decryption failure so an operator can tell
 * "the previous key was removed too early" from "this data is corrupt".
 */
export class UnknownKeyError extends Error {
  public override readonly name = "UnknownKeyError";

  public constructor(public readonly keyId: string) {
    super(`Value was encrypted under key ${keyId}, which is not configured.`);
  }
}

export function createKeyring(current: string, previous?: string): Keyring {
  const currentMaterial = keyMaterial(current);
  const previousMaterial = previous === undefined ? null : keyMaterial(previous);

  // A copy-paste mistake would otherwise start a rotation that rotates nothing,
  // and the operator would only find out after removing the "old" key.
  if (previousMaterial !== null && previousMaterial.id === currentMaterial.id) {
    throw new Error(
      "ENCRYPTION_KEY_PREVIOUS is the same key as ENCRYPTION_KEY; set it to the key being rotated out."
    );
  }

  return { current: currentMaterial, previous: previousMaterial };
}

/** The keyring's material for an id, or null when neither slot holds it. */
export function keyMaterialFor(keyring: Keyring, keyId: string): KeyMaterial | null {
  if (keyring.current.id === keyId) return keyring.current;
  if (keyring.previous !== null && keyring.previous.id === keyId) return keyring.previous;
  return null;
}

function keyMaterial(masterKey: string): KeyMaterial {
  // deriveSubkeys enforces the minimum length before anything is derived.
  return { ...deriveSubkeys(masterKey), id: keyFingerprint(masterKey) };
}
