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

  // F-051: a hand-built web image with no build arguments showed the
  // different-builds line on every page, even beside its own API.
  it("does not claim different builds when the web app carries no build identity", async () => {
    await footer(release("local-3cd2c20", "3cd2c2034c6d3607"), {});
    expect(screen.queryByText(/different builds/)).toBeNull();
    const note = screen.getByText(
      "The web image was built without WAYSCRIBE_BUILD_VERSION, so this page cannot tell whether the web app and the API are the same build."
    );
    expect(note.className).not.toContain("error");
  });

  it("says the same of an API that carries no build identity", async () => {
    await footer({ version: "0.0.0", source: "package" });
    expect(screen.queryByText(/different builds/)).toBeNull();
    expect(
      screen.getByText(
        "The API image was built without WAYSCRIBE_BUILD_VERSION, so this page cannot tell whether the web app and the API are the same build."
      )
    ).toBeTruthy();
  });

  it("says nothing about builds when they match", async () => {
    await footer(release("v0.1.0", "27f4d64e0b5a63f0"));
    expect(screen.queryByText(/different builds/)).toBeNull();
    expect(screen.queryByText(/cannot tell/)).toBeNull();
  });
});
