import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  diffPayloads,
  normalizeKey as apiNormalizeKey,
  pairChanges as apiPairChanges,
  type Change
} from "../packages/payload-diff/src/index.js";
import {
  normalizeKey as webNormalizeKey,
  pairChanges as webPairChanges
} from "../apps/web/src/lib/diff-pairing.js";
import { normalizeKey as cliNormalizeKey } from "../packages/cli/src/cause-paths.js";

const root = fileURLToPath(new URL("../", import.meta.url));

/**
 * One pairing, in the diff table and in the likely cause (ADR-072).
 *
 * The API finds a failure's likely cause with `pairChanges` from
 * `@wayscribe/payload-diff`, and the web app pairs the diff it displays with
 * its own copy, because it depends on no workspace package: a workspace
 * package in the web image has broken it before. So the code exists twice, and
 * this test holds the copies to one behaviour and one text. A rename paired in
 * one and not the other would show a reader a diff that disagrees with the
 * likely cause printed above it.
 */
const ACCOUNT = {
  Id: "0018Z00002ABC",
  Name: "Acme Field Services",
  Phone: "+1 919 555 1234",
  Status__c: "Former Customer",
  BillingAddress: { city: "Raleigh", postalCode: "27601" },
  Opportunity_Lines__c: [{ Product_Code__c: "SKU-100", Unit_Price__c: 49.5 }]
};
const CUSTOMER = {
  externalId: "0018Z00002ABC",
  name: "Acme Field Services",
  phone: null,
  status: "former customer",
  address: { city: "Raleigh", postalCode: "27601" },
  lines: [{ sku: "SKU-100", unitPrice: 49.5 }]
};

const VECTORS: [name: string, changes: Change[]][] = [
  ["a Salesforce account mapped to a customer", diffPayloads(ACCOUNT, CUSTOMER).changes],
  [
    "two removed keys that normalize alike, left unpaired",
    [
      { path: "Phone", kind: "removed", before: "+1 919 555 1234" },
      { path: "Phone__c", kind: "removed", before: "+1 919 555 1234" },
      { path: "phone", kind: "added", after: "+1 919 555 1234" }
    ]
  ],
  [
    "keys paired only within their parent",
    [
      { path: "BillingAddress.PostalCode", kind: "removed", before: "27601" },
      { path: "address.postalCode", kind: "added", after: "27601" }
    ]
  ],
  [
    "array elements, which never pair",
    [
      { path: "lines[2]", kind: "removed", before: "SKU-300" },
      { path: "lines[3]", kind: "added", after: "SKU-300" }
    ]
  ],
  ["no changes at all", []]
];

describe("pairChanges", () => {
  for (const [name, changes] of VECTORS) {
    it(`pairs ${name} the same in the API and the web app`, () => {
      expect(webPairChanges(changes)).toEqual(apiPairChanges(changes));
    });
  }

  it.each(["Phone", "PHONE", "Status__c", "First_Name__c", "x-request-id", "my__cfield"])(
    "normalizes %s the same in the API, the web app and the CLI",
    (key) => {
      expect(webNormalizeKey(key)).toBe(apiNormalizeKey(key));
      expect(cliNormalizeKey(key)).toBe(apiNormalizeKey(key));
    }
  );

  it("is the same text in both copies", () => {
    const block = (relative: string): string => {
      const text = readFileSync(`${root}${relative}`, "utf8");
      const found = /\/\/ pairChanges: begin\n([\s\S]*?)\/\/ pairChanges: end\n/.exec(text);
      expect(found, `${relative} has no marked pairChanges block`).not.toBeNull();
      return found?.[1] ?? "";
    };
    expect(block("apps/web/src/lib/diff-pairing.ts")).toBe(
      block("packages/payload-diff/src/pairing.ts")
    );
  });
});

/**
 * The likely-cause line names the changed path when it lies below the
 * reported field (ADR-072). The web app and the CLI decide that with their own
 * copies of one test, since the CLI is published and depends on neither; a
 * difference would make `wayscribe journey` and the page read differently.
 * Only the text is compared: the web module's extensionless imports keep it
 * out of the root typecheck, and one text over one `normalizeKey` (above) is
 * one behaviour.
 */
describe("isBelow", () => {
  it("is the same text in both copies", () => {
    const block = (relative: string): string => {
      const text = readFileSync(`${root}${relative}`, "utf8");
      const found = /\/\/ isBelow: begin\n([\s\S]*?)\/\/ isBelow: end\n/.exec(text);
      expect(found, `${relative} has no marked isBelow block`).not.toBeNull();
      return found?.[1] ?? "";
    };
    expect(block("packages/cli/src/cause-paths.ts")).toBe(
      block("apps/web/src/lib/likely-cause-display.ts")
    );
  });
});
