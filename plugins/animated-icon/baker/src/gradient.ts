// Gradient fills and strokes (`gf`, `gs`) as lottie-web 5.13's SVG renderer
// draws them: color stops and opacity stops from the `g` property
// (utils/shapes/GradientProperty.js:10-90), in style space with
// `userSpaceOnUse` and `spreadMethod="pad"`
// (elements/helpers/shapes/SVGGradientFillStyleData.js:42-73). lottie-web
// rounds color stop offsets and opacity stop offsets to whole percents and
// colors to 8 bits; the colors and the opacities interpolate separately
// (opacity through a mask, or as stop-opacity when both lists share their
// offsets). The catalog stores one list of straight RGBA stops, so the two
// lists merge: every offset of either, with the other channel interpolated
// linearly there. That reproduces both piecewise-linear ramps exactly.

import { type Property, valueAt } from "./keyframes.ts";

/** One catalog gradient stop: offset 0..1 and straight RGBA 0..1. */
export interface GradientStop {
  readonly offset: number;
  readonly color: readonly [number, number, number, number];
}

/** A gradient item's `g`: the color stop count and the stop values. */
export interface GradientColors {
  /** Color stops; opacity stops follow them in `k`, if any. */
  readonly p: number;
  readonly k: Property;
}

/** Most stops a catalog gradient holds (../../catalog/FORMAT.md). */
export const MAX_STOPS = 8;

interface Ramp {
  readonly offsets: readonly number[];
  readonly values: readonly (readonly number[])[];
}

/** SVG clamps stop offsets to 0..1 and to at least the previous offset. */
function monotone(offsets: readonly number[]): number[] {
  let last = 0;
  return offsets.map((offset) => {
    last = Math.max(last, Math.min(1, Math.max(0, offset)));
    return last;
  });
}

/**
 * A ramp's value at `t`, padded past its ends. At a hard stop (two stops
 * at one offset) `side` picks the value below ("left") or above it.
 */
function rampAt(ramp: Ramp, t: number, side: "left" | "right"): number[] {
  const { offsets, values } = ramp;
  const n = offsets.length;
  if (n === 0) return [];
  const value = (k: number): number[] => [...(values[k] as number[])];
  const first = offsets.indexOf(t);
  if (first !== -1)
    return value(side === "left" ? first : offsets.lastIndexOf(t));
  if (t < (offsets[0] as number)) return value(0);
  if (t > (offsets[n - 1] as number)) return value(n - 1);
  let k = 0;
  while ((offsets[k + 1] as number) < t) k++;
  const a = offsets[k] as number;
  const b = offsets[k + 1] as number;
  const f = (t - a) / (b - a);
  const va = values[k] as number[];
  const vb = values[k + 1] as number[];
  return va.map((x, i) => x + ((vb[i] ?? x) - x) * f);
}

/**
 * The merged straight-RGBA stops of `g` at `frame`: color stops rounded as
 * lottie-web rounds them, opacity stops (if any) folded into alpha.
 */
export function gradientStops(
  g: GradientColors,
  frame: number,
): GradientStop[] {
  const values = valueAt(g.k, frame, []);
  const count = Math.max(0, Math.floor(g.p));
  const colorOffsets: number[] = [];
  const colors: number[][] = [];
  for (let s = 0; s < count; s++) {
    colorOffsets.push(Math.round((values[4 * s] ?? 0) * 100) / 100);
    colors.push(
      [1, 2, 3].map(
        (c) =>
          Math.min(
            255,
            Math.max(0, Math.round((values[4 * s + c] ?? 0) * 255)),
          ) / 255,
      ),
    );
  }
  const alphaOffsets: number[] = [];
  const alphas: number[][] = [];
  for (let k = 4 * count; k + 1 < values.length; k += 2) {
    alphaOffsets.push(Math.round((values[k] ?? 0) * 100) / 100);
    alphas.push([Math.min(1, Math.max(0, values[k + 1] ?? 1))]);
  }
  if (colors.length === 0) return [];
  const color: Ramp = { offsets: monotone(colorOffsets), values: colors };
  const alpha: Ramp = { offsets: monotone(alphaOffsets), values: alphas };
  // Every offset of either list; a hard stop in either becomes two stops.
  const hard = (ramp: Ramp, t: number): boolean =>
    ramp.offsets.filter((o) => o === t).length > 1;
  const offsets = [...new Set([...color.offsets, ...alpha.offsets])].sort(
    (a, b) => a - b,
  );
  const stops: GradientStop[] = [];
  const stop = (t: number, side: "left" | "right"): void => {
    const [r = 0, gr = 0, b = 0] = rampAt(color, t, side);
    const [a = 1] = alpha.offsets.length > 0 ? rampAt(alpha, t, side) : [1];
    stops.push({ offset: t, color: [r, gr, b, a] });
  };
  for (const t of offsets) {
    stop(t, "left");
    if (hard(color, t) || hard(alpha, t)) stop(t, "right");
  }
  if (stops.length === 1) {
    const only = stops[0] as GradientStop;
    return [
      { offset: 0, color: only.color },
      { offset: 1, color: only.color },
    ];
  }
  return stops;
}

/**
 * Stops resampled evenly to MAX_STOPS, for an entry that ignores the
 * `gradient-stops` limit: a close approximation of a longer gradient.
 */
export function resampleStops(stops: readonly GradientStop[]): GradientStop[] {
  const ramp: Ramp = {
    offsets: stops.map((s) => s.offset),
    values: stops.map((s) => [...s.color]),
  };
  return Array.from({ length: MAX_STOPS }, (_, k) => {
    const t = k / (MAX_STOPS - 1);
    const [r = 0, g = 0, b = 0, a = 1] = rampAt(ramp, t, "left");
    return { offset: t, color: [r, g, b, a] };
  });
}

/** The gradient's straight color at `t` (0..1, padded), as the shader mixes it. */
export function stopsAt(
  stops: readonly GradientStop[],
  t: number,
): [number, number, number, number] {
  const [r = 0, g = 0, b = 0, a = 1] = rampAt(
    {
      offsets: stops.map((s) => s.offset),
      values: stops.map((s) => [...s.color]),
    },
    Math.min(1, Math.max(0, t)),
    "right",
  );
  return [r, g, b, a];
}
