import { describe, expect, it } from "vitest";
import type { DiffChange } from "./api";
import { normalizeKey, pairChanges, type PairedChange } from "./diff-pairing";

const removed = (path: string, before: unknown): DiffChange => ({ path, kind: "removed", before });
const added = (path: string, after: unknown): DiffChange => ({ path, kind: "added", after });
const changed = (path: string, before: unknown, after: unknown): DiffChange => ({
  path,
  kind: "changed",
  before,
  after
});

/** `from → path kind[ lost]`, one string per row, so an ordering reads at a glance. */
const summary = (rows: PairedChange[]): string[] =>
  rows.map(
    (row) =>
      `${row.from === null ? "" : `${row.from} → `}${row.path} ${row.kind}${row.lost ? " lost" : ""}`
  );

describe("normalizeKey", () => {
  it.each([
    ["Phone", "phone"],
    ["PHONE", "phone"],
    ["Status__c", "status"],
    ["Status__C", "status"],
    ["first_name", "firstname"],
    ["first-name", "firstname"],
    ["First_Name__c", "firstname"],
    // Only a trailing suffix is Salesforce's; one inside the key is kept.
    ["a__cb", "acb"]
  ])("normalizes %s to %s", (key, expected) => {
    expect(normalizeKey(key)).toBe(expected);
  });
});

describe("pairChanges", () => {
  it("turns the demo transform into one lost row, one altered rename and two quiet renames, in that order", () => {
    const rows = pairChanges([
      removed("Id", "0018Z00005PIN01"),
      removed("Name", "Dana Whitfield"),
      removed("Phone", "+1 555 0100"),
      removed("Status__c", "Active"),
      added("externalId", "0018Z00005PIN01"),
      added("name", "Dana Whitfield"),
      added("phone", null),
      added("status", "active")
    ]);
    expect(rows).toEqual([
      {
        path: "phone",
        from: "Phone",
        kind: "renamed-changed",
        before: "+1 555 0100",
        after: null,
        lost: true
      },
      {
        path: "status",
        from: "Status__c",
        kind: "renamed-changed",
        before: "Active",
        after: "active",
        lost: false
      },
      {
        path: "externalId",
        from: "Id",
        kind: "renamed",
        before: "0018Z00005PIN01",
        after: "0018Z00005PIN01",
        lost: false
      },
      {
        path: "name",
        from: "Name",
        kind: "renamed",
        before: "Dana Whitfield",
        after: "Dana Whitfield",
        lost: false
      }
    ]);
  });

  it.each([
    ["case only", "Phone", "phone"],
    ["upper to lower", "EMAIL", "email"],
    ["Salesforce __c suffix", "Region__c", "region"],
    ["snake to camel", "first_name", "firstName"],
    ["kebab to camel", "first-name", "firstName"],
    ["suffix and snake together", "Account_Tier__c", "accountTier"]
  ])("pairs a rename by name: %s", (_, from, to) => {
    expect(summary(pairChanges([removed(from, 1), added(to, 1)]))).toEqual([
      `${from} → ${to} renamed`
    ]);
    expect(summary(pairChanges([removed(from, 1), added(to, 2)]))).toEqual([
      `${from} → ${to} renamed-changed`
    ]);
  });

  it("pairs a rename by value when the names have nothing in common", () => {
    expect(summary(pairChanges([removed("Id", "x1"), added("externalId", "x1")]))).toEqual([
      "Id → externalId renamed"
    ]);
  });

  it("pairs by value with object values compared deeply", () => {
    expect(
      summary(pairChanges([removed("addr", { city: "Ames" }), added("location", { city: "Ames" })]))
    ).toEqual(["addr → location renamed"]);
  });

  it("does not pair by value when two removed fields share the value", () => {
    expect(
      summary(pairChanges([removed("a", "same"), removed("b", "same"), added("c", "same")]))
    ).toEqual(["a removed lost", "b removed lost", "c added"]);
  });

  it("does not pair by value when two added fields share the value", () => {
    expect(
      summary(pairChanges([removed("a", "same"), added("b", "same"), added("c", "same")]))
    ).toEqual(["a removed lost", "b added", "c added"]);
  });

  it("does not pair by name when two removed fields normalize to the same key", () => {
    expect(
      summary(pairChanges([removed("Phone", 1), removed("PHONE", 2), added("phone", 3)]))
    ).toEqual(["Phone removed lost", "PHONE removed lost", "phone added"]);
  });

  it("prefers a name match over a value match", () => {
    // `Code` and `code` match by name; the value match `Code` → `ref` is never tried.
    expect(
      summary(pairChanges([removed("Code", "A"), added("ref", "A"), added("code", "B")]))
    ).toEqual(["Code → code renamed-changed", "ref added"]);
  });

  it("pairs within the same parent object", () => {
    expect(
      summary(pairChanges([removed("customer.Phone", "1"), added("customer.phone", "1")]))
    ).toEqual(["customer.Phone → customer.phone renamed"]);
    expect(summary(pairChanges([removed("a[0].Id", "k"), added("a[0].key", "k")]))).toEqual([
      "a[0].Id → a[0].key renamed"
    ]);
  });

  it("never pairs across parents, by name or by value", () => {
    expect(
      summary(pairChanges([removed("customer.Phone", "1"), added("contact.phone", "1")]))
    ).toEqual(["customer.Phone removed lost", "contact.phone added"]);
    expect(summary(pairChanges([removed("Phone", "1"), added("customer.phone", "1")]))).toEqual([
      "Phone removed lost",
      "customer.phone added"
    ]);
    expect(summary(pairChanges([removed("a[0].Id", "k"), added("a[1].Id", "k")]))).toEqual([
      "a[0].Id removed lost",
      "a[1].Id added"
    ]);
  });

  it("never pairs array elements, which are compared by index", () => {
    expect(summary(pairChanges([removed("tags[2]", "x"), added("tags[3]", "x")]))).toEqual([
      "tags[2] removed lost",
      "tags[3] added"
    ]);
    expect(summary(pairChanges([removed("tags[0]", "x"), added("labels[0]", "x")]))).toEqual([
      "tags[0] removed lost",
      "labels[0] added"
    ]);
  });

  it("marks a renamed field whose value went to null as lost", () => {
    expect(summary(pairChanges([removed("Phone", "+1"), added("phone", null)]))).toEqual([
      "Phone → phone renamed-changed lost"
    ]);
  });

  it("marks a changed field whose value went to null as lost", () => {
    expect(summary(pairChanges([changed("phone", "+1", null)]))).toEqual(["phone changed lost"]);
  });

  it("does not call a null that stayed gone, or a value that arrived, lost", () => {
    expect(
      summary(
        pairChanges([
          removed("a", null),
          changed("b", null, 1),
          added("c", null),
          changed("d", 1, 2),
          removed("Phone", null),
          added("phone", null)
        ])
      )
    ).toEqual(["b changed", "d changed", "a removed", "c added", "Phone → phone renamed"]);
  });

  // Decision: a field the input had with a value and the output does not have
  // at all is a lost value, whatever the reason. A rename the pairing could
  // not see reads as a lost field and an added one; that is the honest reading.
  it("labels a plain removed field with a value as lost, since its value is gone from the output", () => {
    expect(pairChanges([removed("Phone", "+1")])).toEqual([
      { path: "Phone", from: null, kind: "removed", before: "+1", after: undefined, lost: true }
    ]);
  });

  it("orders lost, then changed, then added and removed, then renamed, keeping order within each", () => {
    expect(
      summary(
        pairChanges([
          removed("Id", "k"),
          added("key", "k"),
          added("n1", "fresh"),
          changed("c1", 1, 2),
          removed("gone", 1),
          removed("r1", null),
          changed("c2", 1, null),
          removed("Code", "a"),
          added("code", "b"),
          changed("c3", 3, 4),
          removed("Name", "n"),
          added("name", "n")
        ])
      )
    ).toEqual([
      "gone removed lost",
      "c2 changed lost",
      "c1 changed",
      "Code → code renamed-changed",
      "c3 changed",
      "n1 added",
      "r1 removed",
      "Id → key renamed",
      "Name → name renamed"
    ]);
  });

  it("leaves a diff with nothing to pair as it was", () => {
    const input = [changed("a", 1, 2), changed("b", "x", "y")];
    expect(summary(pairChanges(input))).toEqual(["a changed", "b changed"]);
  });
});
