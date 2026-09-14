import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventDetailData, EventListItem, EventsPageResponse } from "../../src/lib/api";
import { JourneyTimeline } from "./JourneyTimeline";

function event(id: string, overrides: Partial<EventListItem> = {}): EventListItem {
  return {
    id,
    operation: "received",
    name: `step-${id}`,
    service: "webhook-api",
    eventTimestamp: `2026-09-14T10:00:0${id.slice(-1)}.000Z`,
    receivedAt: `2026-09-14T10:00:0${id.slice(-1)}.500Z`,
    durationMs: null,
    hasInput: true,
    hasOutput: false,
    hasError: false,
    ...overrides
  };
}

function detail(id: string): EventDetailData {
  return {
    ...event(id),
    journeyId: "jrn_1",
    traceId: null,
    messageId: null,
    inputPayload: { id },
    outputPayload: null,
    payloadDiff: null,
    error: null
  };
}

const EVENTS = [
  event("evt_1"),
  event("evt_2", { service: "sync-worker" }),
  event("evt_3", { service: "sync-worker", hasError: true }),
  event("evt_4", { hasError: true })
];

function page(overrides: Partial<EventsPageResponse> = {}): EventsPageResponse {
  return {
    items: [],
    nextCursor: null,
    journeyStatus: "active",
    journeyEventCount: 4,
    ...overrides
  };
}

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
const failed = (): Response => new Response("nope", { status: 502 });

const fetchMock = vi.fn<typeof fetch>();
// jsdom implements no layout, so `scrollIntoView` does not exist to spy on.
const scrollIntoView = vi.fn<Element["scrollIntoView"]>();

function mount(props: Partial<Parameters<typeof JourneyTimeline>[0]> = {}) {
  return render(
    <JourneyTimeline
      journeyId="jrn_1"
      initialStatus="failed"
      initialEvents={EVENTS}
      initialCursor={null}
      initialSelectedId="evt_1"
      initialDetail={detail("evt_1")}
      initialLastEventAt="2026-01-01T00:00:00.000Z"
      totalEvents={4}
      knownServices={["webhook-api", "sync-worker"]}
      {...props}
    />
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  scrollIntoView.mockReset();
  Element.prototype.scrollIntoView = scrollIntoView;
  window.history.replaceState(null, "", "/journeys/jrn_1?event=evt_1");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

describe("JourneyTimeline", () => {
  it("moves the selection with the keyboard and fetches the new event's detail", async () => {
    fetchMock.mockResolvedValueOnce(ok(detail("evt_2")));
    mount();

    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("step-evt_2");
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/events/evt_2",
      expect.objectContaining({ headers: { accept: "application/json" } })
    );
    expect(screen.getByRole("option", { selected: true })).toHaveAttribute("id", "event-evt_2");
    expect(window.location.search).toBe("?event=evt_2");
  });

  it("stops at the top rather than wrapping", () => {
    mount();
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowUp" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("option", { selected: true })).toHaveAttribute("id", "event-evt_1");
  });

  it("filters to failures and moves the selection to the first one", async () => {
    fetchMock.mockResolvedValueOnce(ok(detail("evt_3")));
    mount();

    await userEvent.click(screen.getByRole("button", { name: "Failures only" }));

    expect(screen.getAllByRole("option")).toHaveLength(2);
    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("step-evt_3");
    });
    expect(screen.getByText(/2 of 4 events shown/)).toBeInTheDocument();
  });

  it("loads the next page and merges it", async () => {
    fetchMock.mockResolvedValueOnce(
      ok(
        page({
          items: [event("evt_5"), event("evt_6")],
          journeyStatus: "failed",
          journeyEventCount: 6
        })
      )
    );
    mount({ initialCursor: "c1", totalEvents: 6 });

    expect(screen.getByText(/showing 4 of 6 events/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show 2 more events" }));

    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(6);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/journeys/jrn_1/events?cursor=c1",
      expect.anything()
    );
    expect(screen.getByText(/· 6 events ·/)).toBeInTheDocument();
  });

  it("polls a finished journey until it goes quiet, not until it is marked finished", async () => {
    vi.useFakeTimers();
    // A fresh Response each time: a body can only be read once.
    const tail = () =>
      Promise.resolve(
        ok(page({ items: [event("evt_5")], journeyStatus: "completed", journeyEventCount: 5 }))
      );
    fetchMock.mockImplementation(tail);
    mount({ initialStatus: "active" });

    expect(screen.getByRole("checkbox", { name: "Live" })).toBeChecked();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    // Terminal status, but it brought a new event: still following.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("option")).toHaveLength(5);
    expect(screen.getByText(/^completed/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Live" })).toBeChecked();

    // Three polls that add nothing: six seconds of quiet, then it stops.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(screen.queryByRole("checkbox", { name: "Live" })).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("keeps following a failed journey while events are still arriving", async () => {
    vi.useFakeTimers();
    // The demo journey is marked `failed` the instant its sixth event lands and
    // keeps recording retries for ten more seconds.
    const arriving = [event("evt_5"), event("evt_6"), event("evt_7"), event("evt_8")];
    let served = 0;
    fetchMock.mockImplementation(() => {
      served += 1;
      return Promise.resolve(
        ok(
          page({
            items: arriving.slice(0, served),
            journeyStatus: "failed",
            journeyEventCount: 4 + served
          })
        )
      );
    });
    mount({ initialStatus: "failed", initialLastEventAt: new Date().toISOString() });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(screen.getAllByRole("option")).toHaveLength(8);
    expect(screen.getByRole("checkbox", { name: "Live" })).toBeChecked();
  });

  it("starts live on a finished journey whose last event is recent", () => {
    mount({
      initialStatus: "failed",
      initialLastEventAt: "2026-09-14T10:00:20.000Z",
      now: () => Date.parse("2026-09-14T10:00:30.000Z")
    });

    expect(screen.getByRole("checkbox", { name: "Live" })).toBeChecked();
  });

  it("does not start live on a finished journey that went quiet long ago", () => {
    mount({
      initialStatus: "failed",
      initialLastEventAt: "2026-09-14T10:00:00.000Z",
      now: () => Date.parse("2026-09-14T10:05:00.000Z")
    });

    expect(screen.queryByRole("checkbox", { name: "Live" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives up after three failed polls and says so", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(failed());
    mount({ initialStatus: "active" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.getByText(/Live updates stopped/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Live" })).not.toBeChecked();
    expect(screen.getAllByRole("option")).toHaveLength(4);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops live mode at once when the session is refused", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(new Response("{}", { status: 401 }));
    mount({ initialStatus: "active" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Sign in again/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Live" })).not.toBeChecked();
  });

  it("keeps polling from the last cursor it was given, not from page one", async () => {
    vi.useFakeTimers();
    // First poll from c1: the tail has one new event and no further page.
    // Second poll must still ask from c1, not refetch page one.
    fetchMock
      .mockResolvedValueOnce(ok(page({ items: [event("evt_5")], journeyEventCount: 5 })))
      .mockResolvedValueOnce(
        ok(page({ items: [event("evt_5"), event("evt_6")], journeyEventCount: 6 }))
      );
    mount({ initialStatus: "active", initialCursor: "c1", totalEvents: 4 });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/journeys/jrn_1/events?cursor=c1",
      expect.anything()
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/journeys/jrn_1/events?cursor=c1",
      expect.anything()
    );
    expect(screen.getAllByRole("option")).toHaveLength(6);
  });

  it("keeps the previous detail when a detail fetch fails", async () => {
    fetchMock.mockResolvedValueOnce(failed());
    mount();

    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });

    await waitFor(() => {
      expect(screen.getByText(/Could not load this event/)).toBeInTheDocument();
    });
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("step-evt_1");
  });

  it("applies only the latest detail when responses arrive out of order", async () => {
    let resolveSecond: (r: Response) => void = () => undefined;
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveSecond = resolve;
          })
      )
      .mockResolvedValueOnce(ok(detail("evt_3")));
    mount();

    const list = screen.getByRole("listbox");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "ArrowDown" });

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("step-evt_3");
    });
    resolveSecond(ok(detail("evt_2")));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("step-evt_3");
  });
  it("keeps a deep link to an event that is not on the first page", () => {
    window.history.replaceState(null, "", "/journeys/jrn_1?event=evt_99");

    mount({ initialSelectedId: "evt_99", initialDetail: detail("evt_99") });

    // The event is simply not loaded yet, which is not the same as being
    // filtered out: relocating here would throw away the server's detail.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("step-evt_99");
    expect(window.location.search).toBe("?event=evt_99");
    expect(screen.getByRole("listbox")).not.toHaveAttribute("aria-activedescendant");
  });

  it("scrolls the newly selected row into view", async () => {
    fetchMock.mockResolvedValueOnce(ok(detail("evt_2")));
    mount();
    scrollIntoView.mockClear();

    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("step-evt_2");
    });
  });

  it("says so, in both columns, when a filter matches nothing", async () => {
    mount({
      initialEvents: [event("evt_1"), event("evt_2", { service: "sync-worker" })],
      totalEvents: 2
    });

    await userEvent.click(screen.getByRole("button", { name: "Failures only" }));

    // The listbox stays mounted with no options rather than unmounting, so the
    // reader's focus is not thrown back to the top of the document.
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getAllByText("No events match these filters.")).toHaveLength(2);
    // The selection survives in state, so loosening the filter costs no request.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the empty-journey wording when there is nothing for a filter to hide", () => {
    mount({ initialEvents: [], initialSelectedId: null, initialDetail: null, totalEvents: 0 });

    expect(screen.getByText("This journey has no events yet.")).toBeInTheDocument();
    expect(screen.queryByText("No events match these filters.")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives the failure budget back when Live is switched on again", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(failed());
    mount({ initialStatus: "active" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    act(() => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Live" }));
    });
    expect(screen.queryByText(/Live updates stopped/)).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Live" })).toBeChecked();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    // The call count alone does not distinguish a fresh budget from a spent
    // one: the fifth request goes out before React has processed a setLive
    // (false) from the fourth. Still being live afterwards does.
    expect(screen.getByRole("checkbox", { name: "Live" })).toBeChecked();
    expect(screen.queryByText(/Live updates stopped/)).not.toBeInTheDocument();
  });

  it("discards a poll that lands after Live was switched off", async () => {
    vi.useFakeTimers();
    let resolvePoll: (r: Response) => void = () => undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolvePoll = resolve;
        })
    );
    mount({ initialStatus: "active" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Live" }));
    });
    await act(async () => {
      resolvePoll(ok(page({ items: [event("evt_5")], journeyEventCount: 5 })));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getAllByRole("option")).toHaveLength(4);
  });

  it("does not start a second poll while one is still in flight", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise<Response>(() => undefined));
    mount({ initialStatus: "active" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores a second load-more click while a page is in flight", () => {
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => undefined));
    mount({ initialCursor: "c1", totalEvents: 6 });

    const button = screen.getByRole("button", { name: "Show 2 more events" });
    // Both in one tick: a guard read from the render closure is still false on
    // the second click, because React has not re-rendered in between.
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
  });

  it("does not promise a count it cannot know", () => {
    mount({ initialCursor: "c1", totalEvents: 4 });

    expect(screen.getByRole("button", { name: "Show more events" })).toBeInTheDocument();
  });

  it("says the session ended, rather than offering a retry, when load-more is refused", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    mount({ initialCursor: "c1", totalEvents: 6 });

    await userEvent.click(screen.getByRole("button", { name: "Show 2 more events" }));

    await waitFor(() => {
      expect(screen.getByText(/Sign in again/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Try again/)).not.toBeInTheDocument();
  });

  it("says the session ended, rather than offering a retry, when a detail is refused", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 409 }));
    mount();

    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });

    await waitFor(() => {
      expect(screen.getByText(/Sign in again/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Select it again/)).not.toBeInTheDocument();
  });

  it("keeps the rest of the query string when the selection changes", async () => {
    window.history.replaceState(null, "", "/journeys/jrn_1?event=evt_1&from=search");
    fetchMock.mockResolvedValueOnce(ok(detail("evt_2")));
    mount();

    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("step-evt_2");
    });
    expect(window.location.search).toBe("?event=evt_2&from=search");
  });
});
