import { describe, expect, it } from "vitest";
import { estimateLines, minSeconds, words } from "../src/captions";
import { captionText, FORMATS, SCENES } from "../src/scenes";

describe("captions", () => {
  it("counts words the way a reader does", () => {
    expect(words("  Search by the account's Salesforce ID. ")).toBe(6);
    expect(words("Looking for pilot teams: pilots@wayscribe.dev")).toBe(5);
  });

  it("asks for 1 second per 3 words plus 1, never under 2.5 seconds", () => {
    expect(minSeconds("one two three four five six")).toBe(3);
    expect(minSeconds("Short.")).toBe(2.5);
  });

  it("estimates wrapped lines conservatively", () => {
    expect(estimateLines("a".repeat(10), 50, 1000)).toBe(1);
    expect(estimateLines("aaaa ".repeat(20).trim(), 50, 300)).toBe(10);
  });
});

describe("the story", () => {
  it("gives every caption at least its reading time", () => {
    for (const scene of SCENES) {
      expect(scene.seconds, scene.id).toBeGreaterThanOrEqual(minSeconds(captionText(scene)));
    }
  });

  it("runs about a minute", () => {
    const total = SCENES.reduce((sum, scene) => sum + scene.seconds, 0);
    expect(total).toBeGreaterThanOrEqual(55);
    expect(total).toBeLessThanOrEqual(65);
  });

  it("uses no em dashes, en dashes or backticks", () => {
    for (const scene of SCENES) expect(captionText(scene), scene.id).not.toMatch(/[\u2013\u2014`]/);
  });

  it("fits every caption on its band's lines in both formats", () => {
    for (const scene of SCENES) {
      if (scene.kind !== "capture") continue;
      for (const format of Object.values(FORMATS)) {
        const lines = estimateLines(scene.caption, format.captionPx, format.captionMaxWidth - 72);
        expect(lines, `${scene.id} ${format.id}`).toBeLessThanOrEqual(format.captionLines);
      }
    }
  });

  it("opens on the hook and closes on the call to pilot teams", () => {
    expect(SCENES[0]?.kind).toBe("card");
    const last = SCENES[SCENES.length - 1];
    expect(last?.kind).toBe("card");
    expect(last === undefined ? "" : captionText(last)).toContain("pilots@wayscribe.dev");
  });

  it("gives every scene a unique id and every capture scene a shot in each format", () => {
    expect(new Set(SCENES.map((scene) => scene.id)).size).toBe(SCENES.length);
    for (const scene of SCENES) {
      if (scene.kind !== "capture") continue;
      for (const format of Object.values(FORMATS)) {
        expect(scene.shots[format.id].length, `${scene.id} ${format.id}`).toBeGreaterThan(0);
        for (const shot of scene.shots[format.id]) expect(shot.maxZoom).toBeLessThanOrEqual(2.2);
      }
    }
  });

  it("sounds a tick only where a highlight lands, and exactly twice", () => {
    const ticking = SCENES.filter((scene) => scene.kind === "capture" && scene.tick === true);
    expect(ticking.map((scene) => scene.id)).toEqual(["phone", "comparison"]);
    for (const scene of ticking)
      if (scene.kind === "capture") expect(scene.highlight).toBeDefined();
  });

  it("glides only into a scene that starts on the frame the previous one froze on", () => {
    SCENES.forEach((scene, index) => {
      if (scene.kind !== "capture" || scene.enter !== "glide") return;
      const previous = SCENES[index - 1];
      expect(previous?.kind).toBe("capture");
      if (previous?.kind === "capture") {
        expect(previous.until).toBeUndefined();
        expect(previous.from).toBe(scene.from);
      }
    });
  });
});
