// The camera-side inputs of the building shader (../../README.md,
// "Tile units and meters" and "Shading"): the style light as core
// fill-extrusion reads it, and the meters per tile unit a tile's roofs use.

/** maplibre-gl-js's earth radius (geo/lng_lat.ts earthRadius), in meters. */
export const EARTH_RADIUS = 6371008.8;
/** The tile extent the layout works in. */
const TILE_EXTENT = 8192;

/** The evaluated style light. */
export interface Light {
  readonly anchor: "map" | "viewport";
  /** [radial, azimuthal, polar]: azimuthal in degrees clockwise from north. */
  readonly position: readonly [number, number, number];
  /** Premultiplied [r, g, b, a] in 0..1, as style-spec colors are. */
  readonly color: readonly [number, number, number, number];
  readonly intensity: number;
}

/** The style spec's light defaults, which a style without `light` gets. */
export const DEFAULT_LIGHT: Light = {
  anchor: "viewport",
  position: [1.15, 210, 30],
  color: [1, 1, 1, 1],
  intensity: 0.5,
};

/** maplibre-gl-js's sphericalToCartesian (util/util.ts). */
export function sphericalToCartesian([r, azimuthal, polar]: readonly [
  number,
  number,
  number,
]): [number, number, number] {
  const a = ((azimuthal + 90) * Math.PI) / 180;
  const p = (polar * Math.PI) / 180;
  return [
    r * Math.cos(a) * Math.sin(p),
    r * Math.sin(a) * Math.sin(p),
    r * Math.cos(p),
  ];
}

/**
 * BuildingDrawableUBO's light_color (rgb, a = intensity) and light_position
 * (core's u_lightpos, w = 0), as maplibre-gl-js's
 * fillExtrusionUniformValues computes them: the light's Cartesian position,
 * rotated by the bearing (radians, clockwise from north) for a viewport
 * anchor.
 */
export function lightUniforms(
  light: Light,
  bearing: number,
): {
  color: [number, number, number, number];
  position: [number, number, number, number];
} {
  const [x, y, z] = sphericalToCartesian(light.position);
  const angle = light.anchor === "viewport" ? bearing : 0;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return {
    color: [light.color[0], light.color[1], light.color[2], light.intensity],
    position: [c * x - s * y, s * x + c * y, z, 0],
  };
}

/**
 * Meters per tile unit at the center latitude of a canonical tile, in f64:
 * 2π R cos(lat) / (2^z × 8192), with maplibre-gl-js's earth radius, so a
 * roof angle renders true under its projection.
 */
export function metersPerTileUnit(tile: { z: number; y: number }): number {
  const n = 2 ** tile.z;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (tile.y + 0.5)) / n)));
  return (2 * Math.PI * EARTH_RADIUS * Math.cos(lat)) / (n * TILE_EXTENT);
}
