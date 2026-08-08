import { DEFAULT_SECRET_PATHS, redact } from "@flight-recorder/payload-security";
import type { Knex } from "knex";

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
export async function recordAudit(db: Knex, entry: AuditEntry): Promise<void> {
  await db("audit_events").insert({
    project_id: entry.projectId,
    actor: entry.actor,
    action: entry.action,
    resource_type: entry.resourceType,
    resource_id: entry.resourceId ?? null,
    metadata:
      entry.metadata === undefined
        ? null
        : JSON.stringify(redact(entry.metadata, DEFAULT_SECRET_PATHS))
  });
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
