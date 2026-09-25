import { describe, expect, it } from "vite-plus/test";

import type { Contour, Point } from "./pack.ts";
import { distanceToQuad, quadAt, refitContour } from "./quadratic.ts";
import { ellipsePath } from "./shapes.ts";
import {
  canvasKit,
  contoursFromCommands,
  STROKE_PRECISION,
  type StrokeStyle,
  strokeOutline,
} from "./skia.ts";
import { IDENTITY, scaling } from "./transform.ts";

const ck = await canvasKit();
const round: StrokeStyle = {
  width: 4,
  cap: "round",
  join: "round",
  miterLimit: 4,
};

/** Every point of every contour, densely sampled. */
function points(contours: readonly Contour[]): Point[] {
  const out: Point[] = [];
  for (const contour of contours) {
    contour.forEach(({ on, ctrl }, k) => {
      const end = contour[(k + 1) % contour.length]?.on ?? on;
      for (let i = 0; i < 16; i++) out.push(quadAt([on, ctrl, end], i / 16));
    });
  }
  return out;
}

/** Twice the signed area enclosed, summed over contours. */
function area(contours: readonly Contour[]): number {
  let sum = 0;
  for (const contour of contours) {
    const ps = points([contour]);
    ps.forEach(([x0, y0], i) => {
      const [x1, y1] = ps[(i + 1) % ps.length] ?? [0, 0];
      sum += x0 * y1 - x1 * y0;
    });
  }
  return sum / 2;
}

describe("strokeOutline", () => {
  const ring = ellipsePath({ p: { k: [32, 32] }, s: { k: [40, 40] }, d: 1 }, 0);

  it("outlines a circle as two contours at radius ± half the width", () => {
    // 3 device pixels per canvas pixel; 0.2 device pixels is 1/15 canvas px.
    const contours = strokeOutline(ck, [ring], IDENTITY, round, 3, 0.2);
    expect(contours).toHaveLength(2);
    for (const contour of contours) {
      const radii = points([contour]).map(([x, y]) =>
        Math.hypot(x - 32, y - 32),
      );
      const target = (radii[0] ?? 0) > 20 ? 22 : 18;
      for (const r of radii)
        expect(Math.abs(r - target)).toBeLessThan(0.2 / 3 + 0.02);
    }
    // Nonzero fill of the outline covers the ring's area once.
    expect(Math.abs(area(contours))).toBeCloseTo(
      Math.PI * (22 * 22 - 18 * 18),
      -1,
    );
  });

  it("strokes in the style's space, so a squashed group squashes the stroke", () => {
    const contours = strokeOutline(
      ck,
      [ring],
      [1, 0, 0, 0.5, 0, 16],
      round,
      3,
      0.2,
    );
    const ys = points(contours).map(([, y]) => y);
    const xs = points(contours).map(([x]) => x);
    // Width 4 around radius 20: 22 across, halved vertically.
    expect(Math.max(...xs) - 32).toBeCloseTo(22, 1);
    expect(Math.max(...ys) - 32).toBeCloseTo(11, 1);
  });

  it("caps open paths", () => {
    const line = {
      closed: false,
      v: [
        [0, 0],
        [10, 0],
      ] as Point[],
      i: [
        [0, 0],
        [10, 0],
      ] as Point[],
      o: [
        [0, 0],
        [10, 0],
      ] as Point[],
    };
    const butt = strokeOutline(
      ck,
      [line],
      IDENTITY,
      { ...round, cap: "butt" },
      4,
      0.2,
    );
    expect(Math.abs(area(butt))).toBeCloseTo(40, 3);
    const square = strokeOutline(
      ck,
      [line],
      IDENTITY,
      { ...round, cap: "square" },
      4,
      0.2,
    );
    expect(Math.abs(area(square))).toBeCloseTo(56, 3);
    const rounded = strokeOutline(ck, [line], IDENTITY, round, 4, 0.2);
    expect(Math.abs(area(rounded))).toBeCloseTo(40 + Math.PI * 4, 1);
  });

  it("scales small canvases up before stroking", () => {
    // A 0.4-unit ring drawn at 100 device pixels per unit keeps its shape.
    const tiny = ellipsePath({ p: { k: [0, 0] }, s: { k: [0.4, 0.4] } }, 0);
    const contours = strokeOutline(
      ck,
      [tiny],
      IDENTITY,
      { ...round, width: 0.04 },
      100,
      0.2,
    );
    for (const [x, y] of points(contours)) {
      const r = Math.hypot(x, y);
      expect(Math.min(Math.abs(r - 0.22), Math.abs(r - 0.18))).toBeLessThan(
        0.2 / 100 + 1e-4,
      );
    }
  });

  it("refits wide butt-capped arcs to fewer curves, never more", () => {
    // The refit budget strokeOutline gives a 0.2-pixel tolerance.
    const tolerance = 0.2 - 1 / (4 * STROKE_PRECISION) - 0.01;
    const quads = (contour: Contour) =>
      contour.map(
        ({ on, ctrl }, k) =>
          [on, ctrl, (contour[(k + 1) % contour.length] as Contour[0]).on] as [
            Point,
            Point,
            Point,
          ],
      );
    for (const [radius, sweep, width] of [
      [200, 0.6, 30],
      [400, 1.2, 40],
    ] as const) {
      // An arc of cubics (quarter turns at most), then a straight leg, so
      // the outline has miter corners at the ends of curved runs.
      const builder = new ck.PathBuilder();
      builder.moveTo(300 + radius, 300);
      const n = Math.ceil(sweep / (Math.PI / 2));
      const d = sweep / n;
      const h = (4 / 3) * Math.tan(d / 4) * radius;
      for (let i = 0; i < n; i++) {
        const a = i * d;
        const b = a + d;
        builder.cubicTo(
          300 + radius * Math.cos(a) - h * Math.sin(a),
          300 + radius * Math.sin(a) + h * Math.cos(a),
          300 + radius * Math.cos(b) + h * Math.sin(b),
          300 + radius * Math.sin(b) - h * Math.cos(b),
          300 + radius * Math.cos(b),
          300 + radius * Math.sin(b),
        );
      }
      builder.lineTo(
        300 + radius * Math.cos(sweep) + radius,
        300 + radius * Math.sin(sweep) - radius * 0.3,
      );
      const path = builder.detachAndDelete();
      const stroked = path.makeStroked({
        width,
        cap: ck.StrokeCap.Butt,
        join: ck.StrokeJoin.Miter,
        miter_limit: 4,
        precision: STROKE_PRECISION,
      });
      path.delete();
      if (!stroked) throw new Error("Skia stroked nothing");
      const [outline] = contoursFromCommands(ck, stroked.toCmds(), 0.01);
      stroked.delete();
      if (!outline) throw new Error("the stroke has no outline");
      const refit = refitContour(outline, tolerance);
      expect(refit.length).toBeLessThanOrEqual(outline.length);
      // The long arc needs the tangent the curve arrives with at each
      // corner; with the leaving one it grew by a curve.
      if (radius === 400) expect(refit.length).toBeLessThan(outline.length);
      const source = quads(outline);
      for (const quad of quads(refit)) {
        for (let i = 0; i <= 16; i++) {
          const p = quadAt(quad, i / 16);
          const nearest = Math.min(...source.map((q) => distanceToQuad(p, q)));
          expect(nearest).toBeLessThan(tolerance + 1e-6);
        }
      }
    }
  });

  it("skips zero-width strokes", () => {
    expect(
      strokeOutline(ck, [ring], IDENTITY, { ...round, width: 0 }, 3, 0.2),
    ).toEqual([]);
    expect(strokeOutline(ck, [ring], scaling(0, 0), round, 3, 0.2)).toEqual([]);
  });
});
