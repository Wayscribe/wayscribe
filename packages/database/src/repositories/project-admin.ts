import type { Knex } from "knex";
import { insertReturningId } from "../insert.js";

export interface ProjectRecord {
  id: string;
  name: string;
  slug: string;
}

export class ProjectAdminError extends Error {
  public override readonly name = "ProjectAdminError";
}

/**
 * A slug is a URL and a command-line argument before it is a label.
 *
 * Lowercase letters, digits and interior hyphens only. Rejecting at creation is
 * the one cheap moment: a slug reaches project selection, the CLI, and the
 * interface, and renaming one afterwards means touching every place an operator
 * has written it down.
 */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Create a project.
 *
 * Until this existed there was no supported way to make one. `key:create`
 * requires a project, and the only two that could exist came from the two
 * hardcoded seeds — so a team pointing Wayscribe at their own database
 * had an installation with nothing to instrument and no way to add anything.
 */
export async function createProject(
  db: Knex,
  options: { slug: string; name: string }
): Promise<ProjectRecord> {
  const slug = options.slug.trim();
  const name = options.name.trim();

  if (!SLUG.test(slug)) {
    throw new ProjectAdminError(
      `"${options.slug}" is not a usable slug. Use lowercase letters, digits and hyphens, ` +
        `for example "acme-payments".`
    );
  }
  if (name === "") {
    throw new ProjectAdminError("A project needs a name; it is what the interface shows.");
  }

  // Checked rather than left to the unique constraint, so the operator gets a
  // sentence instead of a driver error naming an index.
  const existing: unknown = await db("projects").where({ slug }).first("id");
  if (existing !== undefined) {
    throw new ProjectAdminError(`A project with slug "${slug}" already exists.`);
  }

  const id = await insertReturningId(db, "projects", { name, slug });
  return { id, name, slug };
}

/** Every project, oldest first. */
export async function listProjects(db: Knex): Promise<ProjectRecord[]> {
  const rows: unknown = await db("projects")
    .orderBy("created_at", "asc")
    .select("id", "name", "slug");
  return rows as ProjectRecord[];
}
