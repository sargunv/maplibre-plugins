// Mirrors the tests in ../../native/src/layout.zig: both twins run every
// case in ../../fixtures/layout through the same checks, so the two layouts
// cannot drift apart unnoticed.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import {
  CORNERS,
  FLOATS_PER_VERTEX,
  IconLayout,
  INDICES_PER_ANCHOR,
  MAX_SEGMENT_VERTICES,
  type Point,
  QUAD_INDICES,
  VERTICES_PER_ANCHOR,
} from "./layout.ts";

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "layout",
);

interface Fixture {
  description: string;
  extent: number;
  features?: { index: number; points: [number, number][] }[];
  /**
   * A MultiPoint of columns × rows points, generated column by column so the
   * sort has to reorder them.
   */
  grid?: {
    index: number;
    origin: [number, number];
    step: [number, number];
    columns: number;
    rows: number;
  };
  expected: {
    anchor_count: number;
    /** Draw order: [x, y, feature index] of every anchor. */
    anchors?: [number, number, number][];
    /** [anchor number, x, y, feature index] of some anchors. */
    samples?: [number, number, number, number][];
    /** [vertex_offset, index_offset, vertex_length, index_length]. */
    segments: [number, number, number, number][];
    vertices?: [number, number][];
    indices?: number[];
  };
}

const fixtures = readdirSync(fixturesDir)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => ({
    name,
    fixture: JSON.parse(
      readFileSync(join(fixturesDir, name), "utf8"),
    ) as Fixture,
  }));

function build(fixture: Fixture): IconLayout {
  const layout = new IconLayout(fixture.extent);
  for (const feature of fixture.features ?? []) {
    layout.addPoints(
      feature.points.map(([x, y]) => ({ x, y })),
      feature.index,
    );
  }
  const grid = fixture.grid;
  if (grid) {
    const points: Point[] = [];
    for (let column = 0; column < grid.columns; column++) {
      for (let row = 0; row < grid.rows; row++) {
        points.push({
          x: grid.origin[0] + column * grid.step[0],
          y: grid.origin[1] + row * grid.step[1],
        });
      }
    }
    layout.addPoints(points, grid.index);
  }
  layout.finish();
  return layout;
}

function expectAnchor(
  layout: IconLayout,
  k: number,
  x: number,
  y: number,
  featureIndex: number,
): void {
  const vertices = layout.vertices();
  const first = k * VERTICES_PER_ANCHOR * FLOATS_PER_VERTEX;
  expect([vertices[first], vertices[first + 1]]).toEqual([x * 2, y * 2]);
  expect(layout.ranges[k]).toEqual({
    featureIndex,
    firstVertex: k * VERTICES_PER_ANCHOR,
    vertexCount: VERTICES_PER_ANCHOR,
  });
}

describe("IconLayout", () => {
  it("has fixtures", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const { name, fixture } of fixtures) {
    it(`${name}: ${fixture.description}`, () => {
      const layout = build(fixture);
      const expected = fixture.expected;
      const count = expected.anchor_count;
      expect(layout.vertexCount).toBe(count * VERTICES_PER_ANCHOR);
      expect(layout.indexCount).toBe(count * INDICES_PER_ANCHOR);
      expect(layout.ranges.length).toBe(count);
      if (expected.anchors) {
        expect(expected.anchors.length).toBe(count);
        expected.anchors.forEach(([x, y, feature], k) =>
          expectAnchor(layout, k, x, y, feature),
        );
      }
      for (const [k, x, y, feature] of expected.samples ?? []) {
        expectAnchor(layout, k, x, y, feature);
      }
      expect(
        layout.segments.map((s) => [
          s.vertexOffset,
          s.indexOffset,
          s.vertexLength,
          s.indexLength,
        ]),
      ).toEqual(expected.segments);
      if (expected.vertices) {
        expect(Array.from(layout.vertices())).toEqual(expected.vertices.flat());
      }
      if (expected.indices) {
        expect(Array.from(layout.indices())).toEqual(expected.indices);
      }

      // Every anchor is a quad of its own four vertices, with the corners in
      // order and the indices relative to its segment.
      // Counted rather than asserted one by one: the large fixtures have
      // tens of thousands of anchors.
      const vertices = layout.vertices();
      const indices = layout.indices();
      let anchor = 0;
      let mismatches = 0;
      for (const segment of layout.segments) {
        expect(segment.vertexLength).toBeLessThanOrEqual(MAX_SEGMENT_VERTICES);
        expect(segment.vertexOffset).toBe(anchor * VERTICES_PER_ANCHOR);
        expect(segment.indexOffset).toBe(anchor * INDICES_PER_ANCHOR);
        for (
          let local = 0;
          local < segment.vertexLength / VERTICES_PER_ANCHOR;
          local++, anchor++
        ) {
          const first = anchor * VERTICES_PER_ANCHOR * FLOATS_PER_VERTEX;
          CORNERS.forEach(([cx, cy], c) => {
            const at = first + c * FLOATS_PER_VERTEX;
            if (vertices[at] !== vertices[first]! + cx) mismatches++;
            if (vertices[at + 1] !== vertices[first + 1]! + cy) mismatches++;
          });
          QUAD_INDICES.forEach((offset, j) => {
            const index = indices[anchor * INDICES_PER_ANCHOR + j];
            if (index !== local * VERTICES_PER_ANCHOR + offset) mismatches++;
          });
        }
      }
      expect(anchor).toBe(count);
      expect(mismatches).toBe(0);

      // The ranges cover every vertex exactly once, as the native host
      // requires of buckets with property bindings.
      const covered = new Uint8Array(layout.vertexCount);
      for (const range of layout.ranges) {
        for (
          let v = range.firstVertex;
          v < range.firstVertex + range.vertexCount;
          v++
        ) {
          covered[v]! += 1;
        }
      }
      expect(covered.every((c) => c === 1)).toBe(true);
    });
  }
});
