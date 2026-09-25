// The CPU mirror of maplibre-gl-js's projectTile() for custom layers, from
// its globe prelude (_projection_globe.vertex.glsl), so hit tests place icons
// where the vertex shader drew them. While the globe draws, gl-js hands a
// layer the unit-sphere view-projection matrix as mainMatrix and the mercator
// tile matrix as fallbackMatrix, and blends the two by projectionTransition;
// in mercator, and on the globe at high zoom, the transition is 0 and the
// tile matrix alone places the tile. Double precision where the shader has
// f32, and no pole vertices: anchors lie inside their tile.

import type { Clip } from "./place.ts";

/** The parts of gl-js's per-tile projection data that projectTile reads. */
export interface GlobeProjection {
  /** The globe's view-projection matrix, unit-sphere positions to clip. */
  readonly mainMatrix: ArrayLike<number>;
  /** The mercator tile matrix, tile units to clip. */
  readonly fallbackMatrix: ArrayLike<number>;
  /** The tile's mercator offset (x, y) and scale per tile unit (z, w). */
  readonly tileMercatorCoords: readonly [number, number, number, number];
  /** The horizon plane on the unit sphere; the visible side is positive. */
  readonly clippingPlane: readonly [number, number, number, number];
  /** 0 is mercator, 1 is the globe. */
  readonly projectionTransition: number;
}

/** Copies the fields projectTile reads out of gl-js's projection data. */
export function globeProjection(data: GlobeProjection): GlobeProjection {
  return {
    mainMatrix: Float64Array.from(data.mainMatrix),
    fallbackMatrix: Float64Array.from(data.fallbackMatrix),
    tileMercatorCoords: [...data.tileMercatorCoords] as [
      number,
      number,
      number,
      number,
    ],
    clippingPlane: [...data.clippingPlane] as [number, number, number, number],
    projectionTransition: data.projectionTransition,
  };
}

function transform(
  m: ArrayLike<number>,
  x: number,
  y: number,
  z: number,
): [number, number, number, number] {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
    m[3]! * x + m[7]! * y + m[11]! * z + m[15]!,
  ];
}

const HIDDEN: Clip = [0, 0, 0, -1];

/**
 * A tile point's position on the unit sphere, as projectToSphere computes
 * it: mercator x becomes the longitude and mercator y the latitude.
 */
export function sphereAt(
  mercator: readonly [number, number, number, number],
  x: number,
  y: number,
): [number, number, number] {
  const mx = mercator[0] + mercator[2] * x;
  const my = mercator[1] + mercator[3] * y;
  const longitude = mx * Math.PI * 2 + Math.PI;
  // sin and cos of the latitude through the Gudermannian, as the prelude
  // writes them.
  const t = Math.exp(Math.PI - my * Math.PI * 2);
  const sinLatitude = (t * t - 1) / (t * t + 1);
  const cosLatitude = (2 * t) / (t * t + 1);
  return [
    Math.sin(longitude) * cosLatitude,
    sinLatitude,
    Math.cos(longitude) * cosLatitude,
  ];
}

/**
 * Tile units to clip space as projectTile places them. A point the GPU
 * would clip, such as one on the far side of the globe, has w = -1.
 */
export function globeProjector(
  data: GlobeProjection,
): (x: number, y: number) => Clip {
  const transition = data.projectionTransition;
  const plane = data.clippingPlane;
  return (x, y) => {
    let result: Clip;
    if (!(transition > 0)) {
      result = transform(data.fallbackMatrix, x, y, 0);
    } else {
      const p = sphereAt(data.tileMercatorCoords, x, y);
      const globe = transform(data.mainMatrix, p[0], p[1], p[2]);
      // The prelude replaces z so that the far side of the globe clips.
      const clipZ =
        1 - (p[0] * plane[0] + p[1] * plane[1] + p[2] * plane[2] + plane[3]);
      const globeZ = clipZ * globe[3];
      if (transition > 0.999) {
        result = [globe[0], globe[1], globeZ, globe[3]];
      } else {
        const flat = transform(data.fallbackMatrix, x, y, 0);
        const mix = (a: number, b: number, t: number) => a + (b - a) * t;
        // Globe z only over the last 80% of the transition.
        const zWeight = Math.min(Math.max((transition - 0.2) / 0.8, 0), 1);
        result = [
          mix(flat[0], globe[0], transition),
          mix(flat[1], globe[1], transition),
          mix(0, globeZ, zWeight),
          mix(flat[3], globe[3], transition),
        ];
      }
      if (!(Math.abs(result[2]) <= result[3])) return HIDDEN;
    }
    return result;
  };
}
