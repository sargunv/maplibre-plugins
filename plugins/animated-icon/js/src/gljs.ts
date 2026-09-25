// The maplibre-gl-js internals the layer reads, and the only module that
// touches them: a source's tile manager (its visible tiles, each tile's
// feature index and the source's feature state) and the feature index's
// decoded vector-tile layers and ids. None of them is public API, though all
// are typed in maplibre-gl's declarations; each access checks the shape it
// relies on and throws one GlJsInternalsError naming what moved, so a
// maplibre-gl upgrade that changes them fails clearly instead of drawing
// nothing. Checked against maplibre-gl 6.10.

import type {
  FeatureIndex,
  Map as MaplibreMap,
  OverscaledTileID,
  Tile,
} from "maplibre-gl";

/** The source layer maplibre-gl-js gives the features of a GeoJSON source. */
export const GEOJSON_SOURCE_LAYER = "_geojsonTileLayer";

/** Thrown when a maplibre-gl internal the layer reads has moved. */
export class GlJsInternalsError extends Error {
  override name = "GlJsInternalsError";
  constructor(what: string) {
    super(
      `animated-icon: maplibre-gl's internals changed (${what}); this layer supports maplibre-gl >=6.10 <7`,
    );
  }
}

type TileManager = MaplibreMap["style"]["tileManagers"][string];

/** A feature of a decoded vector-tile layer: MVT, MLT or GeoJSON-as-MVT. */
export interface VectorFeatureLike {
  /** 1 point, 2 line, 3 polygon; MLT gives 0 for unknown geometry. */
  readonly type: number;
  /** A number for MVT and GeoJSON; NaN for an MLT feature without one. */
  readonly id?: number | string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly extent: number;
  loadGeometry(): ReadonlyArray<ReadonlyArray<{ x: number; y: number }>>;
}

export interface VectorLayerLike {
  readonly length: number;
  feature(index: number): VectorFeatureLike;
}

/** What the layer reads of a source's SourceFeatureState. */
export interface FeatureStateLike {
  /** Bumps whenever coalesced state changes; restarts at 0 for a new object. */
  readonly revision: number;
  /** Coalesced state, by source layer and then String(feature id). */
  readonly state: Readonly<
    Record<string, Readonly<Record<string, Readonly<Record<string, unknown>>>>>
  >;
}

/** One loaded tile's decoded data. */
export interface TileData {
  /**
   * The raw tile the features come from, compared by identity: a reload
   * (setData, an expired tile) replaces it.
   */
  readonly raw: ArrayBuffer;
  layers(): Readonly<Record<string, VectorLayerLike>>;
  /** The feature-state id: the feature's id, or its promoted property. */
  stateId(feature: VectorFeatureLike, sourceLayer: string): unknown;
}

function isFunction(value: unknown): boolean {
  return typeof value === "function";
}

/** The tile manager of a source, or null while the style or source is missing. */
function manager(map: MaplibreMap, source: string): TileManager | null {
  const style = (map as { style?: MaplibreMap["style"] }).style;
  if (!style) return null;
  const managers = (style as { tileManagers?: unknown }).tileManagers;
  if (typeof managers !== "object" || managers === null)
    throw new GlJsInternalsError("map.style.tileManagers is gone");
  const found = (managers as Record<string, TileManager | undefined>)[source];
  if (!found) return null;
  for (const method of [
    "getVisibleCoordinates",
    "getTileByID",
    "getState",
    "getSource",
  ] as const) {
    if (!isFunction((found as unknown as Record<string, unknown>)[method]))
      throw new GlJsInternalsError(`TileManager.${method} is gone`);
  }
  return found;
}

/**
 * A source's tiles, as the layer reads them: null while the style has no
 * such source.
 */
export interface SourceTiles {
  /** The source's type: "vector", "geojson", ... */
  readonly type: string;
  /** The tiles to draw this frame, in maplibre-gl-js's order. */
  visibleCoordinates(): OverscaledTileID[];
  /** A loaded tile's data, or null while it has none (loading, or empty). */
  tile(key: string): TileData | null;
  /** The source's feature state; a new object after the source is re-added. */
  featureState(): FeatureStateLike;
}

export function sourceTiles(
  map: MaplibreMap,
  source: string,
): SourceTiles | null {
  const found = manager(map, source);
  if (!found) return null;
  const type = (found.getSource() as { type?: unknown } | undefined)?.type;
  return {
    type: typeof type === "string" ? type : "",
    visibleCoordinates: () => found.getVisibleCoordinates(),
    tile: (key) => tileData(found.getTileByID(key)),
    featureState: () => {
      const state = found.getState() as unknown as Partial<FeatureStateLike>;
      if (
        typeof state?.revision !== "number" ||
        typeof state.state !== "object" ||
        state.state === null
      )
        throw new GlJsInternalsError("SourceFeatureState changed shape");
      return state as FeatureStateLike;
    },
  };
}

/**
 * The tile's feature index and raw data. An emptied tile (a GeoJSON tile
 * that lost its features) clears latestFeatureIndex but keeps
 * latestRawTileData, so only the feature index's raw data says what the tile
 * holds now.
 */
function tileData(tile: Tile | undefined): TileData | null {
  const index = (tile as { latestFeatureIndex?: FeatureIndex | null })
    ?.latestFeatureIndex;
  if (!index) return null;
  const members = index as unknown as Record<string, unknown>;
  if (!isFunction(members.loadVTLayers) || !isFunction(members.getId))
    throw new GlJsInternalsError("FeatureIndex.loadVTLayers or getId is gone");
  const raw = index.rawTileData as ArrayBuffer | undefined | null;
  if (!raw) return null;
  return {
    raw,
    layers: () =>
      index.loadVTLayers() as unknown as Record<string, VectorLayerLike>,
    stateId: (feature, sourceLayer) =>
      index.getId(feature as never, sourceLayer) as unknown,
  };
}
