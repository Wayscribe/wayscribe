import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const TOKEN = ["admin-token", "for-tests", "00000000000000"].join("-");
const OTHER = ["admin-token", "for-tests", "99999999999999"].join("-");

const tokenFile = (): string => {
  const path = join(mkdtempSync(join(tmpdir(), "wayscribe-web-health-")), "admin-token");
  writeFileSync(path, `${TOKEN}\n`, "utf8");
  return path;
};

/**
 * The container's health check probes this route (apps/web/Dockerfile), so
 * what it answers is what `docker compose up --wait` reports. F-030: the probe
 * used to be /login, which reads no configuration, and a web app that could
 * not sign anybody in was reported healthy.
 */
describe("GET /health", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("answers 200 when the configuration loads", async () => {
    vi.stubEnv("ADMIN_TOKEN", TOKEN);
    vi.stubEnv("ADMIN_TOKEN_FILE", "");
    vi.stubEnv("API_URL", "http://api:8080");

    const response = GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it.each([
    [
      "ADMIN_TOKEN and ADMIN_TOKEN_FILE are both set",
      { ADMIN_TOKEN: OTHER, ADMIN_TOKEN_FILE: "file" }
    ],
    ["ADMIN_TOKEN_FILE names no file", { ADMIN_TOKEN: "", ADMIN_TOKEN_FILE: "/no/such/file" }],
    ["ADMIN_TOKEN is unset", { ADMIN_TOKEN: "", ADMIN_TOKEN_FILE: "" }]
  ])("answers 503 when %s", async (_case, settings) => {
    vi.stubEnv("API_URL", "http://api:8080");
    vi.stubEnv("ADMIN_TOKEN", settings.ADMIN_TOKEN);
    vi.stubEnv(
      "ADMIN_TOKEN_FILE",
      settings.ADMIN_TOKEN_FILE === "file" ? tokenFile() : settings.ADMIN_TOKEN_FILE
    );

    const response = GET();
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ status: "not_configured" });
    // Unauthenticated, so it names nothing: no value, no path, no variable.
    // The container log has the specific message.
    expect(body).not.toContain(OTHER);
    expect(body).not.toContain("ADMIN_TOKEN");
  });

  it("is never cached", () => {
    vi.stubEnv("ADMIN_TOKEN", TOKEN);
    vi.stubEnv("API_URL", "http://api:8080");
    expect(GET().headers.get("cache-control")).toBe("no-store");
  });
});
