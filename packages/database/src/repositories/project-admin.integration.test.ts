import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKnexConfig } from "../knex-config.js";
import { issueKey } from "./key-admin.js";
import { ProjectAdminError, createProject, listProjects } from "./project-admin.js";

const MASTER_KEY = "0123456789abcdef0123456789abcdef";

/**
 * Until this existed there was no supported way to create a project at all.
 * `key:create` requires one, and the only two that could exist came from the
 * two hardcoded seeds — so a team standing Flight Recorder up against their own
 * database had an empty installation and nothing to point the SDK at.
 */
describe("project administration", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  it("creates a project on an empty installation", async () => {
    const created = await createProject(db, { slug: "acme", name: "Acme Payments" });
    expect(created.slug).toBe("acme");
    expect(created.name).toBe("Acme Payments");
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("makes the project usable by key:create, which is the point", async () => {
    // The end of the chain that was broken: a project must be something the key
    // issuer can find, or creating one has achieved nothing.
    await createProject(db, { slug: "fulfilment", name: "Fulfilment" });
    const issued = await issueKey(db, MASTER_KEY, {
      projectSlug: "fulfilment",
      environmentName: "production",
      name: "worker"
    });
    expect(issued.projectSlug).toBe("fulfilment");
    expect(issued.apiKey).toMatch(/^fr_/);
  });

  it("lists what exists", async () => {
    const slugs = (await listProjects(db)).map((project) => project.slug);
    expect(slugs).toContain("acme");
    expect(slugs).toContain("fulfilment");
  });

  it("refuses a duplicate slug by name rather than by constraint violation", async () => {
    await expect(createProject(db, { slug: "acme", name: "Acme Again" })).rejects.toThrow(
      ProjectAdminError
    );
    await expect(createProject(db, { slug: "acme", name: "Acme Again" })).rejects.toThrow(
      /exists/i
    );
  });

  it("refuses a slug that would not survive a URL", async () => {
    // The slug reaches `x-flight-project-id` selection, the CLI, and the
    // interface. Rejecting at creation is the only cheap moment.
    for (const slug of ["Acme Corp", "acme/prod", "", "UPPER", "trailing-"]) {
      await expect(createProject(db, { slug, name: "x" })).rejects.toThrow(ProjectAdminError);
    }
  });

  it("accepts the slugs a team will reasonably choose", async () => {
    // The control: a validator that rejected everything would pass the test
    // above.
    for (const slug of ["billing", "acme-payments", "team2", "a"]) {
      await expect(createProject(db, { slug, name: slug })).resolves.toMatchObject({ slug });
    }
  });

  it("requires a name", async () => {
    await expect(createProject(db, { slug: "nameless", name: "  " })).rejects.toThrow(
      ProjectAdminError
    );
  });
});
