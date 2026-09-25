import {
  type AttributeLayout,
  attributeLayout,
  type FeatureSource,
  type FeatureState,
  fillAttributes,
  isFeatureValue,
  type Vector,
} from "@maplibre-plugins/paint";
import type {
  CircleLayerSpecification,
  FilterSpecification,
} from "@maplibre/maplibre-gl-style-spec";
import type { Feature, Point as GeoJsonPoint } from "geojson";
import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MaplibreMap,
  OverscaledTileID,
} from "maplibre-gl";

import { Catalog } from "./catalog.ts";
import { clockSeconds } from "./clock.ts";
import catalogBase64 from "./generated/catalog.ts";
import {
  type FeatureStateLike,
  GEOJSON_SOURCE_LAYER,
  GlJsInternalsError,
  type SourceTiles,
  sourceTiles,
  type TileData,
} from "./gljs.ts";
import {
  type GlobeProjection,
  globeProjection,
  globeProjector,
} from "./globe.ts";
import {
  FLOATS_PER_VERTEX,
  IconLayout,
  type Range,
  type Segment,
} from "./layout.ts";
import {
  type AnimatedIconPaintState,
  createPaintState,
  type CurrentPaint,
  DEFAULT_TRANSITION,
  shouldAnimate,
  type TransitionOptions,
  uniformNumber,
} from "./paint.ts";
import { corners, hitPoint, type Resolved, type View } from "./place.ts";
import {
  ART_SAMPLER,
  ATTRIBUTE_SLOTS,
  CATALOG_BINDING,
  CATALOG_BLOCK,
  DRAWABLE_BINDING,
  DRAWABLE_BLOCK,
  DRAWABLE_OFFSETS,
  DRAWABLE_UBO_BYTES,
  fragmentSource,
  interpolationOffset,
  POSITION_LOCATION,
  PROJECTION_UNIFORMS,
  PROPERTY_OFFSETS,
  vertexSource,
} from "./shaders.ts";
import { EXTENT, LAYER_TYPE, type PaintName, paintNames } from "./spec.ts";
import {
  type CanonicalTile,
  compileFilter,
  type PointFeature,
  readPointFeatures,
} from "./tiles.ts";

const TILE_SIZE = 512;
/** Frames a tile's geometry survives after it stops being rendered. */
const EVICT_AFTER_FRAMES = 120;

/** Raw paint input: literals, CSS colors, or style expressions, keyed by property name. */
export type PaintInput = Partial<Record<PaintName, unknown>> &
  Partial<Record<`${PaintName}-transition`, TransitionOptions>>;

export interface AnimatedIconLayerOptions {
  id: string;
  /** A vector or GeoJSON source in the map's style. */
  source: string;
  /** The point layer inside the source's vector tiles, e.g. `poi`; omit it for a GeoJSON source. */
  sourceLayer?: string;
  filter?: FilterSpecification;
  paint?: PaintInput;
  minzoom?: number;
  maxzoom?: number;
  visibility?: "visible" | "none";
  /** Default transition for property changes; per-property `<name>-transition` overrides it. */
  transition?: TransitionOptions;
  /**
   * The animations icon-animation names, one catalog per layer; defaults to
   * the demo catalog the native plugin embeds. Load others with loadCatalog.
   */
  catalog?: Catalog;
}

/** A style-JSON layer object using the `animated-icon` type, as the native plugin accepts. */
export interface AnimatedIconLayerJson {
  id: string;
  type: typeof LAYER_TYPE;
  source: string;
  "source-layer"?: string;
  filter?: FilterSpecification;
  paint?: PaintInput;
  layout?: { visibility?: "visible" | "none" };
  minzoom?: number;
  maxzoom?: number;
}

/**
 * A feature under a query point: its state id, decoded properties and
 * anchor, like a rendered-feature query result of a built-in layer.
 */
export interface AnimatedIconFeature extends Feature<GeoJsonPoint> {
  /** The feature-state id; omitted for a feature without one. */
  id?: number | string;
  source: string;
  /** Omitted for a GeoJSON source. */
  sourceLayer?: string;
  layer: { id: string };
}

let demo: Catalog | null = null;

/** The baked demo catalog (../../catalog/demo.mlvc), parsed on first use. */
export function demoCatalog(): Catalog {
  demo ??= Catalog.fromBase64(catalogBase64);
  return demo;
}

interface Program {
  handle: WebGLProgram;
  uniforms: Partial<
    Record<(typeof PROJECTION_UNIFORMS)[number], WebGLUniformLocation | null>
  >;
}

/**
 * One tile's anchors and their paint attributes. The refresh rules follow
 * the native bucket: a new raw tile lays out again; a new feature-state
 * object, paint generation or attribute layout refills every attribute; a
 * feature-state revision refills the state-dependent ones of the features
 * whose state is or was set.
 */
interface TileEntry {
  /** The raw tile laid out, compared by identity; null for an empty tile. */
  raw: ArrayBuffer | null;
  canonical: CanonicalTile;
  features: PointFeature[];
  /** One range per anchor, in draw order; featureIndex indexes `features`. */
  ranges: Range[];
  /** Range indices by feature-state key. */
  byKey: Map<string, number[]>;
  /** Keys whose state was not empty at the last fill. */
  statedKeys: Set<string>;
  sfs: FeatureStateLike | null;
  rev: number;
  gen: number;
  layoutKey: string;
  positions: Float32Array;
  indices: Uint16Array;
  segments: Segment[];
  /** Per-vertex paint attributes, vertex count × layout stride. */
  paint: Float32Array;
  vao: WebGLVertexArrayObject | null;
  positionBuffer: WebGLBuffer | null;
  paintBuffer: WebGLBuffer | null;
  indexBuffer: WebGLBuffer | null;
  /** The layout key whose attribute arrays the VAO has enabled. */
  enabledKey: string;
  /** The last render's tile matrix and scale, for queries. */
  matrix: Float64Array | null;
  /** The last render's globe projection, while the globe draws. */
  globe: GlobeProjection | null;
  pixelsToTileUnits: number;
  lastUsed: number;
}

interface Resources {
  gl: WebGL2RenderingContext;
  programs: globalThis.Map<string, Program>;
  tiles: globalThis.Map<string, TileEntry>;
  /** The catalog texture, u_art. */
  art: WebGLTexture;
  /** IconCatalogUBO: the clock and the catalog's header table. */
  catalogBuffer: WebGLBuffer;
  /** IconDrawableUBO, rewritten for each tile. */
  drawableBuffer: WebGLBuffer;
  /** The clock last uploaded into catalogBuffer. */
  clock: number;
}

/** The camera values of the last render, for queries. */
interface LastView {
  viewport: [number, number];
  pixelRatio: number;
  cameraToCenter: number;
  bearing: number;
  /** Tile keys in draw order. */
  drawn: string[];
}

/**
 * A maplibre-gl-js custom layer drawing the same animated vector icons as
 * the native `animated-icon` plugin layer: one quad per point of a source
 * the style already loads, placed like a point-symbol icon, playing the
 * catalog animation its paint picks, per feature when the paint is
 * data-driven. The catalog lives in a float texture and a uniform block,
 * and data-driven values in per-vertex attributes, as the native host binds
 * them. Add it with `map.addLayer(layer, beforeId)`.
 */
export class AnimatedIconLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom";
  readonly renderingMode = "2d";
  readonly source: string;
  readonly sourceLayer: string | undefined;
  readonly catalog: Catalog;

  private filterJson: FilterSpecification | undefined;
  private filter: ReturnType<typeof compileFilter>;
  private readonly paint: AnimatedIconPaintState;
  private minzoom: number;
  private maxzoom: number;
  private visibility: "visible" | "none";
  private readonly defines: string;
  /** The IconCatalogUBO contents; only the clock changes. */
  private readonly header: Float32Array;
  private readonly drawable = new Float32Array(DRAWABLE_UBO_BYTES / 4);

  private map: MaplibreMap | null = null;
  private resources: Resources | null = null;
  private contextLost = false;
  /** Set once maplibre-gl's internals turned out to have moved. */
  private broken = false;
  private frame = 0;
  private lastView: LastView | null = null;
  private helperLayer: string | null = null;
  private readonly listeners: Array<() => void> = [];

  constructor(options: AnimatedIconLayerOptions) {
    this.id = options.id;
    this.source = options.source;
    this.sourceLayer = options.sourceLayer;
    this.catalog = options.catalog ?? demoCatalog();
    this.filterJson = options.filter;
    this.filter = compileFilter(options.filter);
    this.minzoom = options.minzoom ?? 0;
    this.maxzoom = options.maxzoom ?? 24;
    this.visibility = options.visibility ?? "visible";
    this.paint = createPaintState(
      this.catalog,
      { ...DEFAULT_TRANSITION, ...options.transition },
      options.paint ?? {},
    );
    this.defines = this.catalog.shaderDefines();
    this.header = new Float32Array(this.catalog.headerBlockFloats);
    this.catalog.writeHeaderBlock(0, this.header);
  }

  /** Builds a layer from style-layer JSON of type `animated-icon`, the form the native plugin consumes. */
  static fromLayerJson(
    json: AnimatedIconLayerJson,
    options: { transition?: TransitionOptions; catalog?: Catalog } = {},
  ): AnimatedIconLayer {
    const actual: string = (json as { type: string }).type;
    if (actual !== LAYER_TYPE) {
      throw new Error(`Expected layer type ${LAYER_TYPE}, got ${actual}`);
    }
    if (!json.source) throw new Error(`${LAYER_TYPE} layers need a source`);
    const layerOptions: AnimatedIconLayerOptions = {
      id: json.id,
      source: json.source,
    };
    if (json["source-layer"]) layerOptions.sourceLayer = json["source-layer"];
    if (json.filter !== undefined) layerOptions.filter = json.filter;
    if (json.paint) layerOptions.paint = json.paint;
    if (json.minzoom !== undefined) layerOptions.minzoom = json.minzoom;
    if (json.maxzoom !== undefined) layerOptions.maxzoom = json.maxzoom;
    if (json.layout?.visibility)
      layerOptions.visibility = json.layout.visibility;
    if (options.transition) layerOptions.transition = options.transition;
    if (options.catalog) layerOptions.catalog = options.catalog;
    return new AnimatedIconLayer(layerOptions);
  }

  /** The layer as style-layer JSON, with the current raw paint values. */
  toLayerJson(): AnimatedIconLayerJson {
    const json: AnimatedIconLayerJson = {
      id: this.id,
      type: LAYER_TYPE,
      source: this.source,
    };
    if (this.sourceLayer !== undefined) json["source-layer"] = this.sourceLayer;
    if (this.filterJson !== undefined) json.filter = this.filterJson;
    json.paint = this.paint.toJson() as PaintInput;
    if (this.minzoom !== 0) json.minzoom = this.minzoom;
    if (this.maxzoom !== 24) json.maxzoom = this.maxzoom;
    if (this.visibility !== "visible")
      json.layout = { visibility: this.visibility };
    return json;
  }

  getPaintProperty(name: PaintName): unknown {
    return this.paint.get(name);
  }

  /**
   * Sets a paint property or its `<name>-transition`, animating to the new
   * value like a native style transition; a data-driven value snaps.
   * Invalid values throw and leave the old value in place.
   */
  setPaintProperty(
    name: string,
    value: unknown,
    transition?: TransitionOptions,
  ): void {
    this.paint.set(name, value, now(), transition);
    this.map?.triggerRepaint();
  }

  /** Sets several paint properties at once with one transition. */
  setPaint(paint: PaintInput, transition?: TransitionOptions): void {
    for (const [name, value] of Object.entries(paint)) {
      this.setPaintProperty(name, value, transition);
    }
  }

  setLayoutProperty(name: "visibility", value: "visible" | "none"): void {
    if (name !== "visibility")
      throw new Error(`Unknown layout property ${String(name)}`);
    this.visibility = value;
    if (this.map) this.syncHelperLayer(this.map);
    this.map?.triggerRepaint();
  }

  /** Replaces the feature filter; tiles re-layout on their next frame. */
  setFilter(filter: FilterSpecification | undefined): void {
    this.filter = compileFilter(filter);
    this.filterJson = filter;
    this.dropTiles();
    this.map?.triggerRepaint();
  }

  setZoomRange(minzoom: number, maxzoom: number): void {
    this.minzoom = minzoom;
    this.maxzoom = maxzoom;
    if (this.map) this.syncHelperLayer(this.map);
    this.map?.triggerRepaint();
  }

  /** The animation clock the layer draws with; see clockSeconds(). */
  clockSeconds(): number {
    return clockSeconds();
  }

  /**
   * Every icon under a screen point (logical pixels from the map's top
   * left), topmost first, one per feature. Like the native query_feature,
   * each icon's box is placed with the paint values the host would use:
   * values the same for every feature at the map's zoom, transitions
   * included, and data-driven values evaluated at the tile's own zoom level
   * with the feature's state. The boxes come from the last render.
   */
  queryFeatures(point: { x: number; y: number }): AnimatedIconFeature[] {
    const map = this.map;
    const resources = this.resources;
    const last = this.lastView;
    if (!map || !resources || !last) return [];
    const current = this.paint.current(map.getZoom(), now());
    const layerState = this.layerState();
    const animations = this.catalog.animations;
    const results: AnimatedIconFeature[] = [];
    const seen = new Set<string>();
    for (let t = last.drawn.length - 1; t >= 0; t--) {
      const key = last.drawn[t]!;
      const entry = resources.tiles.get(key);
      if (!entry?.matrix) continue;
      const view: View = {
        matrix: entry.matrix,
        ...(entry.globe && { project: globeProjector(entry.globe) }),
        viewport: last.viewport,
        pixelRatio: last.pixelRatio,
        cameraToCenterDistance: last.cameraToCenter,
        pixelsToTileUnits: entry.pixelsToTileUnits,
        bearing: last.bearing,
      };
      for (let r = entry.ranges.length - 1; r >= 0; r--) {
        const range = entry.ranges[r]!;
        const feature = entry.features[range.featureIndex];
        if (!feature) continue;
        const dedupe =
          feature.stateKey === undefined
            ? `${key}:${feature.index}`
            : `id:${feature.stateKey}`;
        if (seen.has(dedupe)) continue;
        const state =
          feature.stateKey === undefined
            ? undefined
            : layerState?.[feature.stateKey];
        const resolved = resolve(current, feature, state, entry.canonical.z);
        const animation = animations[resolved.animation - 1];
        if (!animation) continue;
        const anchor = [
          entry.positions[range.firstVertex * FLOATS_PER_VERTEX]! / 2,
          entry.positions[range.firstVertex * FLOATS_PER_VERTEX + 1]! / 2,
        ] as const;
        const quad = corners(
          anchor,
          resolved,
          { box: animation.box, displayPx: animation.displayPx },
          view,
        );
        if (!quad || !hitPoint(quad, [point.x, point.y])) continue;
        seen.add(dedupe);
        results.push(this.toFeature(feature, entry.canonical, anchor));
      }
    }
    return results;
  }

  /** The topmost icon's feature under a screen point, or null. */
  queryFeature(point: { x: number; y: number }): AnimatedIconFeature | null {
    return this.queryFeatures(point)[0] ?? null;
  }

  /** Whether a screen point is over an icon. */
  hitTest(point: { x: number; y: number }): boolean {
    return this.queryFeature(point) !== null;
  }

  onAdd(map: MaplibreMap, _gl: WebGL2RenderingContext): void {
    this.map = map;
    this.contextLost = false;
    this.addHelperLayer(map);
    const lost = () => {
      this.contextLost = true;
      this.resources = null;
    };
    const restored = () => {
      this.contextLost = false;
      map.triggerRepaint();
    };
    // A layer added before its source gets its helper once the source
    // exists. Source events fire outside the render pass, where adding a
    // layer is safe.
    const sourcedata = () => {
      if (this.helperLayer === null) this.addHelperLayer(map);
    };
    map.on("webglcontextlost", lost);
    map.on("webglcontextrestored", restored);
    map.on("sourcedata", sourcedata);
    this.listeners.push(
      () => map.off("webglcontextlost", lost),
      () => map.off("webglcontextrestored", restored),
      () => map.off("sourcedata", sourcedata),
    );
  }

  onRemove(map: MaplibreMap): void {
    for (const remove of this.listeners.splice(0)) remove();
    this.removeHelperLayer(map);
    this.release();
    this.lastView = null;
    this.map = null;
  }

  render(gl: WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    if (this.broken) return;
    try {
      this.draw(gl, args);
    } catch (error) {
      // Report moved internals once, then stay out of the way.
      if (error instanceof GlJsInternalsError) this.broken = true;
      throw error;
    }
  }

  private draw(gl: WebGL2RenderingContext, args: CustomRenderMethodInput) {
    const map = this.map;
    if (!map || this.contextLost || gl.isContextLost()) return;
    this.frame++;
    const zoom = map.getZoom();
    if (
      this.visibility === "none" ||
      zoom < this.minzoom ||
      zoom >= this.maxzoom
    ) {
      this.lastView = null;
      return;
    }

    const time = now();
    const current = this.paint.current(zoom, time);
    if (this.paint.active(time) || this.animates(current)) map.triggerRepaint();
    const tiles = this.drawsAnything(current)
      ? sourceTiles(map, this.source)
      : null;
    const coords = tiles?.visibleCoordinates() ?? [];
    if (!tiles || coords.length === 0) {
      this.lastView = null;
      return;
    }

    const resources = this.resources ?? this.acquire(gl);
    const layout = attributeLayout(paintNames, current);
    const generation = this.paint.generation;
    const program = this.program(resources, args, layout.key);
    // The camera values MapLibre Native's uniform context carries, in
    // logical pixels.
    const canvas = map.getCanvas();
    const width = Math.max(canvas.clientWidth, 1);
    const height = Math.max(canvas.clientHeight, 1);
    const pixelRatio = gl.drawingBufferWidth / width;
    const cameraToCenter = (0.5 * height) / Math.tan(args.fov / 2);
    // MapLibre Native's transform keeps the camera bearing negated.
    const bearing = (-map.getBearing() * Math.PI) / 180;
    const drawn: string[] = [];
    this.lastView = {
      viewport: [width, height],
      pixelRatio,
      cameraToCenter,
      bearing,
      drawn,
    };

    const previousVao = gl.getParameter(
      gl.VERTEX_ARRAY_BINDING,
    ) as WebGLVertexArrayObject | null;
    try {
      gl.useProgram(program.handle);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.STENCIL_TEST);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, resources.art);
      // Another custom layer may use the same binding points, so bind both
      // blocks on every render. The catalog block changes only its clock.
      gl.bindBufferBase(
        gl.UNIFORM_BUFFER,
        CATALOG_BINDING,
        resources.catalogBuffer,
      );
      this.catalog.writeHeaderBlock(clockSeconds(), this.header);
      if (this.header[0] !== resources.clock) {
        gl.bufferSubData(gl.UNIFORM_BUFFER, 0, this.header, 0, 4);
        resources.clock = this.header[0]!;
      }
      gl.bindBufferBase(
        gl.UNIFORM_BUFFER,
        DRAWABLE_BINDING,
        resources.drawableBuffer,
      );
      this.writePaintUniforms(current);
      const block = this.drawable;
      block[DRAWABLE_OFFSETS.camera / 4] = 2 / width;
      block[DRAWABLE_OFFSETS.camera / 4 + 1] = -2 / height;
      block[DRAWABLE_OFFSETS.camera / 4 + 3] = cameraToCenter;
      block[DRAWABLE_OFFSETS.view / 4] = pixelRatio;
      block[DRAWABLE_OFFSETS.view / 4 + 1] = bearing;

      for (const coord of coords) {
        const entry = this.tileEntry(
          resources,
          tiles,
          coord,
          current,
          layout,
          generation,
        );
        // A visible tile without anchors stays cached too, or eviction
        // would parse it again every few seconds while icons animate.
        entry.lastUsed = this.frame;
        if (!entry.vao || entry.segments.length === 0) continue;
        const projection = args.getProjectionData({
          tileID: { wrap: coord.wrap, canonical: coord.canonical },
          applyGlobeMatrix: true,
        });
        this.setProjectionUniforms(gl, program, projection);
        // Layout coordinates span the canonical tile, also when overscaled.
        const pixelsToTileUnits =
          EXTENT / (TILE_SIZE * 2 ** (zoom - coord.canonical.z));
        // The mercator tile matrix: in mercator gl-js's mainMatrix is the
        // same, but while the globe draws it is the unit-sphere
        // view-projection matrix, which queries then read through globe.ts
        // as projectTile does. The vertex shader projects through
        // projectTile and never reads the block's matrix.
        entry.matrix = Float64Array.from(projection.fallbackMatrix);
        entry.globe =
          projection.projectionTransition > 0
            ? globeProjection(projection)
            : null;
        entry.pixelsToTileUnits = pixelsToTileUnits;
        drawn.push(coord.key);
        block.set(entry.matrix, DRAWABLE_OFFSETS.matrix / 4);
        block[DRAWABLE_OFFSETS.camera / 4 + 2] = pixelsToTileUnits;
        this.writeInterpolation(current, layout, coord.overscaledZ, zoom);
        gl.bufferSubData(gl.UNIFORM_BUFFER, 0, block);
        this.drawTile(gl, entry, layout);
      }
    } finally {
      gl.bindVertexArray(previousVao);
    }
    if (this.frame % 30 === 0) this.evict(resources);
  }

  /**
   * Whether the map keeps repainting for these values: a playing animation
   * of more than one frame, unless shouldAnimate rules it out.
   */
  private animates(current: CurrentPaint): boolean {
    if (!shouldAnimate(current)) return false;
    const index = uniformNumber(current, "icon-animation");
    if (index === null) return true;
    return (this.catalog.animations[index - 1]?.frameCount ?? 0) > 1;
  }

  /** False when a value the same for every feature collapses every icon. */
  private drawsAnything(current: CurrentPaint): boolean {
    const animation = uniformNumber(current, "icon-animation");
    const size = uniformNumber(current, "icon-size");
    const opacity = uniformNumber(current, "icon-opacity");
    return (
      (animation === null ||
        (animation >= 1 && animation <= this.catalog.animations.length)) &&
      (size === null || size > 0) &&
      (opacity === null || opacity > 0)
    );
  }

  /** The source layer's coalesced feature states, by String(id). */
  private layerState():
    | Readonly<Record<string, Readonly<Record<string, unknown>>>>
    | undefined {
    const map = this.map;
    if (!map) return undefined;
    const tiles = sourceTiles(map, this.source);
    return tiles?.featureState().state[
      this.sourceLayer ?? GEOJSON_SOURCE_LAYER
    ];
  }

  private toFeature(
    feature: PointFeature,
    canonical: CanonicalTile,
    anchor: readonly [number, number],
  ): AnimatedIconFeature {
    const result: AnimatedIconFeature = {
      type: "Feature",
      geometry: { type: "Point", coordinates: lngLat(canonical, anchor) },
      properties: { ...feature.evaluation.properties },
      source: this.source,
      layer: { id: this.id },
    };
    if (feature.id !== undefined) result.id = feature.id;
    if (this.sourceLayer !== undefined) result.sourceLayer = this.sourceLayer;
    return result;
  }

  /**
   * gl-js loads a source's tiles only while a visible built-in layer uses
   * it, and custom layers never count; nor does it apply feature-state to a
   * source no such layer uses. So every layer gets its own hidden circle
   * layer, `<id>-tiles`, with this layer's visibility and zoom range:
   * removing, hiding or zoom-limiting any other layer cannot unload this
   * layer's tiles, and they load exactly when the native layer's would.
   */
  private addHelperLayer(map: MaplibreMap): void {
    if (!map.getSource(this.source)) return;
    const id = `${this.id}-tiles`;
    // A style restored after context loss keeps the helper but drops this
    // layer; adopt it so it goes away with the layer again.
    if (map.getLayer(id)) {
      this.helperLayer = id;
      this.syncHelperLayer(map);
      return;
    }
    const helper: CircleLayerSpecification = {
      id,
      type: "circle",
      source: this.source,
      // No feature passes, so the worker builds no circles; the tiles and
      // their raw data still load, since that depends only on the layer
      // not being hidden.
      filter: false,
      layout: { visibility: this.visibility },
      paint: {
        "circle-radius": 0,
        "circle-opacity": 0,
        "circle-stroke-width": 0,
      },
    };
    if (this.sourceLayer !== undefined)
      helper["source-layer"] = this.sourceLayer;
    if (this.minzoom !== 0) helper.minzoom = this.minzoom;
    if (this.maxzoom !== 24) helper.maxzoom = this.maxzoom;
    map.addLayer(helper, this.id);
    this.helperLayer = id;
  }

  /** Gives the helper layer this layer's visibility and zoom range. */
  private syncHelperLayer(map: MaplibreMap): void {
    const id = this.helperLayer;
    if (id === null || !map.getLayer(id)) return;
    map.setLayoutProperty(id, "visibility", this.visibility);
    map.setLayerZoomRange(id, this.minzoom, this.maxzoom);
  }

  private removeHelperLayer(map: MaplibreMap): void {
    const id = this.helperLayer;
    this.helperLayer = null;
    if (id === null) return;
    // When the whole style is torn down, the helper goes with it and the
    // style may refuse changes.
    try {
      if (map.getLayer(id)) map.removeLayer(id);
    } catch {
      // Nothing left to remove.
    }
  }

  /**
   * A tile's entry, brought up to date: laid out again when its raw tile
   * changed (or emptied), refilled when the feature-state object, the paint
   * generation or the attribute layout changed, and partly refilled when
   * the feature states changed and a bound value reads them.
   */
  private tileEntry(
    resources: Resources,
    tiles: SourceTiles,
    coord: OverscaledTileID,
    current: CurrentPaint,
    layout: AttributeLayout<PaintName>,
    generation: number,
  ): TileEntry {
    const { gl } = resources;
    const data = tiles.tile(coord.key);
    const raw = data?.raw ?? null;
    const sfs = tiles.featureState();
    let entry = resources.tiles.get(coord.key);
    if (!entry || entry.raw !== raw) {
      if (entry) this.releaseTile(gl, entry);
      entry = this.layoutTile(gl, data, tiles.type, coord);
      resources.tiles.set(coord.key, entry);
      this.fill(gl, entry, sfs, current, layout, generation, coord.overscaledZ);
    } else if (
      entry.sfs !== sfs ||
      entry.gen !== generation ||
      entry.layoutKey !== layout.key
    ) {
      this.fill(gl, entry, sfs, current, layout, generation, coord.overscaledZ);
    } else if (entry.rev !== sfs.revision) {
      this.refillStates(gl, entry, sfs, current, layout, coord.overscaledZ);
    }
    return entry;
  }

  /** Quads for the points a tile owns, sorted and segmented like the native bucket. */
  private layoutTile(
    gl: WebGL2RenderingContext,
    data: TileData | null,
    sourceType: string,
    coord: OverscaledTileID,
  ): TileEntry {
    const sourceLayer = this.sourceLayer ?? GEOJSON_SOURCE_LAYER;
    const features =
      (data &&
        readPointFeatures(data.layers()[sourceLayer], {
          geojson: sourceType === "geojson",
          filter: this.filter,
          zoom: coord.overscaledZ,
          canonical: coord.canonical,
          stateId: (feature) => data.stateId(feature, sourceLayer),
        })) ??
      [];
    const layout = new IconLayout(EXTENT);
    features.forEach((feature, i) => layout.addPoints(feature.points, i));
    layout.finish();
    const byKey = new Map<string, number[]>();
    layout.ranges.forEach((range, r) => {
      const key = features[range.featureIndex]?.stateKey;
      if (key === undefined) return;
      const list = byKey.get(key);
      if (list) list.push(r);
      else byKey.set(key, [r]);
    });
    const entry: TileEntry = {
      raw: data?.raw ?? null,
      canonical: {
        z: coord.canonical.z,
        x: coord.canonical.x,
        y: coord.canonical.y,
      },
      features,
      ranges: layout.ranges,
      byKey,
      statedKeys: new Set(),
      sfs: null,
      rev: -1,
      gen: -1,
      layoutKey: "",
      positions: layout.vertices(),
      indices: layout.indices(),
      segments: layout.segments,
      paint: new Float32Array(0),
      vao: null,
      positionBuffer: null,
      paintBuffer: null,
      indexBuffer: null,
      enabledKey: "",
      matrix: null,
      globe: null,
      pixelsToTileUnits: 0,
      lastUsed: this.frame,
    };
    if (layout.vertexCount > 0) {
      entry.vao = gl.createVertexArray();
      entry.positionBuffer = gl.createBuffer();
      entry.indexBuffer = gl.createBuffer();
      gl.bindVertexArray(entry.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, entry.positions, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, entry.indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, entry.indices, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(POSITION_LOCATION);
    }
    return entry;
  }

  /** What the paint binder reads of a tile's features and their states. */
  private featureSource(
    entry: TileEntry,
    sfs: FeatureStateLike,
  ): FeatureSource {
    const states = sfs.state[this.sourceLayer ?? GEOJSON_SOURCE_LAYER];
    return {
      feature: (index) => entry.features[index]?.evaluation,
      stateKey: (index) => entry.features[index]?.stateKey,
      state: (key) => states?.[key] as FeatureState | undefined,
    };
  }

  /** Fills every bound attribute of a tile and uploads the buffer. */
  private fill(
    gl: WebGL2RenderingContext,
    entry: TileEntry,
    sfs: FeatureStateLike,
    current: CurrentPaint,
    layout: AttributeLayout<PaintName>,
    generation: number,
    bucketZoom: number,
  ): void {
    const vertexCount = entry.positions.length / FLOATS_PER_VERTEX;
    const floats = vertexCount * layout.stride;
    if (entry.paint.length !== floats) entry.paint = new Float32Array(floats);
    if (floats > 0) {
      fillAttributes(
        entry.paint,
        layout,
        current,
        entry.ranges,
        this.featureSource(entry, sfs),
        bucketZoom,
      );
      entry.paintBuffer ??= gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.paintBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, entry.paint, gl.DYNAMIC_DRAW);
    }
    const states = sfs.state[this.sourceLayer ?? GEOJSON_SOURCE_LAYER];
    entry.statedKeys = new Set();
    for (const key of entry.byKey.keys()) {
      if (isStated(states?.[key])) entry.statedKeys.add(key);
    }
    entry.sfs = sfs;
    entry.rev = sfs.revision;
    entry.gen = generation;
    entry.layoutKey = layout.key;
  }

  /**
   * After a feature-state change, refills the state-dependent attributes of
   * the features whose state is set now or was at the last fill, and
   * uploads the vertices that changed.
   */
  private refillStates(
    gl: WebGL2RenderingContext,
    entry: TileEntry,
    sfs: FeatureStateLike,
    current: CurrentPaint,
    layout: AttributeLayout<PaintName>,
    bucketZoom: number,
  ): void {
    entry.rev = sfs.revision;
    const readsState = layout.bound.some((name) => {
      const value = current[name];
      return isFeatureValue(value) && value.stateDependent;
    });
    if (!readsState || layout.stride === 0) return;
    const states = sfs.state[this.sourceLayer ?? GEOJSON_SOURCE_LAYER] ?? {};
    const keys = new Set(entry.statedKeys);
    for (const key of Object.keys(states)) {
      if (entry.byKey.has(key)) keys.add(key);
    }
    if (keys.size === 0) return;
    const span = fillAttributes(
      entry.paint,
      layout,
      current,
      entry.ranges,
      this.featureSource(entry, sfs),
      bucketZoom,
      { keys, stateOnly: true },
    );
    if (span && entry.paintBuffer) {
      const { stride } = layout;
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.paintBuffer);
      gl.bufferSubData(
        gl.ARRAY_BUFFER,
        span.first * stride * 4,
        entry.paint,
        span.first * stride,
        (span.end - span.first) * stride,
      );
    }
    entry.statedKeys = new Set([...keys].filter((k) => isStated(states[k])));
  }

  /** Draws a tile's segments, re-basing every attribute at each one. */
  private drawTile(
    gl: WebGL2RenderingContext,
    entry: TileEntry,
    layout: AttributeLayout<PaintName>,
  ): void {
    gl.bindVertexArray(entry.vao);
    if (entry.enabledKey !== layout.key) {
      for (const name of paintNames) {
        const bound = layout.offsets[name] !== undefined;
        for (const slot of ATTRIBUTE_SLOTS[name]) {
          if (bound) gl.enableVertexAttribArray(slot.location);
          else gl.disableVertexAttribArray(slot.location);
        }
      }
      entry.enabledKey = layout.key;
    }
    const stride = layout.stride * 4;
    for (const segment of entry.segments) {
      // Indices are segment-relative, as in the native bucket, so each
      // segment re-bases the attribute pointers.
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.positionBuffer);
      gl.vertexAttribPointer(
        POSITION_LOCATION,
        2,
        gl.FLOAT,
        false,
        FLOATS_PER_VERTEX * 4,
        segment.vertexOffset * FLOATS_PER_VERTEX * 4,
      );
      if (stride > 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, entry.paintBuffer);
        for (const name of layout.bound) {
          const offset = layout.offsets[name] ?? 0;
          for (const slot of ATTRIBUTE_SLOTS[name]) {
            gl.vertexAttribPointer(
              slot.location,
              slot.size,
              gl.FLOAT,
              false,
              stride,
              segment.vertexOffset * stride + (offset + slot.offset) * 4,
            );
          }
        }
      }
      gl.drawElements(
        gl.TRIANGLES,
        segment.indexLength,
        gl.UNSIGNED_SHORT,
        segment.indexOffset * 2,
      );
    }
  }

  private evict(resources: Resources): void {
    for (const [key, entry] of resources.tiles) {
      if (this.frame - entry.lastUsed <= EVICT_AFTER_FRAMES) continue;
      this.releaseTile(resources.gl, entry);
      resources.tiles.delete(key);
    }
  }

  private dropTiles(): void {
    const resources = this.resources;
    if (!resources) return;
    for (const entry of resources.tiles.values())
      this.releaseTile(resources.gl, entry);
    resources.tiles.clear();
    this.lastView = null;
  }

  private releaseTile(gl: WebGL2RenderingContext, entry: TileEntry): void {
    if (entry.vao) gl.deleteVertexArray(entry.vao);
    if (entry.positionBuffer) gl.deleteBuffer(entry.positionBuffer);
    if (entry.paintBuffer) gl.deleteBuffer(entry.paintBuffer);
    if (entry.indexBuffer) gl.deleteBuffer(entry.indexBuffer);
    entry.vao = entry.positionBuffer = entry.paintBuffer = null;
    entry.indexBuffer = null;
    entry.matrix = null;
    entry.globe = null;
  }

  /**
   * IconDrawableUBO's property fields: each value the same for every
   * feature; a bound one reads its attribute instead, so its field stays 0.
   */
  private writePaintUniforms(current: CurrentPaint): void {
    const block = this.drawable;
    for (const name of paintNames) {
      const value = current[name];
      const vector: Vector = isFeatureValue(value) ? [] : value;
      const at = PROPERTY_OFFSETS[name] / 4;
      const components =
        name === "icon-color" ? 4 : name === "icon-offset" ? 2 : 1;
      for (let i = 0; i < components; i++) block[at + i] = vector[i] ?? 0;
    }
  }

  /** The interpolation factors of the bound values, at a tile's zoom. */
  private writeInterpolation(
    current: CurrentPaint,
    layout: AttributeLayout<PaintName>,
    bucketZoom: number,
    zoom: number,
  ): void {
    const block = this.drawable;
    block.fill(0, DRAWABLE_OFFSETS.interpolation / 4, DRAWABLE_UBO_BYTES / 4);
    for (const name of layout.bound) {
      const value = current[name];
      if (isFeatureValue(value))
        block[interpolationOffset(name) / 4] = value.factor(bucketZoom, zoom);
    }
  }

  private setProjectionUniforms(
    gl: WebGL2RenderingContext,
    program: Program,
    projection: ReturnType<CustomRenderMethodInput["getProjectionData"]>,
  ): void {
    const u = program.uniforms;
    if (u.u_projection_matrix)
      gl.uniformMatrix4fv(u.u_projection_matrix, false, projection.mainMatrix);
    if (u.u_projection_fallback_matrix) {
      gl.uniformMatrix4fv(
        u.u_projection_fallback_matrix,
        false,
        projection.fallbackMatrix,
      );
    }
    if (u.u_projection_tile_mercator_coords) {
      gl.uniform4fv(
        u.u_projection_tile_mercator_coords,
        projection.tileMercatorCoords,
      );
    }
    if (u.u_projection_clipping_plane) {
      gl.uniform4fv(u.u_projection_clipping_plane, projection.clippingPlane);
    }
    if (u.u_projection_transition) {
      gl.uniform1f(u.u_projection_transition, projection.projectionTransition);
    }
  }

  /**
   * Creates the GL objects and uploads the catalog, from render only: gl-js
   * does not restore its state after onAdd, and it resets the texture,
   * unit and pixel-store state it tracks after every custom layer.
   */
  private acquire(gl: WebGL2RenderingContext): Resources {
    const catalog = this.catalog;
    const art = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, art);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA32F,
      catalog.textureWidth,
      catalog.textureHeight,
      0,
      gl.RGBA,
      gl.FLOAT,
      catalog.texture,
    );
    // The default minification filter samples mipmaps the texture lacks,
    // which leaves it incomplete: every read would be 0.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const catalogBuffer = gl.createBuffer();
    gl.bindBuffer(gl.UNIFORM_BUFFER, catalogBuffer);
    this.catalog.writeHeaderBlock(clockSeconds(), this.header);
    gl.bufferData(gl.UNIFORM_BUFFER, this.header, gl.DYNAMIC_DRAW);
    const drawableBuffer = gl.createBuffer();
    gl.bindBuffer(gl.UNIFORM_BUFFER, drawableBuffer);
    gl.bufferData(gl.UNIFORM_BUFFER, DRAWABLE_UBO_BYTES, gl.DYNAMIC_DRAW);
    this.resources = {
      gl,
      programs: new globalThis.Map(),
      tiles: new globalThis.Map(),
      art,
      catalogBuffer,
      drawableBuffer,
      clock: this.header[0]!,
    };
    return this.resources;
  }

  private release(): void {
    const r = this.resources;
    this.resources = null;
    // gl-js removes custom layers when the context is lost, before its
    // webglcontextlost event, and a lost context has nothing to free.
    if (!r || r.gl.isContextLost()) return;
    for (const program of r.programs.values())
      r.gl.deleteProgram(program.handle);
    for (const entry of r.tiles.values()) this.releaseTile(r.gl, entry);
    r.gl.deleteTexture(r.art);
    r.gl.deleteBuffer(r.catalogBuffer);
    r.gl.deleteBuffer(r.drawableBuffer);
  }

  /** The program for a projection variant and attribute layout, compiled on first use. */
  private program(
    resources: Resources,
    args: CustomRenderMethodInput,
    layoutKey: string,
  ): Program {
    const { gl } = resources;
    const { variantName, vertexShaderPrelude, define } = args.shaderData;
    const key = `${variantName}:${layoutKey}`;
    const cached = resources.programs.get(key);
    if (cached) return cached;
    const vertex = compileShader(
      gl,
      gl.VERTEX_SHADER,
      vertexSource(vertexShaderPrelude, define, layoutKey, this.defines),
    );
    const fragment = compileShader(
      gl,
      gl.FRAGMENT_SHADER,
      fragmentSource(this.defines),
    );
    const handle = gl.createProgram();
    gl.attachShader(handle, vertex);
    gl.attachShader(handle, fragment);
    gl.linkProgram(handle);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(handle, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(handle) ?? "";
      gl.deleteProgram(handle);
      throw new Error(`animated-icon program link failed: ${log}`);
    }
    for (const [name, binding] of [
      [CATALOG_BLOCK, CATALOG_BINDING],
      [DRAWABLE_BLOCK, DRAWABLE_BINDING],
    ] as const) {
      const index = gl.getUniformBlockIndex(handle, name);
      if (index !== gl.INVALID_INDEX)
        gl.uniformBlockBinding(handle, index, binding);
    }
    const program: Program = { handle, uniforms: {} };
    for (const name of PROJECTION_UNIFORMS)
      program.uniforms[name] = gl.getUniformLocation(handle, name);
    gl.useProgram(handle);
    gl.uniform1i(gl.getUniformLocation(handle, ART_SAMPLER), 0);
    resources.programs.set(key, program);
    return program;
  }
}

/** Whether a feature state has any key. */
function isStated(state: Readonly<Record<string, unknown>> | undefined) {
  if (!state) return false;
  for (const _ in state) return true;
  return false;
}

/**
 * A feature's paint values as the native query_feature resolves them: a
 * value the same for every feature as it is, a data-driven one evaluated at
 * the tile's own zoom with the feature's state.
 */
function resolve(
  current: CurrentPaint,
  feature: PointFeature,
  state: FeatureState | undefined,
  tileZoom: number,
): Resolved {
  const at = (name: PaintName): Vector => {
    const value = current[name];
    return isFeatureValue(value)
      ? value.at(tileZoom, feature.evaluation, state)
      : value;
  };
  const first = (name: PaintName) => at(name)[0] ?? 0;
  const index = (name: PaintName) => Math.round(first(name));
  const offset = at("icon-offset");
  return {
    animation: index("icon-animation"),
    size: first("icon-size"),
    rotate: first("icon-rotate"),
    opacity: first("icon-opacity"),
    offset: [offset[0] ?? 0, offset[1] ?? 0],
    anchor: index("icon-anchor"),
    rotationAlignment: index("icon-rotation-alignment"),
    pitchAlignment: index("icon-pitch-alignment"),
  };
}

/** An anchor's longitude and latitude, as maplibre-gl-js's query results give them. */
function lngLat(
  canonical: CanonicalTile,
  anchor: readonly [number, number],
): [number, number] {
  const size = EXTENT * 2 ** canonical.z;
  const x = (canonical.x * EXTENT + anchor[0]) / size;
  const y = (canonical.y * EXTENT + anchor[1]) / size;
  return [
    x * 360 - 180,
    (360 / Math.PI) * Math.atan(Math.exp((1 - 2 * y) * Math.PI)) - 90,
  ];
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("animated-icon: cannot create shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "";
    gl.deleteShader(shader);
    throw new Error(`animated-icon shader compile failed: ${log}`);
  }
  return shader;
}

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}
