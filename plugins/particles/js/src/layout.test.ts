// Mirrors the tests in ../../native/src/layout.zig: the shared fixtures pin
// every output of both twins, and the unit tests below restate the Zig ones.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { pcg3d } from "./hash.ts";
import {
  digest,
  type Edge,
  Emit,
  FeatureLayout,
  FLOATS_PER_VERTEX,
  inside,
  type Kind,
  type Point,
} from "./layout.ts";
import { EXTENT, featuresLayout } from "./spec.ts";

interface FixtureFeature {
  index: number;
  type: Kind;
  paths: [number, number][][];
}

interface FixtureCase {
  name: string;
  extent?: number;
  maxParticles?: number;
  features: FixtureFeature[];
  expected: {
    slotCount: number;
    segment: { vertexLength: number; indexLength: number };
    ranges: [number, number, number][];
    slots?: [number, number, number, number][];
    digest?: number;
  };
}

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), "utf8"),
  ) as { cases: FixtureCase[] };

const pathsOf = (paths: [number, number][][]): Point[][] =>
  paths.map((path) => path.map(([x, y]) => ({ x, y })));

function layOut(
  features: [Kind, number, [number, number][][]][],
  extent = EXTENT,
  maxSlots?: number,
): FeatureLayout {
  const layout = new FeatureLayout(extent, maxSlots);
  for (const [kind, index, paths] of features)
    layout.add(kind, index, pathsOf(paths));
  layout.finish();
  return layout;
}

/** a_emit of vertex i. */
const vertex = (layout: FeatureLayout, i: number) =>
  Array.from(
    layout.vertices.subarray(
      i * FLOATS_PER_VERTEX,
      (i + 1) * FLOATS_PER_VERTEX,
    ),
  );

describe.each([
  "layout-points.json",
  "layout-lines.json",
  "layout-polygons.json",
])("%s", (file) => {
  const { cases } = fixture(file);

  it("has cases", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    it(c.name, () => {
      const layout = layOut(
        c.features.map((f) => [f.type, f.index, f.paths]),
        c.extent,
        c.maxParticles,
      );
      const { expected } = c;
      expect(layout.slotCount).toBe(expected.slotCount);
      expect(layout.vertices.length / FLOATS_PER_VERTEX).toBe(
        expected.segment.vertexLength,
      );
      expect(6 * layout.quads).toBe(expected.segment.indexLength);
      expect(
        layout.ranges.map((r) => [
          r.featureIndex,
          r.firstVertex,
          r.vertexCount,
        ]),
      ).toEqual(expected.ranges);
      expect(expected.slots ?? expected.digest).toBeDefined();
      if (expected.slots) {
        expect(layout.quads).toBe(expected.slots.length);
        expected.slots.forEach((slot, i) => {
          for (let corner = 0; corner < 4; corner++) {
            const [x, y, z, w] = slot;
            expect(vertex(layout, 4 * i + corner)).toEqual([
              x,
              y,
              z,
              w + Emit.cornerStride * corner,
            ]);
          }
        });
      }
      if (expected.digest !== undefined)
        expect(digest(layout.vertices)).toBe(expected.digest);
    });
  }
});

describe("FeatureLayout", () => {
  it("uses the spec's layout constants", () => {
    expect(new FeatureLayout().maxSlots).toBe(16383);
    expect(featuresLayout).toEqual({
      pointSlots: 16,
      lineSlotSpacing: 32,
      polygonCell: 128,
      maxParticlesPerTile: 16383,
    });
    // The shader decodes w and z with shifts and masks, and z stays exact.
    expect(Emit.slotStride).toBe(4 * Emit.cornerStride);
    expect(Emit.lineAngleSteps * Emit.lineLengthSteps).toBeLessThanOrEqual(
      2 ** 24,
    );
  });

  it("owns points half-open and keeps their 16 slots in order", () => {
    const layout = layOut([
      ["point", 3, [[[0, 8191]], [[8192, 5]], [[-1, 5]], [[5, 8192]]]],
    ]);
    expect(layout.slotCount).toBe(16);
    expect(layout.vertices.length / FLOATS_PER_VERTEX).toBe(64);
    for (let i = 0; i < 64; i++) {
      const slot = Math.floor(i / 4);
      expect(vertex(layout, i)).toEqual([0, 8191, 0, slot * 16 + (i % 4) * 4]);
    }
    expect(layout.ranges).toEqual([
      { featureIndex: 3, firstVertex: 0, vertexCount: 64 },
    ]);
  });

  it("gives a line piece to the tile holding its midpoint, once across a seam", () => {
    // The same segment seen from the tile on each side of x = 8192.
    const left = layOut([
      [
        "line",
        0,
        [
          [
            [8000, 100],
            [8400, 100],
          ],
        ],
      ],
    ]);
    const right = layOut([
      [
        "line",
        0,
        [
          [
            [-192, 100],
            [208, 100],
          ],
        ],
      ],
    ]);
    // Left keeps [8000, 8192]: 192 long, 6 slots; right keeps [0, 208]: 7.
    expect(left.slotCount).toBe(6);
    expect(right.slotCount).toBe(7);
    // East is step 256; the half lengths are 96 and 104.
    expect(vertex(left, 0)).toEqual([8096, 100, 256 * 8192 + 96, 1]);
    expect(vertex(right, 0)).toEqual([104, 100, 256 * 8192 + 104, 1]);
    expect(vertex(left, 4 * left.quads - 1)[3]).toBe(5 * 16 + 3 * 4 + 1);

    // A segment lying on the shared edge belongs to the tile it starts.
    const edge = layOut([
      [
        "line",
        0,
        [
          [
            [8192, 100],
            [8192, 900],
          ],
          [
            [0, 100],
            [0, 900],
          ],
        ],
      ],
    ]);
    expect(edge.slotCount).toBe(25);
    expect(vertex(edge, 0)).toEqual([0, 500, 512 * 8192 + 400, 1]);
  });

  it("snaps a clipped piece's midpoint to quarter units on both axes", () => {
    // Clipped at y = 0 to (2.615…, 0)-(15, 23): midpoint (8.807…, 11.5),
    // 26.1 units long.
    const layout = layOut([
      [
        "line",
        0,
        [
          [
            [1, -3],
            [15, 23],
          ],
        ],
      ],
    ]);
    expect(vertex(layout, 0)).toEqual([8.75, 11.5, 432 * 8192 + 13, 1]);
  });

  it("follows even-odd across rings, so holes stay empty", () => {
    const outer: [number, number][] = [
      [1024, 1024],
      [2048, 1024],
      [2048, 2048],
      [1024, 2048],
    ];
    const solid = layOut([["polygon", 0, [[...outer, [1024, 1024]]]]]);
    // 8 x 8 cells lie wholly inside: every candidate of them is kept.
    expect(solid.slotCount).toBe(64);
    const holed = layOut([
      [
        "polygon",
        0,
        [
          outer,
          [
            [1280, 1280],
            [1280, 1792],
            [1792, 1792],
            [1792, 1280],
          ],
        ],
      ],
    ]);
    expect(holed.slotCount).toBe(64 - 16);
    for (let i = 0; i < holed.vertices.length / FLOATS_PER_VERTEX; i++) {
      const [x, y, z, w] = vertex(holed, i) as [number, number, number, number];
      expect(x > 1280 && x < 1792 && y > 1280 && y < 1792).toBe(false);
      expect(z).toBe(0);
      expect(w % 4).toBe(Emit.kindPolygon);
      // Quarter-unit anchors within a quarter cell of their cell's center.
      expect(x % 128).toBeGreaterThanOrEqual(32);
      expect(x % 128).toBeLessThanOrEqual(96);
      expect(Math.floor(x * 4)).toBe(x * 4);
    }
  });

  it("gives a candidate on a shared edge to exactly one polygon", () => {
    // Cell (10, 10)'s candidate, and two rectangles meeting on a vertical
    // line through it (the lattice pattern is the same in every tile).
    const h = pcg3d(10, 10, 0x51);
    const jitter = (bits: number) =>
      Math.floor(4 * (((bits >>> 8) / 2 ** 24 - 0.5) * 64) + 0.5);
    const x4 = 4 * (128 * 10 + 64) + jitter(h[0]);
    const y4 = 4 * (128 * 10 + 64) + jitter(h[1]);
    const vertical = (x: number): Edge => ({
      x0: x,
      y0: 4 * 1000,
      x1: x,
      y1: 4 * 1500,
    });
    expect(inside([vertical(4 * 1000), vertical(x4)], x4, y4)).toBe(false);
    expect(inside([vertical(x4), vertical(4 * 1500)], x4, y4)).toBe(true);
    // On a horizontal edge it belongs to the polygon on its +y side: edges
    // span y0 <= y < y1.
    const square: Edge[] = [
      { x0: 0, y0: 0, x1: 0, y1: 40 },
      { x0: 40, y0: 0, x1: 40, y1: 40 },
    ];
    expect(inside(square, 20, 0)).toBe(true);
    expect(inside(square, 20, 40)).toBe(false);
    // A vertex on the ray (the apex of a diamond) is crossed once.
    const diamond: Edge[] = [
      { x0: 0, y0: 0, x1: -40, y1: 40 },
      { x0: 0, y0: 0, x1: 40, y1: 40 },
      { x0: -40, y0: 40, x1: 0, y1: 80 },
      { x0: 40, y0: 40, x1: 0, y1: 80 },
    ];
    expect(inside(diamond, 0, 40)).toBe(true);
    expect(inside(diamond, -39, 40)).toBe(true);
    expect(inside(diamond, 40, 40)).toBe(false);
    expect(inside(diamond, -80, 40)).toBe(false);
    expect(inside(diamond, 0, 1) && inside(diamond, 0, 79)).toBe(true);
    expect(inside(diamond, 0, 0) || inside(diamond, 0, 80)).toBe(false);
  });

  it("keeps every point's lowest ranks past the cap, the next one spread evenly", () => {
    const layout = layOut(
      [
        [
          "point",
          0,
          [
            [
              [10, 10],
              [20, 20],
            ],
          ],
        ],
        ["point", 1, [[[30, 30]]]],
      ],
      EXTENT,
      10,
    );
    expect(layout.slotCount).toBe(48);
    expect(layout.quads).toBe(10);
    // 10 = 3·3 + 1: ranks 0-2 everywhere, and rank 3 for the third point.
    [0, 1, 2, 0, 1, 2, 0, 1, 2, 3].forEach((rank, i) => {
      expect(vertex(layout, 4 * i)[3]).toBe(rank * 16);
    });
    expect(layout.ranges).toEqual([
      { featureIndex: 0, firstVertex: 0, vertexCount: 24 },
      { featureIndex: 1, firstVertex: 24, vertexCount: 16 },
    ]);

    // A feature thinned to nothing gets no range.
    const thin = layOut(
      [
        ["point", 0, [[[10, 10]]]],
        ["point", 1, [[[20, 20]]]],
      ],
      EXTENT,
      1,
    );
    expect(thin.ranges.map((r) => r.featureIndex)).toEqual([1]);
  });

  it("draws particle-density per point on a saturated tile as far as the budget goes", () => {
    // A dense city center's POI tile (3681 points), and a line and a polygon
    // sharing it.
    const count = 3681;
    const features: [Kind, number, [number, number][][]][] = [];
    for (let i = 0; i < count; i++)
      features.push([
        "point",
        i,
        [[[(i % 61) * 130 + 7, Math.floor(i / 61) * 130 + 7]]],
      ]);
    features.push([
      "line",
      count,
      [
        [
          [0, 4000],
          [8000, 4000],
        ],
      ],
    ]);
    features.push([
      "polygon",
      count + 1,
      [
        [
          [0, 0],
          [2048, 0],
          [2048, 2048],
          [0, 2048],
        ],
      ],
    ]);
    const layout = layOut(features);
    const pointTotal = 16 * count;
    expect(layout.slotCount).toBe(pointTotal + 250 + 256);
    expect(layout.quads).toBe(16383);
    // Points keep floor(16383·Tp/T) slots: 4 ranks each and a fifth for an
    // even spread of the rest.
    const budget = Math.floor((16383 * pointTotal) / layout.slotCount);
    const ranks = Math.floor(budget / count);
    const extra = budget - ranks * count;
    expect(ranks).toBe(4);
    let fifth = 0;
    let lastFifth = -1;
    layout.ranges.slice(0, count).forEach((range, i) => {
      expect(range.featureIndex).toBe(i);
      const slots = range.vertexCount / 4;
      expect([ranks, ranks + 1]).toContain(slots);
      // Ranks 0, 1, ... in order, with no gaps.
      for (let rank = 0; rank < slots; rank++)
        expect(
          Math.floor(
            (vertex(layout, range.firstVertex + 4 * rank)[3] ?? 0) /
              Emit.slotStride,
          ),
        ).toBe(rank);
      if (slots > ranks) {
        // Spread evenly: the points with the extra rank are at most P / rem
        // (rounded up) apart.
        if (lastFifth >= 0)
          expect(i - lastFifth).toBeLessThanOrEqual(Math.ceil(count / extra));
        lastFifth = i;
        fifth++;
      }
    });
    expect(fifth).toBe(extra);
    // The line and the polygon share the rest.
    const others = layout.ranges
      .slice(count)
      .reduce((n, r) => n + r.vertexCount / 4, 0);
    expect(others).toBe(16383 - budget);
  });

  it("keeps line slots 32 units apart along a path however densely it is sampled", () => {
    // A 3200-unit line: 100 slots at every vertex spacing.
    for (const step of [3200, 64, 48, 47, 40, 20, 16, 8, 2]) {
      const path: [number, number][] = [];
      for (let x = 100; x < 3300; x += step) path.push([x, 500]);
      path.push([3300, 500]);
      expect([step, layOut([["line", 0, [path]]]).slotCount]).toEqual([
        step,
        100,
      ]);
    }
    // A 64-gon of radius 20 (126 units around) gets 4 slots, not one per
    // side.
    const ring: [number, number][] = [];
    for (let i = 0; i <= 64; i++) {
      const angle = ((i % 64) * 2 * Math.PI) / 64;
      ring.push([
        Math.round(1000 + 20 * Math.cos(angle)),
        Math.round(1000 + 20 * Math.sin(angle)),
      ]);
    }
    expect(layOut([["line", 0, [ring]]]).slotCount).toBe(4);
  });

  it("thins a tile of a million slots to exactly the maximum", () => {
    // 4000 full-width lines of 256 slots each.
    const features: [Kind, number, [number, number][][]][] = [];
    for (let i = 0; i < 4000; i++) {
      features.push([
        "line",
        i,
        [
          [
            [0, (i % 8000) + 1],
            [8191, (i % 8000) + 1],
          ],
        ],
      ]);
    }
    const layout = layOut(features);
    expect(layout.slotCount).toBe(4000 * 256);
    expect(layout.quads).toBe(16383);
    const covered = layout.ranges.reduce((n, r) => n + r.vertexCount, 0);
    expect(covered).toBe(4 * 16383);
  });

  it("reports nothing for an empty tile", () => {
    const layout = layOut([
      ["point", 0, []],
      ["line", 1, [[[5, 5]]]],
      ["polygon", 2, [[[10, 10]]]],
    ]);
    expect([layout.slotCount, layout.quads, layout.ranges]).toEqual([0, 0, []]);
    expect(digest(layout.vertices)).toBe(0x811c9dc5);
  });
});
