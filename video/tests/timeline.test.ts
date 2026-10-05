import { describe, expect, it } from "vitest";
import { boxOf, type Capture, frameAt, markNamed } from "../src/capture";
import fixture from "../src/fixtures/capture.json";
import { type CaptureScene, type CardScene, SCENES } from "../src/scenes";
import { buildTimeline, frameAtSourceMs, GLIDE_FRAMES, sourceMsAt } from "../src/timeline";

const capture = fixture as Capture;
const box = { x: 0, y: 0, width: 100, height: 100 };
const tiny: Capture = {
  version: 1,
  viewport: { width: 1920, height: 1080 },
  scale: 2,
  frames: [{ at: 0, file: "f0" }],
  marks: [
    { name: "a", at: 1000, boxes: { b: box } },
    { name: "c", at: 3000, boxes: { b: box } },
    { name: "d", at: 13000, boxes: { b: box } }
  ],
  clicks: []
};
const card = (id: string, seconds: number): CardScene => ({
  id,
  kind: "card",
  layout: "statement",
  lines: ["x"],
  seconds
});
// A capture scene from mark "a" to mark "c" over 3 s, framing box "b" of its opening mark.
const scene = (over: Partial<CaptureScene>): CaptureScene => {
  const from = over.from ?? "a";
  return {
    id: "s",
    kind: "capture",
    caption: "x",
    seconds: 3,
    from,
    until: "c",
    enter: "fade",
    shots: {
      wide: [{ mark: from, box: "b", maxZoom: 2 }],
      square: [{ mark: from, box: "b", maxZoom: 2 }]
    },
    ...over
  };
};

describe("frame lookup", () => {
  it("shows the last frame captured at or before a moment", () => {
    const frames = [
      { at: 0, file: "a" },
      { at: 100, file: "b" }
    ];
    expect(frameAt(frames, 50).file).toBe("a");
    expect(frameAt(frames, 100).file).toBe("b");
    expect(frameAt(frames, -1).file).toBe("a");
  });

  it("finds the right frame among several, at the edges and between", () => {
    const frames = [0, 100, 200, 300].map((at) => ({ at, file: `f${String(at)}` }));
    expect(frameAt(frames, 0).file).toBe("f0");
    expect(frameAt(frames, 99).file).toBe("f0");
    expect(frameAt(frames, 100).file).toBe("f100");
    expect(frameAt(frames, 250).file).toBe("f200");
    expect(frameAt(frames, 300).file).toBe("f300");
    expect(frameAt(frames, 99999).file).toBe("f300");
  });

  it("refuses a capture with no frames", () => {
    expect(() => frameAt([], 0)).toThrow(/no frames/);
  });

  it("names the mark or box it cannot find", () => {
    expect(markNamed(tiny, "c").at).toBe(3000);
    expect(() => markNamed(tiny, "nope")).toThrow(/no mark "nope"/);
    expect(boxOf(tiny, "a", "b")).toEqual(box);
    expect(() => boxOf(tiny, "zz", "b")).toThrow(/no mark "zz"/);
    expect(() => boxOf(tiny, "a", "nope")).toThrow(/Mark "a" has no box "nope"/);
  });
});

describe("the timeline", () => {
  it("lays scenes end to end in whole frames", () => {
    const t = buildTimeline([card("one", 2), scene({})], tiny, 30);
    expect(t.scenes.map((s) => [s.startFrame, s.frames])).toEqual([
      [0, 60],
      [60, 90]
    ]);
    expect(t.totalFrames).toBe(150);
  });

  it("holds the opening state, then plays the action at real speed", () => {
    const [s] = buildTimeline([scene({})], tiny, 30).scenes;
    if (s === undefined) throw new Error("no scene");
    expect([s.holdMs, s.rate]).toEqual([1000, 1]);
    expect(sourceMsAt(s, 0, 30)).toBe(1000);
    expect(sourceMsAt(s, 30, 30)).toBe(1000);
    expect(sourceMsAt(s, 60, 30)).toBe(2000);
    expect(sourceMsAt(s, 90, 30)).toBe(3000);
  });

  it("speeds the action up when the capture runs longer than the scene", () => {
    const [s] = buildTimeline([scene({ from: "c", until: "d", seconds: 5 })], tiny, 30).scenes;
    if (s === undefined) throw new Error("no scene");
    expect([s.holdMs, s.rate]).toEqual([0, 2]);
    expect(sourceMsAt(s, 75, 30)).toBe(8000);
  });

  it("refuses to play capture faster than 3x", () => {
    expect(() => buildTimeline([scene({ from: "a", until: "d", seconds: 3 })], tiny, 30)).toThrow(
      /above 3x/
    );
  });

  it("freezes on its mark when a scene has no end mark", () => {
    const [s] = buildTimeline(
      [scene({ from: "c", until: undefined, seconds: 2 })],
      tiny,
      30
    ).scenes;
    if (s === undefined) throw new Error("no scene");
    expect(sourceMsAt(s, 59, 30)).toBe(3000);
  });

  it("maps a source moment back to the frame that shows it", () => {
    const [s] = buildTimeline([scene({})], tiny, 30).scenes;
    if (s === undefined) throw new Error("no scene");
    expect(frameAtSourceMs(s, 500, 30)).toBe(0);
    expect(frameAtSourceMs(s, 2000, 30)).toBe(60);
  });

  it("answers with the first frame that shows the moment, rounding up", () => {
    const [s] = buildTimeline([scene({})], tiny, 30).scenes;
    if (s === undefined) throw new Error("no scene");
    // 2010 ms is 60.3 frames in: frame 60 is too early, frame 61 shows it.
    expect(frameAtSourceMs(s, 2010, 30)).toBe(61);
    expect(sourceMsAt(s, 61, 30)).toBeGreaterThanOrEqual(2010);
    expect(sourceMsAt(s, 60, 30)).toBeLessThan(2010);
  });

  it("keeps a moment at or past the scene's end on the scene's last frame", () => {
    const [s] = buildTimeline([scene({})], tiny, 30).scenes;
    if (s === undefined) throw new Error("no scene");
    expect(frameAtSourceMs(s, 3000, 30)).toBe(s.frames - 1);
    expect(frameAtSourceMs(s, 99999, 30)).toBe(s.frames - 1);
  });

  it("refuses a scene that ends before it starts", () => {
    expect(() => buildTimeline([scene({ from: "c", until: "a" })], tiny, 30)).toThrow(
      /mark "a" comes before "c"/
    );
  });

  it("refuses a scene without a positive number of frames", () => {
    expect(() => buildTimeline([scene({ seconds: 0 })], tiny, 30)).toThrow(/needs at least one/);
    expect(() => buildTimeline([card("back", -1)], tiny, 30)).toThrow(/needs at least one/);
    expect(() => buildTimeline([card("nan", Number.NaN)], tiny, 30)).toThrow(/needs at least one/);
  });

  it("names every mark and box the scenes need that the capture lacks", () => {
    const broken = scene({
      until: "zz",
      shots: {
        wide: [{ mark: "a", box: "nope", maxZoom: 2 }],
        square: [{ mark: "a", box: "b", maxZoom: 2 }]
      }
    });
    expect(() => buildTimeline([broken], tiny, 30)).toThrow(/no mark "zz"[\s\S]*no box "nope"/);
  });

  it("refuses a shot whose mark falls outside its scene", () => {
    const early = scene({
      from: "c",
      until: "d",
      seconds: 6,
      shots: {
        wide: [{ mark: "a", box: "b", maxZoom: 2 }],
        square: [{ mark: "c", box: "b", maxZoom: 2 }]
      }
    });
    expect(() => buildTimeline([early], tiny, 30)).toThrow(/shot on mark "a" falls outside/);
  });

  it("refuses a highlight whose mark falls outside its scene", () => {
    const early = scene({
      from: "c",
      until: "d",
      seconds: 6,
      highlight: { mark: "a", box: "b", tone: "lost" }
    });
    expect(() => buildTimeline([early], tiny, 30)).toThrow(/highlight on mark "a" falls outside/);
  });

  it("sounds each tick once the camera has arrived", () => {
    const t = buildTimeline(
      [card("one", 2), scene({ tick: true, highlight: { mark: "a", box: "b", tone: "lost" } })],
      tiny,
      30
    );
    expect(t.ticks).toEqual([(60 + GLIDE_FRAMES) / 30]);
  });

  it("covers the real story with the recorded capture", () => {
    const t = buildTimeline(SCENES, capture);
    expect(t.totalFrames).toBe(1845);
    expect(t.ticks).toHaveLength(2);
  });

  it("finds, for any moment the real story shows, the first frame that shows it", () => {
    const t = buildTimeline(SCENES, capture);
    let checked = 0;
    for (const timed of t.scenes) {
      if (timed.scene.kind !== "capture") continue;
      // The last frame shows a little before the scene's end; later moments never show.
      const last = sourceMsAt(timed, timed.frames - 1, t.fps);
      for (let ms = timed.fromMs; ms <= last; ms += 7.3) {
        const frame = frameAtSourceMs(timed, ms, t.fps);
        expect(frame).toBeGreaterThanOrEqual(0);
        expect(frame).toBeLessThan(timed.frames);
        expect(sourceMsAt(timed, frame, t.fps)).toBeGreaterThanOrEqual(ms - 1e-6);
        if (frame > 0) expect(sourceMsAt(timed, frame - 1, t.fps)).toBeLessThan(ms + 1e-6);
        checked++;
      }
      if (timed.spanMs > 0) {
        const end = timed.fromMs + timed.spanMs;
        expect(frameAtSourceMs(timed, end, t.fps)).toBe(timed.frames - 1);
        expect(frameAtSourceMs(timed, end + 5000, t.fps)).toBe(timed.frames - 1);
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
});
