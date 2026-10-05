import { describe, expect, it } from "vitest";
import {
  clickPoint,
  frameAt,
  manifestProblems,
  reviewFilter,
  toBox,
  unionBox,
  type Manifest
} from "../scripts/demo-capture-lib.mjs";

const VIEWPORT = { width: 1920, height: 1080 };

describe("demo capture geometry", () => {
  it("measures a box in whole pixels without shrinking it", () => {
    expect(toBox({ x: 10.4, y: 20.6, width: 100.2, height: 30.1 }, "row", VIEWPORT)).toEqual({
      x: 10,
      y: 20,
      width: 101,
      height: 31
    });
  });

  it("clips a box to the viewport, so a table running below the fold is framed by what shows", () => {
    expect(toBox({ x: 100, y: 900, width: 400, height: 500 }, "table", VIEWPORT)).toEqual({
      x: 100,
      y: 900,
      width: 400,
      height: 180
    });
  });

  it("refuses a box that is missing, empty or wholly off screen, naming it", () => {
    expect(() => toBox(null, "query", VIEWPORT)).toThrow(/"query"/);
    expect(() => toBox({ x: 0, y: 0, width: 0, height: 10 }, "query", VIEWPORT)).toThrow(/"query"/);
    expect(() => toBox({ x: 0, y: 1200, width: 10, height: 10 }, "query", VIEWPORT)).toThrow(
      /"query"/
    );
  });

  it("refuses an empty box even at a fractional position, where rounding would grow it to 1 px", () => {
    expect(() => toBox({ x: 10.5, y: 10, width: 0, height: 10 }, "query", VIEWPORT)).toThrow(
      /"query"/
    );
    expect(() => toBox({ x: 10, y: 10.5, width: 10, height: 0 }, "query", VIEWPORT)).toThrow(
      /"query"/
    );
    expect(() => toBox({ x: 10.5, y: 10.5, width: -4, height: 10 }, "query", VIEWPORT)).toThrow(
      /"query"/
    );
  });

  it("clamps a box that starts left of or above the viewport to what shows", () => {
    expect(toBox({ x: -20, y: -10, width: 100, height: 50 }, "banner", VIEWPORT)).toEqual({
      x: 0,
      y: 0,
      width: 80,
      height: 40
    });
  });

  it("refuses a box wholly off screen to the right or above, naming it", () => {
    expect(() => toBox({ x: 2000, y: 0, width: 10, height: 10 }, "query", VIEWPORT)).toThrow(
      /"query"/
    );
    expect(() => toBox({ x: 0, y: -50, width: 10, height: 10 }, "query", VIEWPORT)).toThrow(
      /"query"/
    );
  });

  it("joins boxes into the smallest box holding them all", () => {
    expect(
      unionBox([
        { x: 10, y: 10, width: 10, height: 10 },
        { x: 30, y: 5, width: 5, height: 40 }
      ])
    ).toEqual({ x: 10, y: 5, width: 25, height: 40 });
    expect(() => unionBox([])).toThrow();
  });

  it("clicks the middle of a small target and near the left of a wide row", () => {
    expect(clickPoint({ x: 100, y: 100, width: 80, height: 40 })).toEqual({ x: 140, y: 120 });
    expect(clickPoint({ x: 100, y: 100, width: 1200, height: 40 })).toEqual({ x: 220, y: 120 });
  });

  it("finds the frame on screen at a moment: the last one captured at or before it", () => {
    const frames = [
      { at: 0, file: "a" },
      { at: 100, file: "b" },
      { at: 250, file: "c" }
    ];
    expect(frameAt(frames, -5).file).toBe("a");
    expect(frameAt(frames, 100).file).toBe("b");
    expect(frameAt(frames, 249).file).toBe("b");
    expect(frameAt(frames, 9_999).file).toBe("c");
  });

  it("refuses to find a frame in a capture that has none", () => {
    expect(() => frameAt([], 0)).toThrow(/no frames/);
  });

  it("outlines every box of a mark in device pixels for the review stills", () => {
    expect(reviewFilter({ a: { x: 1, y: 2, width: 3, height: 4 } }, 2)).toBe(
      "drawbox=x=2:y=4:w=6:h=8:color=red@0.9:t=8"
    );
    expect(reviewFilter({}, 2)).toBe("null");
  });

  it("joins one drawbox filter per box with a comma", () => {
    expect(
      reviewFilter(
        {
          a: { x: 1, y: 2, width: 3, height: 4 },
          b: { x: 5, y: 6, width: 7, height: 8 }
        },
        2
      )
    ).toBe(
      "drawbox=x=2:y=4:w=6:h=8:color=red@0.9:t=8," + "drawbox=x=10:y=12:w=14:h=16:color=red@0.9:t=8"
    );
  });
});

describe("demo capture manifest", () => {
  const good = (): Manifest => ({
    version: 1,
    viewport: VIEWPORT,
    scale: 2,
    frames: [
      { at: 0, file: "frames/000000.png" },
      { at: 40, file: "frames/000001.png" }
    ],
    marks: [
      { name: "home", at: 10, boxes: { query: { x: 0, y: 0, width: 10, height: 10 } } },
      { name: "results", at: 30, boxes: {} }
    ],
    clicks: [{ at: 20, x: 5, y: 5 }]
  });

  it("accepts a well-formed capture", () => {
    expect(manifestProblems(good())).toEqual([]);
  });

  it("names every problem a render would trip on", () => {
    const bad = good();
    bad.frames = [];
    bad.marks.push({
      name: "home",
      at: 5,
      boxes: { query: { x: 1900, y: 0, width: 40, height: 10 } }
    });
    bad.clicks.push({ at: 50, x: 2000, y: 5 });
    expect(manifestProblems(bad)).toEqual([
      "The capture has no frames.",
      'Mark "home" appears twice.',
      'Box "query" of mark "home" leaves the 1920x1080 viewport.',
      'Mark "home" is earlier than "results".',
      "Click at 50 ms is off screen."
    ]);
  });

  it("accepts a click on the last pixel of the viewport but not on its far edge", () => {
    const edge = good();
    edge.clicks = [{ at: 20, x: 1919, y: 1079 }];
    expect(manifestProblems(edge)).toEqual([]);

    const pastRight = good();
    pastRight.clicks = [{ at: 50, x: 1920, y: 5 }];
    expect(manifestProblems(pastRight)).toEqual(["Click at 50 ms is off screen."]);

    const pastBottom = good();
    pastBottom.clicks = [{ at: 60, x: 5, y: 1080 }];
    expect(manifestProblems(pastBottom)).toEqual(["Click at 60 ms is off screen."]);

    const corner = good();
    corner.clicks = [{ at: 70, x: 1920, y: 1080 }];
    expect(manifestProblems(corner)).toEqual(["Click at 70 ms is off screen."]);
  });

  it("refuses a box with no width or height, which ffmpeg would draw across the whole frame", () => {
    const flat = good();
    flat.marks[0] = {
      name: "home",
      at: 10,
      boxes: { query: { x: 5, y: 5, width: 0, height: 10 } }
    };
    expect(manifestProblems(flat)).toEqual(['Box "query" of mark "home" has no size.']);

    const thin = good();
    thin.marks[0] = {
      name: "home",
      at: 10,
      boxes: { query: { x: 5, y: 5, width: 10, height: 0 } }
    };
    expect(manifestProblems(thin)).toEqual(['Box "query" of mark "home" has no size.']);

    const inverted = good();
    inverted.marks[0] = {
      name: "home",
      at: 10,
      boxes: { query: { x: 5, y: 5, width: -10, height: 10 } }
    };
    expect(manifestProblems(inverted)).toEqual(['Box "query" of mark "home" has no size.']);
  });

  it("catches frames out of order", () => {
    const bad = good();
    bad.frames.reverse();
    expect(manifestProblems(bad)).toEqual(["Frame 1 is earlier than frame 0."]);
  });
});
