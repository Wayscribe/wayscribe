import { maskDisplayValue, type JourneyAlias } from "@flight-recorder/database";
import { decryptField } from "@flight-recorder/payload-security";

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
 * Undecryptable data returns null rather than throwing. A row encrypted under a
 * rotated key should degrade one field, not fail the whole request.
 */
export function presentEntityId(key: Buffer, encrypted: string | null): string | null {
  if (encrypted === null) return null;
  try {
    return decryptField(key, encrypted);
  } catch {
    return null;
  }
}

export function presentAliases(key: Buffer, aliases: readonly JourneyAlias[]): PresentedAlias[] {
  return aliases.map((alias) => ({
    type: alias.aliasType,
    displayValue:
      alias.encryptedDisplayValue === null ? null : safeMask(key, alias.encryptedDisplayValue)
  }));
}

function safeMask(key: Buffer, encrypted: string): string | null {
  try {
    return maskDisplayValue(decryptField(key, encrypted));
  } catch {
    return null;
  }
}
