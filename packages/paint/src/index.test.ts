import { describe, expect, it } from "vite-plus/test";

import { compile, DEFAULT_TRANSITION, ease, PaintState } from "./index.ts";

const spec = {
  width: { type: "float", default: 4, minimum: 0 },
  color: { type: "color", default: [1, 1, 1, 1] },
  heading: { type: "rotation", default: 0 },
} as const;
const names = ["width", "color", "heading"] as const;

describe("compile", () => {
  it("accepts literal numbers and camera expressions", () => {
    expect(compile(spec.width, "width", 12)(0)).toEqual([12]);
    const zoomed = compile(spec.width, "width", [
      "interpolate",
      ["linear"],
      ["zoom"],
      0,
      4,
      10,
      14,
    ]);
    expect(zoomed(5)[0]).toBeCloseTo(9);
  });

  it("premultiplies colors from CSS strings and float arrays", () => {
    expect(compile(spec.color, "color", "rgba(255, 0, 0, 0.5)")(0)).toEqual([
      0.5, 0, 0, 0.5,
    ]);
    expect(compile(spec.color, "color", [1, 0.5, 0, 0.5])(0)).toEqual([
      0.5, 0.25, 0, 0.5,
    ]);
  });

  it("rejects invalid values", () => {
    expect(() => compile(spec.color, "color", "not a color")).toThrow();
    expect(() => compile(spec.width, "width", "twelve")).toThrow();
  });
});

describe("ease", () => {
  it("matches cubic-bezier(0, 0, 0.25, 1)", () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeGreaterThan(0.5);
  });
});

describe("PaintState", () => {
  it("starts from defaults, sets values with transitions, and serializes", () => {
    const state = new PaintState(spec, names, DEFAULT_TRANSITION, {
      width: 10,
      "color-transition": { duration: 50 },
    });
    expect(state.get("width")).toBe(10);
    expect(state.evaluate(0, 0)).toEqual({
      width: [10],
      color: [1, 1, 1, 1],
      heading: [0],
    });
    state.set("width", 20, 1000);
    expect(state.evaluate(0, 1000).width).toEqual([10]);
    expect(state.evaluate(0, 1150).width[0]).toBeCloseTo(10 + 10 * ease(0.5));
    expect(state.active(1200)).toBe(true);
    expect(state.evaluate(0, 1300).width).toEqual([20]);
    expect(state.active(1300)).toBe(false);
    // Per-property transitions override the default duration.
    state.set("color", [0, 0, 0, 1], 2000);
    expect(state.evaluate(0, 2050).color).toEqual([0, 0, 0, 1]);
    // Rotations take the shortest arc.
    state.set("heading", 350, 3000);
    state.set("heading", 10, 3300);
    // Rotations take the shortest arc, so 350 -> 10 passes through 360.
    expect(state.evaluate(0, 3450).heading[0]).toBeCloseTo(
      350 + 20 * ease(0.5),
    );
    expect(state.toJson()).toEqual({
      width: 20,
      color: [0, 0, 0, 1],
      heading: 10,
      "color-transition": { duration: 50 },
    });
    expect(() => state.set("nope", 1, 0)).toThrow();
    expect(() => state.set("width", "wide", 0)).toThrow();
    expect(state.get("width")).toBe(20);
  });
});
