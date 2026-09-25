import { describe, expect, it } from "vite-plus/test";

import type { Point } from "./pack.ts";
import {
  apply,
  autoOrientAt,
  IDENTITY,
  invert,
  maxScale,
  minScale,
  multiply,
  opacityAt,
  rotation,
  scaling,
  transformAt,
  translation,
} from "./transform.ts";

function close(actual: Point, expected: Point): void {
  expect(actual[0]).toBeCloseTo(expected[0], 9);
  expect(actual[1]).toBeCloseTo(expected[1], 9);
}

describe("matrices", () => {
  it("apply the right-hand matrix first", () => {
    const m = multiply(translation(10, 0), scaling(2, 3));
    close(apply(m, [1, 1]), [12, 3]);
    close(apply(multiply(IDENTITY, m), [1, 1]), [12, 3]);
  });

  it("rotate clockwise on screen", () => {
    close(apply(rotation(Math.PI / 2), [1, 0]), [0, 1]);
  });

  it("measure the largest stretch", () => {
    expect(maxScale(scaling(2, -5))).toBeCloseTo(5, 12);
    expect(maxScale(multiply(rotation(0.7), scaling(3, 1)))).toBeCloseTo(3, 12);
  });
});

describe("transformAt", () => {
  it("maps the anchor point to the position", () => {
    const m = transformAt(
      {
        a: { k: [10, 20] },
        p: { k: [100, 50] },
        s: { k: [200, 50] },
        r: { k: 30 },
      },
      0,
    );
    close(apply(m, [10, 20]), [100, 50]);
  });

  it("scales, then rotates, about the anchor", () => {
    const m = transformAt(
      {
        a: { k: [10, 10] },
        p: { k: [0, 0] },
        s: { k: [200, 100] },
        r: { k: 90 },
      },
      0,
    );
    // (11, 10) is 1 right of the anchor: scaled to 2 right, then turned
    // clockwise to 2 down.
    close(apply(m, [11, 10]), [0, 2]);
  });

  it("skews like lottie-web's skewFromAxis(-sk, sa)", () => {
    // Along the x axis, a positive skew leans the top to the left.
    const m = transformAt({ sk: { k: 45 }, sa: { k: 0 } }, 0);
    close(apply(m, [0, 10]), [-10, 10]);
    close(apply(m, [10, 0]), [10, 0]);
    // A skew axis turns the shear direction with it.
    const turned = transformAt({ sk: { k: 45 }, sa: { k: 90 } }, 0);
    close(apply(turned, [10, 0]), [10, 10]);
  });

  it("reads split positions and animated values", () => {
    const m = transformAt(
      {
        p: {
          s: true,
          x: { k: 5 },
          y: {
            a: 1,
            k: [
              { t: 0, s: [0], o: { x: [0], y: [0] }, i: { x: [1], y: [1] } },
              { t: 10, s: [20] },
            ],
          },
        },
      },
      5,
    );
    close(apply(m, [0, 0]), [5, 10]);
  });

  it("reads opacity in 0..1", () => {
    expect(opacityAt({ o: { k: 40 } }, 0)).toBeCloseTo(0.4, 12);
    expect(opacityAt(undefined, 0)).toBe(1);
  });
});

describe("invert and minScale", () => {
  it("inverts affine maps and refuses collapsed ones", () => {
    const m = multiply(
      multiply([1, 0, 0, 1, 5, -3], rotation(0.7)),
      scaling(2, 3),
    );
    const inverse = invert(m);
    const [x, y] = apply(inverse ?? IDENTITY, apply(m, [4, 9]));
    expect(x).toBeCloseTo(4, 12);
    expect(y).toBeCloseTo(9, 12);
    expect(invert(scaling(0, 1))).toBeUndefined();
    expect(minScale(m)).toBeCloseTo(2, 12);
    expect(maxScale(m)).toBeCloseTo(3, 12);
  });
});

describe("autoOrientAt", () => {
  const linear = { o: { x: [0], y: [0] }, i: { x: [1], y: [1] } };
  const diagonal = {
    a: 1,
    k: [
      { t: 10, s: [0, 0], ...linear },
      { t: 20, s: [10, 10] },
    ],
  };

  it("follows the direction of travel, sampled as lottie-web samples it", () => {
    expect(autoOrientAt(diagonal, 15)).toBeCloseTo(Math.PI / 4, 6);
    // Before the first and after the last keyframe: the ends' directions.
    expect(autoOrientAt(diagonal, 0)).toBeCloseTo(Math.PI / 4, 6);
    expect(autoOrientAt(diagonal, 30)).toBeCloseTo(Math.PI / 4, 6);
    // No keyframes, no turn.
    expect(autoOrientAt({ a: 0, k: [5, 5] }, 15)).toBe(0);
  });

  it("reads separate position dimensions", () => {
    const split = {
      s: true as const,
      x: {
        a: 1,
        k: [
          { t: 0, s: [0], ...linear },
          { t: 10, s: [0] },
        ],
      },
      y: {
        a: 1,
        k: [
          { t: 0, s: [0], ...linear },
          { t: 10, s: [10] },
        ],
      },
    };
    expect(autoOrientAt(split, 5)).toBeCloseTo(Math.PI / 2, 6);
  });
});
