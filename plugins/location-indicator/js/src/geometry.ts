// Frame geometry. This is the maplibre-gl-js twin of buildFrame in
// ../../native/src/plugin.zig: the same components, sizes, shader styles and
// hit envelopes, expressed in Mercator world pixels instead of clip space. It
// depends on nothing from WebGL or the map, so it is unit-tested directly.

import type { Feature, Point as GeoJsonPoint } from "geojson";

import type { EvaluatedPaint, Vector } from "./paint.ts";

export type Point = readonly [number, number];

/** Borrowed per-frame inputs, mirroring mln_plugin_frame_context_v1. */
export interface FrameContext {
  paint: EvaluatedPaint;
  /** Camera pitch in radians. */
  pitch: number;
  /** Camera bearing in degrees clockwise from north, as the map reports it. */
  bearing: number;
  /** Distance from the camera to the map center in logical pixels. */
  cameraToCenterDistance: number;
  /** Framebuffer pixels per logical pixel. */
  pixelRatio: number;
  /** Maps latitude/longitude to Mercator world pixels at the frame zoom, unwrapped toward the camera center. */
  projectMercator(latitude: number, longitude: number): Point;
  /** Clip-space w of a Mercator world-pixel position: its depth from the camera. */
  clipW(x: number, y: number): number;
  /** Moves distanceMeters from a position along bearingDegrees clockwise from north. */
  destination(
    latitude: number,
    longitude: number,
    distanceMeters: number,
    bearingDegrees: number,
  ): readonly [number, number];
}

/** Floats per vertex: position(2) point(2) style(4) fill(4) border(4). */
export const FLOATS_PER_VERTEX = 16;

export const ACCURACY_SEGMENTS = 72;
const COMPONENT_QUADS = 4;
const MAX_VERTICES = ACCURACY_SEGMENTS * 3 + COMPONENT_QUADS * 4;
const MAX_INDICES = ACCURACY_SEGMENTS * 3 + COMPONENT_QUADS * 6;

/** Shape selectors consumed by shaders/puck.glsl. */
export const Style = {
  disc: 0,
  sector: 1,
  shadow: 2,
  arrow: 3,
} as const;

export interface FrameGeometry {
  /** Interleaved vertices; positions are Mercator world pixels relative to `origin`, in double precision. */
  vertices: Float64Array;
  vertexCount: number;
  indices: Uint16Array;
  indexCount: number;
  /** World-pixel origin the vertex positions are relative to (the indicator's projected position). */
  origin: Point;
  /** Hit envelopes in absolute Mercator world pixels: the arrow, then the puck. */
  queryPolygons: Point[][];
  /** The rendered feature, or null when the position is invalid. */
  feature: Feature<GeoJsonPoint> | null;
}

const QUAD_CORNERS: readonly Point[] = [
  [-1.15, -1.15],
  [1.15, -1.15],
  [1.15, 1.15],
  [-1.15, 1.15],
];

const CLEAR: Vector = [0, 0, 0, 0];

function number(paint: EvaluatedPaint, name: keyof EvaluatedPaint): number {
  return paint[name][0] ?? 0;
}

function color(
  paint: EvaluatedPaint,
  name: keyof EvaluatedPaint,
  opacity: number,
): Vector {
  const c = paint[name];
  return [
    (c[0] ?? 0) * opacity,
    (c[1] ?? 0) * opacity,
    (c[2] ?? 0) * opacity,
    (c[3] ?? 0) * opacity,
  ];
}

class FrameBuilder {
  readonly vertices = new Float64Array(MAX_VERTICES * FLOATS_PER_VERTEX);
  readonly indices = new Uint16Array(MAX_INDICES);
  vertexCount = 0;
  indexCount = 0;
  readonly queryPolygons: Point[][] = [];

  constructor(readonly origin: Point) {}

  append(
    positions: readonly Point[],
    points: readonly Point[],
    style: Vector,
    fill: Vector,
    border: Vector,
  ): void {
    const base = this.vertexCount;
    for (let i = 0; i < positions.length; i++) {
      const position = positions[i]!;
      const point = points[i]!;
      let offset = this.vertexCount * FLOATS_PER_VERTEX;
      this.vertices[offset++] = position[0] - this.origin[0];
      this.vertices[offset++] = position[1] - this.origin[1];
      this.vertices[offset++] = point[0];
      this.vertices[offset++] = point[1];
      for (const v of style) this.vertices[offset++] = v;
      for (const v of fill) this.vertices[offset++] = v;
      for (const v of border) this.vertices[offset++] = v;
      this.vertexCount++;
    }
    const offsets = positions.length === 3 ? [0, 1, 2] : [0, 1, 2, 0, 2, 3];
    for (const o of offsets) this.indices[this.indexCount++] = base + o;
  }

  quad(
    center: Point,
    x: Point,
    y: Point,
    style: Vector,
    fill: Vector,
    border: Vector,
  ): void {
    const positions = QUAD_CORNERS.map(([cx, cy]): Point => [
      center[0] + cx * x[0] + cy * y[0],
      center[1] + cx * x[1] + cy * y[1],
    ]);
    this.append(positions, QUAD_CORNERS, style, fill, border);
  }

  queryQuad(center: Point, radius: number, bearing: number): void {
    const [ax, ay] = rotate([radius, 0], [0, radius], bearing);
    this.queryPolygons.push(
      (
        [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ] as const
      ).map(([cx, cy]): Point => [
        center[0] + cx * ax[0] + cy * ay[0],
        center[1] + cx * ax[1] + cy * ay[1],
      ]),
    );
  }
}

function scale(v: Point, s: number): Point {
  return [v[0] * s, v[1] * s];
}

/** Rotates the axis pair clockwise on screen by `angle` radians (y grows downward). */
function rotate(x: Point, y: Point, angle: number): [Point, Point] {
  const sn = Math.sin(angle);
  const cs = Math.cos(angle);
  return [
    [x[0] * cs + y[0] * sn, x[1] * cs + y[1] * sn],
    [-x[0] * sn + y[0] * cs, -x[1] * sn + y[1] * cs],
  ];
}

function empty(
  origin: Point,
  feature: FrameGeometry["feature"],
): FrameGeometry {
  return {
    vertices: new Float64Array(0),
    vertexCount: 0,
    indices: new Uint16Array(0),
    indexCount: 0,
    origin,
    queryPolygons: [],
    feature,
  };
}

/** Builds one frame of indicator geometry, or empty geometry when the position is unusable. */
export function buildFrame(ctx: FrameContext): FrameGeometry {
  const paint = ctx.paint;
  const [lat = NaN, lon = NaN] = paint.position;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90) {
    return empty([0, 0], null);
  }
  const center = ctx.projectMercator(lat, lon);
  const feature: Feature<GeoJsonPoint> = {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: {},
  };
  const frame = new FrameBuilder(center);
  const w = ctx.clipW(center[0], center[1]);
  if (!Number.isFinite(w) || w <= 0 || !(ctx.cameraToCenterDistance > 0)) {
    return empty(center, feature);
  }
  // World pixels per screen pixel at the indicator: the perspective ratio the
  // built-in layers use, clip w over the camera-to-center distance.
  const pixelWorldSize = w / ctx.cameraToCenterDistance;
  const compensation = number(paint, "perspective-compensation");
  const s =
    1 -
    compensation +
    Math.min(Math.max(pixelWorldSize, 0.8), 10.1) * compensation;

  // Tilt displacement moves along screen-up on the ground, which is the
  // camera bearing in world pixels (y down).
  const displacement =
    ctx.pitch * number(paint, "tilt-displacement") * s * pixelWorldSize;
  const bearingRadians = (ctx.bearing * Math.PI) / 180;
  const shift: Point = [
    Math.sin(bearingRadians) * displacement,
    -Math.cos(bearingRadians) * displacement,
  ];
  const top: Point = [center[0] + shift[0], center[1] + shift[1]];
  const shadowCenter: Point = [center[0] - shift[0], center[1] - shift[1]];

  const bearing = (number(paint, "bearing") * Math.PI) / 180;
  const [groundX, groundY] = rotate([s, 0], [0, s], bearing);
  const ratio = ctx.pixelRatio;

  const accuracy = number(paint, "accuracy-radius");
  if (accuracy > 0) {
    // Extra extent leaves room for analytic coverage outside the true radius.
    const fill = color(paint, "accuracy-color", 1);
    const border = color(paint, "accuracy-border-color", 1);
    const style: Vector = [
      Style.disc,
      number(paint, "accuracy-border-width") * ratio,
      0,
      0,
    ];
    const boundary: Point[] = [];
    const points: Point[] = [];
    for (let i = 0; i <= ACCURACY_SEGMENTS; i++) {
      const angle = (i * 360) / ACCURACY_SEGMENTS;
      const [dlat, dlon] = ctx.destination(lat, lon, accuracy * 1.15, angle);
      if (
        !Number.isFinite(dlat) ||
        !Number.isFinite(dlon) ||
        Math.abs(dlat) > 90
      ) {
        return empty(center, feature);
      }
      boundary.push(ctx.projectMercator(dlat, dlon));
      const radians = (angle * Math.PI) / 180;
      points.push([1.15 * Math.sin(radians), -1.15 * Math.cos(radians)]);
    }
    for (let i = 0; i < ACCURACY_SEGMENTS; i++) {
      frame.append(
        [center, boundary[i]!, boundary[i + 1]!],
        [[0, 0], points[i]!, points[i + 1]!],
        style,
        fill,
        border,
      );
    }
  }

  const visible = number(paint, "bearing-visible");
  const sectorRadius = number(paint, "bearing-accuracy-radius");
  const sectorAngle = number(paint, "bearing-accuracy");
  if (visible > 0 && sectorRadius > 0 && sectorAngle > 0) {
    frame.quad(
      center,
      scale(groundX, sectorRadius),
      scale(groundY, sectorRadius),
      [Style.sector, 0, (sectorAngle * Math.PI) / 180, 0],
      color(paint, "bearing-accuracy-color", visible),
      CLEAR,
    );
  }

  const shadow = number(paint, "shadow-radius");
  if (shadow > 0) {
    frame.quad(
      shadowCenter,
      scale(groundX, shadow),
      scale(groundY, shadow),
      [Style.shadow, 0, 0, 0],
      color(paint, "shadow-color", 1),
      CLEAR,
    );
  }

  const radius = number(paint, "puck-radius");
  const border = number(paint, "puck-border-width");
  const outer = radius > 0 ? radius + border : 0;

  // The arrow rides with the puck: both lift under tilt displacement while
  // the shadow, accuracy circle, and sector stay on the ground.
  const arrowRadius = number(paint, "bearing-radius");
  if (visible > 0 && arrowRadius > 0) {
    frame.quad(
      top,
      scale(groundX, arrowRadius),
      scale(groundY, arrowRadius),
      [Style.arrow, 0, 0, 0],
      color(paint, "bearing-arrow-color", visible),
      CLEAR,
    );
    frame.queryQuad(top, arrowRadius * s, bearing);
  }

  if (outer > 0) {
    frame.quad(
      top,
      scale(groundX, outer),
      scale(groundY, outer),
      [Style.disc, border / outer, 0, 1],
      color(paint, "puck-color", 1),
      color(paint, "puck-border-color", 1),
    );
    frame.queryQuad(top, outer * s, bearing);
  }

  return {
    vertices: frame.vertices.subarray(0, frame.vertexCount * FLOATS_PER_VERTEX),
    vertexCount: frame.vertexCount,
    indices: frame.indices.subarray(0, frame.indexCount),
    indexCount: frame.indexCount,
    origin: center,
    queryPolygons: frame.queryPolygons,
    feature,
  };
}

/** Point-in-polygon by ray casting, for the world-pixel hit envelopes. */
export function containsPoint(
  polygon: readonly Point[],
  point: Point,
): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    const crosses = yi > point[1] !== yj > point[1];
    if (crosses && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

const EARTH_RADIUS_METERS = 6371008.8;

/** Spherical destination, matching the host helper the native plugin receives. */
export function destination(
  latitude: number,
  longitude: number,
  distanceMeters: number,
  bearingDegrees: number,
): readonly [number, number] {
  const d = distanceMeters / EARTH_RADIUS_METERS;
  const phi = (latitude * Math.PI) / 180;
  const theta = (bearingDegrees * Math.PI) / 180;
  const lat = Math.asin(
    Math.sin(phi) * Math.cos(d) + Math.cos(phi) * Math.sin(d) * Math.cos(theta),
  );
  const dlon = Math.atan2(
    Math.sin(theta) * Math.sin(d) * Math.cos(phi),
    Math.cos(d) - Math.sin(phi) * Math.sin(lat),
  );
  return [(lat * 180) / Math.PI, longitude + (dlon * 180) / Math.PI];
}
