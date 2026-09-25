import { describe, expect, it } from "vite-plus/test";

import { comp, el, gr, k, layer, sh, st } from "./lottie.testing.ts";
import type { Point } from "./pack.ts";
import { evaluateFrame } from "./scene.ts";
import type { BezierPath } from "./shapes.ts";
import { apply } from "./transform.ts";
import { trimRange, trimShapes } from "./trim.ts";

/** A straight path through `points`. */
function line(points: Point[], closed = false): BezierPath {
  return { closed, v: points, i: points, o: points };
}

const SQUARE = line(
  [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100],
  ],
  true,
);

/** Points rounded to 0.01, which lottie-web's float32 lengths keep. */
function near(points: readonly Point[]): Point[] {
  return points.map(([x, y]) => [
    Math.round(x * 100) / 100 + 0,
    Math.round(y * 100) / 100 + 0,
  ]);
}

function trim(
  shapes: BezierPath[][],
  start: number,
  end: number,
  offset = 0,
  mode = 1,
): BezierPath[][] {
  return trimShapes(shapes, { start, end, offset, mode });
}

describe("trimRange", () => {
  it("normalises start, end and offset as lottie-web does", () => {
    const range = (start: number, end: number, offset: number): Point =>
      near([trimRange({ start, end, offset, mode: 1 })])[0] as Point;
    expect(range(10, 60, 0)).toEqual([0.1, 0.6]);
    // Offsets wrap to one turn and move both ends.
    expect(range(10, 60, 450)).toEqual([0.35, 0.85]);
    expect(range(10, 60, -90)).toEqual([0.85, 1.35]);
    // Reversed ends swap; out-of-range ends clamp before the offset.
    expect(range(60, 10, 0)).toEqual([0.1, 0.6]);
    expect(range(-20, 120, 0)).toEqual([0, 1]);
    // 1e-4 rounding.
    expect(
      trimRange({ start: 12.345678, end: 50, offset: 0, mode: 1 })[0],
    ).toBeCloseTo(0.1235, 12);
  });
});

describe("trimShapes", () => {
  it("leaves the full range untouched and removes an empty one", () => {
    expect(trim([[SQUARE]], 0, 100)).toEqual([[SQUARE]]);
    expect(trim([[SQUARE]], 40, 40)).toEqual([[]]);
  });

  it("cuts a range out of a closed path along its length", () => {
    // 400 long: 10%..60% runs from (40, 0) round to (100, 100) and on to
    // (60, 100)... (0..100 is the top edge, 100..200 the right one).
    const [[part]] = trim([[SQUARE]], 10, 60) as [[BezierPath]];
    expect(part.closed).toBe(false);
    expect(near(part.v)).toEqual([
      [40, 0],
      [100, 0],
      [100, 100],
      [60, 100],
    ]);
  });

  it("wraps a closed path through its start as one path", () => {
    // 80%..110%: up the left edge from (0, 80), through the start at
    // (0, 0), along the top to (40, 0).
    const [[part, ...rest]] = trim([[SQUARE]], 70, 100, 36) as [
      [BezierPath, ...BezierPath[]],
    ];
    expect(rest).toEqual([]);
    expect(part.closed).toBe(false);
    // lottie-web repeats the start vertex where the two spans meet.
    expect(near(part.v)).toEqual([
      [0, 80],
      [0, 0],
      [0, 0],
      [40, 0],
    ]);
  });

  it("opens a closed path at the offset for the full range", () => {
    const [[part]] = trim([[SQUARE]], 0, 100, 90) as [[BezierPath]];
    expect(part.closed).toBe(false);
    // A quarter turn: the path runs from (100, 0) all the way round.
    expect(near([part.v[0] as Point, part.v.at(-1) as Point])).toEqual([
      [100, 0],
      [100, 0],
    ]);
  });

  it("trims open paths without wrapping", () => {
    const open = line([
      [0, 0],
      [100, 0],
    ]);
    const [[part]] = trim([[open]], 25, 50) as [[BezierPath]];
    expect(near(part.v)).toEqual([
      [25, 0],
      [50, 0],
    ]);
    // Past the end of an open path the range continues from its start,
    // as a separate path.
    const [paths] = trim([[open]], 70, 100, 72) as [BezierPath[]];
    expect(paths.map((p) => near(p.v))).toEqual([
      [
        [90, 0],
        [100, 0],
      ],
      [
        [0, 0],
        [20, 0],
      ],
    ]);
  });

  it("trims each shape alone in mode 1 and all as one path in mode 2", () => {
    const a = line([
      [0, 0],
      [100, 0],
    ]);
    const b = line([
      [0, 10],
      [300, 10],
    ]);
    const simultaneous = trim([[a], [b]], 0, 50, 0, 1);
    expect(near(simultaneous.map((s) => s[0]?.v.at(-1) as Point))).toEqual([
      [50, 0],
      [150, 10],
    ]);
    // Individually: 50% of 400 is all of `a` and 100 of `b`, in order.
    const individual = trim([[a], [b]], 0, 50, 0, 2);
    expect(individual[0]?.[0]?.v).toEqual(a.v);
    expect(near(individual[1]?.[0]?.v ?? [])).toEqual([
      [0, 10],
      [100, 10],
    ]);
    // A later range misses `a` entirely.
    expect(trim([[a], [b]], 50, 100, 0, 2)[0]).toEqual([]);
  });

  it("measures curves on lottie-web's polyline", () => {
    // A quarter circle of radius 100 (~157.08 long): its middle sits at
    // 45 degrees.
    const c = 0.5519 * 100;
    const arc: BezierPath = {
      closed: false,
      v: [
        [100, 0],
        [0, 100],
      ],
      o: [
        [100, c],
        [0, 100],
      ],
      i: [
        [100, 0],
        [c, 100],
      ],
    };
    const [[part]] = trim([[arc]], 0, 50) as [[BezierPath]];
    const end = part.v.at(-1) as Point;
    expect(Math.hypot(end[0], end[1])).toBeCloseTo(100, 0);
    expect(end[0]).toBeCloseTo(end[1], 0);
  });
});

describe("trim in the scene", () => {
  const trimItem = (s: number, e: number, o = 0, m = 1) => ({
    ty: "tm",
    s: k(s),
    e: k(e),
    o: k(o),
    m,
  });

  it("trims every path before it, including nested groups, before the style", () => {
    const [draw] = evaluateFrame(
      comp([
        layer([
          gr([
            sh(
              [
                [0, 0],
                [40, 0],
              ],
              false,
            ),
          ]),
          sh(
            [
              [0, 10],
              [40, 10],
            ],
            false,
          ),
          trimItem(0, 50) as never,
          st(2),
        ]),
      ]),
      0,
    );
    expect(draw?.paths.map((p) => p.v.at(-1))).toEqual([
      [20, 10],
      [20, 0],
    ]);
  });

  it("trims in each shape's own space and draws the result through the group", () => {
    // Small coordinates in a group scaled 20x trim exactly as large ones:
    // lottie-web measures before the transform.
    const small = evaluateFrame(
      comp([
        layer([
          gr([el(2, 2, 2), trimItem(0, 20) as never, st(0.1)], {
            s: k([2000, 2000]),
          }),
        ]),
      ]),
      0,
    );
    const large = evaluateFrame(
      comp([layer([gr([el(40, 40, 40), trimItem(0, 20) as never, st(2)])])]),
      0,
    );
    const at = (draws: typeof small): Point[] =>
      (draws[0]?.paths[0]?.v ?? []).map((p) =>
        apply(draws[0]?.matrix ?? [1, 0, 0, 1, 0, 0], p),
      );
    const a = at(small);
    const b = at(large);
    expect(a.length).toBe(b.length);
    a.forEach((p, i) => {
      expect(p[0]).toBeCloseTo((b[i] as Point)[0], 1);
      expect(p[1]).toBeCloseTo((b[i] as Point)[1], 1);
    });
  });

  it("is dropped when the entry ignores it", () => {
    const [draw] = evaluateFrame(
      comp([layer([el(0, 0), trimItem(0, 10) as never, st(2)])]),
      0,
      { ignore: new Set(["trim"]) },
    );
    expect(draw?.paths[0]?.closed).toBe(true);
  });
});
