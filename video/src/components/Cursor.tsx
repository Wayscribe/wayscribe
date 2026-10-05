import type { Point } from "../geometry";
import { INK, POINTER } from "../theme";

/** A drawn pointer (Playwright's capture shows none), with a ripple as a click lands. */
export const Cursor = ({ at, ripple }: { at: Point; ripple?: Point & { progress: number } }) => (
  <>
    {ripple === undefined ? null : (
      <div
        style={{
          position: "absolute",
          left: ripple.x - (12 + 30 * ripple.progress),
          top: ripple.y - (12 + 30 * ripple.progress),
          width: 2 * (12 + 30 * ripple.progress),
          height: 2 * (12 + 30 * ripple.progress),
          borderRadius: "50%",
          border: `4px solid ${POINTER}`,
          opacity: 0.6 * (1 - ripple.progress)
        }}
      />
    )}
    <svg
      style={{ position: "absolute", left: at.x - 6, top: at.y - 3 }}
      width={36}
      height={36}
      viewBox="0 0 24 24"
    >
      <path
        d="M4 2 L4 20 L9 15 L12.5 22 L15.5 20.5 L12 13.5 L19 13.5 Z"
        fill="#ffffff"
        stroke={INK}
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
    </svg>
  </>
);
