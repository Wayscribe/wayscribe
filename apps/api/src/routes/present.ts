import { maskDisplayValue, type JourneyAlias } from "@flight-recorder/database";
import { decryptValue, type Keyring } from "@flight-recorder/payload-security";

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
 */
export function presentEntityId(keyring: Keyring, encrypted: string | null): string | null {
  if (encrypted === null) return null;
  try {
    return decryptValue(keyring, encrypted);
  } catch {
    return null;
  }
}

export function presentAliases(
  keyring: Keyring,
  aliases: readonly JourneyAlias[]
): PresentedAlias[] {
  return aliases.map((alias) => ({
    type: alias.aliasType,
    displayValue:
      alias.encryptedDisplayValue === null ? null : safeMask(keyring, alias.encryptedDisplayValue)
  }));
}

function safeMask(keyring: Keyring, encrypted: string): string | null {
  try {
    return maskDisplayValue(decryptValue(keyring, encrypted));
  } catch {
    return null;
  }
}
