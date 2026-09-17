// Your application's own code. Nothing here knows about Wayscribe.

export interface Customer {
  externalId: string;
  name: string;
  email: string;
  country: string;
}

function text(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  if (typeof value !== "string" || value === "") throw new Error(`customer has no ${name}`);
  return value;
}

/** The external id, if the body has one, so a journey can start before parsing. */
export function externalIdOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const id = (body as Record<string, unknown>).externalId;
  return typeof id === "string" && id !== "" ? id : undefined;
}

export function parseCustomer(body: unknown): Customer {
  if (typeof body !== "object" || body === null) throw new Error("customer is not an object");
  const record = body as Record<string, unknown>;
  return {
    externalId: text(record, "externalId"),
    name: text(record, "name"),
    email: text(record, "email"),
    country: text(record, "country").toUpperCase()
  };
}

const saved = new Map<string, Customer>();

/** Stands in for your database write. */
export function saveCustomer(customer: Customer): Promise<{ rowId: number }> {
  saved.set(customer.externalId, customer);
  return Promise.resolve({ rowId: saved.size });
}
