import { describe, expect, it } from "vitest";
import { TEST_ACCOUNT } from "./account.js";
import { transformAccount } from "./transform.js";

describe("transformAccount", () => {
  it("carries the fields it maps correctly", () => {
    const customer = transformAccount(TEST_ACCOUNT);
    expect(customer.externalId).toBe("0018Z00002ABC");
    expect(customer.name).toBe("Jorge Polanco");
    expect(customer.status).toBe("active");
  });

  it("loses the phone number, which is the demo's defect", () => {
    // DEMO_SCENARIO.md section 4. The account carries `Phone`; the mapping
    // reads `Phone__c`. Fixing that breaks the demo and the Phase 6 replay
    // comparison, so this test exists to make the break loud.
    expect(TEST_ACCOUNT.Phone).toBe("+1 919 555 1234");
    expect(transformAccount(TEST_ACCOUNT).phone).toBeNull();
  });

  it("keeps the phone when the source really does use Phone__c", () => {
    // Proves the null above comes from the field name, not from the mapping
    // discarding phone numbers outright.
    const withCustomField = { ...TEST_ACCOUNT, Phone__c: "+1 919 555 9999" };
    expect(transformAccount(withCustomField).phone).toBe("+1 919 555 9999");
  });
});
