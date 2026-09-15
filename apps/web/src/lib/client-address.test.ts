import { request as httpRequest, createServer } from "node:http";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { clientAddress } from "./client-address";
import { currentSocketAddress, installSocketAddressCapture } from "./socket-address";

describe("clientAddress", () => {
  it("is the socket's address when no proxy is trusted, whatever the header says", () => {
    expect(clientAddress("203.0.113.1", "198.51.100.9", 0)).toBe("203.0.113.1");
    expect(clientAddress("203.0.113.1", null, 0)).toBe("203.0.113.1");
  });

  it("is one shared bucket when the socket address is unknown", () => {
    // Never the header: with no socket to key on, a spoofable value would be
    // worse than one bucket for everyone.
    expect(clientAddress(undefined, "198.51.100.9", 0)).toBe("unknown");
  });

  it("takes the entry that many hops from the right", () => {
    expect(clientAddress("10.0.0.5", "spoofed, 198.51.100.7", 1)).toBe("198.51.100.7");
    expect(clientAddress("10.0.0.6", "spoofed, 198.51.100.7, 10.0.0.5", 2)).toBe("198.51.100.7");
  });

  it("falls back to the socket when the header is shorter than the count", () => {
    expect(clientAddress("10.0.0.5", "198.51.100.7", 2)).toBe("10.0.0.5");
    expect(clientAddress("10.0.0.5", null, 1)).toBe("10.0.0.5");
  });
});

describe("socket address capture", () => {
  it("makes the socket's address readable inside the request's handling", async () => {
    installSocketAddressCapture(http);
    // Installing twice must not wrap twice.
    installSocketAddressCapture(http);

    const seen: (string | undefined)[] = [];
    const server = createServer((_request, response) => {
      // Read after an await, as a route handler would be, deep in Next.
      void Promise.resolve().then(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        seen.push(currentSocketAddress());
        response.end("ok");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    await new Promise<void>((resolve, reject) => {
      const outgoing = httpRequest(
        { host: "127.0.0.1", port, path: "/", headers: { "x-forwarded-for": "198.51.100.9" } },
        (response) => {
          response.resume();
          response.on("end", resolve);
        }
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
    await new Promise((resolve) => server.close(resolve));

    expect(seen).toEqual(["127.0.0.1"]);
    expect(currentSocketAddress()).toBeUndefined();
  });
});
