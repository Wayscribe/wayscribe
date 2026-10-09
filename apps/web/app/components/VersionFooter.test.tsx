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

  it("shows the full line, not the short one, with the demo off", async () => {
    await footer(release("v0.1.0", "27f4d64e0b5a63f0"), {
      WAYSCRIBE_BUILD_VERSION: "v0.1.0",
      WAYSCRIBE_BUILD_COMMIT: "27f4d64e0b5a63f0",
      WEB_ANONYMOUS_READ_ONLY: "false"
    });
    expect(screen.getByRole("contentinfo").querySelector("details")).toBeNull();
    expect(screen.queryByText(/^Wayscribe /)).toBeNull();
  });

  it("says nothing about builds when they match", async () => {
    await footer(release("v0.1.0", "27f4d64e0b5a63f0"));
    expect(screen.queryByText(/different builds/)).toBeNull();
    expect(screen.queryByText(/cannot tell/)).toBeNull();
  });
});

/** The public demo (ADR-069): the product and its version, the detail one click away. */
describe("VersionFooter in the demo", () => {
  const FULL = "Web 0.2.3, commit b12397b656af · API 0.2.3, commit b12397b656af";
  const demoEnv = {
    WAYSCRIBE_BUILD_VERSION: "0.2.3",
    WAYSCRIBE_BUILD_COMMIT: "b12397b656af0000",
    WEB_ANONYMOUS_READ_ONLY: "true"
  };

  it("shows only the web version, with the full line in a closed disclosure and a title", async () => {
    await footer(release("0.2.3", "b12397b656af0000"), demoEnv);
    const summary = screen.getByText("Wayscribe 0.2.3");
    expect(summary.tagName).toBe("SUMMARY");
    expect(summary.getAttribute("title")).toBe(FULL);
    const details = screen.getByRole("contentinfo").querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.querySelector("p")?.textContent).toBe(FULL);
  });

  it("follows the demo prop over the environment", async () => {
    render(
      await VersionFooter({
        env: { WAYSCRIBE_BUILD_VERSION: "0.2.3", WAYSCRIBE_BUILD_COMMIT: "b12397b656af0000" },
        readApi: () => Promise.resolve(release("0.2.3", "b12397b656af0000")),
        demo: true
      })
    );
    expect(screen.getByText("Wayscribe 0.2.3").tagName).toBe("SUMMARY");
  });

  it("keeps a mismatch note inside the detail", async () => {
    await footer(release("0.2.4", "ffffffffffff0000"), demoEnv);
    const note = screen.getByText("The web app and the API are different builds.");
    expect(note.closest("details")).not.toBeNull();
  });
});
