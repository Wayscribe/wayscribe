import { describe, expect, it } from "vitest";
import { terminalSafe } from "./terminal-safe.js";

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
    const bidi = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
    for (const code of bidi) {
      expect(terminalSafe(`x${String.fromCodePoint(code)}y`)).toBe(`x\\u{${code.toString(16)}}y`);
    }
  });

  it("leaves printable text, including non-ASCII, unchanged", () => {
    const text = "Zoë 東京 café — Ünïcödé 🚀 SF…99 \\n already-literal";
    expect(terminalSafe(text)).toBe(text);
  });
});
