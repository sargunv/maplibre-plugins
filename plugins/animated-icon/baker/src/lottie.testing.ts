// Builders for the small Lottie documents the baker's tests evaluate.

import type { Layer, Lottie, MaskItem, ShapeItem } from "./scene.ts";

/** A static property. */
export const k = (value: unknown): { a: 0; k: unknown } => ({ a: 0, k: value });

/** Linear keyframes `[t, value]...`. */
export function keys(...frames: [number, number | number[]][]): {
  a: 1;
  k: unknown[];
} {
  return {
    a: 1,
    k: frames.map(([t, s], i) => ({
      t,
      s: typeof s === "number" ? [s] : s,
      ...(i < frames.length - 1
        ? { o: { x: [0], y: [0] }, i: { x: [1], y: [1] } }
        : {}),
    })),
  };
}

export function el(
  x: number,
  y: number,
  size = 10,
  extra: object = {},
): ShapeItem {
  return { ty: "el", p: k([x, y]), s: k([size, size]), ...extra } as ShapeItem;
}

export function rc(
  x: number,
  y: number,
  w: number,
  h: number,
  extra: object = {},
): ShapeItem {
  return {
    ty: "rc",
    p: k([x, y]),
    s: k([w, h]),
    r: k(0),
    ...extra,
  } as ShapeItem;
}

/** A path item through `points` (straight segments). */
export function sh(points: [number, number][], closed = true): ShapeItem {
  const zero = points.map(() => [0, 0]);
  return {
    ty: "sh",
    ks: k({ c: closed, v: points, i: zero, o: zero }),
  } as ShapeItem;
}

export function fl(
  r: number,
  g: number,
  b: number,
  extra: object = {},
): ShapeItem {
  return {
    ty: "fl",
    c: k([r, g, b, 1]),
    o: k(100),
    r: 1,
    ...extra,
  } as ShapeItem;
}

export function st(width: number, extra: object = {}): ShapeItem {
  return {
    ty: "st",
    c: k([0, 0, 0, 1]),
    o: k(100),
    w: k(width),
    lc: 1,
    lj: 1,
    ml: 4,
    ...extra,
  } as ShapeItem;
}

export function tr(extra: object = {}): ShapeItem {
  return { ty: "tr", ...extra } as ShapeItem;
}

export function gr(items: ShapeItem[], transform: object = {}): ShapeItem {
  return { ty: "gr", it: [...items, tr(transform)] } as ShapeItem;
}

export function layer(shapes: ShapeItem[], extra: Partial<Layer> = {}): Layer {
  return { ty: 4, ip: 0, op: 60, ks: {}, shapes, ...extra };
}

export function mask(
  mode: string,
  points: [number, number][],
  extra: Partial<MaskItem> = {},
): MaskItem {
  const zero = points.map(() => [0, 0]);
  return {
    mode,
    pt: k({ c: true, v: points, i: zero, o: zero }),
    o: k(100),
    x: k(0),
    ...extra,
  };
}

export function comp(layers: Layer[], extra: Partial<Lottie> = {}): Lottie {
  return { w: 64, h: 64, fr: 60, ip: 0, op: 60, layers, ...extra };
}

/** The square from (x0, y0) to (x1, y1), as path points. */
export function square(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): [number, number][] {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}
