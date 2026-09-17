/**
 * The Salesforce account shape, as `DEMO_SCENARIO.md` section 3 defines it.
 *
 * `Phone__c` is optional and absent from the fixture on purpose: it is the
 * field the transformation mistakenly reads.
 */
export interface SalesforceAccount {
  Id: string;
  Name: string;
  Phone: string;
  Status__c: string;
  Phone__c?: string;
}

export const TEST_ACCOUNT: SalesforceAccount = {
  Id: "0018Z00002ABC",
  Name: "Jorge Polanco",
  Phone: "+1 919 555 1234",
  Status__c: "Active"
};

/**
 * Keep only the account fields, so a trigger body cannot smuggle anything else
 * into the recorded payload. Unknown keys are dropped rather than refused: this
 * stands in for a source system, and a source system ignores what it does not
 * model.
 */
export function accountFrom(overrides: unknown): SalesforceAccount {
  const given = (typeof overrides === "object" && overrides !== null ? overrides : {}) as Record<
    string,
    unknown
  >;
  const text = (key: keyof SalesforceAccount): string | undefined =>
    typeof given[key] === "string" && given[key] !== "" ? given[key] : undefined;

  const account: SalesforceAccount = {
    Id: text("Id") ?? TEST_ACCOUNT.Id,
    Name: text("Name") ?? TEST_ACCOUNT.Name,
    Phone: text("Phone") ?? TEST_ACCOUNT.Phone,
    Status__c: text("Status__c") ?? TEST_ACCOUNT.Status__c
  };

  // Present only when asked for. It is the field the transformation mistakenly
  // reads, so setting it is how a caller asks for the journey that succeeds.
  const custom = text("Phone__c");
  return custom === undefined ? account : { ...account, Phone__c: custom };
}
