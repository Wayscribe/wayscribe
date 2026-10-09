import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TEST_ACCOUNT } from "./account.js";
import {
  accountFor,
  failureShape,
  isFailureShape,
  MAX_DELIVERIES,
  RETRY_DELAY_SECONDS,
  SLOW_ACCOUNT_PREFIX,
  UNMAPPED_STATUS
} from "./failures.js";

describe("failure shapes", () => {
  it("holds the queue timing to what ElasticMQ is configured with", () => {
    const conf = readFileSync(
      new URL("../../../infrastructure/elasticmq.conf", import.meta.url),
      "utf8"
    );
    expect(/defaultVisibilityTimeout = (\d+) seconds/.exec(conf)?.[1]).toBe(
      String(RETRY_DELAY_SECONDS)
    );
    expect(/maxReceiveCount = (\d+)/.exec(conf)?.[1]).toBe(String(MAX_DELIVERIES));
  });

  it("draws each shape from its slice of one random number", () => {
    expect(
      [0, 0.39, 0.4, 0.59, 0.6, 0.74, 0.75, 0.89, 0.9, 0.999].map((n) => failureShape(() => n))
    ).toEqual([
      "dead-letter",
      "dead-letter",
      "schema-rejected",
      "schema-rejected",
      "timeout",
      "timeout",
      "transform-failed",
      "transform-failed",
      "persist-failed",
      "persist-failed"
    ]);
    expect(isFailureShape("timeout")).toBe(true);
    expect(isFailureShape("__proto__")).toBe(false);
  });

  it("shapes the reference account without touching what the shape does not need", () => {
    const withPhone = { ...TEST_ACCOUNT, Phone__c: TEST_ACCOUNT.Phone };
    expect(accountFor(withPhone, "dead-letter")).toEqual(TEST_ACCOUNT);
    expect(accountFor(TEST_ACCOUNT)).toEqual(withPhone);
    expect(accountFor(TEST_ACCOUNT, "schema-rejected")).toEqual({
      ...withPhone,
      Status__c: UNMAPPED_STATUS
    });
    expect(accountFor(TEST_ACCOUNT, "timeout").Id).toBe(`${SLOW_ACCOUNT_PREFIX}00002ABC`);
    expect(accountFor(TEST_ACCOUNT, "transform-failed")).not.toHaveProperty("Status__c");
    expect(accountFor(TEST_ACCOUNT, "persist-failed")).not.toHaveProperty("Name");
  });
});
