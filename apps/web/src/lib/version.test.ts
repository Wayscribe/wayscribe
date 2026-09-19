import { describe, expect, it, vi } from "vitest";
import {
  cachedFor,
  describeVersions,
  parseReady,
  readApiVersion,
  resolveWebVersion,
  type RunningVersion
} from "./version";

describe("resolveWebVersion", () => {
  it("reports the build arguments the published image baked in", () => {
    expect(
      resolveWebVersion({
        WAYSCRIBE_BUILD_VERSION: "v0.1.0",
        WAYSCRIBE_BUILD_COMMIT: "27f4d64e0b5a63f0d0b3e2a1c4d5e6f708192a3b"
      })
    ).toEqual({
      version: "v0.1.0",
      commit: "27f4d64e0b5a63f0d0b3e2a1c4d5e6f708192a3b",
      source: "build"
    });
  });

  // An ARG with no value bakes an empty string, as in the API image.
  it("falls back to the package version, and says so, when nothing was baked in", () => {
    for (const env of [{}, { WAYSCRIBE_BUILD_VERSION: "", WAYSCRIBE_BUILD_COMMIT: "" }]) {
      expect(resolveWebVersion(env)).toEqual({ version: "0.0.0", source: "package" });
    }
  });

  it("leaves out a commit the build did not record", () => {
    expect(resolveWebVersion({ WAYSCRIBE_BUILD_VERSION: "v0.1.0" })).toEqual({
      version: "v0.1.0",
      source: "build"
    });
  });
});

describe("parseReady", () => {
  it("reads version, commit and source from a /ready body", () => {
    expect(
      parseReady({ status: "ready", version: "v0.1.0", commit: "abc1234", source: "build" })
    ).toEqual({ version: "v0.1.0", commit: "abc1234", source: "build" });
  });

  // The 503 answers carry the three fields too (docs/API_SPEC.md section 14).
  it("reads them from a not-ready body as well", () => {
    expect(
      parseReady({ status: "not_ready", reason: "database", version: "0.0.0", source: "package" })
    ).toEqual({ version: "0.0.0", source: "package" });
  });

  it("is null for a body that does not say what is running", () => {
    for (const body of [
      null,
      "ready",
      { status: "ready" },
      { version: 1, source: "build" },
      { version: "v1", source: "something else" },
      { version: "", source: "build" }
    ]) {
      expect(parseReady(body), JSON.stringify(body)).toBeNull();
    }
  });

  // The answer is shown on every page. Whatever answers at API_URL, it cannot
  // put a paragraph there.
  it("refuses a version or commit longer than a version or a commit", () => {
    expect(parseReady({ version: "v".repeat(200), source: "build" })).toBeNull();
    expect(parseReady({ version: "v1", commit: "c".repeat(200), source: "build" })).toEqual({
      version: "v1",
      source: "build"
    });
  });
});

describe("readApiVersion", () => {
  it("asks /ready at API_URL, without the admin token", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(Response.json({ status: "ready", version: "v0.1.0", source: "build" }))
    );
    expect(await readApiVersion("http://api:8080", fetcher)).toEqual({
      version: "v0.1.0",
      source: "build"
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api:8080/ready");
    expect(new Headers(init.headers).has("authorization")).toBe(false);
  });

  it("reads a 503 answer's version", async () => {
    const fetcher = (): Promise<Response> =>
      Promise.resolve(
        Response.json(
          { status: "not_ready", reason: "db", version: "v0.1.0", source: "build" },
          { status: 503 }
        )
      );
    expect(await readApiVersion("http://api:8080", fetcher)).toEqual({
      version: "v0.1.0",
      source: "build"
    });
  });

  it("is null, not a throw, when the API is unreachable or answers something else", async () => {
    const unreachable = (): Promise<Response> => Promise.reject(new TypeError("fetch failed"));
    const html = (): Promise<Response> => Promise.resolve(new Response("<html>", { status: 502 }));
    expect(await readApiVersion("http://api:8080", unreachable)).toBeNull();
    expect(await readApiVersion("http://api:8080", html)).toBeNull();
  });

  // No clock is read: a read that ignored its timeout would never resolve, and
  // the test would fail on vitest's own timeout rather than on a busy machine.
  it("gives up after its timeout rather than holding the page", async () => {
    const hangs = (_url: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    expect(await readApiVersion("http://api:8080", hangs, 50)).toBeNull();
  });
});

describe("cachedFor", () => {
  it("asks once per period and again after it", async () => {
    let now = 0;
    let calls = 0;
    const read = cachedFor(
      1_000,
      () => {
        calls += 1;
        return Promise.resolve(calls);
      },
      () => now
    );

    expect(await read()).toBe(1);
    now = 999;
    expect(await read()).toBe(1);
    now = 1_000;
    expect(await read()).toBe(2);
    expect(calls).toBe(2);
  });
});

describe("describeVersions", () => {
  const build = (version: string, commit?: string): RunningVersion => ({
    version,
    ...(commit === undefined ? {} : { commit }),
    source: "build" as const
  });

  it("names each version and its short commit", () => {
    expect(
      describeVersions(
        build("v0.1.0", "27f4d64e0b5a63f0d0b3"),
        build("v0.1.0", "27f4d64e0b5a63f0d0b3")
      )
    ).toEqual({
      web: "Web v0.1.0, commit 27f4d64e0b5a",
      api: "API v0.1.0, commit 27f4d64e0b5a",
      mismatch: false,
      unverified: null
    });
  });

  it("says a version is not a release when nothing was baked in", () => {
    const source = { version: "0.0.0", source: "package" as const };
    expect(describeVersions(source, source)).toEqual({
      web: "Web 0.0.0, not a release build",
      api: "API 0.0.0, not a release build",
      mismatch: false,
      unverified: null
    });
  });

  it("says the API version is unknown when /ready did not answer", () => {
    expect(describeVersions(build("v0.1.0"), null)).toEqual({
      web: "Web v0.1.0",
      api: "API version unknown",
      mismatch: false,
      unverified: null
    });
  });

  // A partial upgrade is the case F-045 asks to see.
  it("flags different builds: another version, or the same version from another commit", () => {
    expect(describeVersions(build("v0.2.0"), build("v0.1.0")).mismatch).toBe(true);
    expect(describeVersions(build("v0.1.0", "aaaa"), build("v0.1.0", "bbbb")).mismatch).toBe(true);
    expect(describeVersions(build("v0.1.0", "aaaa"), build("v0.1.0")).mismatch).toBe(false);
  });

  // F-051: a web image built without its build arguments reads 0.0.0 from its
  // package, which differs from any release, so it was called a different
  // build from an API built from the same commit.
  it("does not call a web app with no build identity a different build, and says it cannot tell", () => {
    const hand = { version: "0.0.0", source: "package" as const };
    const versions = describeVersions(hand, build("local-3cd2c20", "3cd2c2034c6d3607"));
    expect(versions.mismatch).toBe(false);
    expect(versions.unverified).toBe("web");
  });

  it("does not call an API with no build identity a different build, and says it cannot tell", () => {
    const hand = { version: "0.0.0", source: "package" as const };
    const versions = describeVersions(build("v0.1.0", "27f4d64e0b5a"), hand);
    expect(versions.mismatch).toBe(false);
    expect(versions.unverified).toBe("api");
  });

  it("has nothing to say when neither side carries a build identity", () => {
    const web = { version: "0.0.0", source: "package" as const };
    const api = { version: "0.1.0", source: "package" as const };
    expect(describeVersions(web, api)).toMatchObject({ mismatch: false, unverified: null });
  });
});
