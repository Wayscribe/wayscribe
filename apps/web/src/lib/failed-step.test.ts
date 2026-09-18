import { describe, expect, it } from "vitest";
import { failedStepOf, statusText } from "./failed-step";

describe("failedStepOf", () => {
  it("is the failed step of a failed journey that names one", () => {
    expect(failedStepOf({ status: "failed", failedStep: "push-hubspot" })).toBe("push-hubspot");
  });

  // ADR-063: an older API omits the field, and a failure that predates
  // migration 021 has it null. Both read as no failed step.
  it("is null when the API omits the field or sends null", () => {
    expect(failedStepOf({ status: "failed" })).toBeNull();
    expect(failedStepOf({ status: "failed", failedStep: null })).toBeNull();
  });

  it("is null for a journey that is not failed, whatever the field holds", () => {
    for (const status of ["active", "completed", "abandoned"]) {
      expect(failedStepOf({ status, failedStep: "push-hubspot" })).toBeNull();
    }
  });

  // Only text crosses to the browser (event-display.ts): anything else the
  // API might send in the field is treated as absent, never passed along.
  it("is null when the field is not a string", () => {
    for (const failedStep of [1, true, {}, ["push-hubspot"], { name: "push-hubspot" }]) {
      expect(failedStepOf({ status: "failed", failedStep })).toBeNull();
    }
  });
});

describe("statusText", () => {
  it("reads 'failed at' the failed step of a failed journey", () => {
    expect(statusText("failed", "push-hubspot")).toBe("failed at push-hubspot");
  });

  it("is the status alone when there is no failed step", () => {
    expect(statusText("failed", null)).toBe("failed");
    expect(statusText("completed", null)).toBe("completed");
  });

  it("is the status alone when the journey is not failed", () => {
    expect(statusText("active", "push-hubspot")).toBe("active");
  });
});
