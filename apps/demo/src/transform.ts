import type { SalesforceAccount } from "./account.js";

export interface Customer {
  externalId: string;
  name: string;
  phone: string | null;
  status: string;
}

/**
 * Map a Salesforce account onto the internal customer.
 *
 * **The `Phone__c` read is the demo's intentional defect** (`DEMO_SCENARIO.md`
 * section 4). The payload that arrives carries `Phone`, so the phone number
 * becomes null and the target rejects the customer. Do not correct it: the
 * demo, the end-to-end test, and the Phase 6 replay comparison all depend on
 * this being wrong.
 */
export function transformAccount(account: SalesforceAccount): Customer {
  return {
    externalId: account.Id,
    name: account.Name,
    phone: account.Phone__c ?? null,
    status: account.Status__c.toLowerCase()
  };
}
