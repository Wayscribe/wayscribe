/**
 * Who a read is allowed to see.
 *
 * An absent environment means every environment of this one project — never
 * every project. The project filter always applies (ADR-029).
 *
 * This lived inside `search.ts` as `SearchScope`, and search was the only read
 * that took it. `/v1/journeys/:id`, `/v1/journeys/:id/events` and
 * `/v1/events/:id` took a bare project id, so a key scoped to `development`
 * could fetch a `production` journey and its decrypted payload by id. The
 * boundary was real in the schema, enforced on one route, and absent on the
 * three that return the data.
 */
export interface ReadScope {
  projectId: string;
  environmentId?: string | undefined;
}

/** Applies a scope to a query on any table carrying both columns. */
export function scoped<T extends { where: (clause: Record<string, unknown>) => T }>(
  query: T,
  scope: ReadScope
): T {
  const filtered = query.where({ project_id: scope.projectId });
  return scope.environmentId === undefined
    ? filtered
    : filtered.where({ environment_id: scope.environmentId });
}
