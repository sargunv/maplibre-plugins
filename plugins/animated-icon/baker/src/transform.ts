// 2D affine matrices and Lottie transforms (layer `ks` and group `tr`),
// composed as lottie-web's TransformProperty does: anchor, scale, skew,
// rotation, then position.

import {
  isKeyframed,
  keyframedValueAt,
  type Property,
  scalarAt,
  valueAt,
} from "./keyframes.ts";
import type { Point } from "./pack.ts";

/**
 * An affine matrix `[a, b, c, d, e, f]` mapping `(x, y)` to
 * `(a x + c y + e, b x + d y + f)`, as canvas and SVG write it.
 */
export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m · n`: applies `n` first, then `m`. */
export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function apply(m: Matrix, [x, y]: Point): Point {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function translation(x: number, y: number): Matrix {
  return [1, 0, 0, 1, x, y];
}

export function scaling(x: number, y: number): Matrix {
  return [x, 0, 0, y, 0, 0];
}

/** Rotation by `radians`, clockwise on screen (y down). */
export function rotation(radians: number): Matrix {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return [c, s, -s, c, 0, 0];
}

/** The largest factor by which `m` stretches any direction. */
export function maxScale(m: Matrix): number {
  const [a, b, c, d] = m;
  const p = (a * a + b * b + c * c + d * d) / 2;
  const q = Math.sqrt(Math.max(0, p * p - (a * d - b * c) ** 2));
  return Math.sqrt(p + q);
}

/** The smallest factor by which `m` stretches any direction. */
export function minScale(m: Matrix): number {
  const [a, b, c, d] = m;
  const det = Math.abs(a * d - b * c);
  const max = maxScale(m);
  return max > 0 ? det / max : 0;
}

/** The inverse of `m`, or undefined when it collapses the plane. */
export function invert(m: Matrix): Matrix | undefined {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
  if (
    !Number.isFinite(det) ||
    Math.abs(det) <= 1e-12 * scale * scale ||
    det === 0
  ) {
    return undefined;
  }
  return [
    d / det,
    -b / det,
    -c / det,
    a / det,
    (c * f - d * e) / det,
    (b * e - a * f) / det,
  ];
}

/** A position split into separate `x` and `y` properties. */
export interface SplitPosition {
  readonly s: true;
  readonly x?: Property;
  readonly y?: Property;
}

/** A Lottie transform: a layer's `ks` or a group's `tr` item. */
export interface Transform {
  readonly a?: Property;
  readonly p?: Property | SplitPosition;
  readonly s?: Property;
  readonly r?: Property;
  readonly o?: Property;
  readonly sk?: Property;
  readonly sa?: Property;
}

function isSplit(
  position: Property | SplitPosition,
): position is SplitPosition {
  return (position as SplitPosition).s === true;
}

const DEG = Math.PI / 180;

function keyTimes(property: Property | undefined): number[] {
  const k = property?.k;
  return isKeyframed(k) ? k.map((key) => key.t) : [];
}

/**
 * The rotation auto-orient (`ao: 1`) adds at `frame`, in radians clockwise:
 * the direction of travel, from the position a hundredth of a frame
 * earlier, or at the ends of the keyframes from the first or last stretch
 * of the path, exactly as lottie-web samples it
 * (TransformProperty.js:74-110). A position without keyframes adds
 * nothing.
 */
export function autoOrientAt(
  position: Property | SplitPosition | undefined,
  frame: number,
): number {
  if (!position) return 0;
  let v1: [number, number];
  let v2: [number, number];
  if (!isSplit(position)) {
    const times = keyTimes(position);
    const first = times[0];
    const last = times.at(-1);
    if (first === undefined || last === undefined) return 0;
    const at = (t: number): [number, number] => {
      const [x = 0, y = 0] = keyframedValueAt(position, t, [0, 0]);
      return [x, y];
    };
    if (frame <= first) {
      v1 = at(first + 0.01);
      v2 = at(first);
    } else if (frame >= last) {
      v1 = at(last);
      v2 = at(last - 0.05);
    } else {
      const [x = 0, y = 0] = valueAt(position, frame, [0, 0]);
      v1 = [x, y];
      v2 = at(frame - 0.01);
    }
  } else {
    const xs = keyTimes(position.x);
    const ys = keyTimes(position.y);
    const first = xs[0];
    const last = xs.at(-1);
    const yFirst = ys[0];
    const yLast = ys.at(-1);
    if (
      first === undefined ||
      last === undefined ||
      yFirst === undefined ||
      yLast === undefined
    ) {
      return 0;
    }
    const x = (t: number): number =>
      keyframedValueAt(position.x, t, [0])[0] ?? 0;
    const y = (t: number): number =>
      keyframedValueAt(position.y, t, [0])[0] ?? 0;
    // lottie-web picks the branch by the X keyframes alone.
    if (frame <= first) {
      v1 = [x(first + 0.01), y(yFirst + 0.01)];
      v2 = [x(first), y(yFirst)];
    } else if (frame >= last) {
      v1 = [x(last), y(yLast)];
      v2 = [x(last - 0.01), y(yLast - 0.01)];
    } else {
      v1 = [scalarAt(position.x, frame, 0), scalarAt(position.y, frame, 0)];
      v2 = [x(frame - 0.01), y(frame - 0.01)];
    }
  }
  return Math.atan2(v1[1] - v2[1], v1[0] - v2[0]);
}

/**
 * The transform's matrix at `frame`. `autoOrient` (a layer's `ao: 1`)
 * turns it along its position path, after its own rotation and before its
 * position, as lottie-web does.
 */
export function transformAt(
  transform: Transform | undefined,
  frame: number,
  autoOrient = false,
): Matrix {
  if (!transform) return IDENTITY;
  const [ax = 0, ay = 0] = valueAt(transform.a, frame, [0, 0]);
  const [sx = 100, sy = sx] = valueAt(transform.s, frame, [100, 100]);
  const position = transform.p;
  const [px = 0, py = 0] =
    position && isSplit(position)
      ? [scalarAt(position.x, frame, 0), scalarAt(position.y, frame, 0)]
      : valueAt(position, frame, [0, 0]);
  let m = translation(px, py);
  if (autoOrient) m = multiply(m, rotation(autoOrientAt(position, frame)));
  m = multiply(m, rotation(scalarAt(transform.r, frame, 0) * DEG));
  if (transform.sk) {
    // lottie-web's skewFromAxis(-sk, sa): shear along the axis at `sa`.
    const skew = scalarAt(transform.sk, frame, 0) * DEG;
    const axis = scalarAt(transform.sa, frame, 0) * DEG;
    if (skew !== 0) {
      m = multiply(m, rotation(-axis));
      m = multiply(m, [1, 0, -Math.tan(skew), 1, 0, 0]);
      m = multiply(m, rotation(axis));
    }
  }
  m = multiply(m, scaling(sx / 100, sy / 100));
  return multiply(m, translation(-ax, -ay));
}

/** The transform's opacity at `frame`, in 0..1. */
export function opacityAt(
  transform: Transform | undefined,
  frame: number,
): number {
  return scalarAt(transform?.o, frame, 100) / 100;
}
