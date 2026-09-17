import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReplayFailure, replayFailureMessage } from "./ReplayFailure";

const UNEXPECTED = "Something went wrong, so the replay may not have been sent. Try again.";

describe("replayFailureMessage", () => {
  it.each([
    ["invalid_request", /request was incomplete/],
    ["invalid_method", /Choose POST, PUT, or PATCH/],
    ["not_found", /step or the destination no longer exists/],
    ["no_captured_input", /no captured input/],
    ["destination_disabled", /destination is disabled/],
    ["project_not_found", /which project to use/],
    ["unauthorized", /same ADMIN_TOKEN/],
    ["too_many_attempts", /too many failed authentication attempts/],
    ["query_timeout", /database took too long/],
    ["internal_error", /API's log has the details/],
    ["api_unavailable", /could not be reached/]
  ])("says what %s means", (code, message) => {
    expect(replayFailureMessage(code)).toMatch(message);
    expect(replayFailureMessage(code)).not.toBe(UNEXPECTED);
  });

  it.each(["unexpected", "", "something_new", "constructor", "toString", "__proto__"])(
    "reads %j as the generic failure",
    (code) => {
      expect(replayFailureMessage(code)).toBe(UNEXPECTED);
    }
  );
});

describe("ReplayFailure", () => {
  it("announces the message as an alert", () => {
    render(<ReplayFailure code="destination_disabled" />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "That destination is disabled, so nothing was sent. Choose another destination."
    );
  });

  it("never shows the code it was given", () => {
    const code = "<b>Your account is locked, call 555-0100</b>";
    render(<ReplayFailure code={code} />);

    expect(screen.getByRole("alert")).toHaveTextContent(UNEXPECTED);
    expect(document.body.textContent).not.toContain("555-0100");
  });
});
