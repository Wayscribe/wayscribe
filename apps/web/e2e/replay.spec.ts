import { expect, test } from "@playwright/test";
import { ADMIN_TOKEN, API_KEY, API_URL, projectHolding, signIn } from "./session";

// Its own journey, versioned like the other suites' seeds.
const SEED_VERSION = "v1";
const JOURNEY_ID = `jrn_e2e_replay_${SEED_VERSION}`;
const EVENT_ID = `evt_replay_${SEED_VERSION}_1`;
/** Found and reused on later runs, so the list does not grow with every run. */
const DESTINATION_NAME = "e2e-replay-refusals";

async function seed(): Promise<void> {
  const response = await fetch(`${API_URL}/v1/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      protocolVersion: "0.1",
      event: {
        id: EVENT_ID,
        journeyId: JOURNEY_ID,
        environment: "development",
        service: "webhook-api",
        entity: { type: "customer", id: `E2E-REPLAY-${SEED_VERSION.toUpperCase()}` },
        operation: "failed",
        name: "sync-customer",
        timestamp: "2026-08-09T10:00:00.000Z",
        input: { customerId: "C-1" }
      }
    })
  });
  if (response.status === 409) {
    throw new Error(`Seeding ${EVENT_ID} conflicted with different content. Bump SEED_VERSION.`);
  }
  if (!response.ok) throw new Error(`Seeding ${EVENT_ID} failed with ${String(response.status)}`);

  // The form only appears once a destination exists. Nothing is ever sent to
  // it here: the method below is refused before the API looks for a host.
  const projectId = await projectHolding(JOURNEY_ID);
  const headers = {
    authorization: `Bearer ${ADMIN_TOKEN}`,
    "content-type": "application/json",
    ...(projectId === null ? {} : { "x-wayscribe-project-id": projectId })
  };
  const listed = await fetch(`${API_URL}/v1/replay-destinations`, { headers });
  if (!listed.ok) throw new Error(`Listing destinations failed with ${String(listed.status)}`);
  const { items } = ((await listed.json()) as { data: { items: { name: string }[] } }).data;
  if (items.some((item) => item.name === DESTINATION_NAME)) return;

  const created = await fetch(`${API_URL}/v1/replay-destinations`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: DESTINATION_NAME,
      baseUrl: "http://localhost:9",
      environmentType: "development"
    })
  });
  if (!created.ok) throw new Error(`Creating a destination failed with ${String(created.status)}`);
}

test.beforeAll(seed);

test("a replay the API refuses before running says why on the replay page", async ({ page }) => {
  await signIn(page, JOURNEY_ID);
  await page.goto(`/journeys/${JOURNEY_ID}/replay?event=${EVENT_ID}`);
  await expect(page.locator("main").getByRole("alert")).toHaveCount(0);

  // The form offers only methods the API accepts, so one it refuses is put in
  // by hand: the refusal is what is under test, not the form's choices.
  await page
    .locator("#method option[value=PATCH]")
    .evaluate((option: HTMLOptionElement) => (option.value = "DELETE"));
  await page.locator("#method").selectOption("DELETE");
  await page.getByRole("button", { name: "Send replay" }).click();

  await expect(page).toHaveURL(
    `/journeys/${JOURNEY_ID}/replay?event=${EVENT_ID}&error=invalid_method`
  );
  await expect(page.locator("main").getByRole("alert")).toHaveText(
    "That method cannot be replayed, so nothing was sent. Choose POST, PUT, or PATCH."
  );
});
