import { describe, expect, it } from "vite-plus/test";

import {
  ellipsePath,
  pathFromShape,
  rectPath,
  ROUND_CORNER,
  roundCorners,
  starPath,
  transformPath,
} from "./shapes.ts";
import { scaling } from "./transform.ts";

const k = (value: unknown) => ({ a: 0, k: value });

/** Twice the signed area of a path's vertex polygon; positive is clockwise on screen. */
function turning(v: readonly (readonly [number, number])[]): number {
  let sum = 0;
  v.forEach(([x0, y0], i) => {
    const [x1, y1] = v[(i + 1) % v.length] ?? [0, 0];
    sum += x0 * y1 - x1 * y0;
  });
  return sum;
}

describe("pathFromShape", () => {
  it("makes tangents absolute", () => {
    const path = pathFromShape({
      c: true,
      v: [
        [10, 10],
        [20, 10],
      ],
      i: [
        [-1, 0],
        [0, -2],
      ],
      o: [
        [3, 0],
        [0, 4],
      ],
    });
    expect(path.closed).toBe(true);
    expect(path.i).toEqual([
      [9, 10],
      [20, 8],
    ]);
    expect(path.o).toEqual([
      [13, 10],
      [20, 14],
    ]);
  });
});

describe("rectPath", () => {
  it("starts at the top right and runs clockwise for d 1", () => {
    const path = rectPath({ p: k([0, 0]), s: k([20, 10]), r: k(0), d: 1 }, 0);
    expect(path.v).toEqual([
      [10, -5],
      [10, 5],
      [-10, 5],
      [-10, -5],
    ]);
    expect(turning(path.v)).toBeGreaterThan(0);
  });

  it("runs counterclockwise for d 3 (and, as in lottie-web, when d is missing)", () => {
    const reversed = rectPath(
      { p: k([0, 0]), s: k([20, 10]), r: k(0), d: 3 },
      0,
    );
    expect(turning(reversed.v)).toBeLessThan(0);
    expect(rectPath({ p: k([0, 0]), s: k([20, 10]), r: k(0) }, 0).v).toEqual(
      reversed.v,
    );
  });

  it("rounds corners with eight vertices, clamping the radius to the shorter half side", () => {
    const path = rectPath({ p: k([0, 0]), s: k([20, 10]), r: k(50), d: 1 }, 0);
    expect(path.v).toHaveLength(8);
    // The radius clamps to 5, so the right side's two vertices meet.
    expect(path.v[0]).toEqual([10, 0]);
    expect(path.v[1]).toEqual([10, 0]);
    // Corner handles pull (1 - 0.5519) of the radius back from the corner.
    expect(path.i[2]?.[0]).toBeCloseTo(10 - 5 * (1 - ROUND_CORNER), 12);
  });
});

describe("ellipsePath", () => {
  it("starts at the top with circle handles", () => {
    const path = ellipsePath({ p: k([5, 5]), s: k([20, 10]), d: 1 }, 0);
    expect(path.v).toEqual([
      [5, 0],
      [15, 5],
      [5, 10],
      [-5, 5],
    ]);
    expect(path.o[0]).toEqual([5 + 10 * ROUND_CORNER, 0]);
    expect(turning(path.v)).toBeGreaterThan(0);
    const reversed = ellipsePath({ p: k([5, 5]), s: k([20, 10]), d: 3 }, 0);
    expect(reversed.v[1]).toEqual([-5, 5]);
    expect(turning(reversed.v)).toBeLessThan(0);
  });
});

describe("starPath", () => {
  it("alternates outer and inner points starting at the top", () => {
    const path = starPath(
      {
        sy: 1,
        p: k([0, 0]),
        pt: k(5),
        or: k(10),
        ir: k(4),
        os: k(0),
        is: k(0),
        r: k(0),
        d: 1,
      },
      0,
    );
    expect(path.v).toHaveLength(10);
    expect(path.v[0]?.[0]).toBeCloseTo(0, 12);
    expect(path.v[0]?.[1]).toBeCloseTo(-10, 12);
    const radii = path.v.map(([x, y]) => Math.hypot(x, y));
    radii.forEach((r, i) => expect(r).toBeCloseTo(i % 2 === 0 ? 10 : 4, 12));
    // Without roundness the tangents sit on the vertices.
    expect(path.o).toEqual(path.v);
  });

  it("builds polygons and rounds them along the tangent", () => {
    const path = starPath(
      { sy: 2, p: k([0, 0]), pt: k(4), or: k(10), os: k(100), r: k(45) },
      0,
    );
    expect(path.v).toHaveLength(4);
    // Rotated 45 degrees clockwise from the top.
    expect(path.v[0]?.[0]).toBeCloseTo(10 * Math.SQRT1_2, 12);
    expect(path.v[0]?.[1]).toBeCloseTo(-10 * Math.SQRT1_2, 12);
    // Handles are perimeter / (4 * points) long, perpendicular to the radius.
    const [vx = 0, vy = 0] = path.v[0] ?? [];
    const [ox = 0, oy = 0] = path.o[0] ?? [];
    expect(Math.hypot(ox - vx, oy - vy)).toBeCloseTo(
      (2 * Math.PI * 10) / 16,
      12,
    );
    expect((ox - vx) * vx + (oy - vy) * vy).toBeCloseTo(0, 9);
  });
});

describe("transformPath", () => {
  it("maps vertices and tangents", () => {
    const path = transformPath(
      ellipsePath({ p: k([0, 0]), s: k([2, 2]) }, 0),
      scaling(3, 1),
    );
    expect(path.v[1]).toEqual([3, 0]);
    expect(path.i[0]?.[0]).toBeCloseTo(-3 * ROUND_CORNER, 12);
  });
});

describe("roundCorners", () => {
  const square = {
    closed: true,
    v: [
      [0, 0],
      [20, 0],
      [20, 10],
      [0, 10],
    ] as [number, number][],
    i: [
      [0, 0],
      [20, 0],
      [20, 10],
      [0, 10],
    ] as [number, number][],
    o: [
      [0, 0],
      [20, 0],
      [20, 10],
      [0, 10],
    ] as [number, number][],
  };

  it("replaces each sharp corner with two vertices and a curve", () => {
    const rounded = roundCorners(square, 4);
    expect(rounded.v).toHaveLength(8);
    // The corner at (20, 0): 4 back along the top, 4 down the side.
    expect(rounded.v[2]).toEqual([16, 0]);
    expect(rounded.v[3]).toEqual([20, 4]);
    // Handles reach ROUND_CORNER of the way back to the corner.
    expect(rounded.o[2]?.[0]).toBeCloseTo(16 + 4 * ROUND_CORNER, 12);
    expect(rounded.i[3]?.[1]).toBeCloseTo(4 - 4 * ROUND_CORNER, 12);
  });

  it("never passes a side's middle and keeps an open path's ends", () => {
    const rounded = roundCorners(square, 100);
    // The 10-long sides limit the radius to 5.
    expect(rounded.v[3]).toEqual([20, 5]);
    const open = roundCorners({ ...square, closed: false }, 2);
    expect(open.v).toHaveLength(6);
    expect(open.v[0]).toEqual([0, 0]);
    expect(open.v.at(-1)).toEqual([0, 10]);
  });
});
