// Turns one vector tile into particle-features geometry: the points, lines and
// polygons of one source layer that the native host feeds the plugin's layout
// callbacks, filtered and scaled the way it does, laid out by layout.ts. Each
// kept feature stays around for its data-driven paint values, which the
// shared paint binder fills per vertex range as the host's binders do.

import { VectorTile, type VectorTileFeature } from "@mapbox/vector-tile";
import {
  type AttributeLayout,
  type Current,
  type EvaluationFeature,
  type FeatureSource,
  fillAttributes,
} from "@maplibre-plugins/paint";
import {
  type FeatureFilter,
  featureFilter,
  type FilterSpecification,
  type ICanonicalTileID,
} from "@maplibre/maplibre-gl-style-spec";
import { PbfReader } from "pbf";

import {
  FeatureLayout,
  FLOATS_PER_VERTEX,
  type Kind,
  type Point,
  type Range,
} from "./layout.ts";
import { EXTENT } from "./spec.ts";

/** The one layer maplibre-gl encodes a GeoJSON source's tiles into. */
export const GEOJSON_SOURCE_LAYER = "_geojsonTileLayer";
/** Prefix maplibre-gl gives nested GeoJSON property values it encodes as JSON strings. */
const JSON_PREFIX = "__$json__:";

/** MVT geometry types 1-3 by the layout kind they take. */
const KINDS: readonly (Kind | null)[] = [null, "point", "line", "polygon"];

/** Tile coordinates are int16 in the host; a feature reaching past them loses its geometry there. */
const MIN_COORDINATE = -32768;
const MAX_COORDINATE = 32767;

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

/** One tile's particle slots: the a_emit stream and, per range, its feature. */
export interface TileLayout {
  /** a_emit vertices, FLOATS_PER_VERTEX each, four per slot. */
  vertices: Float32Array;
  vertexCount: number;
  /** Kept slots: the tile draws 6 · quads indices of the shared quad pattern. */
  quads: number;
  /** One contiguous range per feature that kept slots, covering every vertex once. */
  ranges: Range[];
  /** The feature of each range, as data-driven expressions see it. */
  features: EvaluationFeature[];
}

/**
 * A tile's layout once its a_emit stream is on the GPU: what drawing and the
 * data-driven values still read. The layer keeps this, not the vertices.
 */
export type TileSlots = Omit<TileLayout, "vertices">;

/** Compiles a style filter, or null for "everything". Throws on invalid filters. */
export function compileFilter(
  filter: FilterSpecification | undefined,
): FeatureFilter | null {
  if (filter === undefined) return null;
  return featureFilter(filter, "filter");
}

/** C's roundf: to nearest, halves away from zero. */
function roundAway(x: number): number {
  return Math.sign(x) * Math.floor(Math.abs(x) + 0.5);
}

/**
 * A feature's paths in layout coordinates (0..EXTENT across the tile), as
 * MapLibre Native reads them: roundf(float(x) · 8192 / extent) in f32, one
 * path per point, line or ring, and no geometry at all when a point falls
 * outside int16.
 */
export function tileGeometry(feature: VectorTileFeature): Point[][] {
  const scale = Math.fround(EXTENT / feature.extent);
  const paths: Point[][] = [];
  for (const path of feature.loadGeometry()) {
    const points: Point[] = [];
    for (const p of path) {
      const x = roundAway(Math.fround(Math.fround(p.x) * scale));
      const y = roundAway(Math.fround(Math.fround(p.y) * scale));
      if (
        x < MIN_COORDINATE ||
        x > MAX_COORDINATE ||
        y < MIN_COORDINATE ||
        y > MAX_COORDINATE
      )
        return [];
      // | 0 turns -0 into 0, as the host's integers are.
      points.push({ x: x | 0, y: y | 0 });
    }
    paths.push(points);
  }
  return paths;
}

/** The feature as filters and data-driven expressions see it, with nested GeoJSON values decoded. */
function evaluationFeature(feature: VectorTileFeature): {
  type: 1 | 2 | 3;
  id?: number;
  properties: Record<string, unknown>;
  geometry?: Point[][];
} {
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(feature.properties)) {
    properties[key] =
      typeof value === "string" && value.startsWith(JSON_PREFIX)
        ? (JSON.parse(value.slice(JSON_PREFIX.length)) as unknown)
        : value;
  }
  const result: ReturnType<typeof evaluationFeature> = {
    type: feature.type as 1 | 2 | 3,
    properties,
  };
  if (feature.id !== undefined) result.id = feature.id;
  return result;
}

/**
 * Lays out the points, lines and polygons of one source layer in a raw
 * vector tile, in the tile's feature order like the host. Returns null when
 * the tile has no such layer. `zoom` is the tile's overscaled zoom, which the
 * filter sees like a native layout would.
 */
export function layoutTile(
  data: ArrayBuffer,
  sourceLayer: string,
  filter: FeatureFilter | null,
  zoom: number,
  canonical: CanonicalTile,
): TileLayout | null {
  const tile = new VectorTile(new PbfReader(data));
  const layer = tile.layers[sourceLayer];
  if (!layer) return null;
  const layout = new FeatureLayout(EXTENT);
  const tileID = new FilterTileID(canonical.z, canonical.x, canonical.y);
  const features = new Map<number, EvaluationFeature>();
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    const kind = KINDS[feature.type];
    if (!kind) continue;
    const evaluation = evaluationFeature(feature);
    let paths: Point[][] | null = null;
    if (filter) {
      if (filter.needGeometry)
        evaluation.geometry = paths = tileGeometry(feature);
      if (!filter.filter({ zoom }, evaluation, tileID)) continue;
    }
    layout.add(kind, i, paths ?? tileGeometry(feature));
    features.set(i, evaluation);
  }
  layout.finish();
  return {
    vertices: layout.vertices,
    vertexCount: layout.vertices.length / FLOATS_PER_VERTEX,
    quads: layout.quads,
    ranges: layout.ranges,
    features: layout.ranges.map((range) => features.get(range.featureIndex)!),
  };
}

/**
 * What the paint binder reads of a tile's kept features. particle-features
 * takes no feature-state (its data-driven properties do not declare
 * FEATURE_STATE), so no feature has a state key.
 */
export function tileFeatureSource(
  tile: Pick<TileSlots, "ranges" | "features">,
): FeatureSource {
  const features = new Map<number, EvaluationFeature>();
  tile.ranges.forEach((range, i) =>
    features.set(range.featureIndex, tile.features[i]!),
  );
  return {
    feature: (index) => features.get(index),
    stateKey: () => undefined,
    state: () => undefined,
  };
}

/**
 * A tile's data-driven attributes, interleaved as `layout` says and filled
 * the way the host's binders fill them: each feature's value at `zoom` (the
 * tile's overscaled zoom) as the minimum and, for a value that also depends
 * on zoom, at `zoom + 1` as the maximum, repeated over the feature's
 * vertices.
 */
export function tileAttributes<Name extends string>(
  tile: Pick<TileSlots, "vertexCount" | "ranges" | "features">,
  layout: AttributeLayout<Name>,
  current: Readonly<Record<Name, Current>>,
  zoom: number,
): Float32Array {
  const values = new Float32Array(layout.stride * tile.vertexCount);
  fillAttributes(
    values,
    layout,
    current,
    tile.ranges,
    tileFeatureSource(tile),
    zoom,
  );
  return values;
}
