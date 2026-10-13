import { describe, expect, it } from "vitest";
import { jsonSafe, terminalSafe, terminalSafeWithin } from "./terminal-safe.js";

describe("terminalSafe", () => {
  it("shows an ESC sequence instead of letting the terminal run it", () => {
    expect(terminalSafe("a\u001b[2Jb")).toBe("a\\x1b[2Jb");
  });

  it("shows line breaks and tabs as their usual escapes", () => {
    expect(terminalSafe("one\ntwo\r\tthree")).toBe("one\\ntwo\\r\\tthree");
  });

  it("escapes every C0 character and DEL", () => {
    for (let code = 0; code <= 0x1f; code += 1) {
      const out = terminalSafe(String.fromCodePoint(code));
      expect(out.startsWith("\\")).toBe(true);
      expect(out).toMatch(/^[\x20-\x7e]+$/);
    }
    expect(terminalSafe("\u0000\u0007\u007f")).toBe("\\x00\\x07\\x7f");
  });

  it("escapes C1 characters, which some terminals read as CSI and OSC", () => {
    expect(terminalSafe("a\u009b2Jb\u0085c")).toBe("a\\u{9b}2Jb\\u{85}c");
    for (let code = 0x80; code <= 0x9f; code += 1) {
      expect(terminalSafe(String.fromCodePoint(code))).toBe(`\\u{${code.toString(16)}}`);
    }
  });

  it("escapes bidi embedding, override and isolate characters", () => {
    const bidi = [
      0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069
    ];
    for (const code of bidi) {
      expect(terminalSafe(`x${String.fromCodePoint(code)}y`)).toBe(`x\\u{${code.toString(16)}}y`);
    }
  });

  it("leaves printable text, including non-ASCII, unchanged", () => {
    const text = "Zoë 東京 café — Ünïcödé 🚀 SF…99 \\n already-literal";
    expect(terminalSafe(text)).toBe(text);
  });

  describe("terminalSafeWithin", () => {
    it("escapes text that fits without cutting it", () => {
      expect(terminalSafeWithin("a\u001bb", 6)).toBe("a\\x1bb");
    });

    it("bounds the escaped width and never cuts an escape", () => {
      const out = terminalSafeWithin("ab\u001b\u001bcdef", 8);
      // "ab" + "\x1b" is 6; the next escape would pass 7, so the line ends.
      expect(out).toBe("ab\\x1b…");
      expect(out.length).toBeLessThanOrEqual(8);
      for (let width = 2; width <= 20; width += 1) {
        const cut = terminalSafeWithin("\u001b\u009b\u202e".repeat(4), width);
        expect(cut.length).toBeLessThanOrEqual(width);
        expect(cut.replace(/…$/, "")).toMatch(/^(\\x1b|\\u\{9b\}|\\u\{202e\})*$/);
      }
    });

    it("keeps a surrogate pair whole", () => {
      expect(terminalSafeWithin("ab🚀🚀", 5)).toBe("ab🚀…");
    });
  });

  describe("jsonSafe", () => {
    it("writes DEL, C1 and bidi characters as JSON \\uXXXX escapes", () => {
      const value = { k: "a\u007fb\u009bc\u202ed\u061ce\u200ff", "\u2066": "東京 🚀" };
      const text = jsonSafe(JSON.stringify(value, null, 2));
      expect(text).toContain('"a\\u007fb\\u009bc\\u202ed\\u061ce\\u200ff"');
      expect(text).toContain('"\\u2066": "東京 🚀"');
      expect(text).not.toMatch(/[\u007f-\u009f\p{Bidi_Control}]/u);
      expect(JSON.parse(text)).toEqual(value);
    });
  });
});
