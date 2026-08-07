import { z } from "zod";
import { PROTOCOL_ERROR_CODES, type ProtocolErrorCode } from "./errors.js";
import { journeyEventSchema, type JourneyEvent } from "./event.js";
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

  return { ok: true, event: event.data };
}

function toDetails(error: z.ZodError): ParseDetail[] {
  return error.issues.map((issue) => ({
    path: ["event", ...issue.path.map(String)].join("."),
    message: issue.message
  }));
}
