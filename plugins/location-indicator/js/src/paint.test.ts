import { describe, expect, it } from "vite-plus/test";

import { compile, DEFAULT_TRANSITION, ease, PaintValue } from "./paint.ts";

describe("compile", () => {
  it("accepts literal numbers and camera expressions", () => {
    expect(compile("puck-radius", 12)(0)).toEqual([12]);
    const zoomed = compile("puck-radius", [
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
    expect(compile("puck-color", "rgba(255, 0, 0, 0.5)")(0)).toEqual([
      0.5, 0, 0, 0.5,
    ]);
    expect(compile("puck-color", [1, 0.5, 0, 0.5])(0)).toEqual([
      0.5, 0.25, 0, 0.5,
    ]);
    expect(compile("puck-color", "#0000ff")(0)).toEqual([0, 0, 1, 1]);
  });

  it("accepts positions as [latitude, longitude]", () => {
    expect(compile("position", [37.7, -122.4])(0)).toEqual([37.7, -122.4]);
  });

  it("rejects invalid values", () => {
    expect(() => compile("puck-color", "not a color")).toThrow();
    expect(() => compile("puck-radius", "twelve")).toThrow();
    expect(() => compile("position", [1])).toThrow();
  });
});

describe("ease", () => {
  it("matches cubic-bezier(0, 0, 0.25, 1)", () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeGreaterThan(0.5);
    expect(ease(0.25)).toBeLessThan(ease(0.5));
  });
});

describe("PaintValue", () => {
  it("transitions from the prior value over the duration", () => {
    const value = new PaintValue("puck-radius", compile("puck-radius", 0));
    value.retarget(compile("puck-radius", 10), 1000, DEFAULT_TRANSITION);
    expect(value.value(0, 1000)).toEqual([0]);
    expect(value.value(0, 1150)[0]).toBeCloseTo(10 * ease(0.5));
    expect(value.active(1200)).toBe(true);
    expect(value.value(0, 1300)).toEqual([10]);
    expect(value.active(1300)).toBe(false);
  });

  it("retargets mid-flight from the running value", () => {
    const value = new PaintValue("puck-radius", compile("puck-radius", 0));
    value.retarget(compile("puck-radius", 10), 0, { duration: 100, delay: 0 });
    const midway = value.value(0, 50)[0]!;
    value.retarget(compile("puck-radius", 0), 50, { duration: 100, delay: 0 });
    expect(value.value(0, 50)[0]).toBeCloseTo(midway);
    expect(value.value(0, 150)).toEqual([0]);
  });

  it("rotates along the shortest arc", () => {
    const value = new PaintValue("bearing", compile("bearing", 350));
    value.retarget(compile("bearing", 10), 0, { duration: 100, delay: 0 });
    const half = value.value(0, 50)[0]!;
    // 350 → 10 passes through north (360) rather than sweeping back through 180.
    expect(half).toBeGreaterThan(350);
    expect(half).toBeLessThan(370);
  });

  it("honors delay and zero-duration jumps", () => {
    const value = new PaintValue("puck-radius", compile("puck-radius", 0));
    value.retarget(compile("puck-radius", 10), 0, {
      duration: 100,
      delay: 100,
    });
    expect(value.value(0, 50)).toEqual([0]);
    expect(value.value(0, 150)[0]).toBeCloseTo(10 * ease(0.5));
    value.retarget(compile("puck-radius", 3), 150, { duration: 0, delay: 0 });
    expect(value.value(0, 150)).toEqual([3]);
  });

  it("evaluates zoom expressions at both ends of a transition", () => {
    const value = new PaintValue(
      "puck-radius",
      compile("puck-radius", [
        "interpolate",
        ["linear"],
        ["zoom"],
        0,
        0,
        10,
        10,
      ]),
    );
    value.retarget(compile("puck-radius", 100), 0, { duration: 100, delay: 0 });
    expect(value.value(5, 0)).toEqual([5]);
    expect(value.value(5, 100)).toEqual([100]);
  });
});
