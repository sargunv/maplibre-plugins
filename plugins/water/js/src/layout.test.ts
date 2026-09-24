// Mirrors the tests in ../../native/src/layout.zig: same fixtures, same
// expected vertices, so the two layouts cannot drift apart unnoticed.

import { describe, expect, it } from "vite-plus/test";

import {
  containsPoint,
  MAX_SEGMENT_VERTICES,
  type Point,
  ShoreLayout,
  UNLIMITED,
} from "./layout.ts";

const ring = (points: [number, number][]): Point[] =>
  points.map(([x, y]) => ({ x, y }));

function expectVertex(
  layout: ShoreLayout,
  i: number,
  x: number,
  y: number,
  ex: number,
  ey: number,
  dist: number,
): void {
  const v = layout.vertex(i);
  expect(v.x).toBeCloseTo(x, 3);
  expect(v.y).toBeCloseTo(y, 3);
  expect(v.extrudeX).toBeCloseTo(ex, 5);
  expect(v.extrudeY).toBeCloseTo(ey, 5);
  expect(v.dist).toBe(dist);
}

const SQRT1_2 = Math.SQRT1_2;

describe("ShoreLayout", () => {
  it("turns a square inside the tile into a closed strip with inward miters", () => {
    const layout = new ShoreLayout(8192);
    layout.addPolygon(
      [
        ring([
          [1000, 1000],
          [7000, 1000],
          [7000, 7000],
          [1000, 7000],
          [1000, 1000],
        ]),
      ],
      7,
    );
    // Four corners plus the repeated first pair close the loop.
    expect(layout.vertexCount).toBe(10);
    expect(layout.indexCount).toBe(24);
    expectVertex(layout, 0, 1000, 1000, 0, 0, 0);
    expectVertex(layout, 1, 1000, 1000, 1, 1, 1);
    expectVertex(layout, 3, 7000, 1000, -1, 1, 1);
    expectVertex(layout, 5, 7000, 7000, -1, -1, 1);
    expectVertex(layout, 7, 1000, 7000, 1, -1, 1);
    expectVertex(layout, 9, 1000, 1000, 1, 1, 1);
    expect(Array.from(layout.indices().subarray(0, 6))).toEqual([
      0, 1, 3, 0, 3, 2,
    ]);
    expect(layout.segments).toEqual([
      { vertexOffset: 0, indexOffset: 0, vertexLength: 10, indexLength: 24 },
    ]);
    expect(layout.ranges).toEqual([
      { featureIndex: 7, firstVertex: 0, vertexCount: 10 },
    ]);
  });

  it("fans the band around the reflex corners of a hole", () => {
    const layout = new ShoreLayout(8192);
    // An island: opposite winding, so the water is outside the ring.
    layout.addPolygon(
      [
        ring([
          [3000, 3000],
          [3000, 5000],
          [5000, 5000],
          [5000, 3000],
        ]),
      ],
      0,
    );
    // Each 90° corner fans through three extrusions (0°, -45°, -90°), and
    // the first corner repeats to close the loop.
    expect(layout.vertexCount).toBe(2 * (4 * 3 + 3));
    expectVertex(layout, 1, 3000, 3000, 0, -1, 1);
    expectVertex(layout, 3, 3000, 3000, -SQRT1_2, -SQRT1_2, 1);
    expectVertex(layout, 5, 3000, 3000, -1, 0, 1);
    expectVertex(layout, 7, 3000, 5000, -1, 0, 1);
    expectVertex(layout, 9, 3000, 5000, -SQRT1_2, SQRT1_2, 1);
    expectVertex(layout, 11, 3000, 5000, 0, 1, 1);
    expectVertex(layout, 29, 3000, 3000, -1, 0, 1);
  });

  it("clips edges to the margin and drops tile-edge cuts", () => {
    const layout = new ShoreLayout(8192);
    layout.addPolygon(
      [
        ring([
          [-6000, 2000],
          [4000, 2000],
          [4000, 6000],
          [-6000, 6000],
        ]),
      ],
      0,
    );
    // One open chain clipped at the margin: the top edge, the right edge, the bottom edge.
    expect(layout.vertexCount).toBe(8);
    expect(layout.indexCount).toBe(18);
    expectVertex(layout, 0, -4096, 2000, 0, 0, 0);
    expectVertex(layout, 1, -4096, 2000, 0, 1, 1);
    expectVertex(layout, 3, 4000, 2000, -1, 1, 1);
    expectVertex(layout, 5, 4000, 6000, -1, -1, 1);
    expectVertex(layout, 7, -4096, 6000, 0, -1, 1);

    // Geometry in the tile buffer is kept whole, so a corner just outside
    // the tile still gets its miter.
    const buffered = new ShoreLayout(8192);
    buffered.addPolygon(
      [
        ring([
          [-100, 2000],
          [4000, 1500],
          [4000, 6000],
          [-200, 6000],
        ]),
      ],
      0,
    );
    expect(buffered.vertexCount).toBe(10);
    expectVertex(buffered, 0, -100, 2000, 0, 0, 0);
    expect(buffered.vertex(1).dist).toBe(1);

    // A polygon cut exactly along the tile edge contributes no shoreline there.
    const cut = new ShoreLayout(8192);
    cut.addPolygon(
      [
        ring([
          [0, 0],
          [4000, 0],
          [4000, 4000],
          [0, 4000],
        ]),
      ],
      0,
    );
    expect(cut.vertexCount).toBe(6);
    expectVertex(cut, 0, 4000, 0, 0, 0, 0);
    expectVertex(cut, 5, 0, 4000, 0, -1, 1);

    // Entirely outside the margin: nothing, and no feature range.
    const outside = new ShoreLayout(8192);
    outside.addPolygon(
      [
        ring([
          [-9000, -9000],
          [-5000, -9000],
          [-5000, -5000],
          [-9000, -5000],
        ]),
      ],
      0,
    );
    expect(outside.vertexCount).toBe(0);
    expect(outside.ranges).toEqual([]);
  });

  it("runs a chain that leaves the margin through the ring start as one strip", () => {
    const layout = new ShoreLayout(8192);
    // A wedge whose tip pokes out beyond the clip margin.
    layout.addPolygon(
      [
        ring([
          [2000, 2000],
          [4000, -7000],
          [6000, 2000],
          [6000, 6000],
          [2000, 6000],
        ]),
      ],
      3,
    );
    // One open chain from where the tip re-enters, around the ring, to where it leaves.
    expect(layout.vertexCount).toBe(12);
    expect(layout.indexCount).toBe(30);
    expectVertex(layout, 0, 4000 + (2000 * 2904) / 9000, -4096, 0, 0, 0);
    expectVertex(layout, 2, 6000, 2000, 0, 0, 0);
    expectVertex(layout, 8, 2000, 2000, 0, 0, 0);
    expectVertex(layout, 10, 2000 + (2000 * 6096) / 9000, -4096, 0, 0, 0);
    expect(layout.ranges).toEqual([
      { featureIndex: 3, firstVertex: 0, vertexCount: 12 },
    ]);
  });

  it("limits extrusions to half the distance to the opposite bank", () => {
    const layout = new ShoreLayout(8192);
    // A channel 200 units wide: every inner vertex may extrude 100 units,
    // including the mitered corners, whose diagonal rays hit the far bank
    // at 200·√2 with a √2-long extrusion.
    layout.addPolygon(
      [
        ring([
          [1000, 1000],
          [7000, 1000],
          [7000, 1200],
          [1000, 1200],
        ]),
      ],
      0,
    );
    for (let i = 1; i < layout.vertexCount; i += 2)
      expect(layout.vertex(i).limit).toBeCloseTo(100, 3);
    // A square's corner ray hits the opposite corner; past REACH the limit is off.
    const wide = new ShoreLayout(8192);
    wide.addPolygon(
      [
        ring([
          [1000, 1000],
          [3500, 1000],
          [3500, 3500],
          [1000, 3500],
        ]),
      ],
      0,
    );
    expect(wide.vertex(1).limit).toBeCloseTo(1250, 2);
    const huge = new ShoreLayout(8192);
    huge.addPolygon(
      [
        ring([
          [4096, -3000],
          [11000, 4096],
          [4096, 11000],
          [-3000, 4096],
        ]),
      ],
      0,
    );
    expect(huge.vertex(1).limit).toBe(UNLIMITED);
    // An island inside a lake limits the lake's band and its own.
    const lake = new ShoreLayout(8192);
    lake.addPolygon(
      [
        ring([
          [1000, 1000],
          [7000, 1000],
          [7000, 7000],
          [1000, 7000],
        ]),
        ring([
          [3000, 3000],
          [3000, 5000],
          [5000, 5000],
          [5000, 3000],
        ]),
      ],
      0,
    );
    // Lake corner (1000,1000) along (1,1) hits the island corner at 2000·√2.
    expect(lake.vertex(1).limit).toBeCloseTo(1000, 2);
    // Island edge x=3000 extrudes toward x=1000: limit 1000.
    expect(lake.vertex(10 + 5).limit).toBeCloseTo(1000, 2);
  });

  it("ignores degenerate rings and repeated points", () => {
    const layout = new ShoreLayout(8192);
    layout.addPolygon(
      [
        ring([
          [100, 100],
          [200, 200],
          [300, 300],
        ]),
        ring([
          [500, 500],
          [500, 500],
        ]),
        ring([
          [1000, 1000],
          [1000, 1000],
          [2000, 1000],
          [2000, 2000],
          [1000, 2000],
          [1000, 1000],
        ]),
      ],
      0,
    );
    // Only the square survives; its duplicate point collapses.
    expect(layout.vertexCount).toBe(10);
    expect(layout.ranges).toHaveLength(1);
  });

  it("splits long chains across 16-bit segments and keeps them joined", () => {
    const layout = new ShoreLayout(8192);
    // A jagged coast with 12000 points; its reflex corners fan, so the strip
    // needs several segments.
    const count = 12000;
    const points: Point[] = [];
    for (let i = 0; i < count; i++) {
      const t = i / count;
      points.push({ x: 100 + 8000 * t, y: i % 2 === 0 ? 100 : 150 });
    }
    points[count - 1] = { x: 4000, y: 8000 };
    layout.addPolygon([points], 1);
    expect(layout.segments.length).toBeGreaterThanOrEqual(2);
    const indices = layout.indices();
    let total = 0;
    layout.segments.forEach((segment, i) => {
      expect(segment.vertexLength).toBeLessThanOrEqual(MAX_SEGMENT_VERTICES);
      expect(segment.vertexOffset).toBe(total);
      total += segment.vertexLength;
      for (
        let k = segment.indexOffset;
        k < segment.indexOffset + segment.indexLength;
        k++
      )
        expect(indices[k]!).toBeLessThan(segment.vertexLength);
      if (i === 0) return;
      // The pair that straddles a split ends one segment and starts the next.
      const previous = layout.segments[i - 1]!;
      const tail = layout.vertex(
        previous.vertexOffset + previous.vertexLength - 2,
      );
      const head = layout.vertex(segment.vertexOffset);
      expect(head.x).toBe(tail.x);
      expect(head.y).toBe(tail.y);
      expect(segment.indexOffset).toBe(
        previous.indexOffset + previous.indexLength,
      );
    });
    expect(layout.vertexCount).toBe(total);
    expect(layout.ranges).toEqual([
      { featureIndex: 1, firstVertex: 0, vertexCount: total },
    ]);
  });
});

describe("containsPoint", () => {
  it("treats holes with even-odd parity", () => {
    const rings = [
      ring([
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ]),
      ring([
        [4, 4],
        [4, 6],
        [6, 6],
        [6, 4],
      ]),
    ];
    expect(containsPoint(rings, { x: 2, y: 2 })).toBe(true);
    expect(containsPoint(rings, { x: 5, y: 5 })).toBe(false);
    expect(containsPoint(rings, { x: 12, y: 5 })).toBe(false);
  });
});
