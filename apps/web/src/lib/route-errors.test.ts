import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiUnavailableError, ProjectNotSelectedError } from "./api";
import { apiFailure } from "./route-errors";

describe("apiFailure", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("turns ProjectNotSelectedError into a 409 with a fixed body", async () => {
    const response = apiFailure(new ProjectNotSelectedError("No project is selected."));

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("project_not_selected");
  });

  it("turns ApiUnavailableError into a 502 whose body never names ADMIN_TOKEN, and logs the real error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new ApiUnavailableError(
      "The web and API containers may hold different ADMIN_TOKEN values."
    );

    const response = apiFailure(error);

    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("api_unavailable");
    // The absence of ADMIN_TOKEN in the response body is the security property
    // under test: the real cause belongs in the server log, not a body served
    // to a browser.
    expect(body.error.message).not.toContain("ADMIN_TOKEN");
    expect(consoleError).toHaveBeenCalledWith(error);
  });

  it("rethrows anything else", () => {
    const error = new Error("boom");
    expect(() => apiFailure(error)).toThrow(error);
  });
});
