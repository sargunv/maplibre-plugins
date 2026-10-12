// These scenarios mirror the Zig tests in ../../native/src/plugin.zig, using
// the same flat 100 000 m/degree test projection at 100 world pixels per
// degree, so the two implementations are checked against the same numbers.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  ACCURACY_SEGMENTS,
  buildFrame,
  containsPoint,
  destination,
  FLOATS_PER_VERTEX,
  type FrameContext,
  type FrameGeometry,
  type Point,
} from "./geometry.ts";
import { compile, type EvaluatedPaint } from "./paint.ts";
import { type PaintName, paintNames, paintSpec } from "./spec.ts";

const PIXELS_PER_DEGREE = 100;

function defaults(
  overrides: Partial<Record<PaintName, unknown>> = {},
): EvaluatedPaint {
  const paint: Partial<Record<PaintName, readonly number[]>> = {};
  for (const name of paintNames) {
    paint[name] = compile(name, overrides[name] ?? paintSpec[name].default)(0);
  }
  return paint as EvaluatedPaint;
}

function context(
  paint: EvaluatedPaint,
  overrides: Partial<FrameContext> = {},
): FrameContext {
  return {
    paint,
    pitch: 0,
    bearing: 0,
    // Clip w is 1 everywhere, so one world pixel is one screen pixel.
    cameraToCenterDistance: 1,
    pixelRatio: 1,
    projectMercator: (lat, lon) => [
      lon * PIXELS_PER_DEGREE,
      -lat * PIXELS_PER_DEGREE,
    ],
    clipW: () => 1,
    destination: (lat, lon, distance, bearing) => [
      lat + (distance / 100_000) * Math.cos((bearing * Math.PI) / 180),
      lon + (distance / 100_000) * Math.sin((bearing * Math.PI) / 180),
    ],
    ...overrides,
  };
}

function position(frame: FrameGeometry, vertex: number): [number, number] {
  const i = vertex * FLOATS_PER_VERTEX;
  return [
    frame.origin[0] + frame.vertices[i]!,
    frame.origin[1] + frame.vertices[i + 1]!,
  ];
}

function quadCenterY(frame: FrameGeometry, firstVertex: number): number {
  return (
    (position(frame, firstVertex)[1] + position(frame, firstVertex + 2)[1]) / 2
  );
}

describe("buildFrame", () => {
  it("keeps sub-pixel precision at large world coordinates", () => {
    const first = buildFrame(
      context(defaults({ position: [0, 10_000_000.25] })),
    );
    const second = buildFrame(
      context(defaults({ position: [0, 10_000_000.255] })),
    );
    expect(first.vertexCount).toBe(4);
    for (let i = 0; i < 4; i++) {
      // Vertices are stored relative to the origin, so the origins carry the shift.
      expect(second.origin[0] - first.origin[0]).toBeCloseTo(0.5, 6);
      expect(second.vertices[i * FLOATS_PER_VERTEX]).toBeCloseTo(
        first.vertices[i * FLOATS_PER_VERTEX]!,
        9,
      );
    }
  });

  it("builds the accuracy circle from host destinations", () => {
    for (const radius of [0.001, 5000]) {
      const frame = buildFrame(
        context(defaults({ "accuracy-radius": radius })),
      );
      expect(frame.vertexCount).toBe(ACCURACY_SEGMENTS * 3 + 4);
      // Vertex 1 is the first boundary point at bearing 0: due north by 1.15 × radius.
      expect(position(frame, 1)[1]).toBeCloseTo(
        (-1.15 * radius * PIXELS_PER_DEGREE) / 100_000,
        9,
      );
    }
  });

  it("hides components with zero size and rejects unusable positions", () => {
    const hidden = buildFrame(context(defaults({ "puck-radius": 0 })));
    expect(hidden.vertexCount).toBe(0);
    expect(hidden.feature).not.toBeNull();

    const invalid = buildFrame(context(defaults({ position: [91, 0] })));
    expect(invalid.vertexCount).toBe(0);
    expect(invalid.feature).toBeNull();
  });

  it("lifts the puck and arrow and lowers the shadow under tilt", () => {
    const paint = defaults({
      "shadow-radius": 12,
      "tilt-displacement": 10,
      "bearing-visible": 1,
    });
    const frame = buildFrame(context(paint, { pitch: 0.5 }));
    // Shadow, arrow, puck: the shadow moves down-screen, the arrow and puck
    // up-screen, by pitch × displacement pixels (0.5 × 10 = 5 world pixels).
    expect(quadCenterY(frame, 0)).toBeCloseTo(5, 6);
    expect(quadCenterY(frame, 4)).toBeCloseTo(-5, 6);
    expect(quadCenterY(frame, 8)).toBeCloseTo(-5, 6);
    expect(frame.queryPolygons).toHaveLength(2);
    for (const polygon of frame.queryPolygons) {
      expect((polygon[0]![1] + polygon[2]![1]) / 2).toBeCloseTo(-5, 6);
    }
    const puck = frame.queryPolygons[1]!;
    expect(containsPoint(puck, [0, -5])).toBe(true);
    expect(containsPoint(puck, [0, 20])).toBe(false);

    // With the camera bearing 90°, screen-up is east.
    const east = buildFrame(context(paint, { pitch: 0.5, bearing: 90 }));
    const [x0, y0] = position(east, 8);
    const [x2, y2] = position(east, 10);
    expect((x0 + x2) / 2).toBeCloseTo(5, 6);
    expect((y0 + y2) / 2).toBeCloseTo(0, 6);

    const noPuck = buildFrame(
      context(defaults({ ...paintOf(paint), "puck-radius": 0 }), {
        pitch: 0.5,
      }),
    );
    expect(noPuck.queryPolygons).toHaveLength(1);
    expect(noPuck.vertexCount).toBe(8);
  });

  it("scales with the perspective ratio and clamps it like core", () => {
    // Two screen pixels per world pixel (w = 1, camera distance 2): the world
    // size of a pixel is 0.5, clamped to 0.8.
    const zoomedIn: Partial<FrameContext> = { cameraToCenterDistance: 2 };
    const compensated = buildFrame(
      context(defaults({ "puck-radius": 8 }), zoomedIn),
    );
    const width = position(compensated, 1)[0] - position(compensated, 0)[0];
    expect(width).toBeCloseTo(2 * 1.15 * 10 * (0.15 + 0.8 * 0.85), 6);

    const raw = buildFrame(
      context(
        defaults({ "puck-radius": 8, "perspective-compensation": 0 }),
        zoomedIn,
      ),
    );
    expect(position(raw, 1)[0] - position(raw, 0)[0]).toBeCloseTo(
      2 * 1.15 * 10,
      6,
    );

    // Far from the camera (w = 3) the puck grows by the compensated ratio.
    const far = buildFrame(
      context(defaults({ "puck-radius": 8, "perspective-compensation": 1 }), {
        clipW: () => 3,
      }),
    );
    expect(position(far, 1)[0] - position(far, 0)[0]).toBeCloseTo(
      2 * 1.15 * 10 * 3,
      6,
    );

    // Behind the camera there is nothing to draw.
    expect(
      buildFrame(context(defaults(), { clipW: () => -1 })).vertexCount,
    ).toBe(0);
  });

  it("points the arrow along the bearing", () => {
    const north = buildFrame(
      context(defaults({ "bearing-visible": 1, "puck-radius": 0 })),
    );
    const east = buildFrame(
      context(
        defaults({ "bearing-visible": 1, "puck-radius": 0, bearing: 90 }),
      ),
    );
    // The apex is at point (0, -1): in world pixels that is north for bearing 0 and east for bearing 90.
    const apex = (frame: FrameGeometry) => {
      const [x0, y0] = position(frame, 0);
      const [x1, y1] = position(frame, 1);
      return [(x0 + x1) / 2, (y0 + y1) / 2];
    };
    expect(apex(north)[0]).toBeCloseTo(0, 6);
    expect(apex(north)[1]).toBeCloseTo(-1.15 * 18, 6);
    expect(apex(east)[0]).toBeCloseTo(1.15 * 18, 6);
    expect(apex(east)[1]).toBeCloseTo(0, 6);
  });
});

interface GeographicCase {
  name: string;
  paint: Partial<Record<PaintName, unknown>> & {
    position: [number, number];
    "accuracy-radius": number;
  };
  frame: {
    center: [number, number];
    zoom: number;
    pitch: number;
    bearing: number;
    pixelRatio: number;
    viewport: [number, number];
    cameraToCenterDistance: number;
    matrix: number[];
  };
  boundary: Array<{ latLng: Point; world: Point }>;
  vertices: Point[];
  queryPolygons: Point[][];
}
const geographicCases = (
  JSON.parse(
    readFileSync(
      new URL("../../fixtures/geographic.json", import.meta.url),
      "utf8",
    ),
  ) as { cases: GeographicCase[] }
).cases;

function geographicContext(testCase: GeographicCase): FrameContext {
  const { frame } = testCase;
  const worldSize = 512 * 2 ** frame.zoom;
  return {
    paint: defaults(testCase.paint),
    pitch: frame.pitch,
    bearing: (-frame.bearing * 180) / Math.PI,
    cameraToCenterDistance: frame.cameraToCenterDistance,
    pixelRatio: frame.pixelRatio,
    destination,
    projectMercator: (lat, lon) => {
      const unwrapped = lon + 360 * Math.round((frame.center[1] - lon) / 360);
      const phi = (lat * Math.PI) / 180;
      return [
        ((unwrapped + 180) / 360) * worldSize,
        (0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI)) *
          worldSize,
      ];
    },
    clipW: (x, y) =>
      frame.matrix[3]! * x + frame.matrix[7]! * y + frame.matrix[15]!,
  };
}

function screen(matrix: number[], viewport: Point, world: Point): Point {
  const [x, y] = world;
  const w = matrix[3]! * x + matrix[7]! * y + matrix[15]!;
  return [
    ((1 + (matrix[0]! * x + matrix[4]! * y + matrix[12]!) / w) * viewport[0]) /
      2,
    ((1 - (matrix[1]! * x + matrix[5]! * y + matrix[13]!) / w) * viewport[1]) /
      2,
  ];
}

// These references come from native TransformState/CheapRuler and the built
// Zig plugin, not this module. They cover real geographic coordinates/cameras.
describe("native geographic reference frames", () => {
  it.each(geographicCases)(
    "$name: accuracy destinations, screen geometry and hit envelopes",
    (testCase) => {
      const ctx = geographicContext(testCase);
      for (let i = 0; i < testCase.boundary.length; i++) {
        const [lat, lon] = destination(
          ...testCase.paint.position,
          testCase.paint["accuracy-radius"] * 1.15,
          i * 5,
        );
        const reference = testCase.boundary[i]!;
        expect(lat).toBeCloseTo(reference.latLng[0], 10);
        expect(lon).toBeCloseTo(reference.latLng[1], 10);
        const world = ctx.projectMercator(lat, lon);
        expect(world[0]).toBeCloseTo(reference.world[0], 5);
        expect(world[1]).toBeCloseTo(reference.world[1], 5);
      }
      const geometry = buildFrame(ctx);
      expect(geometry.vertexCount).toBe(testCase.vertices.length);
      for (let i = 0; i < geometry.vertexCount; i++) {
        const actual = screen(
          testCase.frame.matrix,
          testCase.frame.viewport,
          position(geometry, i),
        );
        // Native stores clip coordinates as f32, JS keeps world coordinates f64.
        expect(Math.abs(actual[0] - testCase.vertices[i]![0])).toBeLessThan(
          0.002,
        );
        expect(Math.abs(actual[1] - testCase.vertices[i]![1])).toBeLessThan(
          0.002,
        );
      }
      expect(geometry.queryPolygons).toHaveLength(
        testCase.queryPolygons.length,
      );
      for (let p = 0; p < geometry.queryPolygons.length; p++) {
        const polygon = geometry.queryPolygons[p]!;
        const reference = testCase.queryPolygons[p]!;
        for (let i = 0; i < polygon.length; i++) {
          expect(polygon[i]![0]).toBeCloseTo(reference[i]![0], 5);
          expect(polygon[i]![1]).toBeCloseTo(reference[i]![1], 5);
        }
        const center: Point = [
          (reference[0]![0] + reference[2]![0]) / 2,
          (reference[0]![1] + reference[2]![1]) / 2,
        ];
        expect(containsPoint(polygon, center)).toBe(true);
        const outside: Point = [
          center[0] + 3 * (reference[0]![0] - center[0]),
          center[1] + 3 * (reference[0]![1] - center[1]),
        ];
        expect(containsPoint(polygon, outside)).toBe(false);
      }
    },
  );
});

function paintOf(paint: EvaluatedPaint): Partial<Record<PaintName, unknown>> {
  const raw: Partial<Record<PaintName, unknown>> = {};
  for (const name of paintNames) {
    const value = paint[name];
    raw[name] =
      paintSpec[name].type === "float" || paintSpec[name].type === "rotation"
        ? value[0]
        : value;
  }
  return raw;
}
