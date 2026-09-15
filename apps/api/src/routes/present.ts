import { maskDisplayValue, type JourneyAlias } from "@flight-recorder/database";
import { decryptValue, UnknownKeyError, type Keyring } from "@flight-recorder/payload-security";

export interface PresentedAlias {
  type: string;
  displayValue: string | null;
}

/**
 * Decrypt the primary entity identifier for display, in full.
 *
 * Unmasked deliberately: this is the value the caller searched for, so returning
 * it reveals nothing they did not already hold. Alias values are masked because
 * they are *other* identifiers the caller may not be entitled to see.
 *
 * Undecryptable data returns null rather than throwing. A row under a key the
 * keyring no longer holds should degrade one field, not fail the whole request.
 * That case, and only that one, is reported to `onUnknownKey` with the key's id,
 * so the operator learns a key was removed too early rather than seeing blanks.
 */
export function presentEntityId(
  keyring: Keyring,
  encrypted: string | null,
  onUnknownKey?: (keyId: string) => void
): string | null {
  if (encrypted === null) return null;
  try {
    return decryptValue(keyring, encrypted);
  } catch (error) {
    if (error instanceof UnknownKeyError) onUnknownKey?.(error.keyId);
    return null;
  }
}

export function presentAliases(
  keyring: Keyring,
  aliases: readonly JourneyAlias[],
  onUnknownKey?: (keyId: string) => void
): PresentedAlias[] {
  return aliases.map((alias) => {
    const value = presentEntityId(keyring, alias.encryptedDisplayValue, onUnknownKey);
    return { type: alias.aliasType, displayValue: value === null ? null : maskDisplayValue(value) };
  });
}
