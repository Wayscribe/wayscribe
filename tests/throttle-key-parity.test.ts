import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { throttleKey as apiThrottleKey } from "../apps/api/src/address-throttle.js";
import { throttleKey as webThrottleKey } from "../apps/web/src/lib/client-address.js";

const root = fileURLToPath(new URL("../", import.meta.url));

/**
 * One address, one key, in both throttles.
 *
 * The API and the web app each key their authentication throttle with
 * `throttleKey`. The web app depends on no workspace package and the function
 * fits none of them, so it exists twice; this test holds the copies to one
 * behaviour and one text. A spelling that keyed differently in one would be a
 * spelling that bought a fresh budget of guesses there.
 */
const VECTORS: [input: string, key: string][] = [
  // IPv4, with and without a port.
  ["203.0.113.7", "203.0.113.7"],
  ["203.0.113.7:5555", "203.0.113.7"],
  // IPv4-mapped IPv6, in every spelling, is the IPv4 address.
  ["::ffff:203.0.113.7", "203.0.113.7"],
  ["::FFFF:203.0.113.7", "203.0.113.7"],
  ["0:0:0:0:0:ffff:203.0.113.7", "203.0.113.7"],
  ["0000:0000:0000:0000:0000:ffff:cb00:7107", "203.0.113.7"],
  ["::ffff:cb00:7107", "203.0.113.7"],
  ["[::ffff:203.0.113.7]:8080", "203.0.113.7"],
  // IPv4-compatible, written with a dotted quad, is the IPv4 address too.
  ["::203.0.113.7", "203.0.113.7"],
  ["0:0:0:0:0:0:203.0.113.7", "203.0.113.7"],
  // IPv6 by its /64, whatever the spelling, brackets, port or zone.
  ["2001:db8:1:2::1", "2001:db8:1:2::/64"],
  ["2001:DB8:1:2::abcd", "2001:db8:1:2::/64"],
  ["2001:0db8:0001:0002:0000:0000:0000:0009", "2001:db8:1:2::/64"],
  ["2001:db8:1:2:ffff:ffff:ffff:ffff", "2001:db8:1:2::/64"],
  ["[2001:db8:1:2::1]", "2001:db8:1:2::/64"],
  ["[2001:db8:1:2::1]:443", "2001:db8:1:2::/64"],
  ["2001:db8:1:2::1%eth0", "2001:db8:1:2::/64"],
  ["[fe80::1%en0]:22", "fe80:0:0:0::/64"],
  ["2001:db8::", "2001:db8:0:0::/64"],
  ["1::", "1:0:0:0::/64"],
  ["1:2:3:4:5:6:1.2.3.4", "1:2:3:4::/64"],
  ["64:ff9b::203.0.113.7", "64:ff9b:0:0::/64"],
  // The loopback and unspecified addresses are IPv6, not IPv4-compatible.
  ["::1", "0:0:0:0::/64"],
  ["::", "0:0:0:0::/64"],
  ["::ffff:0:203.0.113.7", "0:0:0:0::/64"],
  // Anything that is not an address is kept as it is.
  ["unknown", "unknown"],
  ["2001:db8:1:2:3:4:5:6:7", "2001:db8:1:2:3:4:5:6:7"],
  ["[not-an-address]:80", "[not-an-address]:80"],
  ["", ""]
];

describe("throttleKey", () => {
  for (const [input, key] of VECTORS) {
    it(`keys ${JSON.stringify(input)} as ${JSON.stringify(key)} in the API and the web app`, () => {
      expect(apiThrottleKey(input)).toBe(key);
      expect(webThrottleKey(input)).toBe(key);
    });
  }

  it("is the same text in both copies", () => {
    const block = (relative: string): string => {
      const text = readFileSync(`${root}${relative}`, "utf8");
      const found = /\/\/ throttleKey: begin\n([\s\S]*?)\/\/ throttleKey: end\n/.exec(text);
      expect(found, `${relative} has no marked throttleKey block`).not.toBeNull();
      return found?.[1] ?? "";
    };
    expect(block("apps/web/src/lib/client-address.ts")).toBe(
      block("apps/api/src/address-throttle.ts")
    );
  });
});
