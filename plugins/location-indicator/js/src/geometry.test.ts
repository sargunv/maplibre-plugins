// These scenarios mirror the Zig tests in ../../native/src/plugin.zig, using
// the same flat 100 000 m/degree test projection at 100 world pixels per
// degree, so the two implementations are checked against the same numbers.

import { describe, expect, it } from "vite-plus/test";

import {
  ACCURACY_SEGMENTS,
  buildFrame,
  containsPoint,
  destination,
  FLOATS_PER_VERTEX,
  type FrameContext,
  type FrameGeometry,
  shouldAnimate,
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
    timeSeconds: 0,
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

  it("pulses on frame time and hides components with zero size", () => {
    const hidden = buildFrame(context(defaults({ "puck-radius": 0 })));
    expect(hidden.vertexCount).toBe(0);
    expect(hidden.feature).not.toBeNull();

    const pulsing = defaults({
      "puck-radius": 0,
      "pulse-radius": 40,
      "pulse-period": 2,
    });
    const frame = buildFrame(context(pulsing, { timeSeconds: 1 }));
    expect(frame.vertexCount).toBe(4);
    // Halfway through the period the ring is halfway from 2 px to 40 px.
    expect(position(frame, 1)[0]).toBeCloseTo(21 * 1.15, 6);
    expect(shouldAnimate(pulsing)).toBe(true);
    expect(shouldAnimate(defaults())).toBe(false);

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

describe("destination", () => {
  it("moves along a bearing on the sphere", () => {
    const [lat, lon] = destination(0, 0, 111_195, 90);
    expect(lat).toBeCloseTo(0, 6);
    expect(lon).toBeCloseTo(1, 3);
    const [lat2] = destination(10, 20, 111_195, 0);
    expect(lat2).toBeCloseTo(11, 3);
  });
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
