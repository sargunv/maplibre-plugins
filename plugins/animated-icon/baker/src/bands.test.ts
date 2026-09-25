import { describe, expect, it } from "vite-plus/test";

import { bandCount, buildBands, SPLIT_OFF, splitEnabled } from "./bands.ts";
import { circle, rect, star } from "./fixtures.ts";
import { type Contour, type Point, polygon } from "./pack.ts";
import { bruteCoverage, packShape, random } from "./shade.testing.ts";
import { coverage } from "./shade.ts";

/** Glyph-like outlines: an "O" with a reversed hole, an "E" and a curvy "S". */
function text(): Contour[] {
  const outer = circle(10, 16, 8, 12);
  const hole = [...circle(10, 16, 5, 12)].reverse().map(({ on }, k, all) => {
    const next = all[(k + 1) % all.length]?.on ?? on;
    return {
      on,
      ctrl: [(on[0] + next[0]) / 2 + 0.3, (on[1] + next[1]) / 2] as Point,
    };
  });
  const e = polygon([
    [22, 8],
    [32, 8],
    [32, 11],
    [25, 11],
    [25, 14.5],
    [30, 14.5],
    [30, 17.5],
    [25, 17.5],
    [25, 21],
    [32, 21],
    [32, 24],
    [22, 24],
  ]);
  const s: Contour = [
    { on: [36, 9], ctrl: [44, 6] },
    { on: [44, 12], ctrl: [44, 14] },
    { on: [40, 15.5], ctrl: [36, 17] },
    { on: [36.5, 20.5], ctrl: [37, 23] },
    { on: [44, 21], ctrl: [44.5, 26] },
    { on: [38, 25], ctrl: [33, 25] },
    { on: [34, 21], ctrl: [36, 18.5] },
    { on: [40.5, 17], ctrl: [41.5, 15] },
    { on: [41, 12], ctrl: [40.5, 10] },
    { on: [36, 12], ctrl: [35, 10] },
  ];
  return [outer, hole, e, s];
}

const SHAPES: readonly {
  name: string;
  contours: Contour[];
  evenOdd: boolean;
}[] = [
  { name: "circle", contours: [circle(16, 16, 12, 24)], evenOdd: false },
  {
    name: "ring",
    contours: [circle(16, 16, 12), circle(16.5, 15.5, 7, 10)],
    evenOdd: true,
  },
  { name: "star", contours: [star(16, 16, 5, 14, 9)], evenOdd: false },
  { name: "text", contours: text(), evenOdd: false },
  {
    name: "far from the origin",
    contours: [circle(4000.25, -3000.5, 2, 12), circle(4006, -2996, 1, 8)],
    evenOdd: false,
  },
  {
    name: "flat",
    contours: [
      polygon([
        [0, 5],
        [10, 5],
      ]),
      polygon([
        [2, 5],
        [7, 5],
        [4, 5],
      ]),
    ],
    evenOdd: false,
  },
  {
    name: "degenerate",
    contours: [
      [{ on: [3, 3], ctrl: [3, 3] }],
      [{ on: [5, 1], ctrl: [9, 4] }],
      polygon([
        [1, 1],
        [1, 9],
      ]),
      rect(2, 2, 2.0001, 8),
    ],
    evenOdd: false,
  },
];

describe("bandCount and splitEnabled", () => {
  it("aim at four curves per band and four pixels per band, 1 to 16", () => {
    expect(bandCount(0, 100)).toBe(1);
    expect(bandCount(3, 100)).toBe(1);
    expect(bandCount(12, 100)).toBe(3);
    expect(bandCount(12, 8)).toBe(2);
    expect(bandCount(1000, 1000)).toBe(16);
    expect(bandCount(1000, 2)).toBe(1);
    expect(bandCount(10, Number.NaN)).toBe(1);
  });

  it("split only bands of at least 16 pixels and 4 curves", () => {
    expect(splitEnabled(4, 16)).toBe(true);
    expect(splitEnabled(4, 15.99)).toBe(false);
    expect(splitEnabled(3, 100)).toBe(false);
  });
});

describe("buildBands", () => {
  it("sorts each list both ways and splits at the lower median", () => {
    const contours = [circle(16, 16, 12, 24)];
    const layout = buildBands(contours, 4);
    expect(layout.h.length).toBe(6);
    expect(layout.v.length).toBe(6);
    const hulls = contours[0]!.map(({ on, ctrl }, k, all) => {
      const end = (all[(k + 1) % all.length] ?? all[0]!).on;
      return [
        Math.min(on[0], ctrl[0], end[0]),
        Math.max(on[0], ctrl[0], end[0]),
      ] as const;
    });
    for (const band of layout.h) {
      expect(band.split).not.toBe(Math.fround(SPLIT_OFF));
      expect([...band.neg].sort((a, b) => a - b)).toEqual(
        [...band.pos].sort((a, b) => a - b),
      );
      const maxes = band.pos.map((i) => hulls[i]![1]);
      expect(maxes).toEqual([...maxes].sort((a, b) => b - a));
      const mins = band.neg.map((i) => hulls[i]![0]);
      expect(mins).toEqual([...mins].sort((a, b) => a - b));
      const mids = band.pos
        .map((i) => (hulls[i]![0] + hulls[i]![1]) / 2)
        .sort((a, b) => a - b);
      expect(band.split).toBe(
        Math.fround(mids[Math.floor((mids.length - 1) / 2)]!),
      );
    }
  });

  it("disables the split below 16 pixels, copying pos into neg", () => {
    const layout = buildBands([circle(16, 16, 12, 24)], 0.5);
    for (const band of [...layout.h, ...layout.v]) {
      expect(band.split).toBe(Math.fround(SPLIT_OFF));
      expect(band.neg).toEqual(band.pos);
    }
  });

  it("gives a flat shape one band and a zero transform", () => {
    const layout = buildBands(
      [
        polygon([
          [0, 5],
          [10, 5],
        ]),
      ],
      10,
    );
    expect(layout.h.length).toBe(1);
    expect(layout.transform[0]).toBe(0);
    expect(layout.transform[1]).toBe(0);
    expect(layout.v.length).toBeGreaterThan(0);
  });

  it("puts every curve that meets a band, with a margin, in its list", () => {
    const contours = [star(16, 16, 5, 14, 9)];
    const layout = buildBands(contours, 3);
    const [hs, hb] = layout.transform;
    const curves = contours[0]!.map(({ on, ctrl }, k, all) => {
      const end = (all[(k + 1) % all.length] ?? all[0]!).on;
      return [
        Math.min(on[1], ctrl[1], end[1]),
        Math.max(on[1], ctrl[1], end[1]),
      ] as const;
    });
    layout.h.forEach((band, k) => {
      const y0 = (k - hb) / hs;
      const y1 = (k + 1 - hb) / hs;
      curves.forEach(([lo, hi], i) => {
        if (hi >= y0 && lo <= y1) expect(band.pos).toContain(i);
        if (hi < y0 - (y1 - y0) / 512 || lo > y1 + (y1 - y0) / 512)
          expect(band.pos).not.toContain(i);
      });
    });
  });
});

describe("banded coverage", () => {
  for (const { name, contours, evenOdd } of SHAPES) {
    it(`equals the brute-force coverage over every curve: ${name}`, () => {
      const next = random(name.length * 7919 + 17);
      let split = 0;
      let visits = 0;
      let bruteVisits = 0;
      for (const pxPerUnit of [0.5, 3, 24]) {
        const packed = packShape(contours, pxPerUnit);
        const on = contours.flatMap((c) => c.map((curve) => curve.on));
        const xs = on.map((p) => p[0] + packed.translation[0]);
        const ys = on.map((p) => p[1] + packed.translation[1]);
        const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
        const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
        const w = Math.max(x1 - x0, 1);
        const h = Math.max(y1 - y0, 1);
        for (let n = 0; n < 3400; n++) {
          let qx = x0 - 0.1 * w + next() * 1.2 * w;
          let qy = y0 - 0.1 * h + next() * 1.2 * h;
          // Some samples sit exactly level with a vertex, where roots are
          // shared between curves.
          const pick = next();
          if (pick < 0.1) qy = ys[Math.floor(next() * ys.length)] ?? qy;
          else if (pick < 0.2) qx = xs[Math.floor(next() * xs.length)] ?? qx;
          const q: Point = [Math.fround(qx), Math.fround(qy)];
          const pp: Point = [
            Math.fround(10 ** (next() * 3 - 1.5)),
            Math.fround(10 ** (next() * 3 - 1.5)),
          ];
          const banded = coverage(packed.art, packed.shape, q, pp, evenOdd);
          const brute = bruteCoverage(packed, q, pp, evenOdd);
          expect(
            Math.abs(banded.coverage - brute),
            `q ${q.join(", ")} pp ${pp.join(", ")}`,
          ).toBeLessThanOrEqual(1e-6);
          visits += banded.visits;
          bruteVisits += 2 * packed.curves.length;
        }
        const t = packed.art.texels;
        for (let b = 0; b < (t[4 * packed.shape] ?? 0); b++) {
          if ((t[4 * (packed.shape + 2 + b)] ?? 0) > -1e38) split++;
        }
      }
      if (name === "circle" || name === "star" || name === "text") {
        expect(split).toBeGreaterThan(0);
        expect(visits).toBeLessThan(bruteVisits / 2);
      }
    });
  }
});
