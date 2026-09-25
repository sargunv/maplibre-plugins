// Converts paths to the closed quadratic contours the catalog stores
// (../../catalog/FORMAT.md, "Frame region"). Cubics and conics become
// quadratics within a distance tolerance, measured both ways between the
// source curve and its replacement: a cubic splits into more equal pieces
// until every piece fits one quadratic. Chains of quadratics that are finer
// than a tolerance needs (Skia's stroke outlines) can be refit with fewer.

import type { Contour, Curve, Point } from "./pack.ts";
import { type BezierPath, transformPath } from "./shapes.ts";
import { apply, type Matrix } from "./transform.ts";

/**
 * A circular arc from angle `from` to `to` (radians, y down, so positive
 * angles turn clockwise on screen) as quadratics of at most 45 degrees. The
 * curves end where the next piece of the contour starts.
 */
export function arc(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  from: number,
  to: number,
): Curve[] {
  const steps = Math.max(1, Math.ceil(Math.abs(to - from) / (Math.PI / 4)));
  const step = (to - from) / steps;
  // The control point sits where the tangents at both ends meet.
  const reach = 1 / Math.cos(step / 2);
  const curves: Curve[] = [];
  for (let i = 0; i < steps; i++) {
    const a = from + i * step;
    const mid = a + step / 2;
    curves.push({
      on: [cx + rx * Math.cos(a), cy + ry * Math.sin(a)],
      ctrl: [cx + rx * reach * Math.cos(mid), cy + ry * reach * Math.sin(mid)],
    });
  }
  return curves;
}

/** An ellipse as 8 quadratics. */
export function ellipse(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
): Contour {
  return arc(cx, cy, rx, ry, 0, 2 * Math.PI);
}

/** A circle as 8 quadratics. */
export function circle(cx: number, cy: number, r: number): Contour {
  return ellipse(cx, cy, r, r);
}

type Cubic = readonly [Point, Point, Point, Point];
type Quad = readonly [Point, Point, Point];

function lerp(a: Point, b: Point, t: number): Point {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function samePoint(a: Point, b: Point): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

export function cubicAt([p0, p1, p2, p3]: Cubic, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [
    a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
  ];
}

export function quadAt([p0, p1, p2]: Quad, t: number): Point {
  const u = 1 - t;
  return [
    u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
  ];
}

/** The part of a cubic between parameters `t0` and `t1`. */
function subCubic(c: Cubic, t0: number, t1: number): Cubic {
  // Blossoming: the sub-curve's control points are the polar values.
  const blossom = (a: number, b: number, d: number): Point => {
    const ab0 = lerp(c[0], c[1], a);
    const ab1 = lerp(c[1], c[2], a);
    const ab2 = lerp(c[2], c[3], a);
    const bc0 = lerp(ab0, ab1, b);
    const bc1 = lerp(ab1, ab2, b);
    return lerp(bc0, bc1, d);
  };
  return [
    cubicAt(c, t0),
    blossom(t0, t0, t1),
    blossom(t0, t1, t1),
    cubicAt(c, t1),
  ];
}

const SAMPLES = 24;

/** The distance from `p` to the closest point of `f` over t in 0..1. */
function distanceToCurve(p: Point, f: (t: number) => Point): number {
  let best = Infinity;
  let bestT = 0;
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const d = distance(p, f(t));
    if (d < best) {
      best = d;
      bestT = t;
    }
  }
  // Refine around the closest sample by golden-section search.
  let lo = Math.max(0, bestT - 1 / SAMPLES);
  let hi = Math.min(1, bestT + 1 / SAMPLES);
  const g = (Math.sqrt(5) - 1) / 2;
  for (let i = 0; i < 24; i++) {
    const a = hi - g * (hi - lo);
    const b = lo + g * (hi - lo);
    if (distance(p, f(a)) < distance(p, f(b))) hi = b;
    else lo = a;
  }
  return Math.min(best, distance(p, f((lo + hi) / 2)));
}

/**
 * Samples of the fit measurement stay this far inside the tolerance, since
 * the error can peak between them.
 */
const MARGIN = 0.9;

/**
 * The distance between a cubic and a quadratic with the same end points:
 * the larger of the farthest cubic point from the quadratic and the
 * farthest quadratic point from the cubic, over dense samples.
 */
function curveDistance(cubic: Cubic, quad: Quad): number {
  let worst = 0;
  const fc = (t: number): Point => cubicAt(cubic, t);
  for (let i = 1; i < 2 * SAMPLES; i++) {
    worst = Math.max(worst, distanceToQuad(fc(i / (2 * SAMPLES)), quad));
  }
  for (let i = 1; i < SAMPLES; i++) {
    worst = Math.max(worst, distanceToCurve(quadAt(quad, i / SAMPLES), fc));
  }
  return worst;
}

/** The control point where the tangents at a cubic's ends meet, if ahead of both. */
function tangentControl([p0, p1, p2, p3]: Cubic): Point | null {
  const d0: Point = [p1[0] - p0[0], p1[1] - p0[1]];
  const d1: Point = [p2[0] - p3[0], p2[1] - p3[1]];
  const cross = d0[0] * d1[1] - d0[1] * d1[0];
  if (
    Math.abs(cross) <
    1e-12 * (Math.hypot(...d0) * Math.hypot(...d1) + 1e-300)
  ) {
    return null;
  }
  const w: Point = [p3[0] - p0[0], p3[1] - p0[1]];
  const s = (w[0] * d1[1] - w[1] * d1[0]) / cross;
  const u = (w[0] * d0[1] - w[1] * d0[0]) / cross;
  if (!(s > 0 && u > 0)) return null;
  return [p0[0] + d0[0] * s, p0[1] + d0[1] * s];
}

/** Whether a cubic's control points lie on the chord between its ends. */
function isStraight([p0, p1, p2, p3]: Cubic): boolean {
  const dx = p3[0] - p0[0];
  const dy = p3[1] - p0[1];
  const length = Math.hypot(dx, dy);
  const scale = Math.max(length, Math.abs(p0[0]), Math.abs(p0[1]), 1);
  const within = (p: Point): boolean => {
    if (length === 0) return distance(p, p0) <= 1e-9 * scale;
    const along =
      ((p[0] - p0[0]) * dx + (p[1] - p0[1]) * dy) / (length * length);
    const off = Math.abs((p[0] - p0[0]) * dy - (p[1] - p0[1]) * dx) / length;
    return off <= 1e-9 * scale && along >= 0 && along <= 1;
  };
  return within(p1) && within(p2);
}

/** Most pieces one curve may split into before the baker gives up. */
const MAX_PIECES = 64;

/**
 * Quadratics within `tolerance` of a cubic, as `[ctrl, end]` pairs that
 * continue from the cubic's start. Straight cubics become one segment with
 * its control point at the midpoint.
 */
export function cubicToQuads(
  cubic: Cubic,
  tolerance: number,
): [Point, Point][] {
  const [p0, , , p3] = cubic;
  if (isStraight(cubic)) {
    return samePoint(p0, p3) ? [] : [[lerp(p0, p3, 0.5), p3]];
  }
  for (let n = 1; n <= MAX_PIECES; n++) {
    const quads: [Point, Point][] = [];
    for (let k = 0; k < n; k++) {
      const piece = subCubic(cubic, k / n, (k + 1) / n);
      const [q0, q1, q2, q3] = piece;
      const middle: Point = [
        (3 * (q1[0] + q2[0]) - q0[0] - q3[0]) / 4,
        (3 * (q1[1] + q2[1]) - q0[1] - q3[1]) / 4,
      ];
      const candidates = [tangentControl(piece), middle].filter(
        (c): c is Point => c !== null,
      );
      const fit = candidates.find(
        (c) => curveDistance(piece, [q0, c, q3]) <= tolerance * MARGIN,
      );
      if (!fit) break;
      quads.push([fit, q3]);
    }
    if (quads.length === n) {
      // Pin the last end point to the cubic's exactly.
      const last = quads[n - 1];
      if (last) last[1] = p3;
      return quads;
    }
  }
  throw new Error(
    `a cubic needs more than ${MAX_PIECES} quadratics to stay within ${tolerance}`,
  );
}

/**
 * Quadratics within `tolerance` of a rational quadratic (conic) of weight
 * `w`, as Skia's stroker emits for round joins and caps. The error of
 * drawing a conic as the quadratic with its control points is Skia's
 * estimate (kept a quarter inside the tolerance, as it is measured at the
 * middle only); halving the conic quarters it.
 */
export function conicToQuads(
  p0: Point,
  p1: Point,
  p2: Point,
  w: number,
  tolerance: number,
): [Point, Point][] {
  const a = w - 1;
  const k = a / (4 * (2 + a));
  const error =
    Math.abs(k) *
    Math.hypot(p0[0] - 2 * p1[0] + p2[0], p0[1] - 2 * p1[1] + p2[1]);
  if (error <= tolerance * 0.75 || !Number.isFinite(w)) return [[p1, p2]];
  // Split at t = 1/2 (SkConic::chop).
  const scale = 1 / (1 + w);
  const wp1: Point = [w * p1[0], w * p1[1]];
  const m: Point = [
    (p0[0] + 2 * wp1[0] + p2[0]) * scale * 0.5,
    (p0[1] + 2 * wp1[1] + p2[1]) * scale * 0.5,
  ];
  const c0: Point = [(p0[0] + wp1[0]) * scale, (p0[1] + wp1[1]) * scale];
  const c1: Point = [(wp1[0] + p2[0]) * scale, (wp1[1] + p2[1]) * scale];
  const half = Math.sqrt(0.5 + w * 0.5);
  return [
    ...conicToQuads(p0, c0, m, half, tolerance),
    ...conicToQuads(m, c1, p2, half, tolerance),
  ];
}

/**
 * Collects closed quadratic contours. Every contour is closed with a
 * straight segment when its end is not its start, since a fill closes open
 * paths that way; contours that enclose nothing (fewer than two curves, or
 * every point on one line) are dropped.
 */
export class ContourBuilder {
  readonly contours: Contour[] = [];
  private curves: Curve[] = [];
  private start: Point = [0, 0];
  private last: Point = [0, 0];
  private readonly tolerance: number;

  /** `tolerance` bounds the error of converting cubics and conics. */
  constructor(tolerance: number) {
    this.tolerance = tolerance;
  }

  moveTo(p: Point): void {
    this.finish();
    this.start = p;
    this.last = p;
  }

  lineTo(p: Point): void {
    if (samePoint(p, this.last)) return;
    this.push(lerp(this.last, p, 0.5), p);
  }

  quadTo(c: Point, p: Point): void {
    if (samePoint(p, this.last) && samePoint(c, this.last)) return;
    this.push(c, p);
  }

  conicTo(c: Point, p: Point, w: number): void {
    for (const [ctrl, end] of conicToQuads(
      this.last,
      c,
      p,
      w,
      this.tolerance,
    )) {
      this.quadTo(ctrl, end);
    }
  }

  cubicTo(c1: Point, c2: Point, p: Point): void {
    for (const [ctrl, end] of cubicToQuads(
      [this.last, c1, c2, p],
      this.tolerance,
    )) {
      this.quadTo(ctrl, end);
    }
  }

  close(): void {
    this.finish();
    this.last = this.start;
  }

  /** Ends the current contour and returns every contour. */
  done(): Contour[] {
    this.finish();
    return this.contours;
  }

  private push(ctrl: Point, end: Point): void {
    this.curves.push({ on: this.last, ctrl });
    this.last = end;
  }

  private finish(): void {
    if (this.curves.length === 0) return;
    // An end within rounding of the start closes the contour as it is;
    // anything farther gets a closing segment.
    const scale = Math.max(Math.abs(this.start[0]), Math.abs(this.start[1]), 1);
    if (distance(this.last, this.start) > 1e-6 * scale) {
      this.push(lerp(this.last, this.start, 0.5), this.start);
    }
    if (this.curves.length >= 2 && !isFlat(this.curves))
      this.contours.push(this.curves);
    this.curves = [];
    this.last = this.start;
  }
}

/** Whether every point of a contour lies on one line, so it encloses nothing. */
function isFlat(curves: readonly Curve[]): boolean {
  const points = curves.flatMap(({ on, ctrl }) => [on, ctrl]);
  const origin = points[0] as Point;
  const far = points.reduce((a, b) =>
    distance(b, origin) > distance(a, origin) ? b : a,
  );
  const length = distance(far, origin);
  if (length === 0) return true;
  const scale = Math.max(length, Math.abs(origin[0]), Math.abs(origin[1]), 1);
  return points.every(
    (p) =>
      Math.abs(
        (p[0] - origin[0]) * (far[1] - origin[1]) -
          (p[1] - origin[1]) * (far[0] - origin[0]),
      ) /
        length <=
      1e-9 * scale,
  );
}

/** A contour with every point mapped through `m`. */
export function mapContour(contour: Contour, m: Matrix): Contour {
  return contour.map(({ on, ctrl }) => ({
    on: apply(m, on),
    ctrl: apply(m, ctrl),
  }));
}

/** Real roots of `a t^3 + b t^2 + c t + d` (lower degrees when leading terms vanish). */
function cubicRoots(a: number, b: number, c: number, d: number): number[] {
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
  if (scale === 0) return [];
  if (Math.abs(a) <= 1e-12 * scale) {
    if (Math.abs(b) <= 1e-12 * scale) {
      return Math.abs(c) <= 1e-12 * scale ? [] : [-d / c];
    }
    const disc = c * c - 4 * b * d;
    if (disc < 0) return [];
    const q = Math.sqrt(disc);
    return [(-c + q) / (2 * b), (-c - q) / (2 * b)];
  }
  // Depressed cubic t = x - b / 3a: x^3 + p x + q = 0.
  const B = b / a;
  const C = c / a;
  const D = d / a;
  const p = C - (B * B) / 3;
  const q = (2 * B * B * B) / 27 - (B * C) / 3 + D;
  const shift = -B / 3;
  const disc = (q * q) / 4 + (p * p * p) / 27;
  if (disc > 0) {
    const r = Math.sqrt(disc);
    return [Math.cbrt(-q / 2 + r) + Math.cbrt(-q / 2 - r) + shift];
  }
  if (p === 0) return [shift];
  const m = 2 * Math.sqrt(-p / 3);
  const theta = Math.acos(Math.max(-1, Math.min(1, (3 * q) / (p * m)))) / 3;
  return [0, 1, 2].map(
    (k) => m * Math.cos(theta - (2 * Math.PI * k) / 3) + shift,
  );
}

/** The exact distance from `p` to a quadratic. */
export function distanceToQuad(p: Point, [p0, p1, p2]: Quad): number {
  const A: Point = [p0[0] - 2 * p1[0] + p2[0], p0[1] - 2 * p1[1] + p2[1]];
  const B: Point = [2 * (p1[0] - p0[0]), 2 * (p1[1] - p0[1])];
  const C: Point = [p0[0] - p[0], p0[1] - p[1]];
  const dot = (u: Point, v: Point): number => u[0] * v[0] + u[1] * v[1];
  // d/dt |Q(t) - p|^2 = 0.
  const roots = cubicRoots(
    2 * dot(A, A),
    3 * dot(A, B),
    dot(B, B) + 2 * dot(A, C),
    dot(B, C),
  );
  let best = Math.min(distance(p, p0), distance(p, p2));
  for (const t of roots) {
    if (t > 0 && t < 1)
      best = Math.min(best, distance(p, quadAt([p0, p1, p2], t)));
  }
  return best;
}

function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  const t =
    length === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length),
        );
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

interface Sample {
  readonly p: Point;
  /** The curve's direction here, not normalized; never zero. */
  readonly d: Point;
  /**
   * The direction arriving at the sample: `d`, or at a corner the end
   * direction of the curve before it.
   */
  readonly into: Point;
  /** Whether the curve turns a corner arriving at this sample. */
  readonly corner: boolean;
}

/** Samples taken along each quadratic when refitting. */
const REFIT_SAMPLES = 8;

function samplesOf(contour: Contour): Sample[] {
  const n = contour.length;
  const samples: Sample[] = [];
  let previousEnd: Point | null = null;
  const lastCurve = contour[n - 1];
  if (lastCurve) {
    const end = (contour[0] as Curve).on;
    previousEnd = samePoint(end, lastCurve.ctrl)
      ? [end[0] - lastCurve.on[0], end[1] - lastCurve.on[1]]
      : [end[0] - lastCurve.ctrl[0], end[1] - lastCurve.ctrl[1]];
  }
  for (let k = 0; k < n; k++) {
    const { on: p0, ctrl: p1 } = contour[k] as Curve;
    const p2 = (contour[(k + 1) % n] as Curve).on;
    for (let s = 0; s < REFIT_SAMPLES; s++) {
      const t = s / REFIT_SAMPLES;
      let d: Point = [
        2 * (1 - t) * (p1[0] - p0[0]) + 2 * t * (p2[0] - p1[0]),
        2 * (1 - t) * (p1[1] - p0[1]) + 2 * t * (p2[1] - p1[1]),
      ];
      if (d[0] === 0 && d[1] === 0) d = [p2[0] - p0[0], p2[1] - p0[1]];
      let corner = false;
      if (s === 0 && previousEnd) {
        const cross = previousEnd[0] * d[1] - previousEnd[1] * d[0];
        const dot = previousEnd[0] * d[0] + previousEnd[1] * d[1];
        // More than about half a degree of turn is a corner.
        corner = Math.abs(Math.atan2(cross, dot)) > 0.01;
      }
      samples.push({
        p: quadAt([p0, p1, p2], t),
        d,
        into: corner && previousEnd ? previousEnd : d,
        corner,
      });
    }
    previousEnd = samePoint(p2, p1)
      ? [p2[0] - p0[0], p2[1] - p0[1]]
      : [p2[0] - p1[0], p2[1] - p1[1]];
  }
  return samples;
}

/** One quadratic through samples `i..j`, or null when none fits. */
function fitSpan(
  samples: readonly Sample[],
  i: number,
  j: number,
  tolerance: number,
): Quad | null {
  const a = samples[i] as Sample;
  const b = samples[j] as Sample;
  if (samePoint(a.p, b.p)) return null;
  // Leave `a` along the direction leaving it and arrive at `b` along the
  // direction arriving there, which differ at a corner.
  const control = tangentControl([
    a.p,
    [a.p[0] + a.d[0], a.p[1] + a.d[1]],
    [b.p[0] - b.into[0], b.p[1] - b.into[1]],
    b.p,
  ]);
  const quad: Quad = [a.p, control ?? lerp(a.p, b.p, 0.5), b.p];
  // Every sample in between lies near the candidate...
  for (let k = i + 1; k < j; k++) {
    if (distanceToQuad((samples[k] as Sample).p, quad) > tolerance) return null;
  }
  // ...and the candidate stays near the polyline through the samples,
  // which the samples keep within a small fraction of the tolerance of the
  // curves they come from.
  for (let s = 1; s < SAMPLES; s++) {
    const q = quadAt(quad, s / SAMPLES);
    let best = Infinity;
    for (let k = i; k < j && best > tolerance; k++) {
      best = Math.min(
        best,
        segmentDistance(
          q,
          (samples[k] as Sample).p,
          (samples[k + 1] as Sample).p,
        ),
      );
    }
    if (best > tolerance) return null;
  }
  return quad;
}

/**
 * Refits a closed quadratic contour with as few quadratics as stay within
 * `tolerance` of it: from each point, the longest smooth span that one
 * quadratic, tangent to the contour at both ends, can follow. Corners
 * always end a span. Skia's stroker splits offset curves by halving, so its
 * outlines carry up to twice the curves a tolerance needs; this takes them
 * back down, and never returns more curves than it was given.
 */
export function refitContour(contour: Contour, tolerance: number): Contour {
  const raw = samplesOf(contour);
  const n = raw.length;
  if (n < 2) return contour;
  // Start at a corner when there is one, so no span has to cross it.
  const first = Math.max(
    0,
    raw.findIndex((s) => s.corner),
  );
  const samples = [
    ...raw.slice(first),
    ...raw.slice(0, first),
    raw[first] as Sample,
  ];
  const corners = samples.map((s, k) => s.corner && k > 0 && k < n);
  const out: Curve[] = [];
  let i = 0;
  while (i < n) {
    // The span may not reach past the next corner or the contour's end.
    let limit = i + 1;
    while (limit < n && !corners[limit]) limit++;
    // Grow the span exponentially, then bisect between the last fit and
    // the first miss.
    let good = i + 1;
    let fit = fitSpan(samples, i, good, tolerance);
    let step = 1;
    let bad = limit + 1;
    while (fit && good < limit) {
      const next = Math.min(limit, good + step);
      const candidate = fitSpan(samples, i, next, tolerance);
      if (!candidate) {
        bad = next;
        break;
      }
      good = next;
      fit = candidate;
      step *= 2;
    }
    while (bad - good > 1) {
      const mid = (good + bad) >> 1;
      const candidate = fitSpan(samples, i, mid, tolerance);
      if (candidate) {
        good = mid;
        fit = candidate;
      } else {
        bad = mid;
      }
    }
    if (!fit) {
      // Two neighbouring samples that no quadratic joins (a cusp); keep
      // the straight step between them.
      const a = (samples[i] as Sample).p;
      const b = (samples[i + 1] as Sample).p;
      fit = [a, lerp(a, b, 0.5), b];
      good = i + 1;
    }
    out.push({ on: fit[0], ctrl: fit[1] });
    i = good;
  }
  // The greedy spans can tie with the input or lose to it; the input is
  // then both no longer and more accurate.
  return out.length >= 2 && out.length < contour.length ? out : contour;
}

/** Adds a cubic bezier path to a builder as one contour. */
export function addBezierPath(builder: ContourBuilder, path: BezierPath): void {
  const { v, i, o } = path;
  const first = v[0];
  if (!first) return;
  builder.moveTo(first);
  const segments = path.closed ? v.length : v.length - 1;
  for (let k = 0; k < segments; k++) {
    const from = v[k] as Point;
    const to = v[(k + 1) % v.length] as Point;
    const out = o[k] ?? from;
    const into = i[(k + 1) % v.length] ?? to;
    if (samePoint(out, from) && samePoint(into, to)) builder.lineTo(to);
    else builder.cubicTo(out, into, to);
  }
  builder.close();
}

/** Fills: the paths mapped through `m` to canvas pixels, as contours. */
export function fillContours(
  paths: readonly BezierPath[],
  m: Matrix,
  tolerance: number,
): Contour[] {
  const builder = new ContourBuilder(tolerance);
  for (const path of paths) addBezierPath(builder, transformPath(path, m));
  return builder.done();
}
