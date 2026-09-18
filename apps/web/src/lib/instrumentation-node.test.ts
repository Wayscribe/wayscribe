import { describe, expect, it, vi } from "vitest";

vi.mock("./startup", () => ({ refuseToStartMisconfigured: vi.fn() }));
vi.mock("./socket-address", () => ({ installSocketAddressCapture: vi.fn() }));

/**
 * The startup check only protects anything if the file Next runs at startup
 * calls it. That Next runs this file in the standalone image is measured on a
 * container, not here (F-030).
 */
describe("instrumentation-node", () => {
  it("checks the configuration before the server takes a request", async () => {
    const { refuseToStartMisconfigured } = await import("./startup");
    const { installSocketAddressCapture } = await import("./socket-address");
    await import("../../instrumentation-node");

    expect(refuseToStartMisconfigured).toHaveBeenCalledWith(process.env);
    expect(
      vi.mocked(refuseToStartMisconfigured).mock.invocationCallOrder[0] ?? Infinity
    ).toBeLessThan(vi.mocked(installSocketAddressCapture).mock.invocationCallOrder[0] ?? 0);
  });
});
