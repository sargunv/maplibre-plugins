import { describe, expect, it } from "vite-plus/test";

import { Catalog } from "../../js/src/catalog.ts";
import { circle, rect } from "./fixtures.ts";
import {
  type Contour,
  type PaintInput,
  packCatalog,
  type Point,
} from "./pack.ts";
import { packShape, random } from "./shade.testing.ts";
import {
  type ArtTexture,
  coverage,
  gradient,
  recolor,
  shade,
} from "./shade.ts";

/** The exact signed area of closed quadratic contours (Green's theorem). */
function area(contours: readonly Contour[]): number {
  let sum = 0;
  const cross = (a: Point, b: Point): number => a[0] * b[1] - a[1] * b[0];
  for (const contour of contours) {
    contour.forEach(({ on, ctrl }, k) => {
      const end = (contour[(k + 1) % contour.length] ?? contour[0])?.on ?? on;
      // B(t) = A t² + B t + C: ∫ B × B' dt = C × A + C × B - (A × B) / 3.
      const a: Point = [
        on[0] - 2 * ctrl[0] + end[0],
        on[1] - 2 * ctrl[1] + end[1],
      ];
      const b: Point = [2 * (ctrl[0] - on[0]), 2 * (ctrl[1] - on[1])];
      sum += cross(on, a) + cross(on, b) - cross(a, b) / 3;
    });
  }
  return sum / 2;
}

/** The length of closed quadratic contours. */
function perimeter(contours: readonly Contour[]): number {
  let sum = 0;
  for (const contour of contours) {
    contour.forEach(({ on, ctrl }, k) => {
      const end = (contour[(k + 1) % contour.length] ?? contour[0])?.on ?? on;
      let previous = on;
      for (let i = 1; i <= 64; i++) {
        const t = i / 64;
        const point: Point = [
          (1 - t) ** 2 * on[0] + 2 * t * (1 - t) * ctrl[0] + t * t * end[0],
          (1 - t) ** 2 * on[1] + 2 * t * (1 - t) * ctrl[1] + t * t * end[1],
        ];
        sum += Math.hypot(point[0] - previous[0], point[1] - previous[1]);
        previous = point;
      }
    });
  }
  return sum;
}

/** Sums the coverage of every pixel of a unit grid shifted by (ox, oy). */
function integrate(
  contours: readonly Contour[],
  evenOdd: boolean,
  ox: number,
  oy: number,
): number {
  const packed = packShape(contours, 1);
  const [tx, ty] = packed.translation;
  let sum = 0;
  for (let y = -2; y < 40; y++) {
    for (let x = -2; x < 40; x++) {
      const q: Point = [x + 0.5 + ox + tx, y + 0.5 + oy + ty];
      sum += coverage(packed.art, packed.shape, q, [1, 1], evenOdd).coverage;
    }
  }
  return sum;
}

describe("coverage", () => {
  const outer = circle(16, 16, 12, 16);
  const inner = circle(16, 16, 7.5, 16);
  const shapes: [string, Contour[], boolean, number][] = [
    [
      "circle",
      [circle(16, 16, 9.3, 16)],
      false,
      Math.abs(area([circle(16, 16, 9.3, 16)])),
    ],
    ["rectangle", [rect(4.2, 6.7, 27.9, 20.35)], false, 23.7 * 13.65],
    [
      "ring",
      [outer, inner],
      true,
      Math.abs(area([outer])) - Math.abs(area([inner])),
    ],
  ];
  for (const [name, contours, evenOdd, exact] of shapes) {
    // Slug's rays box-filter each pixel along x and y, which is exact for
    // axis-aligned edges but not at corners or slanted edges (up to 1/8 of
    // a pixel at 45°), and those errors do not cancel exactly over a finite
    // outline. So the integrated area is held within 2% of a pixel per
    // pixel of outline, not in total.
    it(`integrates to the exact area within 2% of a pixel per outline pixel: ${name}`, () => {
      const next = random(name.length);
      const bound = 0.02 * perimeter(contours);
      for (let k = 0; k < 8; k++) {
        const total = integrate(contours, evenOdd, next(), next());
        expect(Math.abs(total - exact), `offset ${k}`).toBeLessThanOrEqual(
          bound,
        );
      }
    });
  }

  it("is exact along axis-aligned edges, away from corners", () => {
    // A 2-pixel-wide window across the middle of the rectangle's left and
    // right edges, at sub-pixel offsets.
    const packed = packShape([rect(4.2, 0, 27.9, 40)], 1);
    const [tx, ty] = packed.translation;
    const next = random(5);
    for (let k = 0; k < 8; k++) {
      const [ox, oy] = [next(), next()];
      let sum = 0;
      for (let y = 10; y < 30; y++) {
        for (let x = 0; x < 32; x++) {
          sum += coverage(
            packed.art,
            packed.shape,
            [x + 0.5 + ox + tx, y + 0.5 + oy + ty],
            [1, 1],
            false,
          ).coverage;
        }
      }
      expect(Math.abs(sum - 23.7 * 20)).toBeLessThanOrEqual(1e-3);
    }
  });

  it("covers inside, not outside, and half on an axis-aligned edge", () => {
    const packed = packShape([rect(0, 0, 10, 10)], 1);
    const at = (x: number, y: number, pp = 1): number =>
      coverage(packed.art, packed.shape, [x, y], [pp, pp], false).coverage;
    expect(at(5, 5)).toBe(1);
    expect(at(15, 5)).toBe(0);
    expect(at(10, 5)).toBe(0.5);
    expect(at(0, 5)).toBe(0.5);
    expect(at(10.25, 5)).toBeCloseTo(0.25, 6);
    // Four pixels per unit: the edge 0.25 units away is a pixel away.
    expect(at(10.25, 5, 4)).toBe(0);
  });

  it("counts the loop iterations of both rays", () => {
    const packed = packShape([rect(0, 0, 10, 10)], 1);
    const { visits } = coverage(
      packed.art,
      packed.shape,
      [5, 5],
      [1, 1],
      false,
    );
    // One band each way lists all four edges; each ray visits them in turn
    // until one lies wholly behind it.
    expect(visits).toBeGreaterThanOrEqual(2);
    expect(visits).toBeLessThanOrEqual(8);
  });
});

/** A catalog of one full-canvas op with the given paint, and its art. */
function paintCatalog(paint: PaintInput): { art: ArtTexture; frame: number } {
  const packed = packCatalog({
    shapes: [{ contours: [rect(0, 0, 100, 10)], pxPerUnit: 1 }],
    animations: [
      {
        name: "g",
        canvas: [100, 10],
        box: [0, 0, 100, 10],
        displayPx: 100,
        fps: 1,
        frames: [
          {
            ops: [
              {
                bbox: [0, 0, 100, 10],
                affine: [1, 0, 0, 1, 0, 0],
                shape: 0,
                fillRule: "nonzero",
                paint,
              },
            ],
          },
        ],
      },
    ],
  });
  const catalog = Catalog.parse(packed.bytes);
  return {
    art: {
      texels: catalog.texture,
      width: catalog.textureWidth,
      height: catalog.textureHeight,
    },
    frame: catalog.animations[0]?.frameTexel ?? 0,
  };
}

describe("gradient", () => {
  const stops = [
    { offset: 0.2, color: [1, 0, 0, 1] as const },
    { offset: 0.5, color: [0, 1, 0, 0.5] as const },
    { offset: 0.5, color: [0, 0, 1, 1] as const },
    { offset: 0.9, color: [1, 1, 1, 0] as const },
  ];
  const { art, frame } = paintCatalog({
    kind: "linear",
    from: [0, 5],
    to: [100, 5],
    stops,
    opacity: 0.5,
  });
  const g = (t: number): number[] => {
    // The gradient record follows the shape; find it through the op.
    const ops = art.texels[4 * frame + 1] ?? 0;
    const record = art.texels[4 * (ops + 3)] ?? 0;
    return gradient(art, record, 4, false, [t * 100, 5]);
  };

  it("pads before the first and after the last stop", () => {
    expect(g(0)).toEqual([1, 0, 0, 1]);
    expect(g(0.2)).toEqual([1, 0, 0, 1]);
    expect(g(0.95)).toEqual([0, 0, 0, 0]);
    expect(g(1)).toEqual([0, 0, 0, 0]);
  });

  it("interpolates straight colors and premultiplies after", () => {
    const [r, gg, b, a] = g(0.35);
    expect(a).toBeCloseTo(0.75, 6);
    expect(r).toBeCloseTo(0.5 * 0.75, 6);
    expect(gg).toBeCloseTo(0.5 * 0.75, 6);
    expect(b).toBe(0);
  });

  it("takes the first matching stop pair at a hard stop", () => {
    // At exactly 0.5 the first pair (0.2, 0.5) ends: its end color.
    expect(g(0.5)).toEqual([0, Math.fround(0.5), 0, Math.fround(0.5)]);
    const [, , b, a] = g(0.5 + 1e-4);
    expect(b).toBeCloseTo(1, 3);
    expect(a).toBeCloseTo(1, 3);
  });

  it("scales by the op's opacity in shade", () => {
    const { color } = shade({
      art,
      frameTexel: frame,
      uv: [0.5, 5],
      dx: [1, 0],
      dy: [0, 1],
    });
    expect(color).toEqual([0.5, 0, 0, 0.5]);
  });

  it("measures a radial gradient from its centre", () => {
    const radial = paintCatalog({
      kind: "radial",
      from: [50, 5],
      to: [90, 5],
      stops: [
        { offset: 0, color: [1, 1, 1, 1] },
        { offset: 1, color: [0, 0, 0, 1] },
      ],
      opacity: 1,
    });
    const at = (x: number, y: number): number =>
      shade({
        art: radial.art,
        frameTexel: radial.frame,
        uv: [x, y],
        dx: [1, 0],
        dy: [0, 1],
      }).color[0];
    expect(at(50, 5)).toBe(1);
    expect(at(70, 5)).toBeCloseTo(0.5, 5);
    expect(at(30, 5)).toBeCloseTo(0.5, 5);
    expect(at(95, 5)).toBe(0);
  });
});

describe("recolor", () => {
  it("moves the hue by the recolor's alpha and keeps the authored alpha", () => {
    expect(recolor([0.5, 0, 0, 0.5], [0, 0, 0, 0])).toEqual([0.5, 0, 0, 0.5]);
    expect(recolor([0.5, 0, 0, 0.5], [0, 1, 0, 1])).toEqual([0, 0.5, 0, 0.5]);
    const [r, g, b, a] = recolor([0.5, 0, 0, 0.5], [0, 0.5, 0, 0.5]);
    expect([r, g, b, a].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([
      0.25, 0.25, 0, 0.5,
    ]);
  });
});

describe("shade", () => {
  it("composites ops source-over and applies opacity to the whole icon", () => {
    const packed = packCatalog({
      shapes: [{ contours: [rect(0, 0, 10, 10)], pxPerUnit: 1 }],
      animations: [
        {
          name: "a",
          canvas: [10, 10],
          box: [0, 0, 10, 10],
          displayPx: 10,
          fps: 1,
          frames: [
            {
              ops: [
                {
                  bbox: [0, 0, 10, 10],
                  affine: [1, 0, 0, 1, 0, 0],
                  shape: 0,
                  fillRule: "nonzero",
                  paint: { kind: "solid", color: [1, 0, 0, 1] },
                },
                {
                  bbox: [0, 0, 10, 10],
                  affine: [1, 0, 0, 1, 0, 0],
                  shape: 0,
                  fillRule: "nonzero",
                  paint: { kind: "solid", color: [0, 0, 1, 0.5], slot: 2 },
                },
              ],
            },
          ],
        },
      ],
    });
    const catalog = Catalog.parse(packed.bytes);
    const art = {
      texels: catalog.texture,
      width: catalog.textureWidth,
      height: catalog.textureHeight,
    };
    const input = {
      art,
      frameTexel: 0,
      uv: [5, 5] as const,
      dx: [1, 0] as const,
      dy: [0, 1] as const,
    };
    expect(shade(input).color).toEqual([0.5, 0, 0.5, 1]);
    expect(shade({ ...input, opacity: 0.5 }).color).toEqual([
      0.25, 0, 0.25, 0.5,
    ]);
    // The secondary slot recolors the second op; the primary does not.
    expect(shade({ ...input, primary: [0, 1, 0, 1] }).color).toEqual([
      0.5, 0, 0.5, 1,
    ]);
    expect(shade({ ...input, secondary: [0, 1, 0, 1] }).color).toEqual([
      0.5, 0.5, 0, 1,
    ]);
    // A pixel a pixel beyond the bbox skips the op without visiting curves.
    expect(shade({ ...input, uv: [11.5, 5] })).toEqual({
      color: [0, 0, 0, 0],
      visits: 0,
    });
  });

  it("terminates inside the texture on random texels", () => {
    const next = random(99);
    const specials = [
      Number.NaN,
      Infinity,
      -Infinity,
      2 ** 30,
      -(2 ** 30),
      1e38,
      -0.5,
      0,
      1,
      3,
      64,
      1024,
      2047,
    ];
    for (const width of [1024, 2048]) {
      for (let round = 0; round < 40; round++) {
        const height = 1 + Math.floor(next() * 3);
        const data = new Float32Array(width * height * 4);
        for (let k = 0; k < data.length; k++) {
          const pick = next();
          data[k] =
            pick < 0.3
              ? (specials[Math.floor(next() * specials.length)] ?? 0)
              : pick < 0.8
                ? Math.floor(next() * width * height * 1.5)
                : (next() - 0.5) * 100;
        }
        let reads = 0;
        const texels = new Proxy(data, {
          get(target, key, receiver) {
            if (typeof key === "string" && /^-?\d/.test(key)) {
              const index = Number(key);
              if (
                !(
                  Number.isInteger(index) &&
                  index >= 0 &&
                  index < target.length
                )
              ) {
                throw new Error(`read outside the texture: ${key}`);
              }
              reads++;
              return target[index];
            }
            return Reflect.get(target, key, receiver) as unknown;
          },
        });
        const art = { texels, width, height };
        for (let n = 0; n < 20; n++) {
          const result = shade({
            art,
            frameTexel: Math.floor(next() * width * height),
            uv: [(next() - 0.5) * 200, (next() - 0.5) * 200],
            dx: [next(), next() - 0.5],
            dy: [next() - 0.5, next()],
            primary: [next(), next(), next(), next()],
          });
          // 64 ops × (2 × 1024 curve visits): the loops are bounded.
          expect(result.visits).toBeLessThanOrEqual(64 * 2048);
        }
        expect(reads).toBeGreaterThan(0);
      }
    }
  });
});
