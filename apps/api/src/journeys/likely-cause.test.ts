import { diffPayloads } from "@wayscribe/payload-diff";
import { describe, expect, it } from "vitest";
import {
  MAX_JOURNEY_EVENTS_FOR_CAUSES,
  findLikelyCauses,
  type CauseEvent
} from "./likely-cause.js";

/**
 * Salesforce-shaped fixtures: an Account as the webhook delivers it, with a
 * nested billing address, opportunity line items and `__c` custom fields, and
 * the customer the integration turns it into. Every diff is made by
 * `diffPayloads`, the function ingestion stores diffs with, so the paths are
 * the ones a real journey holds.
 */
const ACCOUNT = {
  Id: "0018Z00002ABC",
  Name: "Acme Field Services",
  Phone: "+1 919 555 1234",
  Status__c: "Active",
  BillingAddress: {
    street: "100 Main St",
    city: "Raleigh",
    state: "NC",
    postalCode: "27601",
    country: "US"
  },
  Opportunity_Lines__c: [
    { Product_Code__c: "SKU-100", Quantity__c: 2, Unit_Price__c: 49.5 },
    { Product_Code__c: "SKU-200", Quantity__c: 1, Unit_Price__c: 120 }
  ]
};

const CUSTOMER = {
  externalId: "0018Z00002ABC",
  name: "Acme Field Services",
  phone: "+1 919 555 1234",
  status: "Active",
  address: {
    street: "100 Main St",
    city: "Raleigh",
    state: "NC",
    postalCode: "27601",
    country: "US"
  },
  lines: [
    { sku: "SKU-100", quantity: 2, unitPrice: 49.5 },
    { sku: "SKU-200", quantity: 1, unitPrice: 120 }
  ]
};

/** The demo's defect: the transform reads `Phone__c`, which this account does not have. */
const PHONE_LOST = { ...CUSTOMER, phone: null };

const REJECTED = {
  status: 422,
  body: {
    error: { code: "phone_required", message: "A phone number is required.", fields: ["phone"] }
  }
};

const step = (id: string, name: string, input?: unknown, output?: unknown): CauseEvent => ({
  id,
  step: name,
  failed: false,
  fields: undefined,
  diff: input !== undefined && output !== undefined ? diffPayloads(input, output) : null
});

const failure = (
  id: string,
  name: string,
  fields?: unknown,
  input?: unknown,
  output?: unknown
): CauseEvent => ({
  ...step(id, name, input, output),
  failed: true,
  fields
});

const received = step("evt_received", "receive-salesforce-webhook");
const transformed = step("evt_transform", "transform-salesforce-account", ACCOUNT, PHONE_LOST);

/** As the transform records it: `Phone` paired with `phone`, its value gone. */
const PHONE_LOST_AT_TRANSFORM = {
  field: "phone",
  reportedBy: "evt_deliver",
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

describe("findLikelyCauses", () => {
  it("names the step where a renamed field lost its value", () => {
    const causes = findLikelyCauses([
      received,
      transformed,
      failure("evt_deliver", "deliver-customer-to-target", ["phone"], PHONE_LOST, REJECTED)
    ]);
    expect(causes).toEqual(new Map([["evt_deliver", [PHONE_LOST_AT_TRANSFORM]]]));
  });

  it("matches a nested path, comparing keys as pairing normalizes them", () => {
    const moved = { ...CUSTOMER, address: { ...CUSTOMER.address, postalCode: "27601-1234" } };
    const causes = findLikelyCauses([
      step("evt_transform", "transform-salesforce-account", ACCOUNT, CUSTOMER),
      step("evt_geocode", "geocode-billing-address", CUSTOMER, moved),
      failure("evt_deliver", "deliver-customer-to-target", ["address.postal_code"])
    ]);
    expect(causes.get("evt_deliver")).toEqual([
      {
        field: "address.postal_code",
        reportedBy: "evt_deliver",
        eventId: "evt_geocode",
        step: "geocode-billing-address",
        change: {
          kind: "changed",
          lost: false,
          path: "address.postalCode",
          before: "27601",
          after: "27601-1234"
        },
        alsoChangedAt: []
      }
    ]);
  });

  it("treats removing an ancestor as changing the field under it", () => {
    const { address, ...withoutAddress } = CUSTOMER;
    const causes = findLikelyCauses([
      step("evt_transform", "transform-salesforce-account", ACCOUNT, CUSTOMER),
      step("evt_strip", "strip-unverified-address", CUSTOMER, withoutAddress),
      failure("evt_deliver", "deliver-customer-to-target", ["address.postalCode"])
    ]);
    expect(causes.get("evt_deliver")).toEqual([
      {
        field: "address.postalCode",
        reportedBy: "evt_deliver",
        eventId: "evt_strip",
        step: "strip-unverified-address",
        change: { kind: "removed", lost: true, path: "address", before: address, after: undefined },
        alsoChangedAt: []
      }
    ]);
  });

  it("answers nothing when no earlier step changed the field", () => {
    const causes = findLikelyCauses([
      received,
      transformed,
      failure("evt_deliver", "deliver-customer-to-target", ["email"])
    ]);
    expect(causes).toEqual(new Map([["evt_deliver", []]]));
  });

  it("chooses the nearest step and lists the earlier ones, nearest first", () => {
    const fromCrm = { ...ACCOUNT, Phone: null };
    const enriched = { ...ACCOUNT, Phone: "+1 (919) 555-1234" };
    const causes = findLikelyCauses([
      step("evt_enrich", "enrich-from-crm", fromCrm, enriched),
      step("evt_normalize", "normalize-phone", enriched, ACCOUNT),
      transformed,
      failure("evt_deliver", "deliver-customer-to-target", ["phone"])
    ]);
    expect(causes.get("evt_deliver")).toEqual([
      {
        ...PHONE_LOST_AT_TRANSFORM,
        alsoChangedAt: [
          { eventId: "evt_normalize", step: "normalize-phone" },
          { eventId: "evt_enrich", step: "enrich-from-crm" }
        ]
      }
    ]);
  });

  it("carries the last reporting failure's fields to a dead-letter, and skips failed steps as candidates", () => {
    const causes = findLikelyCauses([
      received,
      transformed,
      failure("evt_deliver", "deliver-customer-to-target", ["phone"], PHONE_LOST, REJECTED),
      failure("evt_retry_2", "retry-customer-delivery", ["phone"], PHONE_LOST, REJECTED),
      failure("evt_retry_3", "retry-customer-delivery", ["phone"], PHONE_LOST, REJECTED),
      failure("evt_dead_letter", "move-message-to-dead-letter")
    ]);
    // Each delivery's own diff, request against 422 response, removes `phone`:
    // a failed step is where the field was refused, not where it changed.
    expect(causes).toEqual(
      new Map([
        ["evt_deliver", [PHONE_LOST_AT_TRANSFORM]],
        ["evt_retry_2", [{ ...PHONE_LOST_AT_TRANSFORM, reportedBy: "evt_retry_2" }]],
        ["evt_retry_3", [{ ...PHONE_LOST_AT_TRANSFORM, reportedBy: "evt_retry_3" }]],
        ["evt_dead_letter", [{ ...PHONE_LOST_AT_TRANSFORM, reportedBy: "evt_retry_3" }]]
      ])
    );
  });

  it("looks only before the reporter, not before the failure that inherits its fields", () => {
    // After the 422, an operator patches the phone back in and the message is
    // requeued; it still dead-letters. The patch changed `phone`, but after the
    // error that named it: the field was lost before the reporter.
    const causes = findLikelyCauses([
      received,
      transformed,
      failure("evt_deliver", "deliver-customer-to-target", ["phone"], PHONE_LOST, REJECTED),
      step("evt_patch", "patch-customer-phone", PHONE_LOST, CUSTOMER),
      failure("evt_dead_letter", "move-message-to-dead-letter")
    ]);
    expect(causes).toEqual(
      new Map([
        ["evt_deliver", [PHONE_LOST_AT_TRANSFORM]],
        ["evt_dead_letter", [PHONE_LOST_AT_TRANSFORM]]
      ])
    );
  });

  it("gives a failure before any reporting failure nothing", () => {
    const causes = findLikelyCauses([
      transformed,
      failure("evt_timeout", "deliver-customer-to-target"),
      failure("evt_deliver", "retry-customer-delivery", ["phone"])
    ]);
    expect(causes.has("evt_timeout")).toBe(false);
    expect(causes.get("evt_deliver")?.map((cause) => cause.eventId)).toEqual(["evt_transform"]);
  });

  it("matches a renamed field named by its input-side key", () => {
    // A counted rename is a by-name pair, so its input key normalizes to its
    // output key: an error that names Salesforce's `Phone` finds `phone`.
    const causes = findLikelyCauses([
      received,
      transformed,
      failure("evt_deliver", "deliver-customer-to-target", ["Phone"])
    ]);
    expect(causes.get("evt_deliver")).toEqual([{ ...PHONE_LOST_AT_TRANSFORM, field: "Phone" }]);
  });

  it("does not count a rename that kept the value", () => {
    const causes = findLikelyCauses([
      step("evt_transform", "transform-salesforce-account", ACCOUNT, CUSTOMER),
      failure("evt_deliver", "deliver-customer-to-target", ["status"])
    ]);
    expect(causes.get("evt_deliver")).toEqual([]);
  });

  it("does not count a field a step added", () => {
    const causes = findLikelyCauses([
      step("evt_contact", "attach-billing-contact", CUSTOMER, {
        ...CUSTOMER,
        billingEmail: "ap@acme.example"
      }),
      failure("evt_deliver", "deliver-customer-to-target", ["billingEmail"])
    ]);
    expect(causes.get("evt_deliver")).toEqual([]);
  });

  it("does not count a whole-payload replacement, which has no field path", () => {
    const causes = findLikelyCauses([
      step("evt_persist", "persist-customer", CUSTOMER, 4711),
      failure("evt_deliver", "deliver-customer-to-target", ["phone"])
    ]);
    expect(causes.get("evt_deliver")).toEqual([]);
  });

  it("does not let a key that normalizes to nothing match a whole-payload replacement", () => {
    const causes = findLikelyCauses([
      step("evt_persist", "persist-customer", CUSTOMER, 4711),
      failure("evt_deliver", "deliver-customer-to-target", ["__c"])
    ]);
    expect(causes.get("evt_deliver")).toEqual([]);
  });

  it("prefers the lost value when one step changed two keys that normalize alike", () => {
    // The org has both the standard `Phone` and a custom `Phone__c`. A dedupe
    // step reformats `Phone` and drops `Phone__c`: the drop is the damage.
    const withCustomPhone = { ...ACCOUNT, Phone__c: "+1 919 555 1234" };
    const deduped = { ...ACCOUNT, Phone: "+19195551234" };
    const causes = findLikelyCauses([
      step("evt_dedupe", "dedupe-phone-fields", withCustomPhone, deduped),
      failure("evt_deliver", "deliver-account-to-erp", ["phone"])
    ]);
    expect(causes.get("evt_deliver")).toEqual([
      {
        field: "phone",
        reportedBy: "evt_deliver",
        eventId: "evt_dedupe",
        step: "dedupe-phone-fields",
        change: {
          kind: "removed",
          lost: true,
          path: "Phone__c",
          before: "+1 919 555 1234",
          after: undefined
        },
        alsoChangedAt: []
      }
    ]);
  });

  it("matches a change below a compound field the error named", () => {
    // Salesforce reports the compound `Address` for a bad postal code inside it.
    const noPostalCode = { ...CUSTOMER, address: { ...CUSTOMER.address, postalCode: null } };
    const causes = findLikelyCauses([
      step("evt_transform", "transform-salesforce-account", ACCOUNT, CUSTOMER),
      step("evt_geocode", "geocode-billing-address", CUSTOMER, noPostalCode),
      failure("evt_deliver", "deliver-customer-to-target", ["Address"])
    ]);
    expect(causes.get("evt_deliver")).toEqual([
      {
        field: "Address",
        reportedBy: "evt_deliver",
        eventId: "evt_geocode",
        step: "geocode-billing-address",
        change: {
          kind: "changed",
          lost: true,
          path: "address.postalCode",
          before: "27601",
          after: null
        },
        alsoChangedAt: []
      }
    ]);
  });

  it("prefers the field itself over a change below it within one step", () => {
    // A merge folds a legacy `Address` block into `address`: it drops the block
    // and loses the postal code. Both are lost; the named field itself wins.
    const legacyAddress = { street: "PO Box 12", city: "Raleigh", state: "NC" };
    const merged = { ...CUSTOMER, address: { ...CUSTOMER.address, postalCode: null } };
    const causes = findLikelyCauses([
      step("evt_merge", "merge-legacy-address", { ...CUSTOMER, Address: legacyAddress }, merged),
      failure("evt_deliver", "deliver-customer-to-target", ["address"])
    ]);
    expect(causes.get("evt_deliver")).toEqual([
      {
        field: "address",
        reportedBy: "evt_deliver",
        eventId: "evt_merge",
        step: "merge-legacy-address",
        change: {
          kind: "removed",
          lost: true,
          path: "Address",
          before: legacyAddress,
          after: undefined
        },
        alsoChangedAt: []
      }
    ]);
  });

  it("still prefers a lost value below the field over a change to the field itself", () => {
    // The merge reshapes the legacy one-line `Address` into an object, keeping
    // its data, and loses the postal code under `address`: the loss wins.
    const reshaped = { street: "PO Box 12", city: "Raleigh", state: "NC" };
    const merged = {
      ...CUSTOMER,
      address: { ...CUSTOMER.address, postalCode: null },
      Address: reshaped
    };
    const causes = findLikelyCauses([
      step(
        "evt_merge",
        "merge-legacy-address",
        { ...CUSTOMER, Address: "PO Box 12, Raleigh NC" },
        merged
      ),
      failure("evt_deliver", "deliver-customer-to-target", ["address"])
    ]);
    expect(causes.get("evt_deliver")).toEqual([
      {
        field: "address",
        reportedBy: "evt_deliver",
        eventId: "evt_merge",
        step: "merge-legacy-address",
        change: {
          kind: "changed",
          lost: true,
          path: "address.postalCode",
          before: "27601",
          after: null
        },
        alsoChangedAt: []
      }
    ]);
  });

  it("never matches a field that normalizes to nothing, even a key that normalizes alike", () => {
    // A mapper that builds `${apiName}__c` from an empty name writes a `__c` key.
    const causes = findLikelyCauses([
      step("evt_map", "map-custom-fields", { ...ACCOUNT, __c: "Gold" }, ACCOUNT),
      failure("evt_deliver", "deliver-account-to-erp", ["__c"])
    ]);
    expect(causes.get("evt_deliver")).toEqual([]);
  });

  it("chooses a nearer step that changed only a field below over a farther exact change", () => {
    const unverified = { ...CUSTOMER, address: null };
    const noPostalCode = { ...CUSTOMER, address: { ...CUSTOMER.address, postalCode: null } };
    const causes = findLikelyCauses([
      step("evt_verify", "verify-billing-address", unverified, CUSTOMER),
      step("evt_geocode", "geocode-billing-address", CUSTOMER, noPostalCode),
      failure("evt_deliver", "deliver-customer-to-target", ["address"])
    ]);
    expect(causes.get("evt_deliver")).toEqual([
      {
        field: "address",
        reportedBy: "evt_deliver",
        eventId: "evt_geocode",
        step: "geocode-billing-address",
        change: {
          kind: "changed",
          lost: true,
          path: "address.postalCode",
          before: "27601",
          after: null
        },
        alsoChangedAt: [{ eventId: "evt_verify", step: "verify-billing-address" }]
      }
    ]);
  });

  it("matches a change inside an array element below the field, comparing indexes literally", () => {
    const unmapped = {
      ...CUSTOMER,
      lines: [{ ...CUSTOMER.lines[0], sku: null }, CUSTOMER.lines[1]]
    };
    const causes = findLikelyCauses([
      step("evt_map", "map-product-codes", CUSTOMER, unmapped),
      failure("evt_deliver", "deliver-customer-to-target", ["lines[1]", "lines"])
    ]);
    expect(causes.get("evt_deliver")).toEqual([
      {
        field: "lines",
        reportedBy: "evt_deliver",
        eventId: "evt_map",
        step: "map-product-codes",
        change: {
          kind: "changed",
          lost: true,
          path: "lines[0].sku",
          before: "SKU-100",
          after: null
        },
        alsoChangedAt: []
      }
    ]);
  });

  it("marks a cause incomplete when a nearer step's diff was cut short", () => {
    const sync: CauseEvent = {
      id: "evt_sync",
      step: "sync-opportunity-lines",
      failed: false,
      fields: undefined,
      diff: {
        changes: [{ path: "lines[0].quantity", kind: "changed", before: 2, after: 3 }],
        truncated: true
      }
    };
    const causes = findLikelyCauses([
      received,
      transformed,
      sync,
      failure("evt_deliver", "deliver-customer-to-target", ["phone"])
    ]);
    expect(causes.get("evt_deliver")).toEqual([{ ...PHONE_LOST_AT_TRANSFORM, incomplete: true }]);
  });

  it("does not mark a cause incomplete for a cut-short diff further back than it", () => {
    const early: CauseEvent = {
      id: "evt_early",
      step: "load-account-history",
      failed: false,
      fields: undefined,
      diff: { changes: [], truncated: true }
    };
    const causes = findLikelyCauses([
      early,
      transformed,
      failure("evt_deliver", "deliver-customer-to-target", ["phone"])
    ]);
    expect(causes.get("evt_deliver")).toEqual([PHONE_LOST_AT_TRANSFORM]);
  });

  it("answers one entry per field that matched, in the order the error named them", () => {
    const moved = { ...PHONE_LOST, address: { ...CUSTOMER.address, postalCode: "27601-1234" } };
    const causes = findLikelyCauses([
      transformed,
      step("evt_geocode", "geocode-billing-address", PHONE_LOST, moved),
      failure("evt_deliver", "deliver-customer-to-target", ["phone", "email", "address.postalCode"])
    ]);
    expect(causes.get("evt_deliver")).toEqual([
      PHONE_LOST_AT_TRANSFORM,
      {
        field: "address.postalCode",
        reportedBy: "evt_deliver",
        eventId: "evt_geocode",
        step: "geocode-billing-address",
        change: {
          kind: "changed",
          lost: false,
          path: "address.postalCode",
          before: "27601",
          after: "27601-1234"
        },
        alsoChangedAt: []
      }
    ]);
  });

  it("compares array indexes literally", () => {
    const repriced = {
      ...CUSTOMER,
      lines: [CUSTOMER.lines[0], { sku: "SKU-200", quantity: 1, unitPrice: null }]
    };
    const causes = findLikelyCauses([
      step("evt_price", "apply-price-book", CUSTOMER, repriced),
      failure("evt_deliver", "deliver-customer-to-target", [
        "lines[0].unitPrice",
        "lines[1].unitPrice"
      ])
    ]);
    expect(causes.get("evt_deliver")).toEqual([
      {
        field: "lines[1].unitPrice",
        reportedBy: "evt_deliver",
        eventId: "evt_price",
        step: "apply-price-book",
        change: {
          kind: "changed",
          lost: true,
          path: "lines[1].unitPrice",
          before: 120,
          after: null
        },
        alsoChangedAt: []
      }
    ]);
  });

  it("ignores fields that are not a list of non-empty strings", () => {
    const causes = findLikelyCauses([
      transformed,
      failure("evt_deliver", "deliver-customer-to-target", "phone"),
      failure("evt_retry", "retry-customer-delivery", [42, "", "phone", "phone"])
    ]);
    expect(causes.has("evt_deliver")).toBe(false);
    expect(causes.get("evt_retry")).toEqual([
      { ...PHONE_LOST_AT_TRANSFORM, reportedBy: "evt_retry" }
    ]);
  });

  it("computes nothing for a journey over the cap, and still does at the cap", () => {
    const filler = (count: number): CauseEvent[] =>
      Array.from({ length: count }, (_, index) =>
        step(`evt_poll_${String(index)}`, "poll-salesforce", ACCOUNT, ACCOUNT)
      );
    const tail = [transformed, failure("evt_deliver", "deliver-customer-to-target", ["phone"])];

    const atCap = [...filler(MAX_JOURNEY_EVENTS_FOR_CAUSES - tail.length), ...tail];
    expect(atCap).toHaveLength(1_000);
    expect(findLikelyCauses(atCap).get("evt_deliver")).toEqual([PHONE_LOST_AT_TRANSFORM]);

    const overCap = [...filler(MAX_JOURNEY_EVENTS_FOR_CAUSES - tail.length + 1), ...tail];
    expect(overCap).toHaveLength(1_001);
    expect(findLikelyCauses(overCap)).toEqual(new Map());
  });
});
