import { describe, expect, it } from "vitest";
import { cursorAt, LEAD_MS, RIPPLE_MS, rippleAt, showsCursor } from "../src/cursor";

const clicks = [
  { at: 1000, x: 100, y: 100 },
  { at: 3000, x: 500, y: 300 }
];
const start = { x: 960, y: 540 };

describe("the drawn cursor", () => {
  it("rests at the start until the lead before the first click", () => {
    expect(cursorAt(clicks, 100, start)).toEqual(start);
  });

  it("arrives on each click exactly as it lands", () => {
    expect(cursorAt(clicks, 1000, start)).toEqual({ x: 100, y: 100 });
    expect(cursorAt(clicks, 3000, start)).toEqual({ x: 500, y: 300 });
  });

  it("glides over the lead, halfway at its middle", () => {
    expect(cursorAt(clicks, 3000 - LEAD_MS / 2, start)).toEqual({ x: 300, y: 200 });
  });

  it("rests on the last click between glides", () => {
    expect(cursorAt(clicks, 2000, start)).toEqual({ x: 100, y: 100 });
  });

  it("ripples for a moment after a click, then stops", () => {
    expect(rippleAt(clicks, 1000)?.progress).toBe(0);
    expect(rippleAt(clicks, 1000 + RIPPLE_MS / 2)?.progress).toBeCloseTo(0.5);
    expect(rippleAt(clicks, 1000 + RIPPLE_MS + 1)).toBeUndefined();
    expect(rippleAt(clicks, 500)).toBeUndefined();
  });

  it("shows only in scenes whose action holds a click", () => {
    expect(showsCursor(clicks, 0, 1500)).toBe(true);
    expect(showsCursor(clicks, 1500, 1000)).toBe(false);
  });
});
