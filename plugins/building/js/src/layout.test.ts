// Runs every case in ../../fixtures/layout through the same checks as the
// Zig twin's tests (../../native/src/layout_test.zig), then checks the
// geometric invariants the shaders rely on and the semantics of each roof
// shape.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import {
  close,
  expectedOutput,
  type Fixture,
  type FixtureFeature,
  layOut,
  triangles,
} from "./fixture.ts";
import { isClipEdge, NO_CUTS } from "./footprint.ts";
import {
  BuildingLayout,
  type LayoutValues,
  MAX_SEGMENT_VERTICES,
  type Point,
  ROOF,
  ROOF_UNDERSIDE,
  type TileBounds,
  tileBounds,
  type Vertex,
  WALL_BOTTOM,
  WALL_TOP,
} from "./layout.ts";
import { ROOF_SHAPES } from "./spec.ts";

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "layout",
);

const fixtures = readdirSync(fixturesDir)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => ({
    name,
    fixture: JSON.parse(
      readFileSync(join(fixturesDir, name), "utf8"),
    ) as Fixture,
  }));

/** Shapes drawn with smooth gradients, exempt from the planar check. */
const SMOOTH = new Set(["round", "round_gabled", "cone", "dome", "onion"]);

function expectClose(actual: number, expected: number, what: string): void {
  if (!close(actual, expected))
    expect.fail(`${what}: ${actual} is not close to ${expected}`);
}

const toRings = (points: [number, number][][]): Point[][] =>
  points.map((ring) => ring.map(([x, y]) => ({ x, y })));

/** Lays out one feature as a tile of its own, unless bounds are given. */
function lay(
  points: [number, number][][],
  values: LayoutValues,
  bounds: TileBounds = tileBounds([toRings(points)]),
): BuildingLayout {
  const layout = new BuildingLayout(8192, bounds);
  layout.addFeature(toRings(points), 0, values);
  return layout;
}

function allVertices(layout: BuildingLayout): Vertex[] {
  return Array.from({ length: layout.vertexCount }, (_, i) => layout.vertex(i));
}

const isWall = (v: Vertex): boolean =>
  v.kind === WALL_BOTTOM || v.kind === WALL_TOP;

/** Checks that hold for every layout, whatever its input. */
function checkInvariants(
  layout: BuildingLayout,
  shapeOf: (featureIndex: number) => string,
): void {
  const vertices = allVertices(layout);
  const indices = layout.indices();

  // Segments tile the buffers and stay within 16-bit indices.
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const segment of layout.segments) {
    expect(segment.vertexOffset).toBe(vertexOffset);
    expect(segment.indexOffset).toBe(indexOffset);
    expect(segment.vertexLength).toBeLessThanOrEqual(MAX_SEGMENT_VERTICES);
    expect(segment.indexLength % 3).toBe(0);
    for (let i = 0; i < segment.indexLength; i++)
      expect(indices[segment.indexOffset + i]!).toBeLessThan(
        segment.vertexLength,
      );
    vertexOffset += segment.vertexLength;
    indexOffset += segment.indexLength;
  }
  expect(vertexOffset).toBe(layout.vertexCount);
  expect(indexOffset).toBe(layout.indexCount);

  // Ranges cover every vertex once, in order.
  let next = 0;
  for (const range of layout.ranges) {
    expect(range.firstVertex).toBe(next);
    expect(range.vertexCount).toBeGreaterThan(0);
    next += range.vertexCount;
  }
  expect(next).toBe(layout.vertexCount);

  for (const v of vertices) {
    expect([WALL_BOTTOM, WALL_TOP, ROOF, ROOF_UNDERSIDE]).toContain(v.kind);
    expect(v.n).toBeGreaterThanOrEqual(0);
    expect(v.n).toBeLessThanOrEqual(1);
    if (v.kind === WALL_BOTTOM) expect(v.n).toBe(0);
    if (isWall(v)) expectClose(Math.hypot(v.gx, v.gy), 1, "wall normal length");
  }

  const featureOf = (vertex: number): number => {
    for (const range of layout.ranges)
      if (vertex < range.firstVertex + range.vertexCount)
        return range.featureIndex;
    return -1;
  };

  // Edges keyed by position and n, for the closed-surface check.
  // Coarse keys: facets meeting at one point may compute it a few ulps apart.
  const key = (v: Vertex): string =>
    `${Math.round(v.x * 100)},${Math.round(v.y * 100)},${Math.round(v.n * 1e4)}`;
  const edges = new Map<string, number>();
  const edgeEnds = new Map<string, [Vertex, Vertex]>();
  const addEdge = (a: Vertex, b: Vertex): void => {
    if (key(a) === key(b)) return;
    const forward = `${key(a)}>${key(b)}`;
    const backward = `${key(b)}>${key(a)}`;
    const reverse = edges.get(backward) ?? 0;
    if (reverse > 0) edges.set(backward, reverse - 1);
    else {
      edges.set(forward, (edges.get(forward) ?? 0) + 1);
      edgeEnds.set(forward, [a, b]);
    }
  };

  for (const tri of triangles(layout)) {
    const [a, b, c] = tri.map((i) => vertices[i]!) as [Vertex, Vertex, Vertex];
    const shape = shapeOf(featureOf(tri[0]!));
    if (isWall(a)) {
      expect(isWall(b) && isWall(c)).toBe(true);
      expect([a.gx, a.gy]).toEqual([b.gx, b.gy]);
      // Core's winding: cross(b - a, c - a) against the outward normal.
      const z = (v: Vertex): number => (v.kind === WALL_BOTTOM ? 0 : 1 + v.n);
      const u = [b.x - a.x, b.y - a.y, z(b) - z(a)];
      const w = [c.x - a.x, c.y - a.y, z(c) - z(a)];
      const nx = u[1]! * w[2]! - u[2]! * w[1]!;
      const ny = u[2]! * w[0]! - u[0]! * w[2]!;
      const nz = u[0]! * w[1]! - u[1]! * w[0]!;
      expect(Math.abs(nz)).toBeLessThan(1e-3 * Math.hypot(nx, ny));
      expect(nx * a.gx + ny * a.gy).toBeLessThan(0);
      // Only the top edge joins the roof.
      const tops = [a, b, c].filter((v) => v.kind === WALL_TOP);
      if (tops.length === 2) {
        const i = [a, b, c].findIndex((v) => v.kind !== WALL_TOP);
        const [p, q] = [
          [b, c],
          [c, a],
          [a, b],
        ][i]! as [Vertex, Vertex];
        addEdge(p, q);
      }
      continue;
    }
    expect(a.kind === b.kind && b.kind === c.kind).toBe(true);
    const area2 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    // As in fuzz.ts, tile-position float32 rounding can flip a sub-ulp sliver.
    const longest = Math.max(
      Math.hypot(b.x - a.x, b.y - a.y),
      Math.hypot(c.x - b.x, c.y - b.y),
      Math.hypot(a.x - c.x, a.y - c.y),
    );
    const sliver = Math.abs(area2) <= 2 ** -9 * longest;
    if (a.kind === ROOF) expect(area2 < 0 || sliver).toBe(true);
    else expect(area2).toBeGreaterThan(0);
    if (!SMOOTH.has(shape)) {
      // Planar: one gradient per triangle, and n follows it.
      expect([a.gx, a.gy]).toEqual([b.gx, b.gy]);
      expect([a.gx, a.gy]).toEqual([c.gx, c.gy]);
      for (const v of [b, c]) {
        const predicted = a.n + a.gx * (v.x - a.x) + a.gy * (v.y - a.y);
        // Match fuzz.ts: steep faces amplify float32 tile-position rounding.
        expect(Math.abs(predicted - v.n)).toBeLessThan(
          2e-4 + 2e-3 * Math.hypot(a.gx, a.gy),
        );
      }
    }
    addEdge(a, b);
    addEdge(b, c);
    addEdge(c, a);
  }

  // Closed surface: every roof edge meets another roof edge or a wall top
  // running the other way, except along tile cuts, which have no walls.
  for (const [edge, count] of edges) {
    if (count === 0) continue;
    const [a, b] = edgeEnds.get(edge)!;
    const onCut = isClipEdge(a, b, layout.extent, layout.bounds);
    if (!onCut || isWall(a))
      expect.fail(
        `open edge (${a.x}, ${a.y}, n ${a.n}, kind ${a.kind}) → (${b.x}, ${b.y}, n ${b.n})`,
      );
  }
}

describe("layout fixtures", () => {
  it("finds the fixtures", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const { name, fixture } of fixtures) {
    it(`matches ${name}`, () => {
      const layout = layOut(fixture.extent, fixture.features);
      const actual = expectedOutput(
        layout,
        fixture.expected.positions !== undefined,
      );
      const expected = fixture.expected;
      expect(actual.vertex_count).toBe(expected.vertex_count);
      expect(actual.index_count).toBe(expected.index_count);
      expect(actual.segments).toEqual(expected.segments);
      expect(actual.ranges).toEqual(expected.ranges);
      expect(actual.summaries).toHaveLength(expected.summaries.length);
      actual.summaries.forEach((s, i) => {
        const e = expected.summaries[i]!;
        const what = `${name} feature ${actual.ranges[i]![0]}`;
        expect(s.vertices, what).toBe(e.vertices);
        expect(s.triangles, what).toBe(e.triangles);
        s.sum_pos.forEach((v, c) =>
          expectClose(v, e.sum_pos[c]!, `${what} sum_pos[${c}]`),
        );
        s.sum_roof.forEach((v, c) =>
          expectClose(v, e.sum_roof[c]!, `${what} sum_roof[${c}]`),
        );
        expectClose(s.weighted, e.weighted, `${what} weighted`);
        expect(s.moment, what).toBe(e.moment);
      });
      if (expected.positions) {
        expect(actual.indices).toEqual(expected.indices);
        actual.positions!.forEach((p, i) =>
          p.forEach((v, c) =>
            expectClose(v, expected.positions![i]![c]!, `position ${i}`),
          ),
        );
        actual.roofs!.forEach((p, i) =>
          p.forEach((v, c) =>
            expectClose(v, expected.roofs![i]![c]!, `roof ${i}`),
          ),
        );
      }
    });

    it(`keeps the invariants on ${name}`, () => {
      const layout = layOut(fixture.extent, fixture.features);
      const shapes = new Map<number, string>();
      for (const f of fixture.features as FixtureFeature[])
        for (let k = 0; k < (f.repeat ?? 1); k++)
          shapes.set(f.index + k, f.shape);
      checkInvariants(layout, (i) => shapes.get(i) ?? "flat");
    });
  }
});

// A 300 × 160 rectangle centered on (1150, 1080): b = 80, a = 150.
const rectangle: [number, number][] = [
  [1000, 1000],
  [1300, 1000],
  [1300, 1160],
  [1000, 1160],
];

const roofOf = (layout: BuildingLayout): Vertex[] =>
  allVertices(layout).filter((v) => v.kind >= ROOF);
const wallTopsOf = (layout: BuildingLayout): Vertex[] =>
  allVertices(layout).filter((v) => v.kind === WALL_TOP);

describe("roof shapes", () => {
  it("runs a gabled ridge along the longer side, or across", () => {
    const along = roofOf(lay([rectangle], { shape: "gabled" }));
    const ridge = along.filter((v) => v.n === 1);
    expect(ridge.length).toBeGreaterThan(0);
    for (const v of ridge) expect(v.y).toBe(1080);
    for (const v of along) expect(Math.abs(v.gy)).toBeCloseTo(1 / 80, 7);
    expect(along[0]!.run).toBe(80);

    const across = roofOf(
      lay([rectangle], { shape: "gabled", orientation: "across" }),
    );
    for (const v of across.filter((v) => v.n === 1)) expect(v.x).toBe(1150);
    expect(across[0]!.run).toBe(150);
  });

  it("raises the gable end walls to the ridge", () => {
    const tops = wallTopsOf(lay([rectangle], { shape: "gabled" }));
    expect(tops.filter((v) => v.n === 1).map((v) => [v.x, v.y])).toEqual([
      [1300, 1080],
      [1000, 1080],
    ]);
  });

  it("turns the frame toward a set direction", () => {
    // 30° is nearer north than east: the ridge runs east-west.
    const north = roofOf(lay([rectangle], { shape: "gabled", direction: 30 }));
    for (const v of north.filter((v) => v.n === 1)) expect(v.y).toBe(1080);
    // 60° is nearer east: the ridge runs north-south, whatever orientation says.
    const east = roofOf(
      lay([rectangle], {
        shape: "gabled",
        direction: 60,
        orientation: "along",
      }),
    );
    for (const v of east.filter((v) => v.n === 1)) expect(v.x).toBe(1150);
  });

  it("slopes a skillion exactly down its direction", () => {
    const degrees = 200;
    const r = (degrees * Math.PI) / 180;
    const d = { x: Math.sin(r), y: -Math.cos(r) };
    const roof = roofOf(
      lay([rectangle], { shape: "skillion", direction: degrees }),
    );
    for (const v of roof) {
      const length = Math.hypot(v.gx, v.gy);
      expect(-v.gx / length).toBeCloseTo(d.x, 6);
      expect(-v.gy / length).toBeCloseTo(d.y, 6);
    }
    const ns = roof.map((v) => v.n);
    expect(Math.min(...ns)).toBeCloseTo(0, 12);
    expect(Math.max(...ns)).toBe(1);
    // Without a direction it falls toward +v, south for this ridge.
    for (const v of roofOf(lay([rectangle], { shape: "skillion" })))
      expect(v.gy).toBeLessThan(0);
  });

  it("turns a saltbox's long face toward its direction", () => {
    // Facing north: front eaves on y = 1000, ridge 0.7 × 160 behind them,
    // back eaves at n = 4/7.
    const layout = lay([rectangle], { shape: "saltbox", direction: 0 });
    const roof = roofOf(layout);
    for (const v of roof.filter((v) => v.n === 1))
      expect(v.y).toBeCloseTo(1112, 3);
    for (const v of roof.filter((v) => v.y === 1000))
      expect(v.n).toBeCloseTo(0, 12);
    for (const v of roof.filter((v) => v.y === 1160))
      expect(v.n).toBeCloseTo(4 / 7, 6);
    expect(roof[0]!.run).toBeCloseTo(112, 4);
  });

  it("gives a hipped roof equal slopes", () => {
    for (const v of roofOf(lay([rectangle], { shape: "hipped" })))
      expect(Math.hypot(v.gx, v.gy)).toBeCloseTo(1 / 80, 7);
    // On a square the hips meet in a point.
    const square = roofOf(
      lay(
        [
          [
            [0, 0],
            [200, 0],
            [200, 200],
            [0, 200],
          ],
        ],
        { shape: "hipped" },
      ),
    );
    expect(
      square.filter((v) => v.n === 1).every((v) => v.x === 100 && v.y === 100),
    ).toBe(true);
  });

  it("cuts a half-hipped roof's hips at 2/3 of the end wall", () => {
    const tops = wallTopsOf(lay([rectangle], { shape: "half-hipped" }));
    const east = tops.filter((v) => v.x === 1300).map((v) => [v.y, v.n]);
    // b / 3 = 26.67 either side of the ridge line.
    for (const [y, n] of east) {
      if (Math.abs(y! - 1080) <= 80 / 3 + 1e-3) expect(n).toBeCloseTo(2 / 3, 5);
    }
    expect(east.some(([, n]) => Math.abs(n! - 2 / 3) < 1e-6)).toBe(true);
  });

  it("sizes half hips from each L arm's width", () => {
    const tops = wallTopsOf(
      lay(
        [
          [
            [1000, 1000],
            [1300, 1000],
            [1300, 1120],
            [1160, 1120],
            [1160, 1300],
            [1000, 1300],
          ],
        ],
        { shape: "half-hipped" },
      ),
    );
    // Widths 120 and 160: local wall stops at 40 and 160/3, not one global time.
    expect(
      Math.max(...tops.filter((v) => v.x === 1300).map((v) => v.n * v.run)),
    ).toBeCloseTo(40, 4);
    expect(
      Math.max(...tops.filter((v) => v.y === 1300).map((v) => v.n * v.run)),
    ).toBeCloseTo(160 / 3, 4);
  });

  it("weights saltbox T arms by direction and keeps their height continuous", () => {
    const rings: [number, number][][] = [
      [
        [1000, 1000],
        [1400, 1000],
        [1400, 1120],
        [1260, 1120],
        [1260, 1320],
        [1140, 1320],
        [1140, 1120],
        [1000, 1120],
      ],
    ];
    for (const direction of [0, 180]) {
      const layout = lay(rings, { shape: "saltbox", direction });
      const roof = roofOf(layout);
      const tops = wallTopsOf(layout).filter((v) => v.n === 1);
      expect(
        tops.filter((v) => v.x === 1000 || v.x === 1400).map((v) => v.y),
      ).toEqual([direction === 0 ? 1084 : 1036, direction === 0 ? 1084 : 1036]);
      expect(tops.find((v) => v.y === 1320)?.x).toBe(1200);
      for (const v of roof) {
        const speed =
          v.gy === 0 ? 1 : v.gy > 0 === (direction === 0) ? 1.4 : 0.6;
        expect(Math.hypot(v.gx, v.gy) * v.run * speed).toBeCloseTo(1, 6);
      }
    }
  });

  it("breaks gambrel and mansard faces at n = 2/3, b/3 in from the eaves", () => {
    // Gambrel's gable walls show the break; mansard's walls are all eaves.
    for (const shape of ["gambrel", "mansard"]) {
      const tops = wallTopsOf(lay([rectangle], { shape }));
      const breaks = (
        shape === "gambrel" ? tops : roofOf(lay([rectangle], { shape }))
      ).filter((v) => Math.abs(v.n - 2 / 3) < 1e-6);
      expect(breaks.length, shape).toBeGreaterThan(0);
      if (shape === "gambrel")
        for (const v of breaks)
          expect(Math.abs(v.y - 1080)).toBeCloseTo(160 / 3, 3);
    }
  });

  it("tops the saltbox variants with a flat roof", () => {
    for (const shape of ["double_saltbox", "quadruple_saltbox"]) {
      const roof = roofOf(lay([rectangle], { shape }));
      const top = roof.filter((v) => v.gx === 0 && v.gy === 0);
      expect(top.length, shape).toBeGreaterThan(0);
      for (const v of top) expect(v.n).toBe(1);
      // The faces rise over 0.3 b.
      for (const v of roof.filter((v) => v.gx !== 0 || v.gy !== 0))
        expect(Math.hypot(v.gx, v.gy)).toBeCloseTo(1 / 24, 6);
    }
  });

  it("vaults a round roof over a semicircle", () => {
    const tops = wallTopsOf(lay([rectangle], { shape: "round" }));
    const east = tops.filter((v) => v.gx === 1);
    expect(east).toHaveLength(13);
    for (const v of east) {
      const s = (v.y - 1080) / 80;
      expect(v.n).toBeCloseTo(Math.sqrt(Math.max(0, 1 - s * s)), 5);
    }
  });

  it("gives round_gabled a crisp ridge between two smooth sides", () => {
    const roof = roofOf(lay([rectangle], { shape: "round_gabled" }));
    const ridge = roof.filter((v) => v.n === 1);
    expect(ridge.some((v) => v.gy > 0)).toBe(true);
    expect(ridge.some((v) => v.gy < 0)).toBe(true);
    for (const v of ridge) expect(v.y).toBe(1080);
  });

  it("builds radial roofs toward the center", () => {
    const pyramid = roofOf(lay([rectangle], { shape: "pyramidal" }));
    for (const v of pyramid.filter((v) => v.n === 1))
      expect([v.x, v.y]).toEqual([1150, 1080]);
    // A pointed cone gets one apex per face; a dome shares a flat apex.
    const circle: [number, number][] = Array.from({ length: 16 }, (_, i) => [
      Math.round(3000 + 150 * Math.cos((2 * Math.PI * i) / 16)),
      Math.round(3000 + 150 * Math.sin((2 * Math.PI * i) / 16)),
    ]);
    const cone = roofOf(lay([circle], { shape: "cone" }));
    expect(cone.filter((v) => v.n === 1)).toHaveLength(16);
    const dome = roofOf(lay([circle], { shape: "dome" }));
    const apex = dome.filter((v) => v.n === 1);
    expect(apex).toHaveLength(1);
    expect([apex[0]!.gx, apex[0]!.gy]).toEqual([0, 0]);
    // The onion's bulge overhangs its neck.
    const onion = roofOf(lay([circle], { shape: "onion" }));
    expect(onion.some((v) => v.kind === ROOF_UNDERSIDE)).toBe(true);
  });

  it("places circular roofs above a terrace without covering the courtyard", () => {
    const hole: [number, number][] = [
      [1100, 1050],
      [1100, 1100],
      [1200, 1100],
      [1200, 1050],
    ];
    for (const shape of ["cone", "dome", "onion"]) {
      for (const rings of [[rectangle], [rectangle, hole]]) {
        const result = lay(rings, { shape });
        const roof = roofOf(result);
        expect(Math.max(...roof.map((v) => v.n))).toBe(1);
        expect(roof[0]!.run).toBeGreaterThan(0);
        expect(roof.some((v) => v.n === 0 && v.gx === 0 && v.gy === 0)).toBe(
          true,
        );
        for (const v of wallTopsOf(result)) expect(v.n).toBe(0);
        let area = 0;
        for (const ids of triangles(result)) {
          const [a, b, c] = ids.map((i) => result.vertex(i)) as [
            Vertex,
            Vertex,
            Vertex,
          ];
          if (a.kind < ROOF) continue;
          area -= ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
          for (const v of [a, b, c]) {
            expect(
              v.x >= 1000 && v.x <= 1300 && v.y >= 1000 && v.y <= 1160,
            ).toBe(true);
            if (rings.length > 1)
              expect(v.x > 1100 && v.x < 1200 && v.y > 1050 && v.y < 1100).toBe(
                false,
              );
          }
        }
        expect(area).toBeCloseTo(
          300 * 160 - (rings.length > 1 ? 100 * 50 : 0),
          1,
        );
      }
    }
  });

  it("falls back to flat roofs", () => {
    const lShape: [number, number][] = [
      [1000, 1000],
      [1160, 1000],
      [1160, 1140],
      [1360, 1140],
      [1360, 1300],
      [1000, 1300],
    ];
    const flat = (layout: BuildingLayout): void => {
      const roof = roofOf(layout);
      expect(roof.length).toBeGreaterThan(0);
      for (const v of roof)
        expect([v.n, v.gx, v.gy, v.run]).toEqual([1, 0, 0, 0]);
      for (const v of wallTopsOf(layout)) expect(v.n).toBe(1);
    };
    flat(lay([lShape], { shape: "pyramidal" }));
    flat(lay([rectangle], { shape: "many" }));
    flat(lay([rectangle], { shape: "lean_to" }));
    flat(
      lay(
        [
          rectangle,
          [
            [1100, 1050],
            [1100, 1100],
            [1200, 1100],
            [1200, 1050],
          ],
        ],
        { shape: "pyramidal" },
      ),
    );
  });

  it("faces courtyard walls into the courtyard", () => {
    const layout = lay(
      [
        rectangle,
        [
          [1100, 1050],
          [1100, 1100],
          [1200, 1100],
          [1200, 1050],
        ],
      ],
      { shape: "flat" },
    );
    const inner = allVertices(layout).filter(
      (v) =>
        isWall(v) && v.x >= 1100 && v.x <= 1200 && v.y >= 1050 && v.y <= 1100,
    );
    expect(inner).toHaveLength(16);
    for (const v of inner) {
      // Toward the courtyard's center (1150, 1075).
      expect(v.gx * (1150 - v.x) + v.gy * (1075 - v.y)).toBeGreaterThan(0);
    }
  });

  it("merges near-coincident wall stops on thin stationary gables", () => {
    const ring: [number, number][] = [
      [1165, 4413],
      [1239, 4730],
      [1230, 4732],
      [1195, 4583],
      [962, 4637],
      [960, 4628],
      [1193, 4574],
      [1156, 4415],
    ];
    for (const shape of ["gabled", "gambrel"]) {
      const layout = lay([ring], { shape });
      for (const ids of triangles(layout)) {
        const [a, b, c] = ids.map((i) => layout.vertex(i)) as [
          Vertex,
          Vertex,
          Vertex,
        ];
        if (!isWall(a)) continue;
        const z = (v: Vertex): number => (v.kind === WALL_BOTTOM ? 0 : 1 + v.n);
        const nx = (b.y - a.y) * (z(c) - z(a)) - (z(b) - z(a)) * (c.y - a.y);
        const ny = (z(b) - z(a)) * (c.x - a.x) - (b.x - a.x) * (z(c) - z(a));
        expect(nx * a.gx + ny * a.gy).toBeLessThan(0);
      }
    }
  });

  it("draws a cut copy roofless, without walls on its cuts", () => {
    // A tile whose features reach x = -128, where the source cut this one.
    const cut: [number, number][] = [
      [-128, 2000],
      [200, 2000],
      [200, 2200],
      [-128, 2200],
    ];
    const layout = lay([cut], { shape: "gabled" });
    const walls = allVertices(layout).filter(isWall);
    expect(walls.some((v) => v.x === -128 && v.gx === -1)).toBe(false);
    expect(walls).toHaveLength(12);
    // Walls to the eaves and a lid there, with the piece's own run (half
    // its 200 short side) for building-roof-angle.
    for (const v of walls) expect(v.n).toBe(0);
    const lid = roofOf(layout);
    expect(lid.length).toBeGreaterThan(0);
    for (const v of lid)
      expect([v.n, v.kind, v.gx, v.gy, v.run]).toEqual([0, ROOF, 0, 0, 100]);
    // Flat shapes and pyramidal courtyards stay flat.
    for (const rings of [
      [cut],
      [
        cut,
        [
          [0, 2050],
          [0, 2150],
          [100, 2150],
          [100, 2050],
        ],
      ] as [number, number][][],
    ]) {
      if (rings.length > 1) {
        for (const v of allVertices(lay(rings, { shape: "dome" })))
          expect(v.n).toBe(0);
      }
      const shape = rings.length === 1 ? "flat" : "pyramidal";
      for (const v of allVertices(lay(rings, { shape })).filter(
        (v) => v.kind !== WALL_BOTTOM,
      ))
        expect([v.n, v.run]).toEqual([1, 0]);
    }
  });

  it("gives buffer and crossing copies their whole roof", () => {
    // The tile's features reach x = 8320, beyond these footprints' walls.
    const bounds = { minX: 0, minY: 0, maxX: 8320, maxY: 8192 };
    for (const x of [8100, 8200]) {
      const layout = lay(
        [
          [
            [x, 3000],
            [x + 200, 3000],
            [x + 200, 3160],
            [x, 3160],
          ],
        ],
        { shape: "gabled" },
        bounds,
      );
      const roof = roofOf(layout);
      expect(Math.max(...roof.map((v) => v.n))).toBe(1);
      for (const v of roof) expect(v.run).toBe(80);
      // The east gable wall rises to the ridge.
      const east = wallTopsOf(layout).filter((v) => v.gx === 1);
      expect(east.map((v) => v.n)).toContain(1);
    }
    // An axis-aligned wall on the tile's own bounds, outside it, is taken
    // for a cut: alone in its tile, this copy draws roofless.
    const alone = lay(
      [
        [
          [8200, 3000],
          [8300, 3000],
          [8300, 3160],
          [8200, 3160],
        ],
      ],
      { shape: "gabled" },
    );
    for (const v of roofOf(alone)) expect(v.n).toBe(0);
  });

  it("builds the same roof for every copy of a footprint", () => {
    // Copies of one footprint in the neighboring tiles' buffers: moved by
    // ±extent, each must build the same geometry, moved.
    const turned = [
      [3000, 3000],
      [3260, 3150],
      [3180, 3289],
      [2920, 3139],
    ] as [number, number][];
    const lShape = [
      [5000, 1000],
      [5160, 1000],
      [5160, 1140],
      [5360, 1140],
      [5360, 1300],
      [5000, 1300],
    ] as [number, number][];
    const circle = Array.from({ length: 16 }, (_, i) => [
      Math.round(6000 + 150 * Math.cos((2 * Math.PI * i) / 16)),
      Math.round(6000 + 150 * Math.sin((2 * Math.PI * i) / 16)),
    ]) as [number, number][];
    const values: LayoutValues[] = [
      ...ROOF_SHAPES.map((shape) => ({ shape })),
      ...ROOF_SHAPES.map((shape) => ({ shape, orientation: "across" })),
      { shape: "skillion", direction: 200 },
      { shape: "saltbox", direction: 135 },
      { shape: "gabled", direction: 30 },
    ];
    const offsets = [
      [8192, 0],
      [-8192, 0],
      [0, 8192],
      [0, -8192],
      [8192, -8192],
      [-8192, 8192],
    ];
    // Whole copies: the tile's other features reach its buffer's edges.
    const none = tileBounds([]);
    let compared = 0;
    for (const rings of [
      [rectangle],
      [turned],
      [lShape],
      [circle],
      [
        rectangle,
        [
          [1100, 1050],
          [1100, 1100],
          [1200, 1100],
          [1200, 1050],
        ],
      ],
    ] as [number, number][][][]) {
      for (const v of values) {
        const base = lay(rings, v, none);
        for (const [dx, dy] of offsets) {
          const moved = lay(
            rings.map((ring) =>
              ring.map(([x, y]) => [x + dx!, y + dy!] as [number, number]),
            ),
            v,
            none,
          );
          expect(moved.vertexCount).toBe(base.vertexCount);
          expect(moved.segments).toEqual(base.segments);
          expect(Array.from(moved.indices())).toEqual(
            Array.from(base.indices()),
          );
          for (let i = 0; i < base.vertexCount; i++) {
            const a = base.exactVertex(i);
            const b = moved.exactVertex(i);
            expect(Math.abs(b.x - dx! - a.x)).toBeLessThanOrEqual(1e-9);
            expect(Math.abs(b.y - dy! - a.y)).toBeLessThanOrEqual(1e-9);
            expect([b.run, b.n, b.kind, b.gx, b.gy]).toEqual([
              a.run,
              a.n,
              a.kind,
              a.gx,
              a.gy,
            ]);
            compared++;
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(10000);
  });

  it("starts a new segment before 65536 vertices", () => {
    const circle: Point[] = Array.from({ length: 32 }, (_, i) => ({
      x: Math.round(4000 + 300 * Math.cos((2 * Math.PI * i) / 32)),
      y: Math.round(4000 + 300 * Math.sin((2 * Math.PI * i) / 32)),
    }));
    const layout = new BuildingLayout(8192);
    for (let i = 0; i < 200; i++)
      layout.addFeature([circle], i, { shape: "round" });
    expect(layout.vertexCount).toBeGreaterThan(MAX_SEGMENT_VERTICES);
    expect(layout.segments.length).toBeGreaterThan(1);
    checkInvariants(layout, () => "round");
  });
});

describe("explicit roof graphs", () => {
  it("recovers the cycling constraint, partitions components, and rejects numeric strings", () => {
    const regression = fixtures.find(
      (f) => f.name === "roof-lines-regressions.json",
    )!.fixture;
    for (const f of regression.features) {
      const mesh = layOut(regression.extent, [f]);
      const runs = [...new Set(allVertices(mesh).map((v) => v.run))].sort(
        (a, b) => a - b,
      );
      if (f.label === "constraint recovery cycle") expect(runs).toEqual([500]);
      else if (
        f.label === "multipolygon apexes" ||
        f.label === "numeric exponent edge"
      )
        expect(runs).toEqual([150]);
      else if (f.label === "cross component edge") {
        expect(runs).toEqual([0, 150]);
        for (const v of allVertices(mesh))
          expect(v.run).toBe(v.x >= 2000 ? 150 : 0);
      } else expect(runs).toEqual([0]);
    }
  });
  it("recovers a segment at the 192-point mesh limit", () => {
    const dense = fixtures.find(
      (f) => f.name === "roof-lines-dense.json",
    )!.fixture;
    const mesh = layOut(dense.extent, dense.features);
    expect(allVertices(mesh).every((v) => v.run === 500)).toBe(true);
  });
  const fixture = fixtures.find((f) => f.name === "roof-lines.json")!.fixture;
  it("keeps gable peaks, mapped apex heights and the same graph in adjacent tiles", () => {
    for (let start = 0; start < 12; start += 3) {
      const layouts = fixture.features.slice(start, start + 3).map((f) => {
        const layout = new BuildingLayout(fixture.extent, NO_CUTS, f.tile);
        layout.addFeature(toRings(f.rings), 0, {
          shape: f.shape,
          lines: f.lines,
        });
        return layout;
      });
      const [base, ...copies] = layouts;
      expect(base!.vertex(0).run).toBeGreaterThan(0);
      for (const [i, copy] of copies.entries()) {
        const dx = (i === 0 ? 1 : -1) * fixture.extent;
        expect(copy.indices()).toEqual(base!.indices());
        for (let v = 0; v < base!.vertexCount; v++) {
          const a = base!.exactVertex(v),
            b = copy.exactVertex(v);
          expect({ ...b, x: b.x - dx }).toEqual(a);
        }
      }
    }
    const apex = layOut(fixture.extent, [fixture.features[6]!]);
    expect(Math.max(...allVertices(apex).map((v) => v.n))).toBe(0.75);
    const gable = layOut(fixture.extent, [fixture.features[3]!]);
    expect(
      allVertices(gable).some((v) => v.kind === WALL_TOP && v.n === 1),
    ).toBe(true);
    expect(allVertices(gable).every((v) => v.run === 80)).toBe(true);
  });
});
