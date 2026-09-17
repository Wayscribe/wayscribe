import { describe, expect, it } from "vitest";
import { accountFrom, TEST_ACCOUNT } from "./account.js";

describe("accountFrom", () => {
  it("sends the reference account when the trigger carries no body", () => {
    // `pnpm demo:trigger` and the acceptance test both POST without one, and
    // DEMO_SCENARIO.md section 3 is what they must keep getting.
    expect(accountFrom(undefined)).toEqual(TEST_ACCOUNT);
    expect(accountFrom({})).toEqual(TEST_ACCOUNT);
    expect(accountFrom("not an object")).toEqual(TEST_ACCOUNT);
  });

  it("overrides only the fields it is given", () => {
    const account = accountFrom({ Id: "0018Z00002QRS", Name: "Northwind Traders" });
    expect(account.Id).toBe("0018Z00002QRS");
    expect(account.Name).toBe("Northwind Traders");
    expect(account.Phone).toBe(TEST_ACCOUNT.Phone);
    expect(account.Status__c).toBe(TEST_ACCOUNT.Status__c);
  });

  it("leaves Phone__c absent unless it is asked for", () => {
    // Absent is the defect: the transformation reads Phone__c and finds
    // nothing. Present is the journey that reaches the target and completes.
    expect("Phone__c" in accountFrom({})).toBe(false);
    expect(accountFrom({ Phone__c: "+1 919 555 7788" }).Phone__c).toBe("+1 919 555 7788");
  });

  it("drops anything that is not an account field, and any empty or non-string value", () => {
    const account = accountFrom({
      Id: "0018Z00002XYZ",
      Name: "",
      Phone: 5551234,
      injected: { nested: true }
    });
    expect(account).toEqual({
      Id: "0018Z00002XYZ",
      Name: TEST_ACCOUNT.Name,
      Phone: TEST_ACCOUNT.Phone,
      Status__c: TEST_ACCOUNT.Status__c
    });
  });
});
