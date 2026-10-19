// Unit tests of the footprint helpers and the triangulator, the twin of
// ../../native/src/footprint_test.zig. Both twins are also covered through
// the shared layout fixtures; these pin the pieces' own contracts.

import { describe, expect, it } from "vite-plus/test";

import {
  classifyRings,
  hasCollapsedCut,
  isClipEdge,
  minimumAreaRectangle,
  NO_CUTS,
  type Point,
  signedArea2,
  simplifyRing,
  tileBounds,
} from "./footprint.ts";
import { triangulate } from "./triangulate.ts";

const ring = (points: [number, number][]): Point[] =>
  points.map(([x, y]) => ({ x, y }));

const square = ring([
  [0, 0],
  [100, 0],
  [100, 100],
  [0, 100],
]);

function triangleArea2(
  points: readonly Point[],
  t: number[],
  i: number,
): number {
  const a = points[t[i]!]!;
  const b = points[t[i + 1]!]!;
  const c = points[t[i + 2]!]!;
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

describe("simplifyRing", () => {
  it("drops repeated, closing, collinear and spike points", () => {
    const simplified = simplifyRing(
      ring([
        [0, 0],
        [0, 0],
        [50, 0],
        [100, 0],
        [100, 50],
        [180, 50],
        [100, 50],
        [100, 100],
        [50, 100],
        [0, 100],
        [0, 0],
      ]),
      8192,
    );
    expect(simplified).toEqual(square);
  });

  it("drops jitter within half a unit and keeps larger kinks", () => {
    expect(
      simplifyRing(
        ring([
          [0, 0],
          [1000, 0],
          [2000, 1],
          [2000, 1000],
        ]),
        8192,
      ),
    ).toHaveLength(3);
    expect(
      simplifyRing(
        ring([
          [0, 0],
          [1000, 1],
          [2000, 0],
          [2000, 1000],
        ]),
        8192,
      ),
    ).toHaveLength(4);
  });

  it("never merges a tile cut into a real wall", () => {
    // (-128, 500) is nearly collinear with its neighbors but ends a cut.
    const input = ring([
      [-128, 100],
      [100, 100],
      [100, 2000],
      [-127, 2000],
      [-128, 500],
    ]);
    const simplified = simplifyRing(input, 8192, tileBounds([[input]]));
    expect(simplified).toContainEqual({ x: -128, y: 500 });
    // Without a cut line there, it is jitter on a wall.
    expect(simplifyRing(input, 8192)).not.toContainEqual({ x: -128, y: 500 });
  });

  it("returns nothing for rings that collapse", () => {
    expect(
      simplifyRing(
        ring([
          [0, 0],
          [10, 0],
          [20, 0],
        ]),
        8192,
      ),
    ).toEqual([]);
  });
});

describe("isClipEdge", () => {
  // A tile whose features reach x = -128 and y = 8320.
  const bounds = { minX: -128, minY: 100, maxX: 8000, maxY: 8320 };

  it("accepts axis-aligned edges on the tile's bounds outside the tile", () => {
    const edge = (ax: number, ay: number, bx: number, by: number): boolean =>
      isClipEdge({ x: ax, y: ay }, { x: bx, y: by }, 8192, bounds);
    expect(edge(-128, 200, -128, 300)).toBe(true);
    expect(edge(0, 8320, 50, 8320)).toBe(true);
    // Inside the tile, on its border, or slanted: never a cut.
    expect(edge(0, 200, 0, 300)).toBe(false);
    expect(edge(-128, 200, -127, 300)).toBe(false);
    // Outside the tile but not on its bounds: a real wall in the buffer.
    expect(edge(-100, 200, -100, 300)).toBe(false);
    expect(edge(0, 8300, 50, 8300)).toBe(false);
    // On the bounds but inside the tile: the clip line is beyond it.
    expect(edge(8000, 200, 8000, 300)).toBe(false);
    expect(edge(0, 100, 50, 100)).toBe(false);
    expect(isClipEdge({ x: -1, y: 0 }, { x: -1, y: 50 }, 8192, NO_CUTS)).toBe(
      false,
    );
  });

  it("finds cuts that collapsed to a repeated point", () => {
    const bounds = { minX: -128, minY: 100, maxX: 8000, maxY: 8320 };
    const tip = ring([
      [-128, 500],
      [-128, 500],
      [0, 400],
      [100, 600],
    ]);
    expect(hasCollapsedCut(tip, 8192, bounds)).toBe(true);
    // Closed, and repeated at the wrap.
    expect(
      hasCollapsedCut([...tip.slice(1), tip[0]!, tip[0]!], 8192, bounds),
    ).toBe(true);
    // A closing point, or a repeat off the cut lines, is not a cut.
    expect(hasCollapsedCut([...tip.slice(1), tip[0]!], 8192, bounds)).toBe(
      false,
    );
    const inside = ring([
      [10, 500],
      [10, 500],
      [0, 400],
      [100, 600],
    ]);
    expect(hasCollapsedCut(inside, 8192, bounds)).toBe(false);
    expect(classifyRings([tip], 8192, bounds)[0]!.cut).toBe(true);
  });

  it("finds the bounds of every ring of every feature", () => {
    expect(
      tileBounds([[ring([[5, 6]]), ring([[-3, 9]])], [ring([[2, -4]])]]),
    ).toEqual({ minX: -3, minY: -4, maxX: 5, maxY: 9 });
  });
});

describe("classifyRings", () => {
  it("groups holes under the exterior before them and normalizes winding", () => {
    const hole = ring([
      [20, 20],
      [20, 80],
      [80, 80],
      [80, 20],
    ]);
    const other = ring([
      [200, 0],
      [300, 0],
      [300, 100],
      [200, 100],
    ]);
    const polygons = classifyRings([square, hole, other], 8192);
    expect(polygons).toHaveLength(2);
    expect(polygons[0]!.holes).toHaveLength(1);
    expect(signedArea2(polygons[0]!.outer)).toBeGreaterThan(0);
    expect(signedArea2(polygons[0]!.holes[0]!)).toBeLessThan(0);

    // The same feature in reversed winding classifies the same way.
    const reversed = classifyRings(
      [square, hole, other].map((r) => [...r].reverse()),
      8192,
    );
    expect(reversed).toHaveLength(2);
    expect(reversed[0]!.holes).toHaveLength(1);
    expect(signedArea2(reversed[0]!.outer)).toBeGreaterThan(0);
    expect(signedArea2(reversed[0]!.holes[0]!)).toBeLessThan(0);
  });

  it("marks polygons the source cut", () => {
    // The tile's features reach x = -128 and x = 8320.
    const bounds = { minX: -128, minY: -128, maxX: 8320, maxY: 8320 };
    const cut = (x0: number, y0: number, x1: number, y1: number): boolean =>
      classifyRings(
        [
          ring([
            [x0, y0],
            [x1, y0],
            [x1, y1],
            [x0, y1],
          ]),
        ],
        8192,
        bounds,
      )[0]!.cut;
    expect(cut(-128, 0, 100, 100)).toBe(true);
    expect(cut(8000, 8000, 8320, 8320)).toBe(true);
    expect(cut(-128, -128, 8320, 8320)).toBe(true);
    // Crossing the tile's edge or only in its buffer, but whole.
    expect(cut(-64, 0, 100, 100)).toBe(false);
    expect(cut(-100, -100, -1, -1)).toBe(false);
    expect(cut(8192, 0, 8300, 100)).toBe(false);
    expect(cut(0, 0, 100, 100)).toBe(false);
    // A courtyard cannot be cut alone, but a cut exterior marks the polygon.
    const polygon = classifyRings(
      [
        ring([
          [-128, 0],
          [300, 0],
          [300, 300],
          [-128, 300],
        ]),
        ring([
          [100, 100],
          [100, 200],
          [200, 200],
          [200, 100],
        ]),
      ],
      8192,
      bounds,
    )[0]!;
    expect(polygon.holes).toHaveLength(1);
    expect(polygon.cut).toBe(true);
  });
});

describe("minimumAreaRectangle", () => {
  it("finds the sides of a rotated rectangle", () => {
    const c = Math.cos(Math.PI / 6);
    const s = Math.sin(Math.PI / 6);
    const corners = [
      [-150, -80],
      [150, -80],
      [150, 80],
      [-150, 80],
    ].map(([x, y]) => ({
      x: 1000 + x! * c - y! * s,
      y: 1000 + x! * s + y! * c,
    }));
    const rect = minimumAreaRectangle(corners)!;
    expect(rect.halfLong).toBeCloseTo(150, 6);
    expect(rect.halfShort).toBeCloseTo(80, 6);
    expect(rect.center.x).toBeCloseTo(1000, 6);
    expect(rect.center.y).toBeCloseTo(1000, 6);
    expect(Math.abs(rect.long.x * c + rect.long.y * s)).toBeCloseTo(1, 9);
    expect(rect.long.x * rect.short.x + rect.long.y * rect.short.y).toBeCloseTo(
      0,
      12,
    );
  });

  it("returns null for collinear points", () => {
    expect(
      minimumAreaRectangle(
        ring([
          [0, 0],
          [10, 10],
          [20, 20],
        ]),
      ),
    ).toBeNull();
  });
});

describe("triangulate", () => {
  const sumArea2 = (points: Point[], triangles: number[]): number => {
    let sum = 0;
    for (let t = 0; t < triangles.length; t += 3)
      sum += triangleArea2(points, triangles, t);
    return sum;
  };

  it("covers a concave polygon with positive triangles", () => {
    const u = ring([
      [0, 0],
      [100, 0],
      [100, 200],
      [300, 200],
      [300, 0],
      [400, 0],
      [400, 300],
      [0, 300],
    ]);
    const { points, triangles } = triangulate(u);
    expect(triangles).toHaveLength(3 * (u.length - 2));
    for (let t = 0; t < triangles.length; t += 3)
      expect(triangleArea2(points, triangles, t)).toBeGreaterThan(0);
    expect(sumArea2(points, triangles)).toBe(signedArea2(u));
  });

  it("bridges holes", () => {
    const outer = ring([
      [0, 0],
      [400, 0],
      [400, 300],
      [0, 300],
    ]);
    const holes = [
      ring([
        [50, 50],
        [50, 100],
        [150, 100],
        [150, 50],
      ]),
      ring([
        [250, 150],
        [250, 250],
        [350, 250],
        [350, 150],
      ]),
    ];
    const { points, triangles } = triangulate(outer, holes);
    for (let t = 0; t < triangles.length; t += 3)
      expect(triangleArea2(points, triangles, t)).toBeGreaterThan(0);
    const expected =
      signedArea2(outer) + signedArea2(holes[0]!) + signedArea2(holes[1]!);
    expect(sumArea2(points, triangles)).toBe(expected);
  });

  it("keeps holes open where rings touch at a point", () => {
    const outer = ring([
      [0, 0],
      [400, 0],
      [400, 300],
      [0, 300],
    ]);
    const cases = [
      // A hole touching the exterior at a corner.
      [
        ring([
          [0, 0],
          [50, 100],
          [100, 50],
        ]),
      ],
      // Two holes touching at a corner.
      [
        ring([
          [50, 50],
          [50, 150],
          [150, 150],
          [150, 50],
        ]),
        ring([
          [150, 150],
          [150, 250],
          [250, 250],
          [250, 150],
        ]),
      ],
    ];
    for (const holes of cases) {
      const { points, triangles } = triangulate(outer, holes);
      for (let t = 0; t < triangles.length; t += 3)
        expect(triangleArea2(points, triangles, t)).toBeGreaterThan(0);
      let expected = signedArea2(outer);
      for (const hole of holes) expected += signedArea2(hole);
      expect(sumArea2(points, triangles)).toBe(expected);
    }
  });

  it("does not span a ring that touches itself", () => {
    // Two squares meeting at (100, 100), as one ring.
    const pinched = ring([
      [0, 0],
      [100, 0],
      [100, 100],
      [200, 100],
      [200, 200],
      [100, 200],
      [100, 100],
      [0, 100],
    ]);
    const { points, triangles } = triangulate(pinched);
    expect(sumArea2(points, triangles)).toBe(signedArea2(pinched));
  });

  it("terminates on a self-intersecting ring", () => {
    const bowtie = ring([
      [0, 0],
      [100, 100],
      [100, 0],
      [0, 100],
    ]);
    const { triangles } = triangulate(bowtie);
    expect(triangles.length).toBeLessThanOrEqual(6);
  });
});
