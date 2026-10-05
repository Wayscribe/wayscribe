import type { Click } from "./capture";
import { clamp01, easeInOutCubic } from "./ease";
import type { Point } from "./geometry";

/** CLICK_LEAD_MS in scripts/demo-video.mjs: the capture waits this long before each click. */
export const LEAD_MS = 800;
export const RIPPLE_MS = 450;

/** Where the drawn cursor is at capture moment `ms`: resting on the last click, gliding to the next over the lead. */
export function cursorAt(clicks: readonly Click[], ms: number, start: Point): Point {
  let previous: Point = start;
  for (const click of clicks) {
    if (click.at <= ms) {
      previous = click;
      continue;
    }
    const t = (ms - (click.at - LEAD_MS)) / LEAD_MS;
    if (t <= 0) break;
    const e = easeInOutCubic(clamp01(t));
    return {
      x: previous.x + (click.x - previous.x) * e,
      y: previous.y + (click.y - previous.y) * e
    };
  }
  return { x: previous.x, y: previous.y };
}

/** The ripple of the latest click, while it lasts. */
export function rippleAt(
  clicks: readonly Click[],
  ms: number
): (Point & { progress: number }) | undefined {
  for (let i = clicks.length - 1; i >= 0; i--) {
    const click = clicks[i] as Click;
    if (click.at > ms) continue;
    const progress = (ms - click.at) / RIPPLE_MS;
    return progress <= 1 ? { x: click.x, y: click.y, progress } : undefined;
  }
  return undefined;
}

/** A scene draws the cursor only when its action holds a click. */
export const showsCursor = (clicks: readonly Click[], fromMs: number, spanMs: number): boolean =>
  clicks.some((click) => click.at >= fromMs && click.at <= fromMs + spanMs);
