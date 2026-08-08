import { decryptField, encryptField } from "@flight-recorder/payload-security";
import type { Knex } from "knex";
import { insertReturningId } from "../insert.js";

export type EnvironmentType = "local" | "development" | "test";
export type ReplayStatus = "queued" | "running" | "completed" | "failed" | "blocked";

export interface ReplayDestination {
  id: string;
  projectId: string;
  name: string;
  baseUrl: string;
  environmentType: EnvironmentType;
  enabled: boolean;
}

export interface ReplayRun {
  id: string;
  projectId: string;
  journeyEventId: string;
  destinationId: string;
  method: string;
  requestPath: string;
  requestPayload: unknown;
  requestHeaders: unknown;
  responseStatus: number | null;
  responsePayload: unknown;
  durationMs: number | null;
  status: ReplayStatus;
  error: unknown;
  initiatedBy: string;
  createdAt: Date;
  completedAt: Date | null;
}

const DESTINATION_COLUMNS = [
  "id",
  "project_id as projectId",
  "name",
  "base_url as baseUrl",
  "environment_type as environmentType",
  "enabled"
];

/**
 * Create a replay destination.
 *
 * `environmentType` is constrained to local, development, and test at the
 * schema. Replay exists to send a recorded input somewhere it is safe to have
 * side effects, and there is no value of this field that means production.
 *
 * Headers are encrypted before storage: a destination's configured credential
 * is a real secret, and the row is read by every list call.
 */
export async function createDestination(
  db: Knex,
  fieldKey: Buffer,
  input: {
    projectId: string;
    name: string;
    baseUrl: string;
    environmentType: EnvironmentType;
    headers?: Record<string, string>;
  }
): Promise<ReplayDestination> {
  const id = await insertReturningId(db, "replay_destinations", {
    project_id: input.projectId,
    name: input.name,
    base_url: input.baseUrl,
    environment_type: input.environmentType,
    encrypted_headers:
      input.headers === undefined || Object.keys(input.headers).length === 0
        ? null
        : encryptField(fieldKey, JSON.stringify(input.headers))
  });

  const created = await findDestination(db, input.projectId, id);
  if (created === undefined) throw new Error("The destination vanished after insert.");
  return created;
}

/** Scoped on project: a destination belonging to another project must not be visible. */
export async function findDestination(
  db: Knex,
  projectId: string,
  id: string
): Promise<ReplayDestination | undefined> {
  const row: unknown = await db("replay_destinations")
    .where({ project_id: projectId, id })
    .first(DESTINATION_COLUMNS);
  return row === undefined ? undefined : (row as ReplayDestination);
}

export async function listDestinations(db: Knex, projectId: string): Promise<ReplayDestination[]> {
  const rows: unknown = await db("replay_destinations")
    .where({ project_id: projectId })
    .orderBy("name")
    .select(DESTINATION_COLUMNS);
  return rows as ReplayDestination[];
}

/**
 * The destination's configured headers, decrypted.
 *
 * Never returned by `findDestination` or `listDestinations`. A caller that
 * needs to send a request asks for them explicitly, so a credential cannot
 * reach a list response by accident.
 */
export async function destinationHeaders(
  db: Knex,
  fieldKey: Buffer,
  projectId: string,
  id: string
): Promise<Record<string, string>> {
  const row: unknown = await db("replay_destinations")
    .where({ project_id: projectId, id })
    .first("encrypted_headers as encryptedHeaders");

  const encrypted = (row as { encryptedHeaders: string | null } | undefined)?.encryptedHeaders;
  if (encrypted === null || encrypted === undefined) return {};

  try {
    return JSON.parse(decryptField(fieldKey, encrypted)) as Record<string, string>;
  } catch {
    // A row encrypted under a rotated key degrades to no headers rather than
    // failing the replay outright, matching how the read path treats payloads.
    return {};
  }
}

/**
 * Record an attempt before it is made.
 *
 * Written first so that a refusal still leaves a row. A blocked attempt that
 * persisted nothing would make the safety checks invisible: the operator would
 * see an error in a browser and no record of what was refused or why.
 */
export async function startRun(
  db: Knex,
  input: {
    projectId: string;
    journeyEventId: string;
    destinationId: string;
    method: string;
    requestPath: string;
    requestPayload: unknown;
    requestHeaders: Record<string, string>;
    initiatedBy: string;
  }
): Promise<string> {
  return insertReturningId(db, "replay_runs", {
    project_id: input.projectId,
    journey_event_id: input.journeyEventId,
    destination_id: input.destinationId,
    method: input.method,
    request_path: input.requestPath,
    request_payload: JSON.stringify(input.requestPayload ?? null),
    request_headers: JSON.stringify(input.requestHeaders),
    status: "running",
    initiated_by: input.initiatedBy
  });
}

export async function finishRun(
  db: Knex,
  projectId: string,
  id: string,
  outcome: {
    status: ReplayStatus;
    responseStatus?: number | null;
    responsePayload?: unknown;
    durationMs?: number | null;
    error?: unknown;
  }
): Promise<void> {
  await db("replay_runs")
    .where({ project_id: projectId, id })
    .update({
      status: outcome.status,
      response_status: outcome.responseStatus ?? null,
      response_payload:
        outcome.responsePayload === undefined ? null : JSON.stringify(outcome.responsePayload),
      duration_ms: outcome.durationMs ?? null,
      error: outcome.error === undefined ? null : JSON.stringify(outcome.error),
      completed_at: db.fn.now()
    });
}

export async function findRun(
  db: Knex,
  projectId: string,
  id: string
): Promise<ReplayRun | undefined> {
  const row: unknown = await db("replay_runs")
    .where({ project_id: projectId, id })
    .first(
      "id",
      "project_id as projectId",
      "journey_event_id as journeyEventId",
      "destination_id as destinationId",
      "method",
      "request_path as requestPath",
      "request_payload as requestPayload",
      "request_headers as requestHeaders",
      "response_status as responseStatus",
      "response_payload as responsePayload",
      "duration_ms as durationMs",
      "status",
      "error",
      "initiated_by as initiatedBy",
      "created_at as createdAt",
      "completed_at as completedAt"
    );
  return row === undefined ? undefined : (row as ReplayRun);
}
