import { expect, test } from "@playwright/test";
import { ADMIN_TOKEN, API_URL } from "./session";

/**
 * Signing in lands on the search box, whatever the installation holds.
 *
 * On an installation with more than one project and none chosen, the Search
 * page once sent every sign-in to the project picker, because it asked for a
 * project on every render to list environments. CI runs this suite on one
 * project and again on two (.gitlab-ci.yml, e2e), so both paths are covered.
 */
test("signing in lands on the search box, before any project is chosen", async ({ page }) => {
  const listed = await fetch(`${API_URL}/v1/projects`, {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
  });
  const projects = ((await listed.json()) as { data: { items: unknown[] } }).data.items;

  await page.goto("/login");
  await page.fill("#token", ADMIN_TOKEN);
  await page.click("button[type=submit]");

  await expect(page).toHaveURL("/");
  await expect(page.getByRole("textbox", { name: "Search" })).toBeVisible();
  const choose = page.getByText("Choose a project to narrow by environment.");
  if (projects.length > 1) {
    await expect(choose).toBeVisible();
    await expect(page.getByLabel("Environment").locator("option")).toHaveText(["all"]);
  } else {
    await expect(choose).toHaveCount(0);
  }
});
