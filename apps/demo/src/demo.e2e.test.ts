import { beforeAll, describe, expect, it } from "vitest";

/**
 * The product acceptance test (`DEMO_SCENARIO.md` sections 1 and 11).
 *
 * It runs against a live stack rather than fabricated data, which is what
 * separates it from every other suite here: start the stack, trigger once, and
 * assert that the journey a developer would actually look at is the one the
 * documentation promises.
 */
const API = process.env["FLIGHT_API_URL"] ?? "http://localhost:8080";
const SOURCE = process.env["DEMO_SOURCE_URL"] ?? "http://localhost:3100";
const ADMIN = process.env["ADMIN_TOKEN"] ?? "replace-for-local-development-0000";

const EXPECTED_SEQUENCE = [
  ["received", "receive-salesforce-webhook"],
  ["transformed", "transform-salesforce-account"],
  ["persisted", "persist-customer"],
  ["identified", "identify"],
  ["published", "publish-customer-updated"],
  ["consumed", "consume-customer-updated"],
  ["delivered", "deliver-customer-to-target"],
  ["retried", "retry-customer-delivery"],
  ["retried", "retry-customer-delivery"],
  ["failed", "move-message-to-dead-letter"]
];

interface EventItem {
  id: string;
  operation: string;
  name: string;
  service: string;
  hasError: boolean;
}

interface DiffChange {
  kind: string;
  path: string;
  before?: unknown;
  after?: unknown;
}

/**
 * Set once the demo project is resolved.
 *
 * The admin token reads one named project. Relying on the "only project"
 * fallback would make this suite pass or fail depending on whether anything
 * else had ever been seeded into the same stack.
 */
let projectId = "";

async function get(path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${API}${path}`, {
    headers: {
      authorization: `Bearer ${ADMIN}`,
      ...(projectId === "" ? {} : { "x-flight-project-id": projectId })
    }
  });
  if (!response.ok) {
    throw new Error(`GET ${path} responded ${String(response.status)}.`);
  }
  const body = (await response.json()) as { data?: Record<string, unknown> };
  return body.data ?? {};
}

async function post(
  path: string,
  body: unknown
): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ADMIN}`,
      "content-type": "application/json",
      ...(projectId === "" ? {} : { "x-flight-project-id": projectId })
    },
    body: JSON.stringify(body)
  });
  const parsed = (await response.json()) as { data?: Record<string, unknown> };
  return { status: response.status, data: parsed.data ?? {} };
}

async function resolveDemoProject(): Promise<string> {
  const page = await get("/v1/projects");
  const items = (page["items"] ?? []) as { id: string; slug: string }[];
  const demo = items.find((project) => project.slug === "demo");
  if (demo === undefined) {
    throw new Error(`No project with slug "demo". Found: ${items.map((p) => p.slug).join(", ")}`);
  }
  return demo.id;
}

function journeyIdsIn(page: Record<string, unknown>): string[] {
  return (page["items"] as { journeyId: string }[]).map((hit) => hit.journeyId);
}

let journeyId = "";
let events: EventItem[] = [];

describe("the reference journey", () => {
  beforeAll(async () => {
    projectId = await resolveDemoProject();

    const triggered = await fetch(`${SOURCE}/trigger`, { method: "POST" });
    expect(triggered.status).toBe(202);
    journeyId = ((await triggered.json()) as { journeyId: string }).journeyId;

    // The queue's visibility timeout drives the retries, so the journey takes
    // roughly ten seconds. Poll for the terminal state rather than sleeping for
    // a guess.
    const deadline = Date.now() + 90_000;
    for (;;) {
      const page = await get(`/v1/journeys/${journeyId}/events`);
      events = (page["items"] ?? []) as EventItem[];
      if (events.some((event) => event.name === "move-message-to-dead-letter")) break;
      if (Date.now() > deadline) {
        throw new Error(
          `The journey never dead-lettered. Saw: ${events.map((e) => e.name).join(", ")}`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  });

  it("records every step, in order, across both owned services", () => {
    expect(events.map((event) => [event.operation, event.name])).toEqual(EXPECTED_SEQUENCE);
    // demo-source and demo-target are not instrumented, so they must not
    // appear: the timeline covers the services the team owns.
    expect(new Set(events.map((event) => event.service))).toEqual(
      new Set(["demo-integration", "demo-worker"])
    );
  });

  it("ends failed", async () => {
    const journey = await get(`/v1/journeys/${journeyId}`);
    expect(journey["status"]).toBe("failed");
    expect(journey["eventCount"]).toBe(10);
  });

  it("shows the phone leaving with a value and arriving null", async () => {
    const transformed = events.find((event) => event.name === "transform-salesforce-account");
    expect(transformed).toBeDefined();

    const detail = await get(`/v1/events/${transformed?.id ?? ""}`);
    const changes = (detail["payloadDiff"] as { changes: DiffChange[] }).changes;
    const at = (path: string): DiffChange | undefined =>
      changes.find((change) => change.path === path);

    // ADR-030: the transformation renames every field, so the defect reads as a
    // pair rather than as one field changing value.
    expect(at("Phone")?.before).toBe("+1 919 555 1234");
    expect(at("phone")?.after).toBeNull();
    // The control. Without it this passes for a transformation that dropped
    // every value, not just the phone number.
    expect(at("name")?.after).toBe("Jorge Polanco");
  });

  it("records the target's rejection on every delivery attempt", async () => {
    const deliveries = events.filter((event) =>
      ["deliver-customer-to-target", "retry-customer-delivery"].includes(event.name)
    );
    expect(deliveries).toHaveLength(3);
    expect(deliveries.every((event) => event.hasError)).toBe(true);

    const detail = await get(`/v1/events/${deliveries[0]?.id ?? ""}`);
    const output = detail["outputPayload"] as {
      status: number;
      body: { error: { code: string } };
    };
    expect(output.status).toBe(422);
    expect(output.body.error.code).toBe("phone_required");
  });

  it("replays the recorded input against the corrected endpoint", async () => {
    // DEMO_SCENARIO.md section 11, steps 10 through 12. This is the second half
    // of the product: find where the value was lost, then check a fix against
    // the input that actually failed.
    const destination = await post("/v1/replay-destinations", {
      name: `corrected-${journeyId.slice(4, 12)}`,
      baseUrl: "http://demo-integration:3200",
      environmentType: "development"
    });
    expect(destination.status).toBe(201);

    const transformed = events.find((event) => event.name === "transform-salesforce-account");
    const replay = await post("/v1/replays", {
      eventId: transformed?.id,
      destinationId: destination.data["id"],
      path: "/replay/customer"
    });

    expect(replay.status).toBe(200);
    expect(replay.data["status"]).toBe("completed");
    expect(replay.data["responseStatus"]).toBe(200);

    const body = replay.data["responsePayload"] as { phone: string };
    // The corrected mapping reads `Phone`, which is what arrives.
    expect(body.phone).toBe("+1 919 555 1234");

    // And the comparison names the one field that changed. Both sides share a
    // shape here, which the transformation diff could not (ADR-030).
    const comparison = replay.data["comparison"] as {
      changes: { path: string; before?: unknown; after?: unknown }[];
    };
    const phone = comparison.changes.find((change) => change.path === "phone");
    expect(phone?.before).toBeNull();
    expect(phone?.after).toBe("+1 919 555 1234");
  });

  it("refuses a destination outside the allowlist and records the refusal", async () => {
    const destination = await post("/v1/replay-destinations", {
      name: `blocked-${journeyId.slice(4, 12)}`,
      baseUrl: "http://169.254.169.254",
      environmentType: "development"
    });
    const transformed = events.find((event) => event.name === "transform-salesforce-account");

    const replay = await post("/v1/replays", {
      eventId: transformed?.id,
      destinationId: destination.data["id"],
      path: "/latest/meta-data/"
    });

    expect(replay.status).toBe(422);
    expect(replay.data["status"]).toBe("blocked");
    expect((replay.data["error"] as { reason: string }).reason).toBe("host_not_allowed");
  });

  it("is findable by the Salesforce ID and by the internal customer ID", async () => {
    expect(journeyIdsIn(await get("/v1/search?q=0018Z00002ABC"))).toContain(journeyId);

    // DEMO_SCENARIO.md section 9. This one is an alias rather than the primary
    // entity, so it tests a different lookup path — and it is the case that was
    // silently broken until the demo exercised it.
    expect(journeyIdsIn(await get("/v1/search?q=18492"))).toContain(journeyId);
  });
});
