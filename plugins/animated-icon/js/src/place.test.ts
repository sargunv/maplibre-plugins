// Mirrors the placement tests in ../../native/src/place.zig: both twins run
// every case in ../../fixtures/place through the same checks, so hit
// testing cannot drift apart between the two implementations.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import {
  corners,
  entryRadius,
  hitPoint,
  hitPolygon,
  project,
  type Quad,
  type Resolved,
  type Vec2,
  type View,
} from "./place.ts";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixturesDir = join(pluginRoot, "fixtures", "place");
const spec = JSON.parse(
  readFileSync(join(pluginRoot, "spec.json"), "utf8"),
) as {
  paint: Record<string, { values?: unknown }>;
};

interface Fixture {
  description: string;
  view: {
    matrix: number[];
    viewport: [number, number];
    pixel_ratio: number;
    camera_to_center_distance: number;
    pixels_to_tile_units: number;
    bearing: number;
  };
  entries: {
    name: string;
    box: [number, number, number, number];
    display_px: number;
  }[];
  cases: {
    anchor: [number, number];
    /** Enum values by name, as the host passes them to query_feature. */
    properties: Record<string, unknown>;
    corners: [Vec2, Vec2, Vec2, Vec2] | null;
    hits: Vec2[];
    misses: Vec2[];
    ring_hits: Vec2[][];
    ring_misses: Vec2[][];
  }[];
}

const fixtures = readdirSync(fixturesDir)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map(
    (name) =>
      [
        name,
        JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as Fixture,
      ] as const,
  );

function enumIndex(property: string, value: unknown): number {
  const values = spec.paint[property]?.values as string[];
  return values.indexOf(value as string);
}

function resolve(
  fixture: Fixture,
  properties: Record<string, unknown>,
): Resolved {
  // Unknown names draw as none, as the host's enum fallback does.
  const animation =
    fixture.entries.findIndex((e) => e.name === properties["icon-animation"]) +
    1;
  return {
    animation,
    size: properties["icon-size"] as number,
    rotate: properties["icon-rotate"] as number,
    opacity: properties["icon-opacity"] as number,
    offset: properties["icon-offset"] as Vec2,
    anchor: enumIndex("icon-anchor", properties["icon-anchor"]),
    rotationAlignment: enumIndex(
      "icon-rotation-alignment",
      properties["icon-rotation-alignment"],
    ),
    pitchAlignment: enumIndex(
      "icon-pitch-alignment",
      properties["icon-pitch-alignment"],
    ),
  };
}

function view(fixture: Fixture): View {
  const v = fixture.view;
  return {
    matrix: v.matrix,
    viewport: v.viewport,
    pixelRatio: v.pixel_ratio,
    cameraToCenterDistance: v.camera_to_center_distance,
    pixelsToTileUnits: v.pixels_to_tile_units,
    bearing: v.bearing,
  };
}

function expectClose(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(
    1e-6 * Math.max(1, Math.abs(expected)),
  );
}

describe("placement fixtures", () => {
  it("cover the cases the contract lists", () => {
    const cases = fixtures.flatMap(([, f]) => f.cases);
    expect(fixtures.length).toBeGreaterThanOrEqual(8);
    expect(cases.some((c) => c.corners === null)).toBe(true);
    for (const anchor of spec.paint["icon-anchor"]!.values as string[]) {
      expect(cases.some((c) => c.properties["icon-anchor"] === anchor)).toBe(
        true,
      );
    }
  });

  for (const [name, fixture] of fixtures) {
    describe(name, () => {
      fixture.cases.forEach((c, i) => {
        it(`case ${i}`, () => {
          const resolved = resolve(fixture, c.properties);
          const entry = fixture.entries[Math.max(resolved.animation - 1, 0)]!;
          const quad = corners(
            c.anchor,
            resolved,
            { box: entry.box, displayPx: entry.display_px },
            view(fixture),
          );
          if (c.corners === null) {
            expect(quad).toBeNull();
          } else {
            expect(quad).not.toBeNull();
            c.corners.forEach((corner, k) => {
              expectClose(quad![k]![0], corner[0]);
              expectClose(quad![k]![1], corner[1]);
            });
          }
          const expected = c.corners as Quad | null;
          if (expected !== null) {
            for (const p of c.hits) expect(hitPoint(expected, p)).toBe(true);
            for (const p of c.misses) expect(hitPoint(expected, p)).toBe(false);
            for (const ring of c.ring_hits) {
              expect(hitPolygon(expected, ring)).toBe(true);
            }
            for (const ring of c.ring_misses) {
              expect(hitPolygon(expected, ring)).toBe(false);
            }
          } else {
            expect(c.hits).toEqual([]);
          }
        });
      });
    });
  }
});

describe("hit tests", () => {
  const square: Quad = [
    [0, 0],
    [10, 0],
    [0, 10],
    [10, 10],
  ];

  it("count points on the edge as hits", () => {
    expect(hitPoint(square, [5, 5])).toBe(true);
    expect(hitPoint(square, [10, 5])).toBe(true);
    expect(hitPoint(square, [10.01, 5])).toBe(false);
  });

  it("overlap polygons, a lone point and a segment", () => {
    expect(hitPolygon(square, [[5, 5]])).toBe(true);
    expect(hitPolygon(square, [[15, 5]])).toBe(false);
    expect(
      hitPolygon(square, [
        [-5, 5],
        [15, 5],
      ]),
    ).toBe(true);
    // A box around the square, a box inside it and one beside it.
    const around: Vec2[] = [
      [-1, -1],
      [11, -1],
      [11, 11],
      [-1, 11],
    ];
    expect(hitPolygon(square, around)).toBe(true);
    expect(
      hitPolygon(square, [
        [2, 2],
        [3, 2],
        [3, 3],
        [2, 2],
      ]),
    ).toBe(true);
    expect(
      hitPolygon(square, [
        [11, 0],
        [12, 0],
        [12, 1],
      ]),
    ).toBe(false);
    expect(hitPolygon(square, [])).toBe(false);
  });

  it("separate along a diagonal the quad's axes miss", () => {
    const diamond: Quad = [
      [5, 0],
      [10, 5],
      [0, 5],
      [5, 10],
    ];
    // Inside the diamond's bounding box but past its edge.
    expect(hitPoint(diamond, [1, 1])).toBe(false);
    expect(
      hitPolygon(diamond, [
        [0, 0],
        [1.5, 0],
        [0, 1.5],
      ]),
    ).toBe(false);
  });
});

describe("placement", () => {
  const flat: View = {
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    viewport: [200, 100],
    pixelRatio: 1,
    cameraToCenterDistance: 1,
    pixelsToTileUnits: 1,
    bearing: 0,
  };
  const resolved: Resolved = {
    animation: 1,
    size: 1,
    rotate: 0,
    opacity: 1,
    offset: [0, 0],
    anchor: 0,
    rotationAlignment: 0,
    pitchAlignment: 0,
  };

  it("maps clip space to y-down logical pixels", () => {
    expect(project(flat, [0, 0])).toEqual([100, 50]);
    expect(project(flat, [1, 1])).toEqual([200, 0]);
    const behind = { ...flat, matrix: Array.from(flat.matrix) };
    behind.matrix[15] = -1;
    expect(project(behind, [0, 0])).toBeNull();
  });

  it("collapses like the shader", () => {
    const entry = { box: [0, 0, 10, 20] as const, displayPx: 40 };
    expect(corners([0, 0], resolved, entry, flat)).not.toBeNull();
    expect(corners([0, 0], { ...resolved, animation: 0 }, entry, flat)).toBe(
      null,
    );
    expect(corners([0, 0], { ...resolved, size: NaN }, entry, flat)).toBe(null);
    expect(corners([0, 0], { ...resolved, opacity: 0 }, entry, flat)).toBe(
      null,
    );
  });

  it("reaches the box diagonal at display size", () => {
    expect(entryRadius({ box: [0, 0, 30, 40], displayPx: 80 })).toBe(100);
  });
});
