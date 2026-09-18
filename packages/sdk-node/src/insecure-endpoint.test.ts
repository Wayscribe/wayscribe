import { afterEach, describe, expect, it, vi } from "vitest";
import type { Diagnostic } from "./diagnostics.js";
import { createRecorder } from "./recorder.js";

const base = {
  apiKey: "wsk_test",
  serviceName: "svc",
  environment: "development"
};

async function diagnosticsFor(
  endpoint: string,
  extra: { logDiagnostics?: boolean } = {}
): Promise<Diagnostic[]> {
  const seen: Diagnostic[] = [];
  const recorder = createRecorder({
    ...base,
    endpoint,
    ...extra,
    onDiagnostic: (d) => seen.push(d)
  });
  await recorder.shutdown({ timeoutMs: 50 });
  return seen;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an endpoint that sends the API key in cleartext", () => {
  it("is reported once, at creation, for http to another host", async () => {
    const seen = await diagnosticsFor("http://ingest.example.com:8080");
    expect(seen.filter((d) => d.kind === "insecure_endpoint")).toEqual([
      {
        kind: "insecure_endpoint",
        code: "unencrypted_endpoint",
        reason:
          "The endpoint is http: to ingest.example.com, so the API key and payloads travel unencrypted. Use https: for any endpoint off this machine.",
        detail: { scheme: "http:", host: "ingest.example.com" }
      }
    ]);
  });

  it.each([
    // A private network is still a network: anything on it can read the key.
    "http://10.0.0.5:8080",
    "http://api.example.com",
    "http://ingest.internal:8080",
    // The URL parser reads a bare number as an IPv4 address, so this is
    // 10.0.0.5 and not a single-label name.
    "http://167772165",
    "http://[fd00::5]:8080"
  ])("is reported for %s", async (endpoint) => {
    const seen = await diagnosticsFor(endpoint);
    expect(seen.some((d) => d.kind === "insecure_endpoint")).toBe(true);
  });

  it.each(["http://api:8080", "http://wayscribe-api:8080", "http://API:8080"])(
    "is not reported for the single-label name in %s",
    async (endpoint) => {
      // A name with no dot resolves only through container or cluster DNS on
      // a private network, which is how the demo reaches the API. Warning
      // there made the first thing a new user runs look broken.
      const seen = await diagnosticsFor(endpoint);
      expect(seen.some((d) => d.kind === "insecure_endpoint")).toBe(false);
    }
  );

  it("names only the scheme and host, never credentials in the URL", async () => {
    // Assembled, so a secret scanner reading this file does not see a URL with
    // a password in it.
    const userinfo = ["svc", "hunter2"].join(":");
    const seen = await diagnosticsFor(`http://${userinfo}@ingest.example.com/path?token=abc`);
    const [diagnostic] = seen.filter((d) => d.kind === "insecure_endpoint");
    expect(diagnostic).toMatchObject({ detail: { scheme: "http:", host: "ingest.example.com" } });
    const text = JSON.stringify(diagnostic);
    for (const secret of ["svc:", "hunter2", "path", "token", "abc"]) {
      expect(text).not.toContain(secret);
    }
  });

  it.each([
    "https://ingest.example.com",
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "http://[::1]:8080",
    "http://api.localhost:8080",
    "http://LOCALHOST:8080"
  ])("is not reported for %s", async (endpoint) => {
    const seen = await diagnosticsFor(endpoint);
    expect(seen.some((d) => d.kind === "insecure_endpoint")).toBe(false);
  });

  it("prints under logDiagnostics", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    await diagnosticsFor("http://ingest.example.com", { logDiagnostics: true });
    vi.restoreAllMocks();
    expect(lines[0]).toBe(
      "[wayscribe] insecure_endpoint: The endpoint is http: to ingest.example.com, so the API key and payloads travel unencrypted. Use https: for any endpoint off this machine."
    );
  });

  it("never throws, even for an endpoint that is not a URL", async () => {
    // ADR-007: a warning about configuration must not become a failure to
    // start. The unusable endpoint shows up as transport errors instead.
    const seen = await diagnosticsFor("not a url");
    expect(seen.some((d) => d.kind === "insecure_endpoint")).toBe(false);
  });

  it("changes no counter", async () => {
    const recorder = createRecorder({ ...base, endpoint: "http://ingest.example.com" });
    expect(recorder.counters()).toEqual({
      recorded: 0,
      dropped: 0,
      rejected: 0,
      transportErrors: 0,
      captureErrors: 0,
      breakerOpened: 0,
      payloadsOmitted: 0,
      payloadsTruncated: 0,
      keysDropped: 0,
      configurationErrors: 0,
      rejectedSettings: [],
      rejectedOptions: [],
      unredactedSecretNames: 0,
      personalDataInPublicValues: 0,
      sent: 0
    });
    await recorder.shutdown({ timeoutMs: 50 });
  });
});
