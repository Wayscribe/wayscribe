import { expect, it } from "vitest";
import { SCENES } from "../src/scenes";
import { transcript } from "../src/transcript";

it("lists every caption in order, cards line by line, with no dashes", () => {
  const text = transcript(SCENES);
  let at = 0;
  for (const scene of SCENES) {
    for (const line of scene.kind === "card" ? scene.lines : [scene.caption]) {
      const found = text.indexOf(line, at);
      expect(found, line).toBeGreaterThanOrEqual(at);
      at = found + line.length;
    }
  }
  expect(text).not.toMatch(/[\u2013\u2014]/);
  expect(text.startsWith("Wayscribe demo: finding a lost phone number\n")).toBe(true);
  expect(text.endsWith("\n")).toBe(true);
});
