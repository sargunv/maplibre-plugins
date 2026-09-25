// Band lists for the coverage shader (../../catalog/FORMAT.md, "Band
// construction"). A shape's control-hull bounds are cut into horizontal
// bands (stacked in y; their rays run along x) and vertical bands (stacked
// in x; rays along y). Each band lists every curve whose control hull meets
// it, so a pixel only visits the curves of its two bands. Every list is
// complete, sorted twice so the shader can exit early in either direction:
// `pos` by descending maximum along the ray, for rays cast toward +x (or
// +y), and `neg` by ascending minimum, for rays cast toward -x (or -y). A
// pixel on the near side of the band's split casts the negative ray, which
// is Slug's median ray split (Lengyel 2017, section 4).

import type { Contour } from "./pack.ts";

/** Bands per axis, at most. */
export const MAX_BANDS = 16;

/** The split of a band that always casts the positive ray. */
export const SPLIT_OFF = -3.0e38;

/**
 * Bands along one axis: about four curves per band, bands at least four
 * pixels tall, 1 to 16.
 */
export function bandCount(curves: number, extentPx: number): number {
  const n = Math.min(Math.ceil(curves / 4), Math.floor(extentPx / 4));
  return n >= 1 ? Math.min(n, MAX_BANDS) : 1;
}

/**
 * Whether a band splits its rays: only when it spans at least 16 pixels
 * along the ray and lists at least four curves, since below that the early
 * exit saves little.
 */
export function splitEnabled(curves: number, extentPx: number): boolean {
  return extentPx >= 16 && curves >= 4;
}

export interface Band {
  /** Pixels whose ray-axis coordinate is below it cast the negative ray. */
  readonly split: number;
  /** Curve indices by descending maximum along the ray. */
  readonly pos: readonly number[];
  /** The same curves by ascending minimum along the ray. */
  readonly neg: readonly number[];
}

export interface BandLayout {
  /** Horizontal bands, smallest y first. */
  readonly h: readonly Band[];
  /** Vertical bands, smallest x first. */
  readonly v: readonly Band[];
  /**
   * `(hs, hb, vs, vb)`, as f32: a point `q` lies in horizontal band
   * `floor(q.y * hs + hb)` and vertical band `floor(q.x * vs + vb)`, clamped.
   */
  readonly transform: readonly [number, number, number, number];
}

/** A curve's control hull: `[xmin, xmax, ymin, ymax]`. */
type Hull = readonly [number, number, number, number];

/** 0 for x, 1 for y. */
type Axis = 0 | 1;

function hullMin(hull: Hull, a: Axis): number {
  return a === 0 ? hull[0] : hull[2];
}

function hullMax(hull: Hull, a: Axis): number {
  return a === 0 ? hull[1] : hull[3];
}

/**
 * The control hulls of a shape's curves, flattened in contour order: curve
 * `k` of a contour runs from its `on` point through `ctrl` to the next
 * curve's `on` point, and the last one closes the contour.
 */
export function curveHulls(contours: readonly Contour[]): Hull[] {
  const hulls: Hull[] = [];
  for (const contour of contours) {
    contour.forEach(({ on, ctrl }, k) => {
      const end = (contour[(k + 1) % contour.length] ?? contour[0])?.on ?? on;
      hulls.push([
        Math.min(on[0], ctrl[0], end[0]),
        Math.max(on[0], ctrl[0], end[0]),
        Math.min(on[1], ctrl[1], end[1]),
        Math.max(on[1], ctrl[1], end[1]),
      ]);
    });
  }
  return hulls;
}

/**
 * Builds both band grids of a shape. `pxPerUnit` is the largest number of
 * logical pixels one local unit covers where the shape is drawn: it sizes
 * the bands and enables the split.
 */
export function buildBands(
  contours: readonly Contour[],
  pxPerUnit: number,
): BandLayout {
  const hulls = curveHulls(contours);
  const h = axis(hulls, 1, pxPerUnit);
  const v = axis(hulls, 0, pxPerUnit);
  return {
    h: h.bands,
    v: v.bands,
    transform: [h.scale, h.bias, v.scale, v.bias],
  };
}

/**
 * The bands stacked along `across` (y for horizontal bands); their rays run
 * along the other axis.
 */
function axis(
  hulls: readonly Hull[],
  across: Axis,
  pxPerUnit: number,
): { bands: Band[]; scale: number; bias: number } {
  const along: Axis = across === 0 ? 1 : 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const hull of hulls) {
    lo = Math.min(lo, hullMin(hull, across));
    hi = Math.max(hi, hullMax(hull, across));
  }
  const all = hulls.map((_, i) => i);
  if (!(hi > lo)) {
    // A flat or empty shape: one band that lists every curve.
    return { bands: [band(hulls, all, along, pxPerUnit)], scale: 0, bias: 0 };
  }
  const count = bandCount(hulls.length, (hi - lo) * pxPerUnit);
  // The shader reads the transform as f32, so the band edges are where the
  // f32 transform puts them, widened by a margin that absorbs the shader's
  // rounding when it picks a band.
  const scale = Math.fround(count / (hi - lo));
  // `+ 0` turns -0 into 0 for a shape that starts at 0.
  const bias = Math.fround(-lo * scale) + 0;
  const margin = 1 / (1024 * scale);
  const bands: Band[] = [];
  for (let k = 0; k < count; k++) {
    const y0 = (k - bias) / scale - margin;
    const y1 = (k + 1 - bias) / scale + margin;
    const members = all.filter((i) => {
      const hull = hulls[i];
      return (
        hull !== undefined &&
        hullMax(hull, across) >= y0 &&
        hullMin(hull, across) <= y1
      );
    });
    bands.push(band(hulls, members, along, pxPerUnit));
  }
  return { bands, scale, bias };
}

/** One band over the given curves, with its two sorted lists and split. */
function band(
  hulls: readonly Hull[],
  members: readonly number[],
  along: Axis,
  pxPerUnit: number,
): Band {
  const min = (i: number): number => {
    const hull = hulls[i];
    return hull ? hullMin(hull, along) : 0;
  };
  const max = (i: number): number => {
    const hull = hulls[i];
    return hull ? hullMax(hull, along) : 0;
  };
  // Ties go to the lower curve index.
  const pos = [...members].sort((a, b) => max(b) - max(a) || a - b);
  const neg = [...members].sort((a, b) => min(a) - min(b) || a - b);
  let lo = Infinity;
  let hi = -Infinity;
  for (const i of members) {
    lo = Math.min(lo, min(i));
    hi = Math.max(hi, max(i));
  }
  const extentPx = members.length > 0 ? (hi - lo) * pxPerUnit : 0;
  if (!splitEnabled(members.length, extentPx)) {
    return { split: Math.fround(SPLIT_OFF), pos, neg: pos };
  }
  // The lower median of the curves' midpoints along the ray.
  const mids = members.map((i) => (min(i) + max(i)) / 2).sort((a, b) => a - b);
  const split = Math.fround(mids[Math.floor((mids.length - 1) / 2)] ?? 0);
  return { split, pos, neg };
}
