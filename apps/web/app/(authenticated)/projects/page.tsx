import { ApiUnavailableError, listProjects } from "../../../src/lib/api";
import { safeReturnTo } from "../../../src/lib/return-to";

/**
 * Choose which project to read.
 *
 * Deliberately not reached by `requireProjectId`, which would send this page to
 * itself. It is the one authenticated page that does not need a project.
 */
export default async function ProjectsPage({
  searchParams
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  // Validated here as well as on submission: this value is put into a form,
  // and a page that renders an attacker's URL into a hidden field is already
  // most of the way to following it.
  const next = safeReturnTo((await searchParams).next);
  let projects;
  try {
    projects = await listProjects();
  } catch (error) {
    if (error instanceof ApiUnavailableError) {
      return (
        <main>
          <h1>Choose a project</h1>
          <p className="error">Cannot reach the Flight Recorder API. Is it running?</p>
        </main>
      );
    }
    throw error;
  }

  if (projects.length === 0) {
    return (
      <main>
        <h1>No projects yet</h1>
        <p className="muted">
          Nothing has been created in this installation. Create a project and an API key with:
        </p>
        <pre className="mono">pnpm db:seed</pre>
        <p className="muted">Then reload this page.</p>
      </main>
    );
  }

  return (
    <main>
      <h1>Choose a project</h1>
      <p className="muted">
        This installation has more than one project. Pick the one you want to search; you can change
        it later from this page.
      </p>

      <ul className="results">
        {projects.map((project) => (
          <li key={project.id}>
            <form method="post" action="/api/select-project">
              <input type="hidden" name="projectId" value={project.id} />
              <input type="hidden" name="next" value={next} />
              <button type="submit">
                {project.name} <span className="mono muted">{project.slug}</span>
              </button>
            </form>
          </li>
        ))}
      </ul>
    </main>
  );
}
