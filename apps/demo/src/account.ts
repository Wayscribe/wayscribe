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
