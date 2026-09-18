import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RunningVersion } from "../../src/lib/version";
import { VersionFooter } from "./VersionFooter";

const release = (version: string, commit: string): RunningVersion => ({
  version,
  commit,
  source: "build"
});

const footer = async (
  api: RunningVersion | null,
  env: Record<string, string | undefined> = {
    WAYSCRIBE_BUILD_VERSION: "v0.1.0",
    WAYSCRIBE_BUILD_COMMIT: "27f4d64e0b5a63f0"
  }
): Promise<void> => {
  render(await VersionFooter({ env, readApi: () => Promise.resolve(api) }));
};

/** F-045: the web app says what it is running, and what the API is running. */
describe("VersionFooter", () => {
  it("names the web app's version and the API's", async () => {
    await footer(release("v0.1.0", "27f4d64e0b5a63f0"));
    const line = screen.getByRole("contentinfo");
    expect(line.textContent).toBe(
      "Web v0.1.0, commit 27f4d64e0b5a · API v0.1.0, commit 27f4d64e0b5a"
    );
  });

  it("still renders, and says the API version is unknown, when /ready did not answer", async () => {
    await footer(null);
    expect(screen.getByRole("contentinfo").textContent).toBe(
      "Web v0.1.0, commit 27f4d64e0b5a · API version unknown"
    );
  });

  it("says so when the two are different builds", async () => {
    await footer(release("v0.2.0", "99999999aaaa"));
    expect(screen.getByText("The web app and the API are different builds.")).toBeTruthy();
  });

  it("says nothing about builds when they match", async () => {
    await footer(release("v0.1.0", "27f4d64e0b5a63f0"));
    expect(screen.queryByText(/different builds/)).toBeNull();
  });
});
