import { describe, expect, it } from "vitest";
import {
  between,
  type Camera,
  clampCamera,
  frameBox,
  glide,
  MIN_ZOOM,
  minZoom,
  PADDING,
  projectBox,
  safeArea,
  sceneCamera
} from "../src/camera";
import { boxOf, type Capture } from "../src/capture";
import fixture from "../src/fixtures/capture.json";
import type { Box } from "../src/geometry";
import { type CaptureScene, type Format, FORMATS, SCENES } from "../src/scenes";
import { buildTimeline, GLIDE_FRAMES } from "../src/timeline";

const capture = fixture as Capture;
const viewport = { width: 1920, height: 1080 };
const wide = FORMATS.wide;

// The plan's original framing, kept here as the reference for "unchanged where it worked".
const referenceFrame = (box: Box, format: Format, maxZoom: number): Camera => {
  const safe = safeArea(format);
  const fit = Math.min(
    safe.width / (box.width + 2 * PADDING),
    safe.height / (box.height + 2 * PADDING)
  );
  const zoom = Math.max(minZoom(format, viewport), Math.min(maxZoom, fit));
  const x = box.x + box.width / 2 - (safe.x + safe.width / 2) / zoom;
  const y = box.y + box.height / 2 - (safe.y + safe.height / 2) / zoom;
  const w = format.width / zoom;
  const h = format.height / zoom;
  return {
    zoom,
    x: Math.min(Math.max(0, x), viewport.width - w),
    y: Math.min(Math.max(0, y), viewport.height - h)
  };
};

const inSafeArea = (box: Box, c: Camera, format: Format): boolean => {
  const safe = safeArea(format);
  const p = projectBox(c, box);
  return (
    p.x >= -0.5 &&
    p.y >= -0.5 &&
    p.x + p.width <= safe.width + 0.5 &&
    p.y + p.height <= safe.height + 0.5
  );
};

/** The subject with its margin below, kept in frame and clear of the caption band. */
const clearOfBand = (box: Box, c: Camera, format: Format): boolean => {
  const safe = safeArea(format);
  const p = projectBox(c, box);
  const eps = 1e-6;
  return (
    p.x >= -eps &&
    p.y >= -eps &&
    p.x + p.width <= safe.width + eps &&
    p.y + p.height + PADDING * c.zoom <= safe.height + eps
  );
};

/** CSS pixels of the window that lie off the page, summed over both axes. */
const padding = (c: Camera, format: Format): number => {
  const w = format.width / c.zoom;
  const h = format.height / c.zoom;
  const over = (from: number, extent: number, size: number) =>
    Math.max(0, -from) + Math.max(0, from + size - extent);
  return over(c.x, viewport.width, w) + over(c.y, viewport.height, h);
};

const formats = Object.values(FORMATS);

describe("framing", () => {
  it("frames a small box as close as the zoom limit allows, centred in the safe area", () => {
    const box = { x: 900, y: 500, width: 120, height: 40 };
    const view = frameBox(box, wide, viewport, 2.2);
    expect(view.zoom).toBe(2.2);
    const p = projectBox(view, box);
    expect(p.x + p.width / 2).toBeCloseTo(960);
    expect(p.y + p.height / 2).toBeCloseTo((1080 - wide.band) / 2);
  });

  it("zooms out to fit a big box, but never below the whole page", () => {
    expect(frameBox({ x: 0, y: 0, width: 1920, height: 1080 }, wide, viewport, 2.2)).toEqual({
      x: 0,
      y: 0,
      zoom: 1
    });
  });

  it("keeps a box near the page edge framed from the page's own corner", () => {
    const view = frameBox({ x: 0, y: 0, width: 50, height: 20 }, wide, viewport, 2);
    expect([view.x, view.y]).toEqual([0, 0]);
  });

  it("glides zoom geometrically and arrives exactly", () => {
    const a = { x: 0, y: 0, zoom: 1 };
    const b = { x: 500, y: 300, zoom: 2 };
    const start = between(a, b, 0, wide);
    expect([start.x, start.y, start.zoom]).toEqual([0, 0, 1]);
    const end = between(a, b, 1, wide);
    expect(end.zoom).toBeCloseTo(2);
    expect(end.x).toBeCloseTo(500);
    expect(end.y).toBeCloseTo(300);
    expect(between(a, b, 0.5, wide).zoom).toBeCloseTo(Math.SQRT2);
  });
});

describe("a camera that may leave the page", () => {
  it("(a) keeps a subject that fits at zoom 1 or more, on the page, exactly as before", () => {
    let fitted = 0;
    for (const format of formats) {
      for (const width of [40, 120, 300, 691, 900]) {
        for (const height of [20, 41, 70, 100, 179, 300]) {
          for (const x of [0, 400, 861, viewport.width - width]) {
            // 800 puts some boxes within a margin of the caption band, which the old framing allowed.
            for (const y of [0, 100, 275, 500, 800]) {
              for (const maxZoom of [1.2, 2.2]) {
                const box = { x, y, width, height };
                const old = referenceFrame(box, format, maxZoom);
                if (!inSafeArea(box, old, format)) continue;
                fitted++;
                const view = frameBox(box, format, viewport, maxZoom);
                expect(view, JSON.stringify([format.id, box, maxZoom])).toEqual(old);
                expect(view.zoom).toBeGreaterThanOrEqual(minZoom(format, viewport));
                expect(padding(view, format)).toBe(0);
              }
            }
          }
        }
      }
    }
    expect(fitted).toBeGreaterThan(300);
  });

  it("(b) zooms out for a subject wider than the square window, only as far as it needs, never below MIN_ZOOM", () => {
    for (const width of [1090, 1106, 1184, 1250, 1286]) {
      const box = { x: 368, y: 300, width, height: 40 };
      const view = frameBox(box, FORMATS.square, viewport, 2.2);
      expect(view.zoom, `width ${width}`).toBeLessThan(1);
      expect(view.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
      expect(view.zoom).toBeCloseTo(FORMATS.square.width / (width + 2 * PADDING), 6);
      expect(inSafeArea(box, view, FORMATS.square), `width ${width}`).toBe(true);
      // The window is narrower than the page, so it stays on the page horizontally.
      expect(view.x).toBeGreaterThanOrEqual(0);
      expect(view.x + FORMATS.square.width / view.zoom).toBeLessThanOrEqual(viewport.width);
    }
  });

  it("(b) does not frame a subject that would need less than MIN_ZOOM, and never zooms below it", () => {
    for (let width = 1200; width <= 1920; width += 60) {
      const box = { x: (viewport.width - width) / 2, y: 300, width, height: 40 };
      for (const format of formats) {
        const view = frameBox(box, format, viewport, 2.2);
        expect(view.zoom, `${format.id} ${width}`).toBeGreaterThanOrEqual(MIN_ZOOM);
        const needs = format.width / (width + 2 * PADDING);
        if (needs < MIN_ZOOM)
          expect(inSafeArea(box, view, format), `${format.id} ${width}`).toBe(false);
      }
    }
  });

  it("(c) pads below the page for a subject that reaches into the caption band at maximum scroll", () => {
    const box = { x: 368, y: 197, width: 474, height: 757 };
    const view = frameBox(box, wide, viewport, 1.4);
    expect(view.zoom).toBeGreaterThanOrEqual(1);
    expect(view.y + wide.height / view.zoom).toBeGreaterThan(viewport.height);
    expect(view.y).toBeGreaterThanOrEqual(0);
    expect(clearOfBand(box, view, wide)).toBe(true);
  });

  it("(c) clears the band for every subject that can be framed, sweeping size and place", () => {
    let padded = 0;
    for (const format of formats) {
      for (const width of [120, 474, 691, 1184]) {
        for (const height of [41, 179, 400, 757]) {
          for (const y of [100, 300, 600, 900, 1000 - height]) {
            if (y < 0 || y + height > viewport.height) continue;
            const box = { x: 368, y, width, height };
            const view = frameBox(box, format, viewport, 2.2);
            const needs = Math.min(
              safeArea(format).width / (width + 2 * PADDING),
              safeArea(format).height / (height + 2 * PADDING)
            );
            if (needs < MIN_ZOOM) continue;
            const reason = JSON.stringify([format.id, box]);
            expect(inSafeArea(box, view, format), reason).toBe(true);
            expect(view.zoom, reason).toBeGreaterThanOrEqual(MIN_ZOOM);
            if (padding(view, format) > 0) {
              padded++;
              expect(clearOfBand(box, view, format), reason).toBe(true);
            }
          }
        }
      }
    }
    expect(padded).toBeGreaterThan(10);
  });

  it("(d) pads as little as it can: one pixel back toward the page loses the subject or pads no less", () => {
    let relaxed = 0;
    for (const format of formats) {
      for (const width of [120, 474, 691, 1184, 1286]) {
        for (const height of [41, 179, 400, 757]) {
          for (const y of [0, 157, 400, 700, 900, 1000 - height]) {
            if (y < 0 || y + height > viewport.height) continue;
            const box = { x: 368, y, width, height };
            const view = frameBox(box, format, viewport, 2.2);
            const here = padding(view, format);
            if (!inSafeArea(box, view, format)) continue;
            if (here > 0 || view.zoom < minZoom(format, viewport)) {
              relaxed++;
              expect(clearOfBand(box, view, format), JSON.stringify([format.id, box])).toBe(true);
            }
            for (const [dx, dy] of [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1]
            ] as const) {
              const shifted = { ...view, x: view.x + dx, y: view.y + dy };
              if (!clearOfBand(box, shifted, format)) continue;
              expect(
                padding(shifted, format),
                JSON.stringify([format.id, box, dx, dy])
              ).toBeGreaterThanOrEqual(here - 1e-9);
            }
          }
        }
      }
    }
    expect(relaxed).toBeGreaterThan(10);
  });

  it("(d) pads only below the page for a low subject: the window never crosses the top or the sides", () => {
    const box = { x: 368, y: 197, width: 474, height: 757 };
    const view = frameBox(box, wide, viewport, 1.4);
    expect(view.x).toBeGreaterThanOrEqual(0);
    expect(view.x + wide.width / view.zoom).toBeLessThanOrEqual(viewport.width);
    expect(view.y).toBeGreaterThanOrEqual(0);
  });

  it("keeps a glide between two views on the page on the page", () => {
    const a = { x: 0, y: 0, zoom: 2 };
    const b = { x: 320, y: 180, zoom: 1.2 };
    for (let i = 0; i <= 24; i++) {
      const c = glide(a, b, i / 24, wide, viewport);
      expect(c.x).toBeGreaterThanOrEqual(-1e-9);
      expect(c.y).toBeGreaterThanOrEqual(-1e-9);
      expect(c.x + wide.width / c.zoom).toBeLessThanOrEqual(viewport.width + 1e-9);
      expect(c.y + wide.height / c.zoom).toBeLessThanOrEqual(viewport.height + 1e-9);
    }
  });

  it("centres the page when the window is wider than it", () => {
    const view = clampCamera({ x: 40, y: 0, zoom: 0.8 }, wide, viewport);
    expect(view.x).toBeCloseTo((viewport.width - wide.width / 0.8) / 2);
  });

  it("(e) glides continuously across a shot below zoom 1, from a scene that stopped on one", () => {
    const frameBoxes = { x: 861, y: 275, width: 691, height: 179 };
    const wideBox = { x: 368, y: 316, width: 1184, height: 44 };
    const lowBox = { x: 368, y: 197, width: 474, height: 757 };
    const tiny: Capture = {
      version: 1,
      viewport,
      scale: 2,
      frames: [{ at: 0, file: "f0" }],
      marks: [
        { name: "a", at: 1000, boxes: { wide: wideBox, low: lowBox, small: frameBoxes } },
        { name: "b", at: 3000, boxes: { wide: wideBox, low: lowBox, small: frameBoxes } },
        { name: "c", at: 5000, boxes: { wide: wideBox, low: lowBox, small: frameBoxes } }
      ],
      clicks: []
    };
    const shot = (mark: string, box: string, maxZoom: number) => ({ mark, box, maxZoom });
    const scenes: CaptureScene[] = [
      {
        id: "one",
        kind: "capture",
        caption: "x",
        seconds: 4,
        from: "a",
        until: "c",
        enter: "fade",
        shots: {
          wide: [shot("a", "wide", 1.6), shot("b", "small", 2.2)],
          square: [shot("a", "wide", 1.6), shot("b", "small", 2.2)]
        }
      },
      {
        id: "two",
        kind: "capture",
        caption: "x",
        seconds: 4,
        from: "a",
        until: "c",
        enter: "glide",
        shots: {
          wide: [shot("a", "low", 1.4), shot("c", "small", 1.8)],
          square: [shot("a", "low", 1.4), shot("c", "wide", 1.6)]
        }
      }
    ];
    const t = buildTimeline(scenes, tiny, 30);
    const one = t.scenes[0];
    const two = t.scenes[1];
    if (one === undefined || two === undefined) throw new Error("no scenes");

    const square = FORMATS.square;
    const wideView = frameBox(wideBox, square, viewport, 1.6);
    const smallView = frameBox(frameBoxes, square, viewport, 2.2);
    expect(wideView.zoom).toBeLessThan(1);
    expect(wideView.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);

    // A fade into a shot below zoom 1 starts on it (a fade never zooms in to arrive).
    const first = sceneCamera(t, 0, 0, square, tiny);
    expect(first.zoom).toBeCloseTo(wideView.zoom);
    expect(first.x).toBeCloseTo(wideView.x);
    expect(first.y).toBeCloseTo(wideView.y);

    // The second shot takes over at the mark and arrives exactly.
    const last = sceneCamera(t, 0, one.frames - 1, square, tiny);
    expect(last.zoom).toBeCloseTo(smallView.zoom);
    expect(last.x).toBeCloseTo(smallView.x);
    expect(last.y).toBeCloseTo(smallView.y);

    // No frame moves more than a fixed share of the whole journey, and the zoom stays between its ends.
    const centreOf = (c: { x: number; y: number; zoom: number }) => ({
      x: c.x + square.width / c.zoom / 2,
      y: c.y + square.height / c.zoom / 2
    });
    const travel = {
      x: Math.abs(centreOf(smallView).x - centreOf(wideView).x),
      y: Math.abs(centreOf(smallView).y - centreOf(wideView).y),
      z: Math.abs(Math.log(smallView.zoom) - Math.log(wideView.zoom))
    };
    for (const [index, timed] of t.scenes.entries()) {
      let previous = sceneCamera(t, index, 0, square, tiny);
      for (let frame = 1; frame < timed.frames; frame++) {
        const now = sceneCamera(t, index, frame, square, tiny);
        const step = {
          x: Math.abs(centreOf(now).x - centreOf(previous).x),
          y: Math.abs(centreOf(now).y - centreOf(previous).y),
          z: Math.abs(Math.log(now.zoom) - Math.log(previous.zoom))
        };
        if (index === 0) {
          expect(step.x, `frame ${frame}`).toBeLessThanOrEqual(0.15 * travel.x + 1e-9);
          expect(step.y, `frame ${frame}`).toBeLessThanOrEqual(0.15 * travel.y + 1e-9);
          expect(step.z, `frame ${frame}`).toBeLessThanOrEqual(0.15 * travel.z + 1e-9);
        }
        expect(now.zoom).toBeGreaterThanOrEqual(MIN_ZOOM - 1e-9);
        previous = now;
      }
    }

    // The next scene glides on from exactly where this one stopped, then carries on to its own shot.
    const start = sceneCamera(t, 1, 0, square, tiny);
    expect(start.zoom).toBeCloseTo(last.zoom);
    expect(start.x).toBeCloseTo(last.x);
    expect(start.y).toBeCloseTo(last.y);
    const lowView = frameBox(lowBox, square, viewport, 1.4);
    const settled = sceneCamera(t, 1, GLIDE_FRAMES, square, tiny);
    expect(settled.zoom).toBeCloseTo(lowView.zoom);
    expect(settled.x).toBeCloseTo(lowView.x);
    expect(settled.y).toBeCloseTo(lowView.y);
  });
});

describe("the real story's framing", () => {
  it("keeps every shot's subject inside the frame and clear of the caption band, in both formats", () => {
    for (const scene of SCENES) {
      if (scene.kind !== "capture") continue;
      for (const format of Object.values(FORMATS)) {
        const safe = safeArea(format);
        for (const shot of scene.shots[format.id]) {
          const box = boxOf(capture, shot.mark, shot.box);
          const p = projectBox(frameBox(box, format, capture.viewport, shot.maxZoom), box);
          const inside =
            p.x >= -0.5 &&
            p.y >= -0.5 &&
            p.x + p.width <= safe.width + 0.5 &&
            p.y + p.height <= safe.height + 0.5;
          expect(inside, `${scene.id} ${format.id} ${shot.box}`).toBe(true);
        }
      }
    }
  });

  it("starts a gliding scene exactly where the previous one stopped", () => {
    const t = buildTimeline(SCENES, capture);
    const i = t.scenes.findIndex((s) => s.scene.id === "phone");
    const previous = t.scenes[i - 1];
    if (previous === undefined) throw new Error("no previous scene");
    for (const format of Object.values(FORMATS)) {
      const a = sceneCamera(t, i, 0, format, capture);
      const b = sceneCamera(t, i - 1, previous.frames - 1, format, capture);
      expect(a.zoom).toBeCloseTo(b.zoom);
      expect(a.x).toBeCloseTo(b.x);
      expect(a.y).toBeCloseTo(b.y);
    }
  });
});
