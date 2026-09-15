import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReplayHeaders } from "./ReplayHeaders";

describe("ReplayHeaders", () => {
  it("lists each header by name and says a redacted value was still sent", () => {
    render(
      <ReplayHeaders
        headers={{
          "x-flight-replay": "true",
          authorization: "[REDACTED]",
          "user-agent": "flight-recorder-replay"
        }}
      />
    );

    expect(screen.getByRole("heading", { name: "Headers sent" })).toBeInTheDocument();
    expect(screen.getByText("authorization")).toBeInTheDocument();
    expect(screen.getByText("flight-recorder-replay")).toBeInTheDocument();
    // A bare marker would read as the value that went out. It must not.
    expect(screen.getByText("(real value used, not stored)")).toBeInTheDocument();
    expect(screen.getByText(/were sent with their real values/)).toBeInTheDocument();
    // Migration 015 redacted every value in older runs, `user-agent` included,
    // so a fully redacted list must not look like a defect in the replay.
    expect(
      screen.getByText(/recorded before the upgrade .* every header value redacted/)
    ).toBeInTheDocument();
  });

  it("orders headers by name", () => {
    render(<ReplayHeaders headers={{ "x-b": "2", accept: "a", "content-type": "c" }} />);
    const names = screen
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.firstElementChild?.textContent);
    expect(names).toEqual(["accept", "content-type", "x-b"]);
  });

  it("says nothing about redaction when nothing was redacted", () => {
    render(<ReplayHeaders headers={{ "user-agent": "flight-recorder-replay" }} />);
    expect(screen.queryByText(/real value/)).not.toBeInTheDocument();
  });

  it("calls an unfinished request an attempt", () => {
    render(<ReplayHeaders headers={{ authorization: "[REDACTED]" }} attempted />);
    expect(
      screen.getByRole("heading", { name: "Headers in the attempted request" })
    ).toBeInTheDocument();
    expect(screen.getByText(/were in the attempt with their real values/)).toBeInTheDocument();
  });

  it("renders nothing without headers", () => {
    const { container } = render(<ReplayHeaders headers={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
