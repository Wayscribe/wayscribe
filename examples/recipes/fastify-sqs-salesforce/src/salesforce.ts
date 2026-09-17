import type { Customer } from "./customer.js";

// Your application's own Salesforce call: an upsert of an Account by an
// external id field. The access token is in a header the recorder never sees.

export interface SalesforceAccount {
  Name: string;
  BillingCountry: string;
}

export interface SalesforceResult {
  status: number;
  body: unknown;
}

export function toAccount(customer: Customer): SalesforceAccount {
  return { Name: customer.name, BillingCountry: customer.country };
}

export async function upsertAccount(
  externalId: string,
  account: SalesforceAccount
): Promise<SalesforceResult> {
  const instance = process.env.SALESFORCE_INSTANCE_URL ?? "";
  const url = `${instance}/services/data/v62.0/sobjects/Account/External_Id__c/${encodeURIComponent(externalId)}`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${process.env.SALESFORCE_ACCESS_TOKEN ?? ""}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(account)
  });
  // 201 has a body with the new id; 204, an update, has none.
  const body: unknown = response.status === 204 ? null : await response.json();
  return { status: response.status, body };
}

export function accountIdOf(result: SalesforceResult): string | undefined {
  const body = result.body;
  if (typeof body !== "object" || body === null) return undefined;
  const id = (body as Record<string, unknown>).id;
  return typeof id === "string" ? id : undefined;
}
