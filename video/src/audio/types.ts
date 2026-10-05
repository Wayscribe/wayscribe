// Copied from Shorts Studio, src/audio/types.ts at commit 5675fc1, and not
// imported from there: later changes in Shorts Studio do not flow in.
// Local changes: added the sine and tick voices to Voice.

export type Voice = "pulse1" | "pulse2" | "triangle" | "noise" | "pad" | "sine" | "tick";

export type NoteEvent = {
  voice: Voice;
  start: number; // seconds
  dur: number; // seconds, before release
  midi: number; // pitch; for noise, the noise clock "pitch"
  vel: number; // 0..1
  duty?: number; // pulse voices only
  slideTo?: number; // MIDI pitch reached at the end of `dur`
  vibrato?: boolean;
  bus?: "duck" | "over"; // SFX only: "over" never ducks the music
};

export type Stereo = { left: Float32Array; right: Float32Array };
