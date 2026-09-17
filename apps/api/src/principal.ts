import type { ApiKeyContext } from "@wayscribe/database";
import { timingSafeEqual } from "node:crypto";
import type { Knex } from "knex";
import { authenticatePresentedKey, bearerToken, type ApiKeyAuthenticator } from "./auth.js";

/**
 * Who is making a request.
 *
 * An API key identifies one project and one environment and may ingest. An admin
 * identifies the operator, reads across every environment of a named project, and
 * may not ingest — ingestion writes into a specific environment and an admin
 * token names none, so accepting it there would mean guessing (ADR-029).
 */
export type Principal =
  { kind: "apiKey"; context: ApiKeyContext } | { kind: "admin"; projectId: string };

export type PrincipalResult =
  | { ok: true; principal: Principal }
  | { ok: false; status: 401 | 403 | 404; code: string; message: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const UNAUTHORIZED = {
  ok: false as const,
  status: 401 as const,
  code: "unauthorized",
  message: "A valid API key is required."
};

export interface ResolveOptions {
  db: Knex;
  apiKeys: ApiKeyAuthenticator;
  adminToken: string;
  authorizationHeader: string | undefined;
  /** Which project an admin is asking about. Ignored for API keys. */
  requestedProjectId?: string | undefined;
}

/**
 * Resolve a bearer token to a principal.
 *
 * The admin token is checked first and in constant time. Every failure returns
 * the same message, so the response cannot be used to distinguish an unknown key
 * from a revoked one or a near-miss admin token.
 */
export async function resolvePrincipal(options: ResolveOptions): Promise<PrincipalResult> {
  const presented = bearerToken(options.authorizationHeader);
  if (presented === undefined) return UNAUTHORIZED;

  if (constantTimeEquals(presented, options.adminToken)) {
    return resolveAdminProject(options.db, options.requestedProjectId);
  }

  const context = await authenticatePresentedKey(presented, options.apiKeys);
  if (context === undefined) return UNAUTHORIZED;

  return { ok: true, principal: { kind: "apiKey", context } };
}

/**
 * An admin names the project it wants. That is not an escalation — an admin can
 * read any project by definition — but the project must exist. Returning an empty
 * result set instead would read as "this record has no events", which is a
 * different and far more misleading answer than "wrong project".
 */
async function resolveAdminProject(
  db: Knex,
  requestedProjectId: string | undefined
): Promise<PrincipalResult> {
  const projectId = requestedProjectId ?? (await onlyProjectId(db));

  if (projectId === undefined) {
    return {
      ok: false,
      status: 404,
      code: "project_not_found",
      message: "Specify a project: none was named and there is not exactly one."
    };
  }

  const exists: unknown = UUID_PATTERN.test(projectId)
    ? await db("projects").where({ id: projectId }).first("id")
    : undefined;
  if (exists === undefined) {
    return {
      ok: false,
      status: 404,
      code: "project_not_found",
      message: "Project not found."
    };
  }

  return { ok: true, principal: { kind: "admin", projectId } };
}

/**
 * The project an admin is asking about, or undefined when it cannot be settled.
 *
 * Exported for callers that authenticate the admin token themselves — replay
 * does, because it must refuse an API key outright rather than resolve one
 * (ADR-032), and `/v1/projects` does because it answers before a project can be
 * named.
 */
export async function resolveAdminProjectId(
  db: Knex,
  requestedProjectId: string | undefined
): Promise<string | undefined> {
  const projectId = requestedProjectId ?? (await onlyProjectId(db));
  // Not a uuid cannot be a project, and PostgreSQL would answer the lookup with
  // an error, a 500, rather than with nothing.
  if (projectId === undefined || !UUID_PATTERN.test(projectId)) return undefined;

  const exists: unknown = await db("projects").where({ id: projectId }).first("id");
  return exists === undefined ? undefined : projectId;
}

/** Convenience for the common single-project install: no selector needed. */
async function onlyProjectId(db: Knex): Promise<string | undefined> {
  const rows: unknown = await db("projects").select("id").limit(2);
  const projects = rows as { id: string }[];
  return projects.length === 1 ? projects[0]?.id : undefined;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // Length is not secret; timingSafeEqual throws on a mismatch.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** The project a principal reads from. */
export function principalProjectId(principal: Principal): string {
  return principal.kind === "admin" ? principal.projectId : principal.context.projectId;
}

/**
 * The environment a principal is limited to, or undefined for project-wide.
 *
 * Undefined means every environment of that one project. It never means every
 * project — every read query still filters on project_id (ADR-029).
 */
export function principalEnvironmentId(principal: Principal): string | undefined {
  return principal.kind === "admin" ? undefined : principal.context.environmentId;
}
