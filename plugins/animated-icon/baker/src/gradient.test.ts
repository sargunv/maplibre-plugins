import { describe, expect, it } from "vite-plus/test";

import {
  type GradientStop,
  gradientStops,
  MAX_STOPS,
  resampleStops,
  stopsAt,
} from "./gradient.ts";
import { comp, el, k, layer } from "./lottie.testing.ts";
import { evaluateFrame, type ShapeItem } from "./scene.ts";

const round = (stops: GradientStop[]) =>
  stops.map((s) => ({
    offset: +s.offset.toFixed(4),
    color: s.color.map((c) => +c.toFixed(4)),
  }));

describe("gradientStops", () => {
  it("reads color stops, rounded as lottie-web rounds them", () => {
    // Offsets to whole percents, colors to 8 bits.
    const stops = gradientStops(
      { p: 2, k: k([0.123, 1, 0.5, 0, 1, 0, 0, 1]) },
      0,
    );
    expect(round(stops)).toEqual([
      { offset: 0.12, color: [1, +(128 / 255).toFixed(4), 0, 1] },
      { offset: 1, color: [0, 0, 1, 1] },
    ]);
  });

  it("merges opacity stops, interpolating each channel at every offset", () => {
    // Color black at 0 to white at 1; opacity 1 at 0, 0 at 0.5.
    const stops = gradientStops(
      { p: 2, k: k([0, 0, 0, 0, 1, 1, 1, 1, 0, 1, 0.5, 0]) },
      0,
    );
    expect(round(stops)).toEqual([
      { offset: 0, color: [0, 0, 0, 1] },
      { offset: 0.5, color: [0.5, 0.5, 0.5, 0] },
      { offset: 1, color: [1, 1, 1, 0] },
    ]);
  });

  it("keeps hard stops as two stops at one offset", () => {
    const stops = gradientStops(
      {
        p: 3,
        k: k([0, 1, 0, 0, 0.5, 1, 0, 0, 0.5, 0, 0, 1, 0, 1, 1, 0.5, 0.5]),
      },
      0,
    );
    expect(stops.map((s) => s.offset)).toEqual([0, 0.5, 0.5, 1]);
    expect(stopsAt(stops, 0.49)[0]).toBeCloseTo(1, 1);
    expect(stopsAt(stops, 0.51)[2]).toBeCloseTo(1, 1);
  });

  it("counts every merged stop, so the baker can refuse more than eight", () => {
    const colors = Array.from({ length: 5 }, (_, i) => [i / 4, 0, 0, 0]).flat();
    const alphas = [0.1, 1, 0.3, 1, 0.6, 1, 0.9, 1];
    const stops = gradientStops({ p: 5, k: k([...colors, ...alphas]) }, 0);
    expect(stops.length).toBe(9);
    expect(stops.length > MAX_STOPS).toBe(true);
    const resampled = resampleStops(stops);
    expect(resampled).toHaveLength(MAX_STOPS);
    expect(resampled[0]?.offset).toBe(0);
    expect(resampled.at(-1)?.offset).toBe(1);
  });

  it("pads a single stop to two", () => {
    expect(gradientStops({ p: 1, k: k([0.3, 1, 1, 1]) }, 0)).toHaveLength(2);
  });
});

describe("gradients in the scene", () => {
  const gradient = (extra: Record<string, unknown>): ShapeItem =>
    ({
      ty: "gf",
      t: 1,
      s: k([0, 0]),
      e: k([10, 0]),
      o: k(50),
      r: 1,
      g: { p: 2, k: k([0, 1, 0, 0, 1, 0, 0, 1]) },
      ...extra,
    }) as ShapeItem;

  it("paints linear and radial gradients in style space with their opacity", () => {
    const [linear] = evaluateFrame(comp([layer([el(0, 0), gradient({})])]), 0);
    expect(linear?.paint).toMatchObject({
      kind: "linear",
      from: [0, 0],
      to: [10, 0],
    });
    expect(linear?.alpha).toBe(0.5);
    const [radial] = evaluateFrame(
      comp([layer([el(0, 0), gradient({ t: 2, h: k(0) })])]),
      0,
    );
    expect(radial?.paint).toMatchObject({ kind: "radial", highlight: 0 });
  });

  it("strokes with a gradient", () => {
    const [draw] = evaluateFrame(
      comp([layer([el(0, 0), gradient({ ty: "gs", w: k(2), lc: 2, lj: 2 })])]),
      0,
    );
    expect(draw?.kind).toBe("stroke");
    expect(draw?.stroke?.width).toBe(2);
  });

  it("draws nothing when the entry ignores gradients", () => {
    expect(
      evaluateFrame(comp([layer([el(0, 0), gradient({})])]), 0, {
        ignore: new Set(["gradients"]),
      }),
    ).toEqual([]);
  });
});
