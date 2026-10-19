// Roof shapes as height functions over a footprint. Part of the building
// layout; ../../native/src/roof.zig is its twin and both are tested
// against ../../fixtures/layout.
//
// A roof is described by n, its relative elevation: z = wallTop + n ×
// roofHeight, with n = 0 at the eaves and 1 at the top. Roof families:
//
// - Frame shapes (gabled, half-hipped, skillion, gambrel, round,
//   double_saltbox, saltbox, quadruple_saltbox, round_gabled) live
//   in the roof frame: u along the ridge, v across it, centered on the
//   footprint's minimum-area bounding rectangle, half-extents a (along u)
//   and b (along v). Every one is concave, so it is written as the minimum
//   of planes n = A·u + B·v + C; the region where a plane is the minimum is
//   a convex facet, and the break lines (ridges, hips and gambrel
//   breaks) are where facets meet. Curved ones (round, round_gabled) are
//   strips of planes with smooth gradients.
// - Skeleton shapes (hipped, mansard) follow every eave, including courtyards.
//   skeleton.ts / skeleton.zig compute the equal-speed wavefront; layout
//   turns its time into roof elevation, with a slope break for mansards.
// - Radial shapes (pyramidal, cone, dome, onion) are concentric copies of
//   the footprint shrunk toward the frame center, following a profile of
//   (height, scale) steps. They need the center inside the footprint's
//   kernel (every edge visible from it).
// - Flat roofs (flat, many and every fallback) are n = 1: the roof sits at
//   building-height and roof-height does not matter.
// - Roofless copies (a footprint the source cut, with a shape that is not
//   flat) are n = 0: walls up to the eaves and a flat lid there, below the
//   real roof that a whole copy in another tile draws.
//
// The constants follow OSM2World (tordanik/OSM2World, core/.../building/
// roof/*.java) unless noted.

import { type BoundingRectangle, type Point, TIE } from "./footprint.ts";
import type { Skeleton } from "./skeleton.ts";
import type { RoofOrientation, RoofShape } from "./spec.ts";

/** n = gx·x + gy·y + c in tile units. */
export interface Plane {
  gx: number;
  gy: number;
  c: number;
}

/** The roof frame: u along the ridge, v across it (front toward +v). */
export interface Frame {
  center: Point;
  u: Point;
  v: Point;
  /** Half the frame's extent along u. */
  a: number;
  /** Half the frame's extent along v. */
  b: number;
}

/**
 * A curved frame shape: profile points (v, n) across the frame, sorted by
 * v, joined by planar strips. Strips in the same group share vertices and
 * get gradients interpolated between the break lines; groups meet at a
 * crease.
 */
export interface StripProfile {
  v: number[];
  n: number[];
  /** Group of each strip (v.length - 1 entries). */
  groups: number[];
}

export type RoofModel =
  | { type: "flat" }
  | ({ type: "skeleton"; mansard: boolean } & Skeleton)
  | {
      /**
       * A cut copy of a footprint: walls to the eaves and a lid at n = 0.
       * The roof's frame needs the whole footprint, which this copy lacks.
       */
      type: "roofless";
      /**
       * The run the copy would have if it were whole, for
       * building-roof-angle's eave height: the real run is unknown here.
       */
      run: number;
    }
  | {
      type: "planes";
      /** Planes in tile coordinates; n is their minimum. */
      planes: Plane[];
      /** Horizontal eave-to-ridge distance, in tile units. */
      run: number;
      /** Present for curved shapes; plane i is strip i. */
      strips?: StripProfile;
      frame: Frame;
    }
  | {
      type: "radial";
      /** (height, scale) from the eaves (0, 1) to the top (1, 0). */
      steps: readonly (readonly [number, number])[];
      /** Smooth gradients shared between faces, or one planar face each. */
      smooth: boolean;
      /** The top is a point with slope: no shared apex vertex. */
      pointed: boolean;
      center: Point;
      run: number;
    };

/** Footprints whose bounding rectangle is thinner than this get flat roofs. */
export const MIN_HALF_WIDTH = 1;
/** OSM2World HalfHippedRoof: the hip is 1/6 of the end wall from each side. */
export const HALF_HIPPED_INSET = 1 / 6;
/** OSM2World RoofWithRidge: a ridge end moves at most 0.4 × the ridge line. */
export const RIDGE_OFFSET_CAP = 0.4;
/** OSM2World SaltboxRoof: the ridge sits 0.7 of the width from the front. */
export const SALTBOX_RIDGE = 0.7;
/**
 * double_saltbox and quadruple_saltbox are a gabled and a hipped roof cut
 * off by a flat top, as Streets GL's QuadrupleSaltboxRoofBuilder and
 * StreetComplete's roof_*_saltbox quest drawings show. The faces run this
 * fraction of the half-width in from the eaves: StreetComplete's drawings
 * measure 0.29 (Streets GL uses 0.5).
 */
export const FLAT_TOP_INSET = 0.3;
/** OSM2World DomeRoof: ten height rings, scale sqrt(1 - h²). */
export const DOME_STEPS: readonly (readonly [number, number])[] = Array.from(
  { length: 10 },
  (_, k) => {
    const h = k / 9;
    return [h, Math.sqrt(1 - h * h)] as const;
  },
);
/** OSM2World OnionRoof's spindle steps. */
export const ONION_STEPS: readonly (readonly [number, number])[] = [
  [0, 1],
  [0.15, 0.8],
  [0.52, 1],
  [0.72, 0.7],
  [0.82, 0.15],
  [1, 0],
];
export const CONE_STEPS: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 0],
];

// cos(15° k) for k = 0..6, from square roots so both twins round alike.
const SQRT2 = Math.sqrt(2);
const SQRT3 = Math.sqrt(3);
const SQRT6 = Math.sqrt(6);
const COS15 = [
  1,
  (SQRT6 + SQRT2) / 4,
  SQRT3 / 2,
  SQRT2 / 2,
  0.5,
  (SQRT6 - SQRT2) / 4,
  0,
];
function cos15(k: number): number {
  return k <= 6 ? COS15[k]! : -COS15[12 - k]!;
}
function sin15(k: number): number {
  return k <= 6 ? COS15[6 - k]! : COS15[k - 6]!;
}

/** round: a semicircular barrel vault across v, in 15° strips. */
export function roundProfile(b: number): StripProfile {
  const v: number[] = [];
  const n: number[] = [];
  for (let k = 0; k <= 12; k++) {
    v.push(-b * cos15(k));
    n.push(sin15(k));
  }
  return { v, n, groups: Array.from({ length: 12 }, () => 0) };
}

/**
 * round_gabled: "gabled, but the two slopes are rounded" (OSM wiki,
 * Tag:roof:shape=round_gabled). An equilateral pointed arch: each side is
 * an arc of radius 2b centered on the opposite eave, vertical at the
 * eaves and meeting the other at a crisp ridge at 60°, in 15° strips.
 */
export function roundGabledProfile(b: number): StripProfile {
  const v: number[] = [];
  const n: number[] = [];
  for (let k = 0; k <= 4; k++) {
    v.push(b - 2 * b * cos15(k));
    n.push((2 * sin15(k)) / SQRT3);
  }
  for (let k = 3; k >= 0; k--) {
    v.push(-(b - 2 * b * cos15(k)));
    n.push((2 * sin15(k)) / SQRT3);
  }
  return { v, n, groups: [0, 0, 0, 0, 1, 1, 1, 1] };
}

/**
 * Picks the roof frame on a bounding rectangle. A set direction (degrees
 * clockwise from north, the way the main face looks) turns +v toward the
 * rectangle axis closest to it (the shorter side's axis on a tie);
 * otherwise orientation picks the ridge axis and +v is u turned 90°
 * clockwise on the map, with u pointing east-ish (+x, or +y when
 * vertical).
 */
export function frameFor(
  rect: BoundingRectangle,
  orientation: RoofOrientation,
  direction: Point | null,
): Frame {
  let u: Point;
  let v: Point;
  if (direction) {
    const alongLong = Math.abs(
      rect.long.x * direction.x + rect.long.y * direction.y,
    );
    const alongShort = Math.abs(
      rect.short.x * direction.x + rect.short.y * direction.y,
    );
    v = alongLong > alongShort + TIE ? rect.long : rect.short;
    if (v.x * direction.x + v.y * direction.y < 0) v = { x: -v.x, y: -v.y };
    u = { x: v.y, y: -v.x };
  } else {
    u = orientation === "across" ? rect.short : rect.long;
    if (u.x < 0 || (u.x === 0 && u.y < 0)) u = { x: -u.x, y: -u.y };
    v = { x: -u.y, y: u.x };
  }
  const uIsLong =
    Math.abs(u.x * rect.long.x + u.y * rect.long.y) >
    Math.abs(u.x * rect.short.x + u.y * rect.short.y);
  return {
    center: rect.center,
    u,
    v,
    a: uIsLong ? rect.halfLong : rect.halfShort,
    b: uIsLong ? rect.halfShort : rect.halfLong,
  };
}

/** Unit vector of a roof:direction, or null when unset. */
export function directionVector(degrees: number): Point | null {
  if (!(degrees >= 0) || !Number.isFinite(degrees)) return null;
  const radians = ((degrees % 360) * Math.PI) / 180;
  // North is -y in tile coordinates, east is +x.
  return { x: Math.sin(radians), y: -Math.cos(radians) };
}

/** A frame plane n = A·u + B·v + C in tile coordinates. */
function framePlane(frame: Frame, A: number, B: number, C: number): Plane {
  const gx = A * frame.u.x + B * frame.v.x;
  const gy = A * frame.u.y + B * frame.v.y;
  return { gx, gy, c: C - (gx * frame.center.x + gy * frame.center.y) };
}

function stripPlanes(frame: Frame, profile: StripProfile): Plane[] {
  const planes: Plane[] = [];
  for (let j = 0; j + 1 < profile.v.length; j++) {
    const slope =
      (profile.n[j + 1]! - profile.n[j]!) / (profile.v[j + 1]! - profile.v[j]!);
    planes.push(
      framePlane(frame, 0, slope, profile.n[j]! - slope * profile.v[j]!),
    );
  }
  return planes;
}

/**
 * The roof model of one footprint. `outer` is the exterior ring (positive
 * area) and is only read by skillion's exact direction. For skeleton shapes,
 * layout builds the full model; this function supplies only a cut-copy run.
 */
export function roofModel(
  shape: RoofShape,
  rect: BoundingRectangle,
  frame: Frame,
  outer: readonly Point[],
  direction: Point | null,
): RoofModel {
  const { a, b } = frame;
  const planes = (
    list: [number, number, number][],
    run: number,
  ): RoofModel => ({
    type: "planes",
    planes: list.map(([A, B, C]) => framePlane(frame, A, B, C)),
    run,
    frame,
  });
  const radial = (
    steps: readonly (readonly [number, number])[],
    smooth: boolean,
    pointed: boolean,
  ): RoofModel => ({
    type: "radial",
    steps,
    smooth,
    pointed,
    center: rect.center,
    run: rect.halfShort,
  });
  switch (shape) {
    case "gabled":
      return planes(
        [
          [0, -1 / b, 1],
          [0, 1 / b, 1],
        ],
        b,
      );
    case "hipped":
    case "mansard":
      // Whole footprints use the skeleton; cut copies only need a run estimate.
      return { type: "roofless", run: rect.halfShort };
    case "half-hipped": {
      // The hip planes keep the side slope and are cut off by the end
      // walls: their ridge ends sit an inset in from the ends.
      const inset = Math.min(
        2 * b * HALF_HIPPED_INSET,
        RIDGE_OFFSET_CAP * 2 * a,
      );
      return planes(
        [
          [0, -1 / b, 1],
          [0, 1 / b, 1],
          [-1 / b, 0, 1 + (a - inset) / b],
          [1 / b, 0, 1 + (a - inset) / b],
        ],
        b,
      );
    }
    case "skillion": {
      if (direction) {
        // The exact direction: highest at the vertex furthest against it.
        let min = Infinity;
        let max = -Infinity;
        for (const p of outer) {
          const d = p.x * direction.x + p.y * direction.y;
          min = Math.min(min, d);
          max = Math.max(max, d);
        }
        const run = max - min;
        if (!(run >= 2 * MIN_HALF_WIDTH)) return { type: "flat" };
        return {
          type: "planes",
          planes: [
            { gx: -direction.x / run, gy: -direction.y / run, c: max / run },
          ],
          run,
          frame,
        };
      }
      return planes([[0, -1 / (2 * b), 0.5]], 2 * b);
    }
    case "gambrel":
      // OSM2World GambrelRoof: the upper slope halves the lower one, with
      // the break 2/3 of the way from the ridge at n = 2/3.
      return planes(
        [
          [0, -1 / (2 * b), 1],
          [0, 1 / (2 * b), 1],
          [0, -2 / b, 2],
          [0, 2 / b, 2],
        ],
        b,
      );
    case "round": {
      const strips = roundProfile(b);
      return {
        type: "planes",
        planes: stripPlanes(frame, strips),
        run: b,
        strips,
        frame,
      };
    }
    case "round_gabled": {
      const strips = roundGabledProfile(b);
      return {
        type: "planes",
        planes: stripPlanes(frame, strips),
        run: b,
        strips,
        frame,
      };
    }
    case "double_saltbox": {
      const r = FLAT_TOP_INSET * b;
      return planes(
        [
          [0, 0, 1],
          [0, -1 / r, b / r],
          [0, 1 / r, b / r],
        ],
        r,
      );
    }
    case "quadruple_saltbox": {
      const r = FLAT_TOP_INSET * b;
      const end = Math.min(r, a);
      return planes(
        [
          [0, 0, 1],
          [0, -1 / r, b / r],
          [0, 1 / r, b / r],
          [-1 / end, 0, a / end],
          [1 / end, 0, a / end],
        ],
        r,
      );
    }
    case "saltbox": {
      // Equal slopes with the ridge moved back: the long face looks toward
      // +v and runs to the front eaves, the back eaves stop at n = 4/7.
      const run = 2 * b * SALTBOX_RIDGE;
      const ridge = b - run;
      return planes(
        [
          [0, -1 / run, 1 + ridge / run],
          [0, 1 / run, 1 - ridge / run],
        ],
        run,
      );
    }
    case "pyramidal":
      return radial(CONE_STEPS, false, true);
    case "cone":
      return radial(CONE_STEPS, true, true);
    case "dome":
      return radial(DOME_STEPS, true, false);
    case "onion":
      return radial(ONION_STEPS, true, true);
    case "flat":
    case "many":
      return { type: "flat" };
  }
}

/** n at a point: the minimum of the planes, clamped to [0, 1]. */
export function envelope(
  planes: readonly Plane[],
  x: number,
  y: number,
): number {
  let n = Infinity;
  for (const p of planes) n = Math.min(n, p.gx * x + p.gy * y + p.c);
  return Math.min(Math.max(n, 0), 1);
}

/**
 * dn/dv of a curved frame shape at frame coordinate v inside strip j:
 * interpolated between the break lines' gradients, each the mean of the
 * slopes of the strips in its group on either side.
 */
export function stripGradient(
  profile: StripProfile,
  j: number,
  v: number,
): number {
  const group = profile.groups[j]!;
  const slope = (k: number): number =>
    (profile.n[k + 1]! - profile.n[k]!) / (profile.v[k + 1]! - profile.v[k]!);
  const atBreak = (k: number): number => {
    // Break k lies between strips k - 1 and k.
    const before = k - 1 >= 0 && profile.groups[k - 1] === group;
    const after = k < profile.groups.length && profile.groups[k] === group;
    if (before && after) return (slope(k - 1) + slope(k)) / 2;
    return before ? slope(k - 1) : slope(k);
  };
  const v0 = profile.v[j]!;
  const v1 = profile.v[j + 1]!;
  const t = Math.min(Math.max((v - v0) / (v1 - v0), 0), 1);
  return atBreak(j) * (1 - t) + atBreak(j + 1) * t;
}
