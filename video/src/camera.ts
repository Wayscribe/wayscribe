import { boxOf, type Capture, markNamed } from "./capture";
import { clamp01, easeInOutCubic } from "./ease";
import type { Box, Point } from "./geometry";
import type { CaptureScene, Format } from "./scenes";
import { frameAtSourceMs, GLIDE_FRAMES, type Timeline, type TimedScene } from "./timeline";

/** A view of the page: its top-left corner in CSS pixels, and output pixels per CSS pixel. */
export type Camera = { x: number; y: number; zoom: number };
type Viewport = { width: number; height: number };

/** Space kept around a subject, in CSS pixels. */
export const PADDING = 32;

/**
 * The least zoom the camera will use. A subject that needs less to fit above
 * the caption band is not framed: the story's framing test fails for it.
 */
export const MIN_ZOOM = 0.8;

/**
 * What the camera shows where its window leaves the page. The app's pages are
 * plain white outside the content column and past the nav and footer
 * (checked on the real capture's frames), so this padding is invisible.
 */
export const PAGE_BACKGROUND = "#ffffff";

/** Slack, in output pixels, when asking whether a projected box is inside the safe area. */
const TOLERANCE = 0.5;

/** The part of the frame above the caption band, where subjects are framed. */
export const safeArea = (format: Format): Box => ({
  x: 0,
  y: 0,
  width: format.width,
  height: format.height - format.band
});

/** The least zoom that still fills the frame with page: the preferred floor. */
export const minZoom = (format: Format, viewport: Viewport): number =>
  Math.max(format.width / viewport.width, format.height / viewport.height);

/**
 * Keeps the window on the page. Where the window is bigger than the page
 * (zoom below the preferred floor) it keeps covering the page instead:
 * horizontally it centres the page, vertically it slides over the page.
 */
export function clampCamera(c: Camera, format: Format, viewport: Viewport): Camera {
  const w = format.width / c.zoom;
  const h = format.height / c.zoom;
  const x =
    w >= viewport.width ? (viewport.width - w) / 2 : Math.min(Math.max(0, c.x), viewport.width - w);
  const y =
    h >= viewport.height
      ? Math.min(Math.max(viewport.height - h, c.y), 0)
      : Math.min(Math.max(0, c.y), viewport.height - h);
  return { zoom: c.zoom, x, y };
}

export const project = (c: Camera, p: Point): Point => ({
  x: (p.x - c.x) * c.zoom,
  y: (p.y - c.y) * c.zoom
});

export const projectBox = (c: Camera, b: Box): Box => ({
  x: (b.x - c.x) * c.zoom,
  y: (b.y - c.y) * c.zoom,
  width: b.width * c.zoom,
  height: b.height * c.zoom
});

/** Whether `box`, seen through `c`, lies inside the safe area: in frame and clear of the caption band. */
function isFramed(box: Box, c: Camera, format: Format): boolean {
  const safe = safeArea(format);
  const p = projectBox(c, box);
  return (
    p.x >= -TOLERANCE &&
    p.y >= -TOLERANCE &&
    p.x + p.width <= safe.width + TOLERANCE &&
    p.y + p.height <= safe.height + TOLERANCE
  );
}

/**
 * The view that frames `box` in the safe area, as close as `maxZoom` allows.
 *
 * The preferred framing keeps the zoom at or above the page-filling floor and
 * the window on the page. Only when that cannot put the whole box in the safe
 * area does the camera relax, and then only as far as the box needs:
 * - zoom drops below the floor to the zoom at which the box and its margin fit
 *   (never below MIN_ZOOM; a box needing less is left to the preferred framing,
 *   which does not frame it);
 * - below zoom 1 the window can be taller than the page, and then the subject
 *   stays centred in the safe area (while the window still covers the page), so
 *   padding may fall above and below the page; this is intended. Otherwise the
 *   window leaves the page only vertically, and only as far as the caption band
 *   needs: it keeps the box's margin clear of the band (a box low on a page at
 *   its maximum scroll) and the box's top in frame. A window wider than the
 *   page centres the page horizontally.
 */
export function frameBox(box: Box, format: Format, viewport: Viewport, maxZoom: number): Camera {
  const safe = safeArea(format);
  const fit = Math.min(
    safe.width / (box.width + 2 * PADDING),
    safe.height / (box.height + 2 * PADDING)
  );
  const floor = minZoom(format, viewport);
  const aim = (zoom: number): Camera => ({
    zoom,
    x: box.x + box.width / 2 - (safe.x + safe.width / 2) / zoom,
    y: box.y + box.height / 2 - (safe.y + safe.height / 2) / zoom
  });
  const preferred = clampCamera(aim(Math.max(floor, Math.min(maxZoom, fit))), format, viewport);
  if (isFramed(box, preferred, format) || fit < MIN_ZOOM) return preferred;
  // No clamp to MIN_ZOOM is needed: fit >= MIN_ZOOM here, and maxZoom and the floor are at least 1 for the story's shots and page.
  const zoom = Math.min(fit, Math.max(maxZoom, floor));
  const onPage = clampCamera(aim(zoom), format, viewport);
  // The least y that keeps the box's margin above the band, and the greatest that keeps its top in frame.
  const lowest = box.y + box.height + PADDING - safe.height / zoom;
  // A guard: for a box inside the page neither bound exceeds box.y, so it only matters for a box that starts above the page.
  const highest = box.y;
  return { ...onPage, y: Math.min(Math.max(onPage.y, lowest), highest) };
}

const centre = (c: Camera, format: Format): Point => ({
  x: c.x + format.width / c.zoom / 2,
  y: c.y + format.height / c.zoom / 2
});

/**
 * The widest view about the same centre: where a scene that fades in starts
 * its zoom. A target already at or below the page-filling floor is its own
 * widest view, so a fade never zooms in to arrive.
 */
export function widest(target: Camera, format: Format, viewport: Viewport): Camera {
  const zoom = Math.min(minZoom(format, viewport), target.zoom);
  if (zoom === target.zoom) return target;
  const c = centre(target, format);
  return clampCamera(
    { zoom, x: c.x - format.width / zoom / 2, y: c.y - format.height / zoom / 2 },
    format,
    viewport
  );
}

/** Between two views at progress `t`: zoom moves geometrically and the centre linearly, eased. */
export function between(a: Camera, b: Camera, t: number, format: Format): Camera {
  const e = easeInOutCubic(clamp01(t));
  const zoom = Math.exp(Math.log(a.zoom) + (Math.log(b.zoom) - Math.log(a.zoom)) * e);
  const ca = centre(a, format);
  const cb = centre(b, format);
  const cx = ca.x + (cb.x - ca.x) * e;
  const cy = ca.y + (cb.y - ca.y) * e;
  return { zoom, x: cx - format.width / zoom / 2, y: cy - format.height / zoom / 2 };
}

/**
 * `between`, with the window kept inside the page and the two views it glides
 * between. Between views that are both on the page this is the plain clamp to
 * the page; a view that leaves the page (padding below a low subject, or a zoom
 * below 1) lets the glide leave it too, so the camera does not swerve onto the
 * page and back as it crosses zoom 1.
 */
export function glide(a: Camera, b: Camera, t: number, format: Format, viewport: Viewport): Camera {
  const raw = between(a, b, t, format);
  const [wa, ha] = [format.width / a.zoom, format.height / a.zoom];
  const [wb, hb] = [format.width / b.zoom, format.height / b.zoom];
  const [w, h] = [format.width / raw.zoom, format.height / raw.zoom];
  const within = (v: number, size: number, lo: number, hi: number) =>
    Math.min(Math.max(v, lo), hi - size);
  return {
    zoom: raw.zoom,
    x: within(raw.x, w, Math.min(0, a.x, b.x), Math.max(viewport.width, a.x + wa, b.x + wb)),
    y: within(raw.y, h, Math.min(0, a.y, b.y), Math.max(viewport.height, a.y + ha, b.y + hb))
  };
}

/**
 * The camera `frame` frames into capture scene `index`. Each shot takes over
 * when the capture reaches its mark, and the camera glides to it over
 * GLIDE_FRAMES: from the previous shot, from where the previous scene stopped
 * (a "glide" entrance), or from the widest view (a "fade" entrance).
 */
export function sceneCamera(
  timeline: Timeline,
  index: number,
  frame: number,
  format: Format,
  capture: Capture
): Camera {
  const timed = timeline.scenes[index] as TimedScene;
  const scene = timed.scene as CaptureScene;
  const shots = scene.shots[format.id];
  const views = shots.map((shot) =>
    frameBox(boxOf(capture, shot.mark, shot.box), format, capture.viewport, shot.maxZoom)
  );
  const starts = shots.map((shot, i) =>
    i === 0 ? 0 : frameAtSourceMs(timed, markNamed(capture, shot.mark).at, timeline.fps)
  );
  let active = 0;
  while (active + 1 < shots.length && frame >= (starts[active + 1] ?? Infinity)) active++;
  const target = views[active] as Camera;
  let origin: Camera;
  if (active > 0) origin = views[active - 1] as Camera;
  else if (scene.enter === "glide" && index > 0) {
    const previous = timeline.scenes[index - 1] as TimedScene;
    origin = sceneCamera(timeline, index - 1, previous.frames - 1, format, capture);
  } else origin = widest(target, format, capture.viewport);
  const t = (frame - (starts[active] ?? 0)) / GLIDE_FRAMES;
  return glide(origin, target, t, format, capture.viewport);
}
