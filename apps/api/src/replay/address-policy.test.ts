import { describe, expect, it } from "vitest";
import { checkAddress } from "./address-policy.js";

describe("checkAddress", () => {
  it.each([
    ["the cloud metadata endpoint", "169.254.169.254"],
    ["anything in 169.254.0.0/16", "169.254.1.1"],
    ["its IPv4-mapped IPv6 form", "::ffff:169.254.169.254"],
    ["the unspecified address", "0.0.0.0"],
    ["IPv6 unspecified", "::"],
    ["IPv4 multicast", "239.1.2.3"],
    ["IPv6 multicast", "ff02::1"],
    ["IPv6 link-local", "fe80::1"]
  ])("refuses %s", (_label, address) => {
    expect(checkAddress(address).allowed).toBe(false);
  });

  it("says why the metadata range is refused", () => {
    // The reason is stored on the blocked run and read by whoever is confused
    // about why their replay did not go out.
    expect(checkAddress("169.254.169.254").reason).toContain("metadata");
  });

  it.each([
    ["loopback", "127.0.0.1"],
    ["IPv6 loopback", "::1"],
    ["a Docker bridge address", "172.24.0.7"],
    ["a private LAN address", "192.168.1.10"],
    ["a 10/8 address", "10.0.0.5"],
    ["a public address", "93.184.216.34"]
  ])("allows %s", (_label, address) => {
    // Private ranges are allowed on purpose (ADR-033): localhost,
    // host.docker.internal, and Compose service names all resolve into them,
    // and blocking them would leave replay unable to reach anything it is for.
    expect(checkAddress(address).allowed).toBe(true);
  });

  it("refuses something that is not an address at all", () => {
    expect(checkAddress("not-an-address").allowed).toBe(false);
  });
});
