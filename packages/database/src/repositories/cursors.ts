/**
 * Opaque keyset cursors.
 *
 * API_SPEC.md section 14 forbids exposing database offsets as a compatibility
 * contract, and offset pagination silently skips or repeats rows when new events
 * arrive mid-scroll — which, for a tool whose entire job is showing a complete
 * history, would be a correctness bug rather than a cosmetic one.
 *
 * A malformed cursor throws rather than being ignored: silently restarting from
 * the beginning would present already-seen results as if they were new.
 */
export class InvalidCursorError extends Error {
  public override readonly name = "InvalidCursorError";
}

export interface SearchCursor {
  lastEventAt: string;
  id: string;
}

export interface EventCursor {
  eventTimestamp: string;
  receivedAt: string;
  id: string;
}

export function encodeCursor(cursor: SearchCursor | EventCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeSearchCursor(encoded: string): SearchCursor {
  const parsed = decode(encoded);
  if (typeof parsed["lastEventAt"] !== "string" || typeof parsed["id"] !== "string") {
    throw new InvalidCursorError("Cursor is not a search cursor.");
  }
  // Checked here rather than left to the query: PostgreSQL's timestamptz cast
  // would reject it as a server error, not as the caller's bad cursor.
  if (Number.isNaN(Date.parse(parsed["lastEventAt"]))) {
    throw new InvalidCursorError("Cursor timestamp is not a date.");
  }
  return { lastEventAt: parsed["lastEventAt"], id: parsed["id"] };
}

export function decodeEventCursor(encoded: string): EventCursor {
  const parsed = decode(encoded);
  if (
    typeof parsed["eventTimestamp"] !== "string" ||
    typeof parsed["receivedAt"] !== "string" ||
    typeof parsed["id"] !== "string"
  ) {
    throw new InvalidCursorError("Cursor is not an event cursor.");
  }
  return {
    eventTimestamp: parsed["eventTimestamp"],
    receivedAt: parsed["receivedAt"],
    id: parsed["id"]
  };
}

function decode(encoded: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError("Cursor is not valid base64url JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InvalidCursorError("Cursor is not an object.");
  }
  return parsed as Record<string, unknown>;
}
