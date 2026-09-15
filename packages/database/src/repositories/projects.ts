import type { Knex } from "knex";

export interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  /** Environment names, sorted. The Recent page offers them as a filter. */
  environments: string[];
}

/**
 * Every project, for an operator choosing one.
 *
 * Unpaginated deliberately. A self-hosted installation has a handful of
 * projects, not thousands, and a cursor here would be ceremony around a list
 * that fits on one screen. Environments ride along for the same reason: a few
 * names per project, and a second endpoint to fetch them would be ceremony too.
 */
export async function listProjects(db: Knex): Promise<ProjectSummary[]> {
  const rows: unknown = await db("projects").select("id", "name", "slug").orderBy("name");
  const environments: unknown = await db("environments")
    .select("project_id as projectId", "name")
    .orderBy("name");

  const byProject = new Map<string, string[]>();
  for (const environment of environments as { projectId: string; name: string }[]) {
    const names = byProject.get(environment.projectId) ?? [];
    names.push(environment.name);
    byProject.set(environment.projectId, names);
  }

  return (rows as Omit<ProjectSummary, "environments">[]).map((project) => ({
    ...project,
    environments: byProject.get(project.id) ?? []
  }));
}
