// Trim paths (`tm`), ported from lottie-web 5.13's TrimModifier
// (player/js/utils/shapes/TrimModifier.js) and the bezier measurements it
// uses (player/js/utils/bez.js), so a trimmed path has the same vertices as
// the one lottie-web strokes: lengths measured on 150-point polylines kept
// in float32, cut points rounded to thousandths, the same start and end
// normalisation, and the same wrap-around joins. Porting the modifier,
// rather than trimming with Skia, also keeps the result a cubic bezier path
// in the shape's own space, which later modifiers and styles take as is.

import type { Point } from "./pack.ts";
import type { BezierPath } from "./shapes.ts";

/** lottie-web's default curve segments per bezier (utils/common.js:42). */
const CURVE_SEGMENTS = 150;

/** bez.getBezierLength's result: cumulative lengths along a polyline. */
interface LengthData {
  readonly addedLength: number;
  readonly percents: Float32Array;
  readonly lengths: Float32Array;
}

function bezierLength(p1: Point, p2: Point, p3: Point, p4: Point): LengthData {
  const percents = new Float32Array(CURVE_SEGMENTS);
  const lengths = new Float32Array(CURVE_SEGMENTS);
  let added = 0;
  let last: Point | undefined;
  for (let k = 0; k < CURVE_SEGMENTS; k++) {
    const perc = k / (CURVE_SEGMENTS - 1);
    const u = 1 - perc;
    const point: Point = [
      u ** 3 * p1[0] +
        3 * u ** 2 * perc * p3[0] +
        3 * u * perc ** 2 * p4[0] +
        perc ** 3 * p2[0],
      u ** 3 * p1[1] +
        3 * u ** 2 * perc * p3[1] +
        3 * u * perc ** 2 * p4[1] +
        perc ** 3 * p2[1],
    ];
    if (last) {
      const d = (point[0] - last[0]) ** 2 + (point[1] - last[1]) ** 2;
      if (d) added += Math.sqrt(d);
    }
    last = point;
    percents[k] = perc;
    lengths[k] = added;
  }
  return { addedLength: added, percents, lengths };
}

interface SegmentsLength {
  readonly lengths: LengthData[];
  readonly totalLength: number;
}

/** bez.getSegmentsLength: every segment's length, closing one included. */
function segmentsLength(path: BezierPath): SegmentsLength {
  const { v, i, o } = path;
  const n = v.length;
  const lengths: LengthData[] = [];
  let total = 0;
  for (let k = 0; k < n - 1; k++) {
    const data = bezierLength(
      v[k] as Point,
      v[k + 1] as Point,
      o[k] as Point,
      i[k + 1] as Point,
    );
    lengths.push(data);
    total += data.addedLength;
  }
  if (path.closed && n) {
    const data = bezierLength(
      v[n - 1] as Point,
      v[0] as Point,
      o[n - 1] as Point,
      i[0] as Point,
    );
    lengths.push(data);
    total += data.addedLength;
  }
  return { lengths, totalLength: total };
}

/** bez.getDistancePerc: the curve parameter at a fraction of its length. */
function distancePerc(perc: number, data: LengthData): number {
  const { percents, lengths } = data;
  const len = percents.length;
  let initPos = Math.floor((len - 1) * perc);
  const lengthPos = perc * data.addedLength;
  let lPerc = 0;
  if (initPos === len - 1 || initPos === 0 || lengthPos === lengths[initPos]) {
    return percents[initPos] as number;
  }
  const dir = (lengths[initPos] as number) > lengthPos ? -1 : 1;
  let flag = true;
  while (flag) {
    const here = lengths[initPos] as number;
    const next = lengths[initPos + 1] as number;
    if (here <= lengthPos && next > lengthPos) {
      lPerc = (lengthPos - here) / (next - here);
      flag = false;
    } else {
      initPos += dir;
    }
    if (initPos < 0 || initPos >= len - 1) {
      if (initPos === len - 1) return percents[initPos] as number;
      flag = false;
    }
  }
  const at = percents[initPos] as number;
  return at + ((percents[initPos + 1] as number) - at) * lPerc;
}

const round3 = (x: number): number => Math.fround(Math.round(x * 1000) / 1000);

/**
 * bez.getNewSegment: the cubic between two fractions of a segment's
 * length, as [start, out, in, end], rounded to thousandths as lottie-web
 * rounds them.
 */
function newSegment(
  p1: Point,
  p2: Point,
  p3: Point,
  p4: Point,
  startPerc: number,
  endPerc: number,
  data: LengthData,
): [Point, Point, Point, Point] {
  const t0 = distancePerc(Math.min(1, Math.max(0, startPerc)), data);
  const t1 = distancePerc(endPerc > 1 ? 1 : endPerc, data);
  const u0 = 1 - t0;
  const u1 = 1 - t1;
  const out: number[][] = [[], [], [], []];
  for (const d of [0, 1] as const) {
    const a = p1[d];
    const b = p3[d];
    const c = p4[d];
    const e = p2[d];
    out[0]?.push(
      round3(
        u0 * u0 * u0 * a +
          t0 * u0 * u0 * 3 * b +
          t0 * t0 * u0 * 3 * c +
          t0 * t0 * t0 * e,
      ),
    );
    out[1]?.push(
      round3(
        u0 * u0 * u1 * a +
          (t0 * u0 * u1 + u0 * t0 * u1 + u0 * u0 * t1) * b +
          (t0 * t0 * u1 + u0 * t0 * t1 + t0 * u0 * t1) * c +
          t0 * t0 * t1 * e,
      ),
    );
    out[2]?.push(
      round3(
        u0 * u1 * u1 * a +
          (t0 * u1 * u1 + u0 * t1 * u1 + u0 * u1 * t1) * b +
          (t0 * t1 * u1 + u0 * t1 * t1 + t0 * u1 * t1) * c +
          t0 * t1 * t1 * e,
      ),
    );
    out[3]?.push(
      round3(
        u1 * u1 * u1 * a +
          (t1 * u1 * u1 + u1 * t1 * u1 + u1 * u1 * t1) * b +
          (t1 * t1 * u1 + u1 * t1 * t1 + t1 * u1 * t1) * c +
          t1 * t1 * t1 * e,
      ),
    );
  }
  const point = (k: number): Point => [out[k]?.[0] ?? 0, out[k]?.[1] ?? 0];
  return [point(0), point(1), point(2), point(3)];
}

/** A path being built the way lottie-web's ShapePath.setXYAt grows one. */
class Builder {
  closed = false;
  readonly v: Point[] = [];
  readonly i: Point[] = [];
  readonly o: Point[] = [];
  get length(): number {
    return this.v.length;
  }
  /** TrimModifier.addSegment: one whole or partial segment at `pos`. */
  add(
    start: Point,
    out: Point,
    into: Point,
    end: Point,
    pos: number,
    newShape: boolean,
  ): void {
    this.o[pos] = out;
    this.i[pos + 1] = into;
    if (newShape) this.v[pos] = start;
    this.v[pos + 1] = end;
  }
  path(): BezierPath {
    const n = this.v.length;
    const fill = (points: Point[]): Point[] =>
      Array.from({ length: n }, (_, k) => points[k] ?? (this.v[k] as Point));
    return {
      closed: this.closed,
      v: fill(this.v),
      i: fill(this.i),
      o: fill(this.o),
    };
  }
}

interface Span {
  readonly s: number;
  readonly e: number;
}

/** TrimModifier.addShapes: the parts of a shape's paths inside `span`. */
function addShapes(
  paths: readonly BezierPath[],
  data: readonly SegmentsLength[],
  span: Span,
  continued?: Builder,
): Builder[] {
  let added = 0;
  let path = continued ?? new Builder();
  let segmentCount = continued ? continued.length : 0;
  let initPos = continued ? continued.length : 0;
  let newShape = true;
  const shapes = [path];
  for (let p = 0; p < paths.length; p++) {
    const source = paths[p] as BezierPath;
    const lengths = (data[p] as SegmentsLength).lengths;
    const { v, i, o } = source;
    path.closed = source.closed;
    const jLen = source.closed ? lengths.length : lengths.length + 1;
    let j = 1;
    for (; j < jLen; j++) {
      const current = lengths[j - 1] as LengthData;
      if (added + current.addedLength < span.s) {
        added += current.addedLength;
        path.closed = false;
      } else if (added > span.e) {
        path.closed = false;
        break;
      } else {
        if (span.s <= added && span.e >= added + current.addedLength) {
          path.add(
            v[j - 1] as Point,
            o[j - 1] as Point,
            i[j] as Point,
            v[j] as Point,
            segmentCount,
            newShape,
          );
        } else {
          const [a, b, c, d] = newSegment(
            v[j - 1] as Point,
            v[j] as Point,
            o[j - 1] as Point,
            i[j] as Point,
            (span.s - added) / current.addedLength,
            (span.e - added) / current.addedLength,
            current,
          );
          path.add(a, b, c, d, segmentCount, newShape);
          path.closed = false;
        }
        newShape = false;
        added += current.addedLength;
        segmentCount += 1;
      }
    }
    if (source.closed && lengths.length) {
      const current = lengths[j - 1] as LengthData;
      if (added <= span.e) {
        const segmentLength = current.addedLength;
        if (span.s <= added && span.e >= added + segmentLength) {
          path.add(
            v[j - 1] as Point,
            o[j - 1] as Point,
            i[0] as Point,
            v[0] as Point,
            segmentCount,
            newShape,
          );
        } else {
          const [a, b, c, d] = newSegment(
            v[j - 1] as Point,
            v[0] as Point,
            o[j - 1] as Point,
            i[0] as Point,
            (span.s - added) / segmentLength,
            (span.e - added) / segmentLength,
            current,
          );
          path.add(a, b, c, d, segmentCount, newShape);
          path.closed = false;
        }
        newShape = false;
      } else {
        path.closed = false;
      }
      added += current.addedLength;
      segmentCount += 1;
    }
    if (path.length) {
      // The path's ends get no handles beyond them.
      path.i[initPos] = path.v[initPos] as Point;
      path.o[path.length - 1] = path.v[path.length - 1] as Point;
    }
    if (added > span.e) break;
    if (p < paths.length - 1) {
      path = new Builder();
      newShape = true;
      shapes.push(path);
      segmentCount = 0;
      initPos = 0;
    }
  }
  return shapes;
}

/** TrimModifier.calculateShapeEdges: one shape's share of a sequential trim. */
function shapeEdges(
  s: number,
  e: number,
  shapeLength: number,
  addedLength: number,
  totalLength: number,
): [number, number][] {
  const segments: Span[] =
    e <= 1
      ? [{ s, e }]
      : s >= 1
        ? [{ s: s - 1, e: e - 1 }]
        : [
            { s, e: 1 },
            { s: 0, e: e - 1 },
          ];
  const edges: [number, number][] = [];
  for (const segment of segments) {
    if (
      !(
        segment.e * totalLength < addedLength ||
        segment.s * totalLength > addedLength + shapeLength
      )
    ) {
      const shapeS =
        segment.s * totalLength <= addedLength
          ? 0
          : (segment.s * totalLength - addedLength) / shapeLength;
      const shapeE =
        segment.e * totalLength >= addedLength + shapeLength
          ? 1
          : (segment.e * totalLength - addedLength) / shapeLength;
      edges.push([shapeS, shapeE]);
    }
  }
  if (edges.length === 0) edges.push([0, 0]);
  return edges;
}

/** A trim's values at one frame, as the Lottie file gives them. */
export interface TrimValues {
  /** Start and end, in percent of the length. */
  readonly start: number;
  readonly end: number;
  /** Offset, in degrees: 360 moves the range once around. */
  readonly offset: number;
  /** 1 trims each shape alone ("simultaneously"), 2 all as one path ("individually"). */
  readonly mode: number;
}

/**
 * The normalised range lottie-web trims to (TrimModifier.js:90-121): the
 * start and end moved by the offset, clamped, ordered, and rounded to
 * 1e-4. `end` may exceed 1, which wraps around the path's start.
 */
export function trimRange({
  start,
  end,
  offset,
}: TrimValues): [number, number] {
  let o = (offset % 360) / 360;
  if (o < 0) o += 1;
  const sv = start / 100;
  const ev = end / 100;
  let s = sv > 1 ? 1 + o : sv < 0 ? o : sv + o;
  let e = ev > 1 ? 1 + o : ev < 0 ? o : ev + o;
  if (s > e) [s, e] = [e, s];
  return [Math.round(s * 10000) * 0.0001, Math.round(e * 10000) * 0.0001];
}

/**
 * Trims shapes, each given as the paths of one shape item in document
 * order, returning each shape's new paths (TrimModifier.processShapes).
 * An empty range removes every path; the full range leaves them untouched.
 */
export function trimShapes(
  shapes: readonly (readonly BezierPath[])[],
  values: TrimValues,
): BezierPath[][] {
  const [s, e] = trimRange(values);
  if (e === s) return shapes.map(() => []);
  if ((e === 1 && s === 0) || (e === 0 && s === 1)) {
    return shapes.map((paths) => [...paths]);
  }
  const data = shapes.map((paths) => paths.map(segmentsLength));
  const shapeLengths = data.map((d) =>
    d.reduce((sum, path) => sum + path.totalLength, 0),
  );
  const total = shapeLengths.reduce((sum, x) => sum + x, 0);
  const sequential = values.mode === 2 && shapes.length > 1;
  let added = 0;
  return shapes.map((paths, index) => {
    const shapeLength = shapeLengths[index] as number;
    const pathsData = data[index] as SegmentsLength[];
    let edges: [number, number][];
    if (sequential) {
      edges = shapeEdges(s, e, shapeLength, added, total);
      added += shapeLength;
    } else {
      edges = [[s, e]];
    }
    const out: Builder[] = [];
    for (const [shapeS, shapeE] of edges) {
      const segments: Span[] =
        shapeE <= 1
          ? [{ s: shapeLength * shapeS, e: shapeLength * shapeE }]
          : shapeS >= 1
            ? [{ s: shapeLength * (shapeS - 1), e: shapeLength * (shapeE - 1) }]
            : [
                { s: shapeLength * shapeS, e: shapeLength },
                { s: 0, e: shapeLength * (shapeE - 1) },
              ];
      const [first, second] = segments as [Span, Span | undefined];
      let pieces = addShapes(paths, pathsData, first);
      if (first.s !== first.e) {
        if (second) {
          if (paths.at(-1)?.closed) {
            // A closed path continues from the end around to its start.
            const last = pieces.pop() as Builder;
            out.push(...pieces);
            pieces = addShapes(paths, pathsData, second, last);
          } else {
            out.push(...pieces);
            pieces = addShapes(paths, pathsData, second);
          }
        }
        out.push(...pieces);
      }
    }
    return out.filter((path) => path.length > 0).map((path) => path.path());
  });
}
