/**
 * Pure helpers for the demo capture in scripts/demo-video.mjs: geometry, the
 * capture manifest (marks.json) and the review stills' filter. Kept apart so
 * they can be tested without a browser or a stack.
 *
 * Boxes are CSS pixels relative to the viewport, as Playwright measures them.
 * The frames are captured at `scale` device pixels per CSS pixel.
 */

/** A measured box in whole CSS pixels, grown rather than shrunk, and clipped to the viewport. */
export function toBox(box, name, viewport) {
  if (box === null || box === undefined) {
    throw new Error(`Nothing measurable for "${name}": is it on the page?`);
  }
  const x = Math.max(0, Math.floor(box.x));
  const y = Math.max(0, Math.floor(box.y));
  const right = Math.min(viewport.width, Math.ceil(box.x + box.width));
  const bottom = Math.min(viewport.height, Math.ceil(box.y + box.height));
  if (right <= x || bottom <= y) throw new Error(`Nothing of "${name}" is on screen.`);
  return { x, y, width: right - x, height: bottom - y };
}

/** The smallest box holding every box given. */
export function unionBox(boxes) {
  if (boxes.length === 0) throw new Error("No boxes to join.");
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x, y, width: right - x, height: bottom - y };
}

/** Where a click on `box` lands: its middle, but no more than 120 px in from the left of a wide row. */
export function clickPoint(box) {
  return {
    x: Math.round(box.x + Math.min(box.width / 2, 120)),
    y: Math.round(box.y + box.height / 2)
  };
}

/** The frame on screen at `at` ms: the last one captured at or before it (the first, before any). */
export function frameAt(frames, at) {
  if (frames.length === 0) throw new Error("The capture has no frames.");
  let low = 0;
  let high = frames.length - 1;
  if (at <= frames[0].at) return frames[0];
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (frames[middle].at <= at) low = middle;
    else high = middle - 1;
  }
  return frames[low];
}

/** Problems with a capture manifest, as sentences; empty when a render can use it. */
export function manifestProblems(manifest) {
  const { viewport, frames, marks, clicks } = manifest;
  const problems = [];
  if (frames.length === 0) problems.push("The capture has no frames.");
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].at < frames[i - 1].at) {
      problems.push(`Frame ${String(i)} is earlier than frame ${String(i - 1)}.`);
      break;
    }
  }
  const seen = new Set();
  for (const mark of marks) {
    if (seen.has(mark.name)) problems.push(`Mark "${mark.name}" appears twice.`);
    seen.add(mark.name);
    for (const [key, box] of Object.entries(mark.boxes)) {
      const inside =
        box.x >= 0 &&
        box.y >= 0 &&
        box.x + box.width <= viewport.width &&
        box.y + box.height <= viewport.height;
      if (!inside) {
        problems.push(
          `Box "${key}" of mark "${mark.name}" leaves the ${String(viewport.width)}x${String(viewport.height)} viewport.`
        );
      }
    }
  }
  for (let i = 1; i < marks.length; i++) {
    if (marks[i].at < marks[i - 1].at) {
      problems.push(`Mark "${marks[i].name}" is earlier than "${marks[i - 1].name}".`);
    }
  }
  for (const click of clicks) {
    if (click.x < 0 || click.y < 0 || click.x > viewport.width || click.y > viewport.height) {
      problems.push(`Click at ${String(click.at)} ms is off screen.`);
    }
  }
  return problems;
}

/** An ffmpeg filter outlining every box of a mark on a frame captured at `scale`. */
export function reviewFilter(boxes, scale) {
  const filters = Object.values(boxes).map(
    (box) =>
      `drawbox=x=${String(box.x * scale)}:y=${String(box.y * scale)}:w=${String(box.width * scale)}` +
      `:h=${String(box.height * scale)}:color=red@0.9:t=${String(4 * scale)}`
  );
  return filters.length === 0 ? "null" : filters.join(",");
}
