// Helpers for the coverage tests (bands.test.ts, shade.test.ts): a seeded
// PRNG, a shape packed on its own, and M0's brute-force coverage over every
// curve, which the banded coverage must match.

import { Catalog } from "../../js/src/catalog.ts";
import { type Contour, packCatalog, type Point } from "./pack.ts";
import { type ArtTexture, rootCode, solve } from "./shade.ts";

/** A deterministic PRNG (mulberry32). */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One shape packed on its own, as the shader reads it. */
export interface PackedShape {
  readonly art: ArtTexture;
  readonly shape: number;
  /** Added to a canvas point to get the shape's (shifted) local point. */
  readonly translation: Point;
  /** Every curve's texel, from the union of the horizontal bands. */
  readonly curves: readonly number[];
}

export function packShape(
  contours: readonly Contour[],
  pxPerUnit: number,
): PackedShape {
  const packed = packCatalog({
    shapes: [{ contours, pxPerUnit }],
    animations: [
      {
        name: "s",
        canvas: [1, 1],
        box: [0, 0, 1, 1],
        displayPx: 1,
        fps: 1,
        frames: [
          {
            ops: [
              {
                bbox: [-1e6, -1e6, 1e6, 1e6],
                affine: [1, 0, 0, 1, 0, 0],
                shape: 0,
                fillRule: "nonzero",
                paint: { kind: "solid", color: [1, 1, 1, 1] },
              },
            ],
          },
        ],
      },
    ],
  });
  const catalog = Catalog.parse(packed.bytes);
  const t = catalog.texels;
  const at = (i: number, c: number): number => t[4 * i + c] ?? NaN;
  const op = at(0, 1);
  const shape = at(op + 2, 2);
  const curves = new Set<number>();
  const h = at(shape, 0);
  for (let b = 0; b < h; b++) {
    const header = shape + 2 + b;
    for (let e = 0; e < at(header, 1); e++) {
      curves.add(at(at(header, 2) + (e >> 1), (e & 1) * 2));
    }
  }
  return {
    art: {
      texels: catalog.texture,
      width: catalog.textureWidth,
      height: catalog.textureHeight,
    },
    shape,
    translation: [at(op + 2, 0), at(op + 2, 1)],
    curves: [...curves].sort((a, b) => a - b),
  };
}

const f = Math.fround;
const sat = (x: number): number => Math.min(Math.max(x, 0), 1);

/**
 * M0's coverage: both rays, positive only, over every curve of the shape,
 * with no bands and no early exit. The banded coverage must equal it.
 */
export function bruteCoverage(
  packed: PackedShape,
  q: Point,
  pp: Point,
  evenOdd: boolean,
): number {
  const t = packed.art.texels;
  const [qx, qy] = [f(q[0]), f(q[1])];
  let [xcov, xwgt, ycov, ywgt] = [0, 0, 0, 0];
  for (const c of packed.curves) {
    const p1: Point = [f((t[4 * c] ?? 0) - qx), f((t[4 * c + 1] ?? 0) - qy)];
    const p2: Point = [
      f((t[4 * c + 2] ?? 0) - qx),
      f((t[4 * c + 3] ?? 0) - qy),
    ];
    const p3: Point = [
      f((t[4 * c + 4] ?? 0) - qx),
      f((t[4 * c + 5] ?? 0) - qy),
    ];
    let code = rootCode(p1[1], p2[1], p3[1]);
    if (code !== 0) {
      const [r0, r1] = solve(p1, p2, p3).map((r) => f(r * f(pp[0]))) as [
        number,
        number,
      ];
      if (code & 1) {
        xcov = f(xcov + sat(f(r0 + 0.5)));
        xwgt = Math.max(xwgt, sat(f(1 - f(Math.abs(r0) * 2))));
      }
      if (code > 1) {
        xcov = f(xcov - sat(f(r1 + 0.5)));
        xwgt = Math.max(xwgt, sat(f(1 - f(Math.abs(r1) * 2))));
      }
    }
    code = rootCode(p1[0], p2[0], p3[0]);
    if (code !== 0) {
      const swap = (p: Point): Point => [p[1], p[0]];
      const [r0, r1] = solve(swap(p1), swap(p2), swap(p3)).map((r) =>
        f(r * f(pp[1])),
      ) as [number, number];
      if (code & 1) {
        ycov = f(ycov - sat(f(r0 + 0.5)));
        ywgt = Math.max(ywgt, sat(f(1 - f(Math.abs(r0) * 2))));
      }
      if (code > 1) {
        ycov = f(ycov + sat(f(r1 + 0.5)));
        ywgt = Math.max(ywgt, sat(f(1 - f(Math.abs(r1) * 2))));
      }
    }
  }
  const c = Math.max(
    f(
      Math.abs(f(f(xcov * xwgt) + f(ycov * ywgt))) /
        Math.max(f(xwgt + ywgt), 1 / 65536),
    ),
    Math.min(Math.abs(xcov), Math.abs(ycov)),
  );
  if (!evenOdd) return sat(c);
  const half = f(c * 0.5);
  return f(1 - Math.abs(f(1 - f(f(half - Math.floor(half)) * 2))));
}
