import { DEFAULT_SECRET_PATHS, redact } from "@wayscribe/payload-security";
import type { Knex } from "knex";
import { insertReturningId } from "../insert.js";

export interface AuditEntry {
  projectId: string;
  /** Who acted. "admin" today; a user identity when there is one. */
  actor: string;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AuditRecord extends AuditEntry {
  id: string;
  createdAt: Date;
}

/**
 * Record that something happened.
 *
 * Metadata goes through `redact` before it is stored. An audit trail that
 * captures the thing it was auditing — a header, a credential, a payload field
 * — turns the safety record into a second copy of the secret, in a table
 * nobody thinks of as sensitive.
 *
 * Failures are the caller's to handle. Audit is not decoration: if the write
 * fails, the caller should know rather than proceed believing it was recorded.
 */
export async function recordAudit(db: Knex, entry: AuditEntry): Promise<string> {
  return insertReturningId(db, "audit_events", {
    project_id: entry.projectId,
    actor: entry.actor,
    action: entry.action,
    resource_type: entry.resourceType,
    resource_id: entry.resourceId ?? null,
    metadata: entry.metadata === undefined ? null : sanitizedMetadata(entry.metadata)
  });
}

/**
 * Replace an audit row's metadata, sanitized the same way as on insert.
 *
 * For a deletion that commits in batches: its one row is written with the
 * first batch and brought up to date in each later batch's transaction, so the
 * row never lags what has committed. Scoped on project like every other write.
 */
export async function updateAuditMetadata(
  db: Knex,
  projectId: string,
  id: string,
  metadata: Record<string, unknown>
): Promise<void> {
  const updated = await db("audit_events")
    .where({ project_id: projectId, id })
    .update({ metadata: sanitizedMetadata(metadata) });
  // A missing row would mean committing a batch with no record of it, which is
  // what writing the row with the first batch exists to prevent.
  if (updated !== 1) throw new Error("The audit row to update does not exist.");
}

function sanitizedMetadata(metadata: Record<string, unknown>): string {
  return JSON.stringify(redact(metadata, DEFAULT_SECRET_PATHS));
}

/** Most recent first. Used by operators reading what replay did. */
export async function listAudit(db: Knex, projectId: string, limit = 50): Promise<AuditRecord[]> {
  const rows: unknown = await db("audit_events")
    .where({ project_id: projectId })
    .orderBy([
      { column: "created_at", order: "desc" },
      { column: "id", order: "desc" }
    ])
    .limit(limit)
    .select(
      "id",
      "project_id as projectId",
      "actor",
      "action",
      "resource_type as resourceType",
      "resource_id as resourceId",
      "metadata",
      "created_at as createdAt"
    );
  return rows as AuditRecord[];
}
