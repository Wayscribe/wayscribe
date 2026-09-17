// Your application's own code: what a lead is, and how a webhook body becomes
// one. Nothing here knows about Wayscribe.

export interface Lead {
  id: string;
  email: string;
  company: string;
  source: string;
}

function field(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`lead has no ${name}`);
  }
  return value.trim();
}

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null) throw new Error("lead is not an object");
  return body as Record<string, unknown>;
}

/** The lead id, if the body has one, so a journey can start before parsing. */
export function leadIdOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const id = (body as Record<string, unknown>).leadId;
  return typeof id === "string" && id !== "" ? id : undefined;
}

export function parseLead(body: unknown): Lead {
  const record = asRecord(body);
  return {
    id: field(record, "leadId"),
    email: field(record, "email").toLowerCase(),
    company: field(record, "companyName"),
    source: field(record, "formName")
  };
}

/** A lead read back from a job, or undefined if the job holds something else. */
export function asLead(value: unknown): Lead | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { id, email, company, source } = value as Record<string, unknown>;
  if (typeof id !== "string" || typeof email !== "string") return undefined;
  if (typeof company !== "string" || typeof source !== "string") return undefined;
  return { id, email, company, source };
}

/** Public text for the Journeys page: no names of people, no email addresses. */
export function leadLabel(lead: Lead): string {
  return `${lead.company} · ${lead.source}`;
}
