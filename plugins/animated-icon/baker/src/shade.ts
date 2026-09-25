// The CPU twin of ../../shaders/icon.glsl: the same statements in the same
// order, rounded to f32 (Math.fround) at every step the shader takes in f32,
// with the same clamps on every loop bound, index and texel row. The baker
// measures visits with it, tests check coverage with it, and a GPU harness
// compares the shader with it pixel for pixel. The GPU may fuse multiply-adds
// and round divisions and square roots differently, so results agree to
// within a few f32 ulps, not bit for bit.

import type { Point } from "./pack.ts";

/** The catalog texture as the shader sees it: Catalog.texture and its size. */
export interface ArtTexture {
  /** width × height texels, four floats each. */
  readonly texels: Float32Array;
  /** 1024 or 2048. */
  readonly width: number;
  readonly height: number;
}

export interface ShadeInput {
  readonly art: ArtTexture;
  /** The frame record's texel: an animation's frameTexel plus the frame. */
  readonly frameTexel: number;
  /** The pixel centre in canvas pixels. */
  readonly uv: Point;
  /** Canvas pixels per screen pixel along screen x and y (dFdx, dFdy of uv). */
  readonly dx: Point;
  readonly dy: Point;
  /** Premultiplied recolors; default (0, 0, 0, 0), which draws as authored. */
  readonly primary?: readonly number[];
  readonly secondary?: readonly number[];
  /** Defaults to 1. */
  readonly opacity?: number;
}

type Vec4 = [number, number, number, number];

const f = Math.fround;
const F_1E_6 = f(1e-6);
const F_1E_12 = f(1e-12);
const F_1_65536 = 1 / 65536;

function clamp(x: number, lo: number, hi: number): number {
  // GLSL's min(max(x, lo), hi); NaN has no defined result there, so any
  // value in range will do.
  return Number.isNaN(x) ? lo : Math.min(Math.max(x, lo), hi);
}

function sat(x: number): number {
  return clamp(x, 0, 1);
}

/**
 * GLSL's int(x): truncation toward zero. Out-of-range and NaN values are
 * undefined in GLSL; here they saturate (NaN becomes 0), and the shader's
 * clamps make any int safe.
 */
function toInt(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x >= 2147483647) return 2147483647;
  if (x <= -2147483648) return -2147483648;
  return Math.trunc(x) | 0;
}

/** FETCH(i): column i & (W - 1), row i >> log2(W) clamped to the texture. */
function fetch(art: ArtTexture, i: number): Vec4 {
  const shift = art.width === 2048 ? 11 : 10;
  const x = i & (art.width - 1);
  const row = Math.min(Math.max(i >> shift, 0), art.height - 1);
  const k = (row * art.width + x) * 4;
  const t = art.texels;
  return [t[k] ?? 0, t[k + 1] ?? 0, t[k + 2] ?? 0, t[k + 3] ?? 0];
}

/** iconRootCode: which roots of a sample-relative quadratic cross the ray. */
export function rootCode(y1: number, y2: number, y3: number): number {
  const shift = (y1 < 0 ? 1 : 0) | (y2 < 0 ? 2 : 0) | (y3 < 0 ? 4 : 0);
  return (0x2e74 >>> shift) & 0x0101;
}

/** iconSolve: the x of the two roots where (p1, p2, p3) crosses y = 0. */
export function solve(p1: Point, p2: Point, p3: Point): [number, number] {
  const ax = f(f(p1[0] - f(p2[0] * 2)) + p3[0]);
  const ay = f(f(p1[1] - f(p2[1] * 2)) + p3[1]);
  const bx = f(p1[0] - p2[0]);
  const by = f(p1[1] - p2[1]);
  const discriminant = f(f(by * by) - f(ay * p1[1]));
  const curved = Math.abs(ay) > F_1E_12;
  const tVertex = curved ? f(by / ay) : 0;
  const root = f(Math.sqrt(Math.max(discriminant, 0)));
  const q = by >= 0 ? f(by + root) : f(by - root);
  const tNear = discriminant > 0 ? f(p1[1] / q) : tVertex;
  const tFar = discriminant > 0 && curved ? f(q / ay) : tNear;
  const t1 = by >= 0 ? tNear : tFar;
  const t2 = by >= 0 ? tFar : tNear;
  const x = (t: number): number => f(f(f(f(ax * t) - f(bx * 2)) * t) + p1[0]);
  return [x(t1), x(t2)];
}

/**
 * iconCoverage: the coverage of the shape record at `shapeTexel` at local
 * point `q`, with `perPixel` screen pixels per local unit. `visits` counts
 * the curve-loop iterations entered on both rays, including one that exits.
 */
export function coverage(
  art: ArtTexture,
  shapeTexel: number,
  q: Point,
  perPixel: Point,
  evenOdd: boolean,
): { coverage: number; visits: number } {
  const [qx, qy] = [f(q[0]), f(q[1])];
  const [ppx, ppy] = [f(perPixel[0]), f(perPixel[1])];
  const shape = shapeTexel | 0;
  const counts = fetch(art, shape);
  const transform = fetch(art, (shape + 1) | 0);
  const hCount = clamp(toInt(f(counts[0] + 0.5)), 1, 16);
  const vCount = clamp(toInt(f(counts[1] + 0.5)), 1, 16);
  const hBand = clamp(
    toInt(Math.floor(f(f(qy * transform[0]) + transform[1]))),
    0,
    hCount - 1,
  );
  const vBand = clamp(
    toInt(Math.floor(f(f(qx * transform[2]) + transform[3]))),
    0,
    vCount - 1,
  );
  const hHeader = fetch(art, (shape + 2 + hBand) | 0);
  const vHeader = fetch(art, (shape + 2 + hCount + vBand) | 0);
  let visits = 0;

  // One ray; `vertical` swaps the axes. Returns (cov, wgt).
  const ray = (header: Vec4, vertical: boolean): [number, number] => {
    const along = vertical ? qy : qx;
    const pp = vertical ? ppy : ppx;
    // The vertical ray counts crossings with the opposite sign.
    const sign = vertical ? -1 : 1;
    let cov = 0;
    let wgt = 0;
    const neg = along < header[0];
    const count = clamp(toInt(f(header[1] + 0.5)), 0, 1024);
    const list = toInt(f(header[2] + 0.5));
    for (let i = 0; i < count; i++) {
      visits++;
      const entry = fetch(art, (list + (i >> 1)) | 0);
      const pair = (i & 1) === 0 ? [entry[0], entry[1]] : [entry[2], entry[3]];
      const c = toInt(f(((neg ? pair[1] : pair[0]) ?? 0) + 0.5));
      const t0 = fetch(art, c);
      const t1 = fetch(art, (c + 1) | 0);
      let p1: Point = [f(t0[0] - qx), f(t0[1] - qy)];
      let p2: Point = [f(t0[2] - qx), f(t0[3] - qy)];
      let p3: Point = [f(t1[0] - qx), f(t1[1] - qy)];
      if (vertical) {
        p1 = [p1[1], p1[0]];
        p2 = [p2[1], p2[0]];
        p3 = [p3[1], p3[0]];
      }
      if (neg) {
        if (f(Math.min(p1[0], p2[0], p3[0]) * pp) > 0.5) break;
      } else if (f(Math.max(p1[0], p2[0], p3[0]) * pp) < -0.5) {
        break;
      }
      const code = rootCode(p1[1], p2[1], p3[1]);
      if (code === 0) continue;
      const [r0, r1] = solve(p1, p2, p3).map((r) => f(r * pp)) as [
        number,
        number,
      ];
      if ((code & 1) !== 0) {
        const d = neg ? -sat(f(0.5 - r0)) : sat(f(r0 + 0.5));
        cov = f(cov + sign * d);
        wgt = Math.max(wgt, sat(f(1 - f(Math.abs(r0) * 2))));
      }
      if (code > 1) {
        const d = neg ? sat(f(0.5 - r1)) : -sat(f(r1 + 0.5));
        cov = f(cov + sign * d);
        wgt = Math.max(wgt, sat(f(1 - f(Math.abs(r1) * 2))));
      }
    }
    return [cov, wgt];
  };

  const [xcov, xwgt] = ray(hHeader, false);
  const [ycov, ywgt] = ray(vHeader, true);
  const blended = f(
    Math.abs(f(f(xcov * xwgt) + f(ycov * ywgt))) /
      Math.max(f(xwgt + ywgt), F_1_65536),
  );
  const c = Math.max(blended, Math.min(Math.abs(xcov), Math.abs(ycov)));
  if (evenOdd) {
    const half = f(c * 0.5);
    const fract = f(half - Math.floor(half));
    return { coverage: f(1 - Math.abs(f(1 - f(fract * 2)))), visits };
  }
  return { coverage: sat(c), visits };
}

/** iconRecolor: moves a premultiplied color's hue toward a recolor by its alpha. */
export function recolor(color: Vec4, over: readonly number[]): Vec4 {
  const [r, g, b, a] = color;
  const [or = 0, og = 0, ob = 0, oa = 0] = over.map(f);
  if (!(oa > 0 && a > 0)) return color;
  const mix = (x: number, y: number): number => f(f(x * f(1 - oa)) + f(y * oa));
  return [
    f(mix(f(r / a), f(or / oa)) * a),
    f(mix(f(g / a), f(og / oa)) * a),
    f(mix(f(b / a), f(ob / oa)) * a),
    a,
  ];
}

function stopOffset(low: Vec4, high: Vec4, k: number): number {
  return (k < 4 ? low : high)[k & 3] ?? 0;
}

/** iconGradient: premultiplied, before the op's opacity. */
export function gradient(
  art: ArtTexture,
  texel: number,
  stops: number,
  radial: boolean,
  q: Point,
): Vec4 {
  const g = texel | 0;
  const ends = fetch(art, g);
  const [qx, qy] = [f(q[0]), f(q[1])];
  const dx = f(ends[2] - ends[0]);
  const dy = f(ends[3] - ends[1]);
  const rx = f(qx - ends[0]);
  const ry = f(qy - ends[1]);
  let t: number;
  if (radial) {
    const length = (x: number, y: number): number =>
      f(Math.sqrt(f(f(x * x) + f(y * y))));
    t = f(length(rx, ry) / Math.max(length(dx, dy), F_1E_6));
  } else {
    t = f(
      f(f(rx * dx) + f(ry * dy)) /
        Math.max(f(f(dx * dx) + f(dy * dy)), F_1E_12),
    );
  }
  t = clamp(t, 0, 1);
  const low = fetch(art, (g + 1) | 0);
  const high = fetch(art, (g + 2) | 0);
  let color = fetch(art, (g + 3) | 0);
  if (t > stopOffset(low, high, 0)) {
    if (t >= stopOffset(low, high, stops - 1)) {
      color = fetch(art, (g + 2 + stops) | 0);
    } else {
      for (let k = 0; k < stops - 1; k++) {
        const a = stopOffset(low, high, k);
        const b = stopOffset(low, high, k + 1);
        if (t <= b) {
          const w = sat(f(f(t - a) / Math.max(f(b - a), F_1E_6)));
          const c0 = fetch(art, (g + 3 + k) | 0);
          const c1 = fetch(art, (g + 4 + k) | 0);
          color = [0, 1, 2, 3].map((j) =>
            f(f((c0[j] ?? 0) * f(1 - w)) + f((c1[j] ?? 0) * w)),
          ) as Vec4;
          break;
        }
      }
    }
  }
  const [r, gg, b, a] = color;
  return [f(r * a), f(gg * a), f(b * a), a];
}

/**
 * iconShade: the icon's premultiplied color at one pixel, and the curve
 * visits it took (both rays of every op whose bbox the pixel is near).
 */
export function shade(input: ShadeInput): {
  color: [number, number, number, number];
  visits: number;
} {
  const { art } = input;
  const [u, v] = [f(input.uv[0]), f(input.uv[1])];
  const dx: Point = [f(input.dx[0]), f(input.dx[1])];
  const dy: Point = [f(input.dy[0]), f(input.dy[1])];
  const primary = input.primary ?? [0, 0, 0, 0];
  const secondary = input.secondary ?? [0, 0, 0, 0];
  const opacity = f(input.opacity ?? 1);
  const ex = f(Math.abs(dx[0]) + Math.abs(dy[0]));
  const ey = f(Math.abs(dx[1]) + Math.abs(dy[1]));
  const record = fetch(art, toInt(f(f(input.frameTexel) + 0.5)));
  const count = clamp(toInt(f(record[0] + 0.5)), 0, 64);
  const ops = toInt(f(record[1] + 0.5));
  let color: Vec4 = [0, 0, 0, 0];
  let visits = 0;
  for (let k = 0; k < count; k++) {
    const o = (ops + 4 * k) | 0;
    const box = fetch(art, o);
    if (
      u < f(box[0] - ex) ||
      v < f(box[1] - ey) ||
      u > f(box[2] + ex) ||
      v > f(box[3] + ey)
    )
      continue;
    const m = fetch(art, (o + 1) | 0);
    const place = fetch(art, (o + 2) | 0);
    const paint = fetch(art, (o + 3) | 0);
    const q: Point = [
      f(f(f(m[0] * u) + f(m[1] * v)) + place[0]),
      f(f(f(m[2] * u) + f(m[3] * v)) + place[1]),
    ];
    const qdx = [
      f(f(m[0] * dx[0]) + f(m[1] * dx[1])),
      f(f(m[2] * dx[0]) + f(m[3] * dx[1])),
    ];
    const qdy = [
      f(f(m[0] * dy[0]) + f(m[1] * dy[1])),
      f(f(m[2] * dy[0]) + f(m[3] * dy[1])),
    ];
    const perPixel: Point = [
      f(1 / Math.max(f(Math.abs(qdx[0] ?? 0) + Math.abs(qdy[0] ?? 0)), F_1E_6)),
      f(1 / Math.max(f(Math.abs(qdx[1] ?? 0) + Math.abs(qdy[1] ?? 0)), F_1E_6)),
    ];
    const style = toInt(f(place[3] + 0.5));
    const covered = coverage(
      art,
      toInt(f(place[2] + 0.5)),
      q,
      perPixel,
      ((style >> 2) & 1) === 1,
    );
    visits += covered.visits;
    if (covered.coverage <= 0) continue;
    const kind = (style >> 3) & 3;
    const slot = style & 3;
    let c: Vec4;
    if (kind === 0) {
      c = paint;
      if (slot === 1) c = recolor(c, primary);
      if (slot === 2) c = recolor(c, secondary);
    } else {
      const stops = clamp(toInt(f(paint[1] + 0.5)), 2, 8);
      const g = gradient(art, toInt(f(paint[0] + 0.5)), stops, kind === 2, q);
      c = g.map((x) => f(x * paint[2])) as Vec4;
    }
    const cov = covered.coverage;
    c = c.map((x) => f(x * cov)) as Vec4;
    const keep = f(1 - c[3]);
    color = color.map((x, j) => f((c[j] ?? 0) + f(x * keep))) as Vec4;
  }
  return { color: color.map((x) => f(x * opacity)) as Vec4, visits };
}
