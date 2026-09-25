import { describe, expect, it } from "vite-plus/test";

import { comp, el, fl, k, layer } from "./lottie.testing.ts";
import { evaluateFrame } from "./scene.ts";
import { deltaE, parseHex, slotOf, srgbToLab } from "./slots.ts";

describe("deltaE", () => {
  it("is the CIE76 distance in Lab under D65", () => {
    const [l, a, b] = srgbToLab([1, 1, 1]);
    expect(l).toBeCloseTo(100, 3);
    expect(a).toBeCloseTo(0, 3);
    expect(b).toBeCloseTo(0, 3);
    // sRGB red is about L 53.24, a 80.09, b 67.20.
    const red = srgbToLab([1, 0, 0]);
    expect(red[0]).toBeCloseTo(53.24, 1);
    expect(red[1]).toBeCloseTo(80.09, 1);
    expect(red[2]).toBeCloseTo(67.2, 1);
    expect(deltaE([0, 0, 0], [1, 1, 1])).toBeCloseTo(100, 3);
  });
});

describe("slotOf", () => {
  const red = parseHex("#e53935");

  it("keeps a slot the Lottie color names", () => {
    expect(slotOf(red, 1)).toBe(1);
    expect(slotOf(red, 2)).toBe(2);
    expect(slotOf(red, 0)).toBe(0);
  });

  it("matches listed colors within a difference of 2", () => {
    const rule = { colors: { primary: ["#e53935"], secondary: ["#1e88e5"] } };
    expect(slotOf(parseHex("#e53a35"), 0, rule)).toBe(1);
    expect(slotOf(parseHex("#1e88e6"), 0, rule)).toBe(2);
    // A visibly different red stays authored.
    expect(slotOf(parseHex("#f44336"), 0, rule)).toBe(0);
  });

  it("puts every solid paint in the primary slot with tint", () => {
    expect(slotOf(red, 0, { tint: true })).toBe(1);
    expect(slotOf(red, 2, { tint: true })).toBe(1);
  });

  it("rejects malformed colors", () => {
    expect(() => parseHex("red")).toThrow(/#rrggbb/);
  });
});

describe("slots in the scene", () => {
  const scene = (sid: string, ignore: string[] = []) =>
    evaluateFrame(
      comp(
        [layer([el(0, 0), fl(0, 0, 0, { c: { a: 0, k: [0, 0, 0, 1], sid } })])],
        { slots: { [sid]: { p: k([0, 0.5, 1, 1]) } } },
      ),
      0,
      { ignore: new Set(ignore) },
    );

  it("resolves the primary and secondary slots and marks the paint", () => {
    expect(scene("primary")[0]?.paint).toEqual({
      kind: "solid",
      color: [0, 0.5, 1],
      slot: 1,
    });
    expect(scene("secondary")[0]?.paint).toMatchObject({ slot: 2 });
  });

  it("uses the slot's value but no slot when the entry ignores color slots", () => {
    expect(scene("primary", ["color-slots"])[0]?.paint).toMatchObject({
      color: [0, 0.5, 1],
      slot: 0,
    });
  });
});
