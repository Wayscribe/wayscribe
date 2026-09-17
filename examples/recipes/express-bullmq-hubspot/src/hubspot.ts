import type { Lead } from "./lead.js";

// Your application's own HubSpot call. The token goes in a header that is
// never passed to the recorder; only the contact properties are recorded.

export interface HubSpotContact {
  properties: { email: string; company: string; lead_source: string };
}

export interface HubSpotResult {
  status: number;
  body: unknown;
}

export function toHubSpotContact(lead: Lead): HubSpotContact {
  return { properties: { email: lead.email, company: lead.company, lead_source: lead.source } };
}

export async function createContact(contact: HubSpotContact): Promise<HubSpotResult> {
  const response = await fetch("https://api.hubapi.com/crm/v3/objects/contacts", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.HUBSPOT_TOKEN ?? ""}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(contact)
  });
  const body: unknown = await response.json();
  return { status: response.status, body };
}

export function contactIdOf(result: HubSpotResult): string | undefined {
  const body = result.body;
  if (typeof body !== "object" || body === null) return undefined;
  const id = (body as Record<string, unknown>).id;
  return typeof id === "string" ? id : undefined;
}
