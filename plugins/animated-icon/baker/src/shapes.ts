// Lottie shape items (`sh`, `rc`, `el`, `sr`) as cubic bezier paths, built
// exactly as lottie-web builds them (player/js/utils/shapes/ShapeProperty.js):
// the same vertex order, start point and direction, which matter for
// nonzero fills of several paths and for stroke joins.

import {
  type Property,
  scalarAt,
  type ShapeValue,
  valueAt,
} from "./keyframes.ts";
import type { Point } from "./pack.ts";
import { apply, type Matrix } from "./transform.ts";

/**
 * A cubic bezier path with absolute tangents: segment `k` runs from `v[k]`
 * through `o[k]` and `i[k + 1]` to `v[k + 1]`, and a closed path adds the
 * segment from the last vertex back to the first.
 */
export interface BezierPath {
  readonly closed: boolean;
  readonly v: readonly Point[];
  readonly i: readonly Point[];
  readonly o: readonly Point[];
}

/** Lottie's circle constant for rectangles and ellipses (lottie-web's). */
export const ROUND_CORNER = 0.5519;

function point(value: readonly number[] | undefined): Point {
  return [value?.[0] ?? 0, value?.[1] ?? 0];
}

/** A Lottie shape value (`sh.ks`) with its relative tangents made absolute. */
export function pathFromShape(shape: ShapeValue): BezierPath {
  const v = shape.v.map(point);
  return {
    closed: shape.c === true,
    v,
    i: shape.i.map((t, k) => {
      const [x, y] = v[k] ?? [0, 0];
      return [x + (t[0] ?? 0), y + (t[1] ?? 0)];
    }),
    o: shape.o.map((t, k) => {
      const [x, y] = v[k] ?? [0, 0];
      return [x + (t[0] ?? 0), y + (t[1] ?? 0)];
    }),
  };
}

class Builder {
  readonly v: Point[] = [];
  readonly i: Point[] = [];
  readonly o: Point[] = [];
  // lottie-web's setTripleAt argument order: vertex, out tangent, in tangent.
  triple(
    vx: number,
    vy: number,
    ox: number,
    oy: number,
    ix: number,
    iy: number,
  ): void {
    this.v.push([vx, vy]);
    this.o.push([ox, oy]);
    this.i.push([ix, iy]);
  }
  path(): BezierPath {
    return { closed: true, v: this.v, i: this.i, o: this.o };
  }
}

export interface RectItem {
  readonly p?: Property;
  readonly s?: Property;
  readonly r?: Property;
  readonly d?: number;
}

/**
 * A rectangle (`rc`), optionally with rounded corners. lottie-web starts at
 * the top of the right side and runs clockwise for directions 1 and 2,
 * counterclockwise otherwise (including when `d` is missing).
 */
export function rectPath(item: RectItem, frame: number): BezierPath {
  const [px = 0, py = 0] = valueAt(item.p, frame, [0, 0]);
  const [w = 0, h = 0] = valueAt(item.s, frame, [0, 0]);
  const right = px + w / 2;
  const left = px - w / 2;
  const top = py - h / 2;
  const bottom = py + h / 2;
  const r = Math.min(w / 2, h / 2, scalarAt(item.r, frame, 0));
  // How far a corner's handles sit from its vertices' far ends.
  const c = r * (1 - ROUND_CORNER);
  const b = new Builder();
  if (item.d === 2 || item.d === 1) {
    b.triple(right, top + r, right, top + r, right, top + c);
    b.triple(right, bottom - r, right, bottom - c, right, bottom - r);
    if (r !== 0) {
      b.triple(right - r, bottom, right - r, bottom, right - c, bottom);
      b.triple(left + r, bottom, left + c, bottom, left + r, bottom);
      b.triple(left, bottom - r, left, bottom - r, left, bottom - c);
      b.triple(left, top + r, left, top + c, left, top + r);
      b.triple(left + r, top, left + r, top, left + c, top);
      b.triple(right - r, top, right - c, top, right - r, top);
    } else {
      b.triple(left, bottom, left + c, bottom, left, bottom);
      b.triple(left, top, left, top + c, left, top);
    }
  } else {
    b.triple(right, top + r, right, top + c, right, top + r);
    if (r !== 0) {
      b.triple(right - r, top, right - r, top, right - c, top);
      b.triple(left + r, top, left + c, top, left + r, top);
      b.triple(left, top + r, left, top + r, left, top + c);
      b.triple(left, bottom - r, left, bottom - c, left, bottom - r);
      b.triple(left + r, bottom, left + r, bottom, left + c, bottom);
      b.triple(right - r, bottom, right - c, bottom, right - r, bottom);
      b.triple(right, bottom - r, right, bottom - r, right, bottom - c);
    } else {
      b.triple(left, top, left + c, top, left, top);
      b.triple(left, bottom, left, bottom - c, left, bottom);
      b.triple(right, bottom, right - c, bottom, right, bottom);
    }
  }
  return b.path();
}

export interface EllipseItem {
  readonly p?: Property;
  readonly s?: Property;
  readonly d?: number;
}

/** An ellipse (`el`): four cubics starting at the top. */
export function ellipsePath(item: EllipseItem, frame: number): BezierPath {
  const [p0 = 0, p1 = 0] = valueAt(item.p, frame, [0, 0]);
  const [w = 0, h = 0] = valueAt(item.s, frame, [0, 0]);
  const s0 = w / 2;
  const s1 = h / 2;
  const cw = item.d !== 3;
  const k = ROUND_CORNER;
  const side = (x: number): number => (cw ? p0 + x : p0 - x);
  return {
    closed: true,
    v: [
      [p0, p1 - s1],
      [side(s0), p1],
      [p0, p1 + s1],
      [side(-s0), p1],
    ],
    i: [
      [side(-s0 * k), p1 - s1],
      [side(s0), p1 - s1 * k],
      [side(s0 * k), p1 + s1],
      [side(-s0), p1 + s1 * k],
    ],
    o: [
      [side(s0 * k), p1 - s1],
      [side(s0), p1 + s1 * k],
      [side(-s0 * k), p1 + s1],
      [side(-s0), p1 - s1 * k],
    ],
  };
}

export interface StarItem {
  readonly p?: Property;
  readonly pt?: Property;
  readonly r?: Property;
  readonly ir?: Property;
  readonly is?: Property;
  readonly or?: Property;
  readonly os?: Property;
  /** 1 for a star, 2 for a polygon. */
  readonly sy?: number;
  readonly d?: number;
}

/** A star or polygon (`sr`), starting at the top point. */
export function starPath(item: StarItem, frame: number): BezierPath {
  const [px = 0, py = 0] = valueAt(item.p, frame, [0, 0]);
  const star = item.sy === 1;
  const points = Math.floor(scalarAt(item.pt, frame, 5));
  const count = star ? points * 2 : points;
  const dir = item.d === 3 ? -1 : 1;
  const outer = scalarAt(item.or, frame, 0);
  const inner = star ? scalarAt(item.ir, frame, 0) : 0;
  const outerRound = scalarAt(item.os, frame, 0) / 100;
  const innerRound = star ? scalarAt(item.is, frame, 0) / 100 : 0;
  // lottie-web divides a polygon's perimeter by 4 and a star's by 2 per point.
  const perimeter = (radius: number): number =>
    (2 * Math.PI * radius) / (star ? count * 2 : points * 4);
  const angle = (Math.PI * 2) / count;
  let current = -Math.PI / 2 + scalarAt(item.r, frame, 0) * (Math.PI / 180);
  const b = new Builder();
  for (let k = 0; k < count; k++) {
    const long = !star || k % 2 === 0;
    const radius = long ? outer : inner;
    const round = long ? outerRound : innerRound;
    const segment = perimeter(radius);
    let x = radius * Math.cos(current);
    let y = radius * Math.sin(current);
    const length = Math.sqrt(x * x + y * y);
    const ox = length === 0 ? 0 : y / length;
    const oy = length === 0 ? 0 : -x / length;
    x += px;
    y += py;
    const t = segment * round * dir;
    b.triple(x, y, x - ox * t, y - oy * t, x + ox * t, y + oy * t);
    current += angle * dir;
  }
  return b.path();
}

/** The path with every vertex and tangent mapped through `m`. */
export function transformPath(path: BezierPath, m: Matrix): BezierPath {
  return {
    closed: path.closed,
    v: path.v.map((p) => apply(m, p)),
    i: path.i.map((p) => apply(m, p)),
    o: path.o.map((p) => apply(m, p)),
  };
}

/**
 * Round corners (`rd`) on one path, ported from lottie-web's
 * RoundCornersModifier.processPath (utils/shapes/RoundCornersModifier.js:21-91):
 * every sharp vertex (both handles on it) of a closed path, and every one
 * but the ends of an open path, becomes two vertices up to `radius` from
 * it along its sides (never past a side's middle), joined by a curve whose
 * handles reach ROUND_CORNER of the way back to the corner.
 */
export function roundCorners(path: BezierPath, radius: number): BezierPath {
  const v: Point[] = [];
  const i: Point[] = [];
  const o: Point[] = [];
  const n = path.v.length;
  const push = (vertex: Point, out: Point, into: Point): void => {
    v.push(vertex);
    o.push(out);
    i.push(into);
  };
  for (let k = 0; k < n; k++) {
    const current = path.v[k] as Point;
    const out = path.o[k] ?? current;
    const into = path.i[k] ?? current;
    const sharp =
      current[0] === out[0] &&
      current[1] === out[1] &&
      current[0] === into[0] &&
      current[1] === into[1];
    if (!sharp) {
      push(current, out, into);
      continue;
    }
    if ((k === 0 || k === n - 1) && !path.closed) {
      push(current, out, into);
      continue;
    }
    // Toward the previous vertex: the new vertex and its in handle.
    let closer = path.v[k === 0 ? n - 1 : k - 1] as Point;
    let distance = Math.hypot(current[0] - closer[0], current[1] - closer[1]);
    let perc = distance ? Math.min(distance / 2, radius) / distance : 0;
    let ix = current[0] + (closer[0] - current[0]) * perc;
    let iy = current[1] - (current[1] - closer[1]) * perc;
    let vx = ix;
    let vy = iy;
    let ox = vx - (vx - current[0]) * ROUND_CORNER;
    let oy = vy - (vy - current[1]) * ROUND_CORNER;
    push([vx, vy], [ox, oy], [ix, iy]);
    // Toward the next vertex: the new vertex and its out handle.
    closer = path.v[k === n - 1 ? 0 : k + 1] as Point;
    distance = Math.hypot(current[0] - closer[0], current[1] - closer[1]);
    perc = distance ? Math.min(distance / 2, radius) / distance : 0;
    ox = current[0] + (closer[0] - current[0]) * perc;
    oy = current[1] + (closer[1] - current[1]) * perc;
    vx = ox;
    vy = oy;
    ix = vx - (vx - current[0]) * ROUND_CORNER;
    iy = vy - (vy - current[1]) * ROUND_CORNER;
    push([vx, vy], [ox, oy], [ix, iy]);
  }
  return { closed: path.closed, v, i, o };
}
