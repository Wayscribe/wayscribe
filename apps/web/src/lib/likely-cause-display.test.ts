import { describe, expect, it } from "vitest";
import { likelyCausesForDisplay } from "./likely-cause-display";

/** As `GET /v1/journeys/:id` answers it for the demo's dead-letter. */
const CAUSE = {
  field: "phone",
  reportedBy: "evt_retry_3",
  eventId: "evt_transform",
  step: "transform-salesforce-account",
  change: {
    kind: "renamed-changed",
    lost: true,
    path: "phone",
    from: "Phone",
    before: "+1 919 555 1234",
    after: null
  },
  alsoChangedAt: []
};

describe("likelyCausesForDisplay", () => {
  it("turns a lost field into text", () => {
    expect(likelyCausesForDisplay([CAUSE])).toEqual([
      {
        field: "phone",
        changedPath: null,
        reportedBy: "evt_retry_3",
        eventId: "evt_transform",
        step: "transform-salesforce-account",
        verb: "lost",
        before: "+1 919 555 1234",
        after: "null",
        alsoChangedAt: [],
        incomplete: false
      }
    ]);
  });

  it("says changed for an altered value, and keeps the earlier steps and the incomplete mark", () => {
    const changed = {
      ...CAUSE,
      field: "status",
      reportedBy: "evt_deliver",
      change: {
        kind: "renamed-changed",
        lost: false,
        path: "status",
        from: "Status__c",
        before: "Former Customer",
        after: "former customer"
      },
      alsoChangedAt: [{ eventId: "evt_normalize", step: "normalize-status" }],
      incomplete: true
    };
    expect(likelyCausesForDisplay([changed])).toEqual([
      {
        field: "status",
        changedPath: null,
        reportedBy: "evt_deliver",
        eventId: "evt_transform",
        step: "transform-salesforce-account",
        verb: "changed",
        before: "Former Customer",
        after: "former customer",
        alsoChangedAt: [{ eventId: "evt_normalize", step: "normalize-status" }],
        incomplete: true
      }
    ]);
  });

  it("says removed for a removed field, and writes a nested value as JSON", () => {
    const removedNull = {
      ...CAUSE,
      change: { kind: "removed", lost: false, path: "phone", before: null }
    };
    const removedAddress = {
      ...CAUSE,
      field: "BillingAddress.PostalCode",
      change: {
        kind: "removed",
        lost: true,
        path: "BillingAddress",
        before: { city: "Raleigh", postalCode: "27601" }
      }
    };
    expect(
      likelyCausesForDisplay([removedNull, removedAddress]).map(
        ({ verb, before, after, changedPath }) => [verb, before, after, changedPath]
      )
    ).toEqual([
      ["removed", "null", "—", null],
      // An ancestor of the field changed: the field went with it, so the line names the field.
      ["lost", '{"city":"Raleigh","postalCode":"27601"}', "—", null]
    ]);
  });

  // A reported field also matches a change below it (ADR-072): the values are
  // the changed path's, so the line must name that path, not only the field.
  it("names the changed path when it lies below the reported field", () => {
    const below = {
      ...CAUSE,
      field: "address",
      change: {
        kind: "changed",
        lost: true,
        path: "address.postalCode",
        before: "27601",
        after: null
      }
    };
    const sameFieldOtherSpelling = {
      ...CAUSE,
      field: "Status__c",
      change: { kind: "changed", lost: false, path: "status", before: "A", after: "a" }
    };
    const belowAnIndex = {
      ...CAUSE,
      field: "lines",
      change: { kind: "removed", lost: false, path: "lines[0].sku", before: "X-1" }
    };
    // Keys compare as the API matches them, so `Address` holds `address.postalCode`.
    const belowOtherCase = { ...below, field: "Address" };
    expect(
      likelyCausesForDisplay([below, sameFieldOtherSpelling, belowAnIndex, belowOtherCase]).map(
        (cause) => cause.changedPath
      )
    ).toEqual(["address.postalCode", null, "lines[0].sku", "address.postalCode"]);
  });

  it("leaves out what it cannot read, and reads no inherited key", () => {
    expect(
      likelyCausesForDisplay([
        null,
        "phone",
        { ...CAUSE, field: 7 },
        { ...CAUSE, change: { ...CAUSE.change, kind: "added" } },
        JSON.parse(`{"__proto__": ${JSON.stringify(CAUSE)}}`) as unknown,
        {
          ...CAUSE,
          alsoChangedAt: [{ eventId: "evt_x" }, { eventId: "evt_enrich", step: "enrich-from-crm" }]
        }
      ]).map((cause) => cause.alsoChangedAt)
    ).toEqual([[{ eventId: "evt_enrich", step: "enrich-from-crm" }]]);
    expect(likelyCausesForDisplay(undefined)).toEqual([]);
    expect(likelyCausesForDisplay({ 0: CAUSE })).toEqual([]);
  });
});
