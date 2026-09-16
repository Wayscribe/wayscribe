import {
  maskDisplayValue,
  type EventDetail,
  type JourneyAlias,
  type JourneyDetail,
  type SearchHit
} from "@flight-recorder/database";
import { decryptValue, UnknownKeyError, type Keyring } from "@flight-recorder/payload-security";

export interface PresentedAlias {
  type: string;
  displayValue: string | null;
  displayable: boolean;
}

/**
 * Decrypt the primary entity identifier for display, in full.
 *
 * Unmasked deliberately: this is the value the caller searched for, so returning
 * it reveals nothing they did not already hold. Alias values are masked because
 * they are *other* identifiers the caller may not be entitled to see, unless the
 * instrumenting code marked the alias displayable (ADR-053).
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

export interface PresentedJourneySummary {
  journeyId: string;
  entity: { type: string; id: string | null };
  status: string;
  eventCount: number;
  startedAt: string;
  lastEventAt: string;
}

/**
 * One row of a journey list, as search and the recent list both return it.
 *
 * One function so the two lists cannot drift: a reader following a link from
 * either expects the same fields, decrypted the same way.
 */
export function presentJourneySummary(
  keyring: Keyring,
  hit: SearchHit,
  onUnknownKey?: (keyId: string) => void
): PresentedJourneySummary {
  return {
    journeyId: hit.journeyId,
    entity: {
      type: hit.entityType,
      id: presentEntityId(keyring, hit.encryptedPrimaryEntityId, onUnknownKey)
    },
    status: hit.status,
    eventCount: hit.eventCount,
    startedAt: hit.startedAt.toISOString(),
    lastEventAt: hit.lastEventAt.toISOString()
  };
}

export function presentAliases(
  keyring: Keyring,
  aliases: readonly JourneyAlias[],
  onUnknownKey?: (keyId: string) => void
): PresentedAlias[] {
  return aliases.map((alias) => {
    const value = presentEntityId(keyring, alias.encryptedDisplayValue, onUnknownKey);
    // Masked unless every event that stated this alias marked it displayable,
    // which the stored flag records (ADR-053). The flag is the only way out of
    // the mask; nothing a reader sends can change it.
    const shown = value === null || alias.displayable ? value : maskDisplayValue(value);
    return { type: alias.aliasType, displayValue: shown, displayable: alias.displayable };
  });
}

/**
 * One journey as `GET /v1/journeys/:journeyId` returns it.
 *
 * Here rather than in the route because a dry run previews the same shape, read
 * through the same repository function inside its transaction. Two presenters
 * would let the preview and the read disagree, which is exactly what makes a
 * validation endpoint worse than useless: it would answer confidently about a
 * server that behaves differently.
 */
export function presentJourneyDetail(
  keyring: Keyring,
  detail: JourneyDetail,
  onUnknownKey?: (keyId: string) => void
): Record<string, unknown> {
  return {
    journeyId: detail.journeyId,
    environment: detail.environment,
    entity: {
      type: detail.entityType,
      id: presentEntityId(keyring, detail.encryptedPrimaryEntityId, onUnknownKey)
    },
    status: detail.status,
    aliases: presentAliases(keyring, detail.aliases, onUnknownKey),
    services: detail.services,
    eventCount: detail.eventCount,
    startedAt: detail.startedAt.toISOString(),
    completedAt: detail.completedAt?.toISOString() ?? null,
    lastEventAt: detail.lastEventAt.toISOString()
  };
}

/** One event as `GET /v1/events/:eventId` returns it, for the same reason. */
export function presentEvent(detail: EventDetail): Record<string, unknown> {
  return {
    ...detail,
    eventTimestamp: detail.eventTimestamp.toISOString(),
    receivedAt: detail.receivedAt.toISOString()
  };
}
