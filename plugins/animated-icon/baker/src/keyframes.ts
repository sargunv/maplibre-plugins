// Lottie property evaluation: static values, keyframes with cubic-bezier
// easing, hold keyframes, legacy `e` end values, spatial (`to`/`ti`)
// position paths, shape morphs, and the loopIn/loopOut expressions. It
// follows lottie-web 5.13 (player/js/utils/PropertyFactory.js, bez.js,
// shapes/ShapeProperty.js, expressions/ExpressionPropertyDecorator.js) so
// baked frames match what lottie-web draws at the same time.
//
// Keyframe times are composition frames: Bodymovin already applies a layer's
// start time to its keyframes, and lottie-web compares them with the
// composition's frame directly (PropertyFactory.js:264 evaluates at
// `comp.renderedFrame - st` and interpolateValue, :33-60, subtracts the same
// `st` from every keyframe time, so it cancels).

/** A property as it appears in Lottie JSON: `k` is a value or keyframes. */
export interface Property {
  readonly a?: number;
  readonly k?: unknown;
  /**
   * An expression. The profile accepts only a whole loopIn/loopOut call
   * (parseLoop), rejecting the rest unless the entry ignores them.
   */
  readonly x?: string;
  /** A slot id (`"primary"` or `"secondary"` recolor); the value stays in `k`. */
  readonly sid?: string;
  /**
   * The parsed loop expression with what evaluating it needs, attached by
   * scene.ts's `prepare` to a copy of the file.
   */
  readonly loop?: Loop;
}

/** The loop types lottie-web implements; any other name loops as a cycle. */
export type LoopType = "cycle" | "pingpong" | "offset" | "continue";

/** A loopIn/loopOut expression (ExpressionPropertyDecorator.js:21-150). */
export interface LoopExpression {
  /** loopIn repeats before the first keyframe, loopOut after the last. */
  readonly direction: "in" | "out";
  readonly type: LoopType;
  /**
   * The second argument: keyframes in the loop, or with `durationFlag`
   * (loopInDuration/loopOutDuration) seconds. 0 means every keyframe (or
   * the layer's in or out point).
   */
  readonly duration: number;
  readonly durationFlag: boolean;
}

/** A loop expression bound to its composition's frame rate and layer. */
export interface Loop extends LoopExpression {
  /** The animation's frame rate (lottie-web's globalData.frameRate). */
  readonly fr: number;
  /** The layer's in and out points, in its composition's frames. */
  readonly ip: number;
  readonly op: number;
}

// A whole expression that only assigns a loop call with literal arguments
// to `$bm_rt`, as Bodymovin exports it: `var $bm_rt;\n$bm_rt =
// loopOut('cycle');`. lottie-web reads the result from `$bm_rt`
// (ExpressionManager.js:440), so a bare `loopOut()` draws nothing there and
// is no loop here.
const LOOP =
  /^\s*(?:var\s+\$bm_rt\s*;\s*)?\$bm_rt\s*=\s*(loopIn|loopOut|loop_in|loop_out|loopInDuration|loopOutDuration)\s*\(\s*(?:(['"])([A-Za-z]*)\2\s*(?:,\s*(\d+(?:\.\d*)?|\.\d+)\s*)?)?\)\s*;?\s*$/;

const LOOP_TYPES: readonly LoopType[] = [
  "cycle",
  "pingpong",
  "offset",
  "continue",
];

/**
 * Parses an expression that is nothing but a loopIn or loopOut call with
 * literal arguments assigned to `$bm_rt`; undefined for anything else. The
 * type is case-insensitive and may be omitted (a cycle), as in lottie-web.
 */
export function parseLoop(expression: string): LoopExpression | undefined {
  const match = LOOP.exec(expression);
  if (!match) return undefined;
  const [, name = "", , rawType = "", rawDuration] = match;
  const type = (rawType.toLowerCase() || "cycle") as LoopType;
  if (!LOOP_TYPES.includes(type)) return undefined;
  return {
    direction: name.startsWith("loopIn") || name === "loop_in" ? "in" : "out",
    type,
    duration: rawDuration === undefined ? 0 : Number(rawDuration),
    durationFlag: name.endsWith("Duration"),
  };
}

/** A bezier path as Lottie stores it: tangents relative to their vertex. */
export interface ShapeValue {
  readonly c?: boolean;
  readonly v: readonly (readonly number[])[];
  readonly i: readonly (readonly number[])[];
  readonly o: readonly (readonly number[])[];
}

interface Easing {
  readonly x: number | readonly number[];
  readonly y: number | readonly number[];
}

interface Keyframe {
  readonly t: number;
  readonly s?: unknown;
  readonly e?: unknown;
  readonly h?: number;
  readonly i?: Easing;
  readonly o?: Easing;
  readonly to?: readonly number[] | null;
  readonly ti?: readonly number[] | null;
}

/** Whether a `k` holds keyframes rather than a value. */
export function isKeyframed(k: unknown): k is readonly Keyframe[] {
  return (
    Array.isArray(k) &&
    k.length > 0 &&
    typeof k[0] === "object" &&
    k[0] !== null &&
    "t" in k[0]
  );
}

/** Whether a property changes over time. */
export function isAnimated(property: Property | undefined): boolean {
  return property !== undefined && isKeyframed(property.k);
}

function vector(value: unknown): number[] {
  if (typeof value === "number") return [value];
  if (Array.isArray(value)) return value.map((x) => Number(x));
  return [];
}

function component(
  value: number | readonly number[] | undefined,
  index: number,
  fallback: number,
): number {
  if (typeof value === "number") return value;
  return value?.[index] ?? value?.[0] ?? fallback;
}

// Cubic-bezier easing from (0,0) through (x1,y1), (x2,y2) to (1,1), solved
// for x with Newton steps and a bisection fallback, as CSS timing functions
// and lottie-web's BezierEaser are.
function bezierCoordinate(u: number, p1: number, p2: number): number {
  return ((1 - 3 * p2 + 3 * p1) * u + (3 * p2 - 6 * p1)) * u * u + 3 * p1 * u;
}

function bezierSlope(u: number, p1: number, p2: number): number {
  return 3 * (1 - 3 * p2 + 3 * p1) * u * u + 2 * (3 * p2 - 6 * p1) * u + 3 * p1;
}

/** The eased progress at linear progress `x` in 0..1. */
export function ease(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x: number,
): number {
  if (x1 === y1 && x2 === y2) return x;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let u = x;
  for (let i = 0; i < 8; i++) {
    const slope = bezierSlope(u, x1, x2);
    if (Math.abs(slope) < 1e-6) break;
    const next = u - (bezierCoordinate(u, x1, x2) - x) / slope;
    if (!(next >= 0 && next <= 1)) break;
    u = next;
  }
  if (Math.abs(bezierCoordinate(u, x1, x2) - x) > 1e-12) {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 60; i++) {
      u = (lo + hi) / 2;
      if (bezierCoordinate(u, x1, x2) < x) lo = u;
      else hi = u;
    }
  }
  return bezierCoordinate(u, y1, y2);
}

function easeAt(key: Keyframe, index: number, progress: number): number {
  if (!key.o || !key.i) return progress;
  return ease(
    component(key.o.x, index, 0),
    component(key.o.y, index, 0),
    component(key.i.x, index, 1),
    component(key.i.y, index, 1),
    progress,
  );
}

// lottie-web's collinearity test for spatial tangents.
function onLine(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
): boolean {
  const det = x1 * y2 + y1 * x3 + x2 * y3 - x3 * y2 - y3 * x1 - x2 * y1;
  return det > -0.001 && det < 0.001;
}

/**
 * The spatial tangents lottie-web keeps: it drops them when both lie on the
 * straight path between the keyframes, or when the keyframes and tangents
 * are all the same point.
 */
function spatialTangents(
  s: readonly number[],
  e: readonly number[],
  to: readonly number[] | null | undefined,
  ti: readonly number[] | null | undefined,
): [readonly number[], readonly number[]] | null {
  if (!to || !ti || s.length < 2) return null;
  const [sx = 0, sy = 0] = s;
  const [ex = 0, ey = 0] = e;
  const [ox = 0, oy = 0] = to;
  const [ix = 0, iy = 0] = ti;
  const same = sx === ex && sy === ey;
  if (
    !same &&
    onLine(sx, sy, ex, ey, sx + ox, sy + oy) &&
    onLine(sx, sy, ex, ey, ex + ix, ey + iy)
  ) {
    return null;
  }
  if (same && ox === 0 && oy === 0 && ix === 0 && iy === 0) return null;
  return [to, ti];
}

/** Points lottie-web samples along a spatial keyframe path. */
const SPATIAL_SEGMENTS = 150;

/**
 * A point along the cubic from `s` to `e` with tangents `to` and `ti`, at
 * `progress` of its arc length, measured on the same polyline lottie-web
 * uses.
 */
function spatialAt(
  s: readonly number[],
  e: readonly number[],
  to: readonly number[],
  ti: readonly number[],
  progress: number,
): number[] {
  const dims = Math.min(s.length, e.length);
  const points: number[][] = [];
  const lengths: number[] = [];
  let total = 0;
  for (let k = 0; k < SPATIAL_SEGMENTS; k++) {
    const u = k / (SPATIAL_SEGMENTS - 1);
    const point: number[] = [];
    let distance = 0;
    for (let d = 0; d < dims; d++) {
      const p0 = s[d] ?? 0;
      const p3 = e[d] ?? 0;
      const p1 = p0 + (to[d] ?? 0);
      const p2 = p3 + (ti[d] ?? 0);
      const v =
        (1 - u) ** 3 * p0 +
        3 * (1 - u) ** 2 * u * p1 +
        3 * (1 - u) * u ** 2 * p2 +
        u ** 3 * p3;
      point.push(v);
      const previous = points[k - 1]?.[d];
      if (previous !== undefined) distance += (v - previous) ** 2;
    }
    distance = Math.sqrt(distance);
    total += distance;
    points.push(point);
    lengths.push(distance);
  }
  const target = total * progress;
  let added = 0;
  for (let j = 0; j < SPATIAL_SEGMENTS; j++) {
    added += lengths[j] ?? 0;
    const point = points[j] ?? [];
    if (target === 0 || progress === 0 || j === SPATIAL_SEGMENTS - 1) {
      return [...point];
    }
    const next = points[j + 1] ?? point;
    const span = lengths[j + 1] ?? 0;
    if (target >= added && target < added + span) {
      const f = (target - added) / span;
      return point.map((v, d) => v + ((next[d] ?? v) - v) * f);
    }
  }
  return [...(points.at(-1) ?? [])];
}

/**
 * Finds the keyframe pair around `frame`: `before` holds from its time
 * until `after`'s. Before the first keyframe `before` is the first one;
 * from the last one on, the value is the last keyframe's.
 */
function segment(
  keys: readonly Keyframe[],
  frame: number,
): { key: Keyframe; next: Keyframe | undefined } {
  const first = keys[0] as Keyframe;
  if (keys.length === 1 || frame < first.t)
    return { key: first, next: undefined };
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i] as Keyframe;
    const next = keys[i + 1] as Keyframe;
    if (frame < next.t) return { key, next };
  }
  const last = keys.at(-1) as Keyframe;
  // A trailing keyframe without a value (old exports) ends at the previous
  // keyframe's `e`.
  if (last.s === undefined) {
    const previous = keys.at(-2) as Keyframe;
    return { key: { t: last.t, s: previous.e ?? previous.s }, next: undefined };
  }
  return { key: last, next: undefined };
}

/** The value of a numeric property at `frame`, as an array of components. */
export function valueAt(
  property: Property | undefined,
  frame: number,
  fallback: readonly number[],
): number[] {
  if (property?.loop && isKeyframed(property.k)) {
    return loopAt(property, property.k, property.loop, frame, fallback);
  }
  return keyframedValueAt(property, frame, fallback);
}

/**
 * valueAt without the property's loop expression: lottie-web's
 * getValueAtTime, which expressions and auto-orient sample.
 */
export function keyframedValueAt(
  property: Property | undefined,
  frame: number,
  fallback: readonly number[],
): number[] {
  if (!property || property.k === undefined) return [...fallback];
  if (!isKeyframed(property.k)) {
    const value = vector(property.k);
    return value.length > 0 ? value : [...fallback];
  }
  const { key, next } = segment(property.k, frame);
  const start = vector(key.s);
  if (!next || key.h === 1) return start.length > 0 ? start : [...fallback];
  const end = vector(next.s ?? key.e);
  const progress = (frame - key.t) / (next.t - key.t);
  const tangents = spatialTangents(start, end, key.to, key.ti);
  if (tangents) {
    return spatialAt(
      start,
      end,
      tangents[0],
      tangents[1],
      easeAt(key, 0, progress),
    );
  }
  return start.map(
    (s, d) => s + ((end[d] ?? s) - s) * easeAt(key, d, progress),
  );
}

/**
 * A property's value under its loop expression, ported from lottie-web's
 * loopOut and loopIn (ExpressionPropertyDecorator.js:21-150) with their
 * quirks: loopIn's cycle measures from the start of the composition, and
 * continue scales multi-component and scalar slopes differently. `frame`
 * is the composition frame (lottie-web's `comp.renderedFrame`); every
 * `getValueAtTime(x / frameRate)` there evaluates the keyframes at frame x.
 */
function loopAt(
  property: Property,
  keys: readonly Keyframe[],
  loop: Loop,
  frame: number,
  fallback: readonly number[],
): number[] {
  const at = (x: number): number[] => keyframedValueAt(property, x, fallback);
  const current = at(frame);
  // lottie-web keeps a scalar property's value as a number and a
  // multidimensional one's as an array (`this.pv.length`).
  const scalar = current.length === 1;
  const combine = (f: (i: number) => number): number[] =>
    current.map((_, i) => f(i));
  const first = (keys[0] as Keyframe).t;
  const last = (keys.at(-1) as Keyframe).t;
  if (loop.direction === "out") {
    if (frame <= last) return current;
    let firstKey: number;
    let cycle: number;
    if (!loop.durationFlag) {
      let n = loop.duration;
      if (!n || n > keys.length - 1) n = keys.length - 1;
      firstKey = (keys[keys.length - 1 - Math.floor(n)] as Keyframe).t;
      cycle = last - firstKey;
    } else {
      cycle = !loop.duration
        ? Math.max(0, last - loop.ip)
        : Math.abs(last - loop.fr * loop.duration);
      firstKey = last - cycle;
    }
    // lottie-web would divide by zero here; the value then holds.
    if (!(cycle > 0)) return current;
    const into = frame - firstKey;
    if (loop.type === "pingpong") {
      if (Math.floor(into / cycle) % 2 !== 0) {
        return at(cycle - (into % cycle) + firstKey);
      }
    } else if (loop.type === "offset") {
      const init = at(firstKey);
      const end = at(last);
      const now = at((into % cycle) + firstKey);
      const repeats = Math.floor(into / cycle);
      return combine(
        (i) => ((end[i] ?? 0) - (init[i] ?? 0)) * repeats + (now[i] ?? 0),
      );
    } else if (loop.type === "continue") {
      const lastValue = at(last);
      const before = at(last - 0.001);
      return combine((i) => {
        const slope = (lastValue[i] ?? 0) - (before[i] ?? 0);
        return scalar
          ? (lastValue[i] ?? 0) + slope * ((frame - last) / 0.001)
          : (lastValue[i] ?? 0) + (slope * ((frame - last) / loop.fr)) / 0.0005;
      });
    }
    return at((into % cycle) + firstKey);
  }
  if (frame >= first) return current;
  let lastKey: number;
  let cycle: number;
  if (!loop.durationFlag) {
    let n = loop.duration;
    if (!n || n > keys.length - 1) n = keys.length - 1;
    lastKey = (keys[Math.floor(n)] as Keyframe).t;
    cycle = lastKey - first;
  } else {
    cycle = !loop.duration
      ? Math.max(0, loop.op - first)
      : Math.abs(loop.fr * loop.duration);
    lastKey = first + cycle;
  }
  if (!(cycle > 0)) return current;
  const before = first - frame;
  if (loop.type === "pingpong") {
    if (Math.floor(before / cycle) % 2 === 0) {
      return at((before % cycle) + first);
    }
  } else if (loop.type === "offset") {
    const init = at(first);
    const end = at(lastKey);
    const now = at(cycle - (before % cycle) + first);
    const repeats = Math.floor(before / cycle) + 1;
    return combine(
      (i) => (now[i] ?? 0) - ((end[i] ?? 0) - (init[i] ?? 0)) * repeats,
    );
  } else if (loop.type === "continue") {
    const firstValue = at(first);
    const after = at(first + 0.001);
    return combine(
      (i) =>
        (firstValue[i] ?? 0) +
        (((firstValue[i] ?? 0) - (after[i] ?? 0)) * before) / 0.001,
    );
  }
  return at(cycle - ((before % cycle) + first));
}

/** The first component of a property at `frame`. */
export function scalarAt(
  property: Property | undefined,
  frame: number,
  fallback: number,
): number {
  return valueAt(property, frame, [fallback])[0] ?? fallback;
}

function shapeOf(value: unknown): ShapeValue | undefined {
  const shape = Array.isArray(value) ? value[0] : value;
  if (typeof shape === "object" && shape !== null && "v" in shape) {
    return shape as ShapeValue;
  }
  return undefined;
}

function lerpPoints(
  a: readonly (readonly number[])[],
  b: readonly (readonly number[])[],
  f: number,
): number[][] {
  return a.map((p, j) => p.map((v, d) => v + ((b[j]?.[d] ?? v) - v) * f));
}

/**
 * The value of a shape property (`sh.ks`) at `frame`; morphs interpolate
 * every vertex and tangent with the keyframe's easing. Returns undefined
 * when the keyframes are malformed; mismatched vertex counts throw.
 */
export function shapeAt(
  property: Property | undefined,
  frame: number,
): ShapeValue | undefined {
  if (!property) return undefined;
  if (!isKeyframed(property.k)) return shapeOf(property.k);
  const { key, next } = segment(property.k, frame);
  const start = shapeOf(key.s);
  if (!start || !next || key.h === 1) return start;
  const end = shapeOf(next.s ?? key.e);
  if (!end) return start;
  if (end.v.length !== start.v.length) {
    throw new Error(
      `shape keyframes at frames ${key.t} and ${next.t} have ${start.v.length} and ${end.v.length} vertices; a morph needs the same count`,
    );
  }
  const f = easeAt(key, 0, (frame - key.t) / (next.t - key.t));
  return {
    c: start.c,
    v: lerpPoints(start.v, end.v, f),
    i: lerpPoints(start.i, end.i, f),
    o: lerpPoints(start.o, end.o, f),
  };
}
