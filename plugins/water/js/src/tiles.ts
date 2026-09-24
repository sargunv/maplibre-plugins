// Turns one vector tile into shoreline geometry: the same features the
// native host feeds the plugin's layout callbacks, filtered the same way.
// The parsed rings stay around for hit testing.

import { VectorTile, type VectorTileFeature } from "@mapbox/vector-tile";
import {
  type FeatureFilter,
  featureFilter,
  type FilterSpecification,
  type ICanonicalTileID,
} from "@maplibre/maplibre-gl-style-spec";
import { PbfReader } from "pbf";

import { type Point, type Range, type Segment, ShoreLayout } from "./layout.ts";
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

export interface TileFeature {
  /** Rings in layout coordinates (0..EXTENT across the tile). */
  rings: Point[][];
  feature: VectorTileFeature;
}

export interface TileGeometry {
  vertices: Float32Array;
  indices: Uint16Array;
  segments: Segment[];
  ranges: Range[];
  features: TileFeature[];
}

/** Compiles a style filter, or null for "everything". Throws on invalid filters. */
export function compileFilter(
  filter: FilterSpecification | undefined,
): FeatureFilter | null {
  if (filter === undefined) return null;
  return featureFilter(filter, "filter");
}

/**
 * Lays out the polygon features of one source layer in a raw vector tile.
 * Returns null when the tile has no such layer. `zoom` is the tile's
 * overscaled zoom, which the filter sees like a layout would.
 */
export function layoutTile(
  data: ArrayBuffer,
  sourceLayer: string,
  filter: FeatureFilter | null,
  zoom: number,
  canonical: CanonicalTile,
): TileGeometry | null {
  const tile = new VectorTile(new PbfReader(data));
  const layer = tile.layers[sourceLayer];
  if (!layer) return null;
  const layout = new ShoreLayout(EXTENT);
  const features: TileFeature[] = [];
  const tileID = new FilterTileID(canonical.z, canonical.x, canonical.y);
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    if (feature.type !== 3) continue;
    if (filter && !filter.filter({ zoom }, feature, tileID)) continue;
    const scale = EXTENT / feature.extent;
    const rings = feature
      .loadGeometry()
      .map((ring) => ring.map((p) => ({ x: p.x * scale, y: p.y * scale })));
    const before = layout.vertexCount;
    layout.addPolygon(rings, i);
    if (layout.vertexCount > before) features.push({ rings, feature });
  }
  return {
    vertices: layout.vertices(),
    indices: layout.indices(),
    segments: layout.segments,
    ranges: layout.ranges,
    features,
  };
}
