import { describe, expect, it } from "vite-plus/test";

import type { Contour, Point } from "./pack.ts";
import {
  arc,
  circle,
  conicToQuads,
  ContourBuilder,
  cubicAt,
  cubicToQuads,
  distanceToQuad,
  quadAt,
  refitContour,
} from "./quadratic.ts";

type Cubic = [Point, Point, Point, Point];

/** A seeded generator, so failures reproduce. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Dense two-way distance between a curve and a chain of quadratics. */
function chainDistance(
  f: (t: number) => Point,
  start: Point,
  quads: [Point, Point][],
): number {
  const pieces: [Point, Point, Point][] = [];
  let from = start;
  for (const [ctrl, end] of quads) {
    pieces.push([from, ctrl, end]);
    from = end;
  }
  let worst = 0;
  for (let i = 0; i <= 400; i++) {
    const p = f(i / 400);
    worst = Math.max(
      worst,
      Math.min(...pieces.map((q) => distanceToQuad(p, q))),
    );
  }
  const n = 4000;
  const curve = Array.from({ length: n + 1 }, (_, j) => f(j / n));
  for (const q of pieces) {
    for (let i = 0; i <= 50; i++) {
      const p = quadAt(q, i / 50);
      const d = (t: number): number => {
        const c = f(t);
        return Math.hypot(p[0] - c[0], p[1] - c[1]);
      };
      let bestJ = 0;
      curve.forEach((c, j) => {
        const best = curve[bestJ] ?? c;
        if (
          Math.hypot(p[0] - c[0], p[1] - c[1]) <
          Math.hypot(p[0] - best[0], p[1] - best[1])
        ) {
          bestJ = j;
        }
      });
      // Ternary search between the neighbouring samples.
      let lo = Math.max(0, bestJ - 1) / n;
      let hi = Math.min(n, bestJ + 1) / n;
      for (let k = 0; k < 60; k++) {
        const a = lo + (hi - lo) / 3;
        const b = hi - (hi - lo) / 3;
        if (d(a) < d(b)) hi = b;
        else lo = a;
      }
      worst = Math.max(worst, d((lo + hi) / 2));
    }
  }
  return worst;
}

describe("arc", () => {
  it("puts control points where the end tangents meet", () => {
    const curves = arc(0, 0, 10, 10, 0, Math.PI / 2);
    expect(curves).toHaveLength(2);
    for (const { on, ctrl } of curves) {
      expect(Math.hypot(on[0], on[1])).toBeCloseTo(10, 9);
      expect(Math.hypot(ctrl[0], ctrl[1])).toBeCloseTo(
        10 / Math.cos(Math.PI / 8),
        9,
      );
    }
  });

  it("draws a circle as 8 quadratics", () => {
    expect(circle(0, 0, 1)).toHaveLength(8);
  });
});

describe("distanceToQuad", () => {
  it("is exact for points around a parabola", () => {
    // y = x^2 / 20 for x in -10..10, apex at the origin.
    const quad: [Point, Point, Point] = [
      [-10, 5],
      [0, -5],
      [10, 5],
    ];
    expect(distanceToQuad([0, -3], quad)).toBeCloseTo(3, 12);
    expect(distanceToQuad([13, 9], quad)).toBeCloseTo(5, 12);
  });
});

describe("cubicToQuads", () => {
  it("stays within the tolerance of random cubics", () => {
    const next = random(7);
    for (let n = 0; n < 40; n++) {
      const cubic: Cubic = [
        [next() * 100, next() * 100],
        [next() * 100, next() * 100],
        [next() * 100, next() * 100],
        [next() * 100, next() * 100],
      ];
      for (const tolerance of [0.5, 0.05]) {
        const quads = cubicToQuads(cubic, tolerance);
        expect(quads.at(-1)?.[1]).toEqual(cubic[3]);
        // The measurement samples, so allow it a hair of slack.
        expect(
          chainDistance((t) => cubicAt(cubic, t), cubic[0], quads),
        ).toBeLessThanOrEqual(tolerance * 1.01);
      }
    }
  });

  it("uses fewer quadratics at looser tolerances", () => {
    const quarter: Cubic = [
      [100, 0],
      [100, 55.19],
      [55.19, 100],
      [0, 100],
    ];
    const coarse = cubicToQuads(quarter, 1).length;
    const fine = cubicToQuads(quarter, 0.01).length;
    expect(coarse).toBeLessThan(fine);
    // A quarter circle of radius 100 needs two quadratics at 1 unit: a
    // single quadratic strays more than 2 from it, two 45-degree ones 0.3.
    expect(coarse).toBe(2);
  });

  it("turns straight cubics into one segment with its control at the midpoint", () => {
    expect(
      cubicToQuads(
        [
          [0, 0],
          [0, 0],
          [10, 10],
          [10, 10],
        ],
        0.1,
      ),
    ).toEqual([
      [
        [5, 5],
        [10, 10],
      ],
    ]);
  });
});

describe("conicToQuads", () => {
  it("approximates circular arcs within the tolerance", () => {
    // A quarter circle as a conic of weight cos(45 degrees).
    const [p0, p1, p2]: [Point, Point, Point] = [
      [50, 0],
      [50, 50],
      [0, 50],
    ];
    const w = Math.SQRT1_2;
    const conic = (t: number): Point => {
      const u = 1 - t;
      const d = u * u + 2 * w * u * t + t * t;
      return [
        (u * u * p0[0] + 2 * w * u * t * p1[0] + t * t * p2[0]) / d,
        (u * u * p0[1] + 2 * w * u * t * p1[1] + t * t * p2[1]) / d,
      ];
    };
    for (const tolerance of [0.5, 0.02]) {
      const quads = conicToQuads(p0, p1, p2, w, tolerance);
      expect(chainDistance(conic, p0, quads)).toBeLessThanOrEqual(tolerance);
    }
  });
});

describe("ContourBuilder", () => {
  it("closes open paths with a straight segment and drops degenerate ones", () => {
    const builder = new ContourBuilder(0.1);
    builder.moveTo([0, 0]);
    builder.lineTo([10, 0]);
    builder.lineTo([10, 10]);
    builder.moveTo([50, 50]);
    builder.lineTo([60, 50]);
    builder.close();
    const [triangle, ...rest] = builder.done();
    expect(rest).toEqual([]);
    expect(triangle).toEqual([
      { on: [0, 0], ctrl: [5, 0] },
      { on: [10, 0], ctrl: [10, 5] },
      { on: [10, 10], ctrl: [5, 5] },
    ]);
  });
});

describe("refitContour", () => {
  /** A circle of radius r as n equal quadratics. */
  function fineCircle(r: number, n: number): Contour {
    return Array.from({ length: n }, (_, k) => {
      const a = (2 * Math.PI * k) / n;
      const mid = a + Math.PI / n;
      const reach = r / Math.cos(Math.PI / n);
      return {
        on: [r * Math.cos(a), r * Math.sin(a)] as Point,
        ctrl: [reach * Math.cos(mid), reach * Math.sin(mid)] as Point,
      };
    });
  }

  it("takes a finely split circle down to what the tolerance needs", () => {
    const refit = refitContour(fineCircle(90, 64), 0.15);
    // A 30-degree quadratic strays 0.0006 r = 0.05 from a circle of radius
    // 90 and a 45-degree one 0.28, so about 12 are needed.
    expect(refit.length).toBeLessThanOrEqual(14);
    expect(refit.length).toBeGreaterThanOrEqual(10);
    for (let k = 0; k < refit.length; k++) {
      const q: [Point, Point, Point] = [
        refit[k]?.on ?? [0, 0],
        refit[k]?.ctrl ?? [0, 0],
        refit[(k + 1) % refit.length]?.on ?? [0, 0],
      ];
      for (let i = 0; i <= 32; i++) {
        const [x, y] = quadAt(q, i / 32);
        expect(Math.abs(Math.hypot(x, y) - 90)).toBeLessThan(0.15 + 0.01);
      }
    }
  });

  it("keeps corners", () => {
    const square: Contour = [
      { on: [0, 0], ctrl: [5, 0] },
      { on: [10, 0], ctrl: [10, 5] },
      { on: [10, 10], ctrl: [5, 10] },
      { on: [0, 10], ctrl: [0, 5] },
    ];
    const refit = refitContour(square, 0.1);
    expect(refit.map((c) => c.on)).toEqual(square.map((c) => c.on));
  });
});
