import type { Scene } from "./scenes";

/** The captions in order, as site/public/videos/wayscribe-demo-transcript.txt. */
export function transcript(scenes: readonly Scene[]): string {
  const blocks = scenes.map((scene) =>
    scene.kind === "card" ? scene.lines.join("\n") : scene.caption
  );
  return [
    "Wayscribe demo: finding a lost phone number",
    "",
    "Caption transcript. The video has no narration: these are its on-screen captions, in order.",
    "",
    blocks.join("\n\n"),
    ""
  ].join("\n");
}
