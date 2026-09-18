import { createHmac } from "node:crypto";

/**
 * Deriving a journey id from an entity, under a secret the host holds
 * (ADR-052).
 *
 * The derivation is specified in `docs/SDK_SPEC.md` (SDK-55) and pinned by the
 * vectors in `packages/protocol/fixtures/journey-id-derivation.json`, so an SDK
 * in another language produces the same id for the same record.
 */

/** Shorter secrets are refused: a derived id is only as unguessable as its key. */
export const JOURNEY_ID_SECRET_MIN_BYTES = 32;

/** Versions the derivation, so a future change cannot collide with this one. */
const LABEL = "journey-id/v1";

/** The prefix a random journey id carries. */
const PREFIX = "jrn_";
const HEX_CHARACTERS = 32;

/**
 * Why a configured secret cannot be used, or undefined when it can.
 *
 * Never quotes the secret.
 */
export function journeyIdSecretProblem(secret: unknown): string | undefined {
  if (secret === undefined) {
    return "journeyIdFor needs journeyIdSecret, and none is configured, so it returned a random journey id. Configure a secret of at least 32 bytes.";
  }
  if (typeof secret !== "string") {
    return "journeyIdSecret is not a string, so journeyIdFor returns random journey ids. Configure a string of at least 32 bytes.";
  }
  if (Buffer.byteLength(secret, "utf8") < JOURNEY_ID_SECRET_MIN_BYTES) {
    return "journeyIdSecret is shorter than 32 bytes, so it is not used and journeyIdFor returns random journey ids. Configure a longer secret.";
  }
  return undefined;
}

/**
 * `jrn_` and the first 32 hex characters of
 * HMAC-SHA256(secret, field(label) || field(environment) || field(type) || field(id)),
 * where `field` is a 4-byte big-endian length followed by the UTF-8 bytes.
 *
 * Length prefixes rather than a separator, because an entity id may contain
 * any character: with a separator, `("ab", "c")` and `("a", "bc")` can be made
 * to meet.
 */
export function deriveJourneyId(
  secret: string,
  environment: string,
  entity: { type: string; id: string }
): string {
  const mac = createHmac("sha256", Buffer.from(secret, "utf8"));
  for (const text of [LABEL, environment, entity.type, entity.id]) {
    const bytes = Buffer.from(text, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    mac.update(length);
    mac.update(bytes);
  }
  return `${PREFIX}${mac.digest("hex").slice(0, HEX_CHARACTERS)}`;
}

/**
 * Why an entity cannot be derived from, or undefined when it can.
 *
 * Text that is not well-formed UTF-16 cannot be encoded as UTF-8 without
 * replacing its unpaired surrogates with U+FFFD, so `"a\uD800"` would derive
 * the id of `"a\uFFFD"`. The server refuses such an entity id anyway.
 */
export function entityProblem(entity: unknown): string | undefined {
  // Non-empty, as ConfigurationErrorDiagnostic says and the protocol's
  // entity schema requires: the server refuses an event for such an entity,
  // and every `{ type, id: "" }` of one type derived the same journey id.
  if (!isEntity(entity) || entity.type === "" || entity.id === "") {
    return "journeyIdFor needs an entity whose type and id are non-empty strings, so it returned a random journey id.";
  }
  if (!entity.type.isWellFormed() || !entity.id.isWellFormed()) {
    return "journeyIdFor was given an entity whose type or id holds an unpaired surrogate, which cannot be encoded faithfully, so it returned a random journey id.";
  }
  return undefined;
}

let warnedAboutSecret = false;

/**
 * Whether this process has yet to print the missing-secret warning, marking it
 * printed. Once per process, not per recorder: a job that creates a recorder
 * per task should not print it per task.
 */
export function firstSecretWarning(): boolean {
  if (warnedAboutSecret) return false;
  warnedAboutSecret = true;
  return true;
}

/** For tests: the next missing-secret warning prints again. */
export function forgetSecretWarning(): void {
  warnedAboutSecret = false;
}

export function isEntity(value: unknown): value is { type: string; id: string } {
  if (typeof value !== "object" || value === null) return false;
  const { type, id } = value as { type?: unknown; id?: unknown };
  return typeof type === "string" && typeof id === "string";
}
