import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AboutJourneyView } from "../../../components/AboutJourneyView";
import { AliasList } from "../../../components/AliasList";
import { JourneyHeading } from "../../../components/JourneyHeading";
import { JourneyTimeline } from "../../../components/JourneyTimeline";
import JourneyPage from "./page";

const { currentSessionMock, getJourneyMock, getEventMock, listEventsMock } = vi.hoisted(() => ({
  currentSessionMock: vi.fn(),
  getJourneyMock: vi.fn(),
  getEventMock: vi.fn(),
  listEventsMock: vi.fn()
}));

vi.mock("../../../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getJourney: getJourneyMock,
  getEvent: getEventMock,
  listEvents: listEventsMock
}));
vi.mock("../../../../src/lib/current-project", () => ({
  requireProjectId: vi.fn(() => Promise.resolve("proj_1")),
  currentSession: currentSessionMock
}));

const session = (principal: "admin" | "reader") => ({
  projectId: "",
  expiresAt: Date.now() + 60_000,
  principal
});

/** Every element in a returned tree, without rendering it. */
function elements(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    node.forEach((child) => elements(child as ReactNode, out));
  } else if (typeof node === "object" && node !== null && "props" in node) {
    const element = node as ReactElement<{ children?: ReactNode }>;
    out.push(element);
    elements(element.props.children, out);
  }
  return out;
}

async function page(principal: "admin" | "reader") {
  currentSessionMock.mockResolvedValue(session(principal));
  const tree = await JourneyPage({
    params: Promise.resolve({ journeyId: "jrn_1" }),
    searchParams: Promise.resolve({})
  });
  const all = elements(tree);
  return {
    deleteLink: all.find((e) => (e.props as { href?: unknown }).href === "/journeys/jrn_1/delete"),
    timeline: all.find((e) => e.type === JourneyTimeline)
  };
}

describe("JourneyPage by principal", () => {
  beforeEach(() => {
    getJourneyMock.mockReset().mockResolvedValue({
      id: "jrn_1",
      status: "failed",
      aliases: [],
      services: [],
      eventCount: 1,
      startedAt: "2026-09-16T08:00:00.000Z",
      lastEventAt: "2026-09-16T08:00:01.000Z"
    });
    listEventsMock.mockReset().mockResolvedValue({ items: [], nextCursor: null });
    getEventMock.mockReset().mockResolvedValue(null);
  });

  it("shows an admin the delete link and lets the timeline offer replay", async () => {
    const { deleteLink, timeline } = await page("admin");
    expect(deleteLink).toBeDefined();
    expect((timeline?.props as { canReplay: boolean }).canReplay).toBe(true);
  });

  it("goes back link, heading, then the timeline with the header lines in its slot", async () => {
    currentSessionMock.mockResolvedValue(session("admin"));
    const tree = (await JourneyPage({
      params: Promise.resolve({ journeyId: "jrn_1" }),
      searchParams: Promise.resolve({})
    })) as ReactElement<{ children: ReactNode[] }>;
    // Nothing between the heading and the status line the timeline draws:
    // no definition paragraph, no "All times UTC." line.
    expect(tree.props.children.map((child) => (child as ReactElement).type)).toEqual([
      "p",
      JourneyHeading,
      JourneyTimeline
    ]);
    const timeline = tree.props.children[2] as ReactElement<{
      children: ReactNode[];
      startedAt: string;
      lastEventAt: string;
    }>;
    expect(timeline.props.startedAt).toBe("2026-09-16T08:00:00.000Z");
    expect(timeline.props.lastEventAt).toBe("2026-09-16T08:00:01.000Z");
    const slot = elements(timeline.props.children);
    expect(slot.map((element) => element.type)).toContain(AliasList);
    expect(slot.map((element) => element.type)).toContain(AboutJourneyView);
  });

  it("shows a reader no delete link and no replay", async () => {
    const { deleteLink, timeline } = await page("reader");
    expect(deleteLink).toBeUndefined();
    expect((timeline?.props as { canReplay: boolean }).canReplay).toBe(false);
  });
});
