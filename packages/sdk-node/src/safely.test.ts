import { describe, expect, it, vi } from "vitest";
import { createDiagnostics } from "./diagnostics.js";
import { safely, safelyAsync } from "./safely.js";

describe("safely", () => {
  it("returns the value when nothing throws", () => {
    expect(safely(createDiagnostics(), "capture_error", () => 42)).toBe(42);
  });

  it("swallows a thrown error and returns undefined", () => {
    const diagnostics = createDiagnostics();
    const result = safely(diagnostics, "capture_error", (): number => {
      throw new Error("boom");
    });
    expect(result).toBeUndefined();
    expect(diagnostics.counters().captureErrors).toBe(1);
  });

  it("swallows a thrown non-Error", () => {
    const diagnostics = createDiagnostics();
    const result = safely(diagnostics, "capture_error", (): number => {
      // Deliberately not an Error: application code throws strings, and the
      // boundary must survive that too.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "a string";
    });
    expect(result).toBeUndefined();
    expect(diagnostics.counters().captureErrors).toBe(1);
  });

  it("reports the reason", () => {
    const onDiagnostic = vi.fn();
    safely(createDiagnostics(onDiagnostic), "capture_error", () => {
      throw new Error("specific message");
    });
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "capture_error", reason: "specific message" })
    );
  });
});

describe("safelyAsync", () => {
  it("returns the resolved value", async () => {
    await expect(
      safelyAsync(createDiagnostics(), "transport_error", () => Promise.resolve(7))
    ).resolves.toBe(7);
  });

  it("swallows a rejection", async () => {
    // Why this exists: `safely` returns the promise before it rejects, so its
    // try/catch never sees the failure.
    const diagnostics = createDiagnostics();
    await expect(
      safelyAsync(diagnostics, "transport_error", () => Promise.reject(new Error("boom")))
    ).resolves.toBeUndefined();
    expect(diagnostics.counters().transportErrors).toBe(1);
  });

  it("swallows a synchronous throw inside an async callback", async () => {
    const diagnostics = createDiagnostics();
    await expect(
      safelyAsync(diagnostics, "transport_error", () => {
        throw new Error("sync throw");
      })
    ).resolves.toBeUndefined();
    expect(diagnostics.counters().transportErrors).toBe(1);
  });
});
