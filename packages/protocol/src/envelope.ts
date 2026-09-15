import { z } from "zod";
import { PROTOCOL_ERROR_CODES, type ProtocolErrorCode } from "./errors.js";
import { aliasValueSchema, journeyEventSchema, type JourneyEvent } from "./event.js";
import { defineProtoKey, ownProtoKey } from "./proto-key.js";
import { isSupportedProtocolVersion } from "./version.js";

export const envelopeSchema = z.object({
  protocolVersion: z.string().min(1).max(16),
  event: z.unknown()
});

export interface ParseDetail {
  path: string;
  message: string;
}

export type ParseResult =
  | { ok: true; event: JourneyEvent }
  | { ok: false; code: ProtocolErrorCode; message: string; details: ParseDetail[] };

/**
 * Version is checked before the event is validated, so a future protocol version
 * produces `unsupported_protocol_version` rather than a confusing pile of field
 * errors from schemas that never applied to it.
 */
export function parseEnvelope(input: unknown): ParseResult {
  const envelope = envelopeSchema.safeParse(input);
  if (!envelope.success) {
    return {
      ok: false,
      code: PROTOCOL_ERROR_CODES.invalidEvent,
      message: "Request body did not match the event envelope.",
      details: toDetails(envelope.error)
    };
  }

  if (!isSupportedProtocolVersion(envelope.data.protocolVersion)) {
    return {
      ok: false,
      code: PROTOCOL_ERROR_CODES.unsupportedProtocolVersion,
      message: `Protocol version ${envelope.data.protocolVersion} is not supported.`,
      details: []
    };
  }

  const event = journeyEventSchema.safeParse(envelope.data.event);
  if (!event.success) {
    return {
      ok: false,
      code: PROTOCOL_ERROR_CODES.invalidEvent,
      message: "The event did not match protocol version 0.1.",
      details: toDetails(event.error)
    };
  }

  const restored = restoreProtoKeys(envelope.data.event, event.data);
  if (restored.length > 0) {
    return {
      ok: false,
      code: PROTOCOL_ERROR_CODES.invalidEvent,
      message: "The event did not match protocol version 0.1.",
      details: restored
    };
  }

  return { ok: true, event: event.data };
}

/**
 * Put back the `__proto__` keys `z.record` dropped, and report the ones it
 * should have refused.
 *
 * Only `aliases` and `metadata` need this: they are the two `z.record` fields.
 * Every other field is either a closed `z.object`, whose keys are fixed and
 * none of them named `__proto__`, or `z.unknown()`, which hands the value back
 * untouched. An unknown key at the top of the event, `__proto__` included, is
 * dropped by the object schema, which is the documented unknown-field rule
 * (ADR-049) and not this defect.
 *
 * Returns the validation details, empty when there is nothing to report, so a
 * refusal here reads exactly like any other `invalid_event`.
 */
function restoreProtoKeys(rawEvent: unknown, event: JourneyEvent): ParseDetail[] {
  if (typeof rawEvent !== "object" || rawEvent === null) return [];
  const raw = rawEvent as Record<string, unknown>;
  const details: ParseDetail[] = [];

  const aliases = ownProtoKey(raw["aliases"]);
  if (aliases.present && event.aliases !== undefined) {
    // z.record neither validated nor kept this value, so the schema's own rule
    // is applied here rather than trusting what arrived.
    const value = aliasValueSchema.safeParse(aliases.value);
    if (value.success) defineProtoKey(event.aliases, value.data);
    else details.push(...detailsUnder("event.aliases.__proto__", value.error));
  }

  const metadata = ownProtoKey(raw["metadata"]);
  if (metadata.present && event.metadata !== undefined) {
    defineProtoKey(event.metadata, metadata.value);
  }

  // The key itself needs no check: it is nine characters, and the key schema
  // only bounds length.
  return details;
}

function detailsUnder(path: string, error: z.ZodError): ParseDetail[] {
  return error.issues.map((issue) => ({ path, message: issue.message }));
}

function toDetails(error: z.ZodError): ParseDetail[] {
  return error.issues.map((issue) => ({
    path: ["event", ...issue.path.map(String)].join("."),
    message: issue.message
  }));
}
