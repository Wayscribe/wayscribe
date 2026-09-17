import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { PendingForm, PendingSubmit } from "./PendingForm";

const cleanups: (() => void)[] = [];

/**
 * jsdom cannot navigate, so stop the real submission, but only after React has
 * seen the event: a listener on the window runs after React's, which sits on
 * the root. Reports whether anything before it cancelled the submission.
 */
function stopSubmission(): { prevented: () => boolean | undefined } {
  let prevented: boolean | undefined;
  const stop = (event: Event): void => {
    prevented = event.defaultPrevented;
    event.preventDefault();
  };
  window.addEventListener("submit", stop);
  cleanups.push(() => {
    window.removeEventListener("submit", stop);
  });
  return { prevented: () => prevented };
}

function renderForm(onSubmit?: ComponentProps<typeof PendingForm>["onSubmit"]) {
  render(
    <PendingForm
      method="get"
      action="/journeys"
      className="search-row"
      aria-label="Find"
      pendingMessage="Searching…"
      {...(onSubmit === undefined ? {} : { onSubmit })}
    >
      <input name="q" aria-label="Search" />
      <PendingSubmit>Search</PendingSubmit>
    </PendingForm>
  );
  return {
    form: screen.getByRole("form", { name: "Find" }),
    button: screen.getByRole("button", { name: "Search" }),
    status: screen.getByRole("status")
  };
}

describe("PendingForm", () => {
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  it("renders a plain GET form, its attributes passed through, and an empty status line", () => {
    const { form, button, status } = renderForm();
    expect(form.getAttribute("method")).toBe("get");
    expect(form.getAttribute("action")).toBe("/journeys");
    expect(form.className).toBe("search-row");
    expect(button.getAttribute("type")).toBe("submit");
    expect(button.getAttribute("aria-busy")).toBeNull();
    expect(status.textContent).toBe("");
    // The status line sits after the form, not in its flex row.
    expect(form.contains(status)).toBe(false);
  });

  it("says the form was sent and marks the button busy, and lets the browser submit", () => {
    const { form, button, status } = renderForm();
    const submission = stopSubmission();

    fireEvent.submit(form);

    // The component did not stop the browser's own submission.
    expect(submission.prevented()).toBe(false);
    expect(status.textContent).toBe("Searching…");
    expect(button.getAttribute("aria-busy")).toBe("true");
  });

  it("stays idle when a caller's handler cancels the submission", () => {
    const { form, status } = renderForm((event) => {
      event.preventDefault();
    });
    stopSubmission();
    fireEvent.submit(form);
    expect(status.textContent).toBe("");
  });

  it("goes idle again when the page is restored from the back-forward cache", () => {
    const { form, button, status } = renderForm();
    stopSubmission();
    fireEvent.submit(form);
    expect(status.textContent).toBe("Searching…");

    act(() => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });

    expect(status.textContent).toBe("");
    expect(button.getAttribute("aria-busy")).toBeNull();
  });

  it("ignores an ordinary page show", () => {
    const { form, status } = renderForm();
    stopSubmission();
    fireEvent.submit(form);

    act(() => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));
    });

    expect(status.textContent).toBe("Searching…");
  });
});
