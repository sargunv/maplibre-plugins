// Reads the point features of one tile: the same features the native host
// feeds the plugin's layout callbacks, filtered and scaled the same way.
// maplibre-gl-js has already decoded the tile (gljs.ts hands over the
// feature index's layers, MVT or MLT alike); layout.ts turns the points
// into quads, and the paint binder and queries read each feature's
// properties and state id.

import type { EvaluationFeature } from "@maplibre-plugins/paint";
import {
  type FeatureFilter,
  featureFilter,
  type FilterSpecification,
  type ICanonicalTileID,
} from "@maplibre/maplibre-gl-style-spec";

import type { VectorFeatureLike, VectorLayerLike } from "./gljs.ts";
import { EXTENT } from "./spec.ts";

export interface CanonicalTile {
  z: number;
  x: number;
  y: number;
}

/** The tile identity a filter expression may inspect (`within`, distance). */
class FilterTileID implements ICanonicalTileID {
  readonly key: string;
  constructor(
    readonly z: number,
    readonly x: number,
    readonly y: number,
  ) {
    this.key = `${z}/${x}/${y}`;
  }
  equals(id: ICanonicalTileID): boolean {
    return id.z === this.z && id.x === this.x && id.y === this.y;
  }
  url(): string {
    return "";
  }
  isChildOf(parent: ICanonicalTileID): boolean {
    const dz = this.z - parent.z;
    return dz > 0 && parent.x === this.x >> dz && parent.y === this.y >> dz;
  }
  getTilePoint(coord: { x: number; y: number }): { x: number; y: number } {
    const tiles = 2 ** this.z;
    return {
      x: (coord.x * tiles - this.x) * EXTENT,
      y: (coord.y * tiles - this.y) * EXTENT,
    };
  }
  toString(): string {
    return this.key;
  }
}

/** A point in layout coordinates: whole numbers, 0..EXTENT across the tile. */
export interface TilePoint {
  x: number;
  y: number;
}

export interface PointFeature {
  /** The feature's index in its source layer. */
  readonly index: number;
  /**
   * Every point of the feature (several for a MultiPoint), including those
   * in the tile's buffer, which the layout leaves to the neighbouring tile.
   */
  readonly points: TilePoint[];
  /** What paint expressions read: decoded properties and the feature's own id. */
  readonly evaluation: EvaluationFeature;
  /** The feature-state id (the id, or the promoted property), if any. */
  readonly id: number | string | undefined;
  /** String(id): the key of the feature's state; undefined without an id. */
  readonly stateKey: string | undefined;
}

/** Compiles a style filter, or null for "everything". Throws on invalid filters. */
export function compileFilter(
  filter: FilterSpecification | undefined,
): FeatureFilter | null {
  if (filter === undefined) return null;
  return featureFilter(filter, "filter");
}

/**
 * maplibre-gl-js's GeoJSON worker stores object and array properties as
 * strings with this prefix in the tiles it encodes; MapLibre Native reads
 * the GeoJSON itself, so its expressions see the values.
 */
const JSON_PREFIX = "__$json__:";

/**
 * A copy of the properties, never the tile's own object (an MLT layer
 * shares it between reads), with a GeoJSON source's encoded values decoded.
 */
function readProperties(
  properties: Readonly<Record<string, unknown>> | undefined,
  geojson: boolean,
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...properties };
  if (!geojson) return copy;
  for (const [key, value] of Object.entries(copy)) {
    if (typeof value === "string" && value.startsWith(JSON_PREFIX)) {
      try {
        copy[key] = JSON.parse(value.slice(JSON_PREFIX.length));
      } catch {
        // Not maplibre-gl-js's encoding after all; keep the string.
      }
    }
  }
  return copy;
}

/** An id as a feature carries it: MLT gives NaN for none. */
function presentId(id: unknown): number | string | undefined {
  if (typeof id === "number") return Number.isNaN(id) ? undefined : id;
  return typeof id === "string" ? id : undefined;
}

/**
 * Scales a tile coordinate to EXTENT like MapLibre Native's vector tile
 * reader: in single precision, then `roundf`, which rounds halves away from
 * zero where Math.round rounds them up.
 */
function toLayout(value: number, scale: number): number {
  const scaled = Math.fround(Math.fround(value) * scale);
  // `0 -` turns a negative that rounds to zero into 0 rather than -0.
  return scaled < 0 ? 0 - Math.round(-scaled) : Math.round(scaled);
}

export interface ReadOptions {
  /** A GeoJSON source, whose tiles encode object and array properties. */
  readonly geojson: boolean;
  readonly filter: FeatureFilter | null;
  /** The tile's overscaled zoom, which the filter sees like a layout would. */
  readonly zoom: number;
  readonly canonical: CanonicalTile;
  /** The feature-state id of a feature (gl-js's FeatureIndex.getId). */
  stateId(feature: VectorFeatureLike): unknown;
}

/**
 * The point features of one source layer of a decoded tile, in source order,
 * or null when the tile has no such layer.
 */
export function readPointFeatures(
  layer: VectorLayerLike | undefined,
  options: ReadOptions,
): PointFeature[] | null {
  if (!layer) return null;
  const { geojson, filter, zoom, canonical } = options;
  const features: PointFeature[] = [];
  const tileID = new FilterTileID(canonical.z, canonical.x, canonical.y);
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    if (feature.type !== 1) continue;
    const scale = Math.fround(EXTENT / Math.fround(feature.extent));
    const paths = feature
      .loadGeometry()
      .map((path) =>
        path.map((p) => ({ x: toLayout(p.x, scale), y: toLayout(p.y, scale) })),
      );
    const properties = readProperties(feature.properties, geojson);
    const ownId = presentId(feature.id);
    const evaluation: EvaluationFeature =
      ownId === undefined
        ? { type: 1, properties }
        : { type: 1, id: ownId, properties };
    if (filter) {
      // `within` and `distance` read a `geometry` field in layout
      // coordinates, which the host's filter sees.
      const filtered = filter.needGeometry
        ? { ...evaluation, geometry: paths }
        : evaluation;
      if (!filter.filter({ zoom }, filtered as never, tileID)) continue;
    }
    const id = presentId(options.stateId(feature));
    features.push({
      index: i,
      points: paths.flat(),
      evaluation,
      id,
      stateKey: id === undefined ? undefined : String(id),
    });
  }
  return features;
}
