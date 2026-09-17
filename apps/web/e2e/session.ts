import { expect, type Page } from "@playwright/test";

export const ADMIN_TOKEN = process.env["ADMIN_TOKEN"] ?? "";
export const API_URL = process.env["API_URL"] ?? "http://localhost:8080";
export const API_KEY = process.env["WAYSCRIBE_API_KEY"] ?? "";

/**
 * The id of the project a seeded journey was written into, or null when the
 * installation has at most one project and nothing has to be chosen.
 *
 * The specs seed through WAYSCRIBE_API_KEY, which belongs to one project, and the
 * interface reads another project's data only after the picker chooses it. On a
 * database with one project the picker never appears. On the demo stack after
 * the README's `project:create` there are two, and every signed-in page used to
 * land on the picker instead of the page under test. The admin API lists the
 * projects, and the one that holds the journey is the one the key writes to.
 */
export async function projectHolding(journeyId: string): Promise<string | null> {
  const headers = { authorization: `Bearer ${ADMIN_TOKEN}` };
  const listed = await fetch(`${API_URL}/v1/projects`, { headers });
  if (!listed.ok) throw new Error(`GET /v1/projects answered ${String(listed.status)}`);
  const projects = ((await listed.json()) as { data: { items: { id: string }[] } }).data.items;
  if (projects.length <= 1) return null;

  for (const project of projects) {
    const found = await fetch(`${API_URL}/v1/journeys/${encodeURIComponent(journeyId)}`, {
      headers: { ...headers, "x-wayscribe-project-id": project.id }
    });
    if (found.ok) return project.id;
  }
  throw new Error(`No project holds ${journeyId}; did seeding with WAYSCRIBE_API_KEY succeed?`);
}

/**
 * Sign in with ADMIN_TOKEN, and choose the project holding `journeyId` when the
 * installation has more than one.
 */
export async function signIn(page: Page, journeyId: string): Promise<void> {
  await page.goto("/login");
  await page.fill("#token", ADMIN_TOKEN);
  await page.click("button[type=submit]");
  await expect(page).toHaveURL("/");

  const projectId = await projectHolding(journeyId);
  if (projectId === null) return;

  await page.goto("/projects");
  await page
    .locator("form", { has: page.locator(`input[name=projectId][value="${projectId}"]`) })
    .getByRole("button")
    .click();
  await expect(page).toHaveURL("/");
}
