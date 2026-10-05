// The story, scene by scene: the single source for order, caption text,
// timing and framing. Every caption has to stay true to what is on screen. If
// the demo changes what it shows, change the caption, not the other way round.

export const FPS = 30;

export type FormatId = "wide" | "square";

export type Format = {
  id: FormatId;
  width: number;
  height: number;
  captionPx: number;
  captionMaxWidth: number;
  captionLines: number;
  captionBottom: number;
  /** Height kept clear at the bottom for the caption; the camera frames subjects above it. */
  band: number;
};

export const FORMATS: Record<FormatId, Format> = {
  wide: {
    id: "wide",
    width: 1920,
    height: 1080,
    captionPx: 48,
    captionMaxWidth: 1600,
    captionLines: 2,
    captionBottom: 48,
    band: 230
  },
  square: {
    id: "square",
    width: 1080,
    height: 1080,
    captionPx: 44,
    captionMaxWidth: 960,
    captionLines: 3,
    captionBottom: 40,
    band: 270
  }
};

/** Frame `box` of mark `mark`, zoomed in no further than `maxZoom` output pixels per CSS pixel. */
export type Shot = { mark: string; box: string; maxZoom: number };

export type Highlight = { mark: string; box: string; tone: "lost" | "kept" };

export type CardScene = {
  id: string;
  kind: "card";
  layout: "statement" | "end";
  lines: string[];
  seconds: number;
};

export type CaptureScene = {
  id: string;
  kind: "capture";
  caption: string;
  seconds: number;
  /** The mark the scene opens on. */
  from: string;
  /** The mark the scene's action runs up to; without one, the scene holds `from`. */
  until?: string;
  /** Fade in over the previous scene, or glide the camera on from where it stopped. */
  enter: "fade" | "glide";
  shots: Record<FormatId, Shot[]>;
  highlight?: Highlight;
  tick?: boolean;
};

export type Scene = CardScene | CaptureScene;

export const captionText = (scene: Scene): string =>
  scene.kind === "card" ? scene.lines.join(" ") : scene.caption;

const same = (mark: string, box: string, maxZoom: number): Record<FormatId, Shot[]> => ({
  wide: [{ mark, box, maxZoom }],
  square: [{ mark, box, maxZoom }]
});

export const SCENES: readonly Scene[] = [
  {
    id: "hook",
    kind: "card",
    layout: "statement",
    lines: ["A phone number left Salesforce.", "It never reached the CRM."],
    seconds: 4.5
  },
  {
    id: "search",
    kind: "capture",
    caption: "Search by the account's Salesforce ID.",
    seconds: 4,
    from: "home",
    until: "results",
    enter: "fade",
    shots: same("home", "query", 1.6)
  },
  {
    id: "results",
    kind: "capture",
    caption: "Two journeys for this account. One completed, one failed.",
    seconds: 5,
    from: "results",
    until: "timeline",
    enter: "fade",
    shots: same("results", "results", 1.5)
  },
  {
    id: "timeline",
    kind: "capture",
    caption: "Delivery failed twice. Was that where the phone was lost?",
    seconds: 5,
    from: "timeline",
    until: "diff",
    enter: "fade",
    shots: same("timeline", "steps", 1.4)
  },
  {
    id: "diff",
    kind: "capture",
    caption: "The transform step: what it received and what it produced.",
    seconds: 5,
    from: "diff",
    enter: "fade",
    shots: {
      wide: [{ mark: "diff", box: "diff", maxZoom: 1.5 }],
      square: [{ mark: "diff", box: "phone", maxZoom: 1.2 }]
    }
  },
  {
    id: "phone",
    kind: "capture",
    // The transform step is shown as a neutral "transformed" badge (Task 1), so no "reported success" wording.
    caption: "The phone goes in with a value and comes out null. This step lost it.",
    seconds: 7,
    from: "diff",
    enter: "glide",
    shots: same("diff", "phone", 2.2),
    highlight: { mark: "diff", box: "phone", tone: "lost" },
    tick: true
  },
  {
    id: "completed",
    kind: "capture",
    caption: "For contrast: this input carried Phone__c, so the phone survived.",
    seconds: 6,
    from: "good-diff",
    enter: "fade",
    shots: same("good-diff", "phone", 1.8),
    highlight: { mark: "good-diff", box: "phone", tone: "kept" }
  },
  {
    id: "replay",
    kind: "capture",
    caption: "Replay the step's recorded input against development, where the fix runs.",
    seconds: 6,
    from: "replay-link",
    until: "replay-response",
    enter: "fade",
    shots: {
      wide: [
        { mark: "replay-link", box: "replay", maxZoom: 1.6 },
        { mark: "replay-form", box: "form", maxZoom: 1.6 }
      ],
      square: [
        { mark: "replay-link", box: "replay", maxZoom: 1.6 },
        { mark: "replay-form", box: "form", maxZoom: 1.6 }
      ]
    }
  },
  {
    id: "response",
    kind: "capture",
    caption: "The fixed transform answers 200.",
    seconds: 3,
    from: "replay-response",
    enter: "fade",
    shots: same("replay-response", "response", 1.8)
  },
  {
    id: "comparison",
    kind: "capture",
    caption: "Original against replay: null before, the phone number after.",
    seconds: 6,
    from: "comparison",
    enter: "fade",
    shots: same("comparison", "phone", 2.0),
    highlight: { mark: "comparison", box: "phone", tone: "kept" },
    tick: true
  },
  {
    id: "end",
    kind: "card",
    layout: "end",
    lines: [
      "Wayscribe",
      "Follow one record through every service, see what each step changed, and replay it.",
      "Self-hosted and open source: wayscribe.dev",
      "Looking for pilot teams: pilots@wayscribe.dev"
    ],
    seconds: 10
  }
];
