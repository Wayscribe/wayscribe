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

function mount(props: Partial<Parameters<typeof JourneyTimeline>[0]> = {}) {
  return render(
    <JourneyTimeline
      journeyId="jrn_1"
      initialStatus="failed"
      initialEvents={EVENTS}
      initialCursor={null}
      initialSelectedId="evt_1"
      initialDetail={detail("evt_1")}
      totalEvents={4}
      knownServices={["webhook-api", "sync-worker"]}
      {...props}
    />
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  window.history.replaceState(null, "", "/journeys/jrn_1?event=evt_1");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("JourneyTimeline", () => {
  it("moves the selection with the keyboard and fetches the new event's detail", async () => {
    fetchMock.mockResolvedValueOnce(ok(detail("evt_2")));
    mount();

    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("step-evt_2");
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/events/evt_2", expect.anything());
    expect(screen.getByRole("option", { selected: true })).toHaveAttribute("id", "event-evt_2");
    expect(window.location.search).toBe("?event=evt_2");
  });

  it("stops at the top rather than wrapping", () => {
    mount();
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowUp" });
    expect(fetchMock).not.toHaveBeenCalled();
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
    await userEvent.click(screen.getByRole("button", { name: "Show 2 more" }));

    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(6);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/journeys/jrn_1/events?cursor=c1",
      expect.anything()
    );
    expect(screen.getByText(/· 6 events ·/)).toBeInTheDocument();
  });

  it("polls an active journey and stops when it finishes", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(
      ok(page({ items: [event("evt_5")], journeyStatus: "completed", journeyEventCount: 5 }))
    );
    mount({ initialStatus: "active" });

    expect(screen.getByRole("checkbox", { name: "Live" })).toBeChecked();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("option")).toHaveLength(5);
    expect(screen.getByText(/^completed/)).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
});
