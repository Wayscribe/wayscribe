import type { Knex } from "knex";

export interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
}

/**
 * Every project, for an operator choosing one.
 *
 * Unpaginated deliberately. A self-hosted installation has a handful of
 * projects, not thousands, and a cursor here would be ceremony around a list
 * that fits on one screen.
 */
export async function listProjects(db: Knex): Promise<ProjectSummary[]> {
  const rows: unknown = await db("projects").select("id", "name", "slug").orderBy("name");
  return rows as ProjectSummary[];
}
