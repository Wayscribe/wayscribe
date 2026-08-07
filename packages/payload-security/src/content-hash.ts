import { createHash } from "node:crypto";

/**
 * Stable hash of a JSON-compatible value.
 *
 * Object keys are sorted recursively, so two semantically identical events
 * serialized with different key order produce the same hash. Array order is
 * preserved, because it is meaningful.
 *
 * Ingestion computes this over the event *as received*, before redaction:
 * ADR-021 exists to catch a client reusing an event ID for different content, so
 * hashing redacted output would let a server-side policy change alter the hash
 * of an unchanged input and manufacture conflicts.
 */
export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`);
    return `{${entries.join(",")}}`;
  }

  // JSON.stringify is typed as returning string but yields undefined for values
  // it cannot represent. `undefined` is handled above; this covers functions and
  // symbols, which cannot appear in a JSON-parsed body but can reach an
  // `unknown` parameter.
  const serialized = JSON.stringify(value) as string | undefined;
  return serialized ?? "null";
}
