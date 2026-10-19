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
  FillLayerSpecification,
  FilterSpecification,
} from "@maplibre/maplibre-gl-style-spec";
import type { Feature, MultiPolygon, Polygon, Position } from "geojson";
import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MaplibreMap,
  OverscaledTileID,
} from "maplibre-gl";

import {
  packAttributes,
  type PackedLayout,
  packedLayout,
} from "./attributes.ts";
import { type Point, signedArea2 } from "./footprint.ts";
import {
  type FeatureStateLike,
  GEOJSON_SOURCE_LAYER,
  GlJsInternalsError,
  type SourceTiles,
  sourceTiles,
  stencilRefFor3D,
  styleLight,
  type TileData,
} from "./gljs.ts";
import { FLOATS_PER_VERTEX, type Range, type Segment } from "./layout.ts";
import { lightUniforms, metersPerTileUnit } from "./light.ts";
import {
  type BuildingPaintState,
  createPaintState,
  type CurrentPaint,
  DEFAULT_TRANSITION,
  LayoutEvaluator,
  type TransitionOptions,
  uniformNumber,
} from "./paint.ts";
import { prismHit, translationInTileUnits } from "./query.ts";
import {
  BINDINGS,
  BOUND_NAMES,
  type BoundName,
  DRAWABLE_BINDING,
  DRAWABLE_BLOCK,
  DRAWABLE_OFFSETS,
  DRAWABLE_UBO_BYTES,
  fragmentSource,
  POS_LOCATION,
  PROJECTION_UNIFORMS,
  ROOF_LOCATION,
  TRANSLATE_UNIFORM,
  VERTEX_STRIDE,
  vertexSource,
} from "./shaders.ts";
import {
  EXTENT,
  isLayoutName,
  LAYER_TYPE,
  type LayoutName,
  type PaintName,
} from "./spec.ts";
import {
  type CanonicalTile,
  compileFilter,
  layoutTile,
  type PolygonFeature,
} from "./tiles.ts";

const TILE_SIZE = 512;
/** The helper layer's metadata key, naming the layer that owns it. */
const HELPER_OF = "maplibre-plugins:helper-of";
/** Frames a tile's geometry survives after it stops being rendered. */
const EVICT_AFTER_FRAMES = 120;

/** Raw paint input: literals, CSS colors, or style expressions, keyed by property name. */
export type PaintInput = Partial<Record<PaintName, unknown>> &
  Partial<Record<`${PaintName}-transition`, TransitionOptions>>;

/** Raw layout input: the roof properties and visibility. */
export type LayoutInput = Partial<Record<LayoutName, unknown>> & {
  visibility?: "visible" | "none";
};

export interface BuildingLayerOptions {
  id: string;
  /** A vector or GeoJSON source in the map's style. */
  source: string;
  /** The polygon layer inside a vector source's tiles; omit for GeoJSON. */
  sourceLayer?: string;
  filter?: FilterSpecification;
  layout?: Partial<Record<LayoutName, unknown>>;
  paint?: PaintInput;
  minzoom?: number;
  maxzoom?: number;
  visibility?: "visible" | "none";
  /** Default transition for paint changes; per-property `<name>-transition` overrides it. */
  transition?: TransitionOptions;
}

/** A style-JSON layer object using the `building` type, as the native plugin accepts. */
export interface BuildingLayerJson {
  id: string;
  type: typeof LAYER_TYPE;
  source: string;
  "source-layer"?: string;
  filter?: FilterSpecification;
  layout?: LayoutInput;
  paint?: PaintInput;
  minzoom?: number;
  maxzoom?: number;
}

/** A queried building, as GeoJSON with the source's properties. */
export interface BuildingFeature extends Feature<Polygon | MultiPolygon> {
  /** The feature-state id, when the feature has one. */
  id?: number | string;
  source: string;
  sourceLayer?: string;
  layer: { id: string };
  /** The layout values the building was drawn with. */
  roof: { shape: string; orientation: string; direction: number };
}

interface Program {
  handle: WebGLProgram;
  uniforms: Partial<
    Record<
      (typeof PROJECTION_UNIFORMS)[number] | typeof TRANSLATE_UNIFORM,
      WebGLUniformLocation | null
    >
  >;
}

/** Geometry shared by overscaled ids with the same canonical tile and raw data. */
interface TileGeometry {
  key: string;
  references: number;
  raw: ArrayBuffer | null;
  canonical: CanonicalTile;
  features: PolygonFeature[];
  ranges: Range[];
  segments: Segment[];
  vertexCount: number;
  /** Range indices by feature-state key. */
  byKey: Map<string, number[]>;
  vertexBuffer: WebGLBuffer | null;
  indexBuffer: WebGLBuffer | null;
}

/** Paint attributes, VAO and query state remain private to each overscaled id. */
interface TileEntry {
  geometry: TileGeometry;
  /** Keys whose state was not empty at the last fill. */
  statedKeys: Set<string>;
  sfs: FeatureStateLike | null;
  rev: number;
  gen: number;
  layoutKey: string;
  /** The binder's floats, vertex count × layout stride. */
  floats: Float32Array;
  /** The same packed for the GPU (attributes.ts). */
  packed: ArrayBuffer;
  packedLayout: PackedLayout | null;
  vao: WebGLVertexArrayObject | null;
  paintBuffer: WebGLBuffer | null;
  /** The layout key whose attribute arrays the VAO has enabled. */
  enabledKey: string;
  /** The last render's untranslated mercator tile matrix, for queries. */
  matrix: Float64Array | null;
  /** The last render's building-translate in tile units. */
  translate: [number, number];
  lastUsed: number;
}

interface Resources {
  gl: WebGL2RenderingContext;
  programs: globalThis.Map<string, Program>;
  tiles: globalThis.Map<string, TileEntry>;
  geometry: globalThis.Map<string, Set<TileGeometry>>;
  /** One BuildingDrawableUBO per drawn tile, each at an aligned offset. */
  blockBuffer: WebGLBuffer;
  blockBufferBytes: number;
  /** Bytes between consecutive tiles' blocks. */
  blockStride: number;
}

/** The camera values of the last render, for queries. */
interface LastView {
  viewport: [number, number];
  /** Tile keys in draw order. */
  drawn: string[];
}

/** One tile's draw this frame. */
interface Draw {
  entry: TileEntry;
  /** The tile's overscaled zoom, at which its attributes were filled. */
  bucketZoom: number;
  projection: ReturnType<CustomRenderMethodInput["getProjectionData"]>;
}

/**
 * A maplibre-gl-js custom layer drawing the same buildings as the native
 * `building` plugin layer: walls and OSM roof:shape roofs for every polygon
 * of a source the style already loads, lit like core fill-extrusion by the
 * style's light, sharing the depth buffer with the map's other 3D layers.
 * Data-driven paint, feature-state included, becomes per-vertex attributes
 * as the native host binds them. Add it with `map.addLayer(layer, beforeId)`.
 */
export class BuildingLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom";
  readonly renderingMode = "3d";
  readonly source: string;
  readonly sourceLayer: string | undefined;

  private filterJson: FilterSpecification | undefined;
  private filter: ReturnType<typeof compileFilter>;
  private readonly layout: LayoutEvaluator;
  private readonly paint: BuildingPaintState;
  private minzoom: number;
  private maxzoom: number;
  private visibility: "visible" | "none";

  private map: MaplibreMap | null = null;
  private resources: Resources | null = null;
  private contextLost = false;
  /** Set once maplibre-gl's internals turned out to have moved. */
  private broken = false;
  private frame = 0;
  private lastView: LastView | null = null;
  private helperLayer: string | null = null;
  private readonly listeners: Array<() => void> = [];

  constructor(options: BuildingLayerOptions) {
    this.id = options.id;
    this.source = options.source;
    this.sourceLayer = options.sourceLayer;
    this.filterJson = options.filter;
    this.filter = compileFilter(options.filter);
    this.layout = new LayoutEvaluator(options.layout ?? {});
    this.minzoom = options.minzoom ?? 0;
    this.maxzoom = options.maxzoom ?? 24;
    this.visibility = options.visibility ?? "visible";
    this.paint = createPaintState(
      { ...DEFAULT_TRANSITION, ...options.transition },
      options.paint ?? {},
    );
  }

  /** Builds a layer from style-layer JSON of type `building`, the form the native plugin consumes. */
  static fromLayerJson(
    json: BuildingLayerJson,
    options: { transition?: TransitionOptions } = {},
  ): BuildingLayer {
    const actual: string = (json as { type: string }).type;
    if (actual !== LAYER_TYPE) {
      throw new Error(`Expected layer type ${LAYER_TYPE}, got ${actual}`);
    }
    if (!json.source) throw new Error(`${LAYER_TYPE} layers need a source`);
    const layerOptions: BuildingLayerOptions = {
      id: json.id,
      source: json.source,
    };
    if (json["source-layer"]) layerOptions.sourceLayer = json["source-layer"];
    if (json.filter !== undefined) layerOptions.filter = json.filter;
    if (json.layout) {
      const { visibility, ...layout } = json.layout;
      layerOptions.layout = layout;
      if (visibility) layerOptions.visibility = visibility;
    }
    if (json.paint) layerOptions.paint = json.paint;
    if (json.minzoom !== undefined) layerOptions.minzoom = json.minzoom;
    if (json.maxzoom !== undefined) layerOptions.maxzoom = json.maxzoom;
    if (options.transition) layerOptions.transition = options.transition;
    return new BuildingLayer(layerOptions);
  }

  /** The layer as style-layer JSON, with the current raw layout and paint values. */
  toLayerJson(): BuildingLayerJson {
    const json: BuildingLayerJson = {
      id: this.id,
      type: LAYER_TYPE,
      source: this.source,
    };
    if (this.sourceLayer !== undefined) json["source-layer"] = this.sourceLayer;
    if (this.filterJson !== undefined) json.filter = this.filterJson;
    json.layout = this.layout.toJson();
    if (this.visibility !== "visible") json.layout.visibility = this.visibility;
    json.paint = this.paint.toJson() as PaintInput;
    if (this.minzoom !== 0) json.minzoom = this.minzoom;
    if (this.maxzoom !== 24) json.maxzoom = this.maxzoom;
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

  getLayoutProperty(name: LayoutName | "visibility"): unknown {
    return name === "visibility" ? this.visibility : this.layout.get(name);
  }

  /**
   * Sets `visibility` or a roof property. A roof property changes the
   * geometry, so every tile lays out again on its next frame, as the native
   * host rebuilds its buckets. Invalid values throw and leave the old value.
   */
  setLayoutProperty(name: string, value: unknown): void {
    if (name === "visibility") {
      if (value !== "visible" && value !== "none")
        throw new Error(`Invalid visibility ${String(value)}`);
      this.visibility = value;
      if (this.map) this.syncHelperLayer(this.map);
    } else if (isLayoutName(name)) {
      this.layout.set(name, value);
      this.dropTiles();
    } else {
      throw new Error(`Unknown layout property ${name}`);
    }
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

  /**
   * Every building under a screen point (logical pixels from the map's top
   * left), nearest first, one per feature id; a building without an id comes
   * back once for each tile that draws a copy of it there, as core
   * queryRenderedFeatures may return a feature once per tile. Like
   * maplibre-gl-js's fill-extrusion query, a building is hit where the point
   * meets its projected prism from building-base to building-height (the
   * roof's top), moved by building-translate as it is drawn. Data-driven
   * heights are evaluated at the camera's zoom with the feature's state, as
   * both maplibre-gl-js and MapLibre Native evaluate them for queries. The
   * tiles and matrices come from the last render.
   */
  queryFeatures(point: { x: number; y: number }): BuildingFeature[] {
    const map = this.map;
    const resources = this.resources;
    const last = this.lastView;
    if (!map || !resources || !last) return [];
    const zoom = map.getZoom();
    const current = this.paint.current(zoom, now());
    const states = this.layerState();
    const q = {
      x: (2 * point.x) / last.viewport[0] - 1,
      y: 1 - (2 * point.y) / last.viewport[1],
    };
    const hits = new Map<
      string,
      { distance: number; feature: BuildingFeature }
    >();
    for (const key of last.drawn) {
      const entry = resources.tiles.get(key);
      if (!entry?.matrix) continue;
      entry.geometry.features.forEach((feature, i) => {
        const dedupe =
          feature.stateKey === undefined
            ? `${key}:${i}`
            : `id:${feature.stateKey}`;
        const state =
          feature.stateKey === undefined
            ? undefined
            : states?.[feature.stateKey];
        const at = (name: "building-height" | "building-base") => {
          const value = current[name];
          const vector = isFeatureValue(value)
            ? value.at(zoom, feature.evaluation, state)
            : value;
          return vector[0] ?? 0;
        };
        const distance = prismHit(
          feature.rings,
          at("building-base"),
          at("building-height"),
          entry.matrix!,
          q,
          entry.translate,
        );
        if (distance === null) return;
        const found = hits.get(dedupe);
        if (found && found.distance <= distance) return;
        hits.set(dedupe, {
          distance,
          feature: this.toFeature(feature, entry.geometry.canonical),
        });
      });
    }
    return [...hits.values()]
      .sort((a, b) => a.distance - b.distance)
      .map((hit) => hit.feature);
  }

  /** The nearest building under a screen point, or null. */
  queryFeature(point: { x: number; y: number }): BuildingFeature | null {
    return this.queryFeatures(point)[0] ?? null;
  }

  /** Whether a screen point is over a building. */
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
    if (this.paint.active(time)) map.triggerRepaint();
    // evaluate_layer's pass mask: nothing at opacity 0, the single opaque
    // pass at 1, else the depth pre-pass and the deduplicated color pass.
    const opacity = uniformNumber(current, "building-opacity") ?? 1;
    const tiles = opacity > 0 ? sourceTiles(map, this.source) : null;
    const coords = tiles?.visibleCoordinates() ?? [];
    if (!tiles || coords.length === 0) {
      this.lastView = null;
      return;
    }

    const resources = this.resources ?? this.acquire(gl);
    const layout = attributeLayout<BoundName>(BOUND_NAMES, current);
    const generation = this.paint.generation;
    const program = this.program(resources, args, layout.key);
    const canvas = map.getCanvas();
    const width = Math.max(canvas.clientWidth, 1);
    const height = Math.max(canvas.clientHeight, 1);
    const bearing = (map.getBearing() * Math.PI) / 180;
    const light = lightUniforms(styleLight(map), bearing);
    const translate = current["building-translate"] as Vector;
    const viewport = uniformNumber(current, "building-translate-anchor") === 1;
    const drawn: string[] = [];
    this.lastView = { viewport: [width, height], drawn };

    // Every tile's block, written once and bound per draw.
    const draws: Draw[] = [];
    for (const coord of coords) {
      const entry = this.tileEntry(
        resources,
        tiles,
        coord,
        current,
        layout,
        generation,
      );
      entry.lastUsed = this.frame;
      if (!entry.vao || entry.geometry.segments.length === 0) continue;
      const projection = args.getProjectionData({
        tileID: { wrap: coord.wrap, canonical: coord.canonical },
        applyGlobeMatrix: true,
      });
      // Layout coordinates span the canonical tile, also when overscaled.
      const pixelsToTileUnits =
        EXTENT / (TILE_SIZE * 2 ** (zoom - coord.canonical.z));
      entry.matrix = Float64Array.from(projection.fallbackMatrix);
      entry.translate = translationInTileUnits(
        [translate[0] ?? 0, translate[1] ?? 0],
        viewport,
        bearing,
        pixelsToTileUnits,
      );
      drawn.push(coord.key);
      draws.push({ entry, bucketZoom: coord.overscaledZ, projection });
    }
    if (draws.length === 0) return;
    const blocks = this.writeBlocks(resources, draws, current, light, zoom);

    const previousVao = gl.getParameter(
      gl.VERTEX_ARRAY_BINDING,
    ) as WebGLVertexArrayObject | null;
    try {
      gl.useProgram(program.handle);
      gl.bindBuffer(gl.UNIFORM_BUFFER, resources.blockBuffer);
      gl.bufferSubData(gl.UNIFORM_BUFFER, 0, blocks);
      // gl-js set the 3D depth range and LEQUAL; draw like its
      // fill-extrusion (depth read and write, back faces culled).
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      gl.frontFace(gl.CCW);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      if (opacity >= 1) {
        gl.disable(gl.STENCIL_TEST);
        gl.enable(gl.BLEND);
        this.drawPass(gl, resources, program, draws, layout);
      } else {
        // Every building into depth first, then only the nearest surface,
        // once per pixel, so no internal face shows.
        gl.disable(gl.STENCIL_TEST);
        gl.disable(gl.BLEND);
        gl.colorMask(false, false, false, false);
        this.drawPass(gl, resources, program, draws, layout);
        gl.colorMask(true, true, true, true);
        gl.enable(gl.BLEND);
        const ref = stencilRefFor3D(map);
        if (ref !== null) {
          gl.enable(gl.STENCIL_TEST);
          gl.stencilMask(0xff);
          gl.stencilFunc(gl.NOTEQUAL, ref, 0xff);
          gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
        }
        this.drawPass(gl, resources, program, draws, layout);
        gl.disable(gl.STENCIL_TEST);
      }
    } finally {
      gl.colorMask(true, true, true, true);
      gl.disable(gl.CULL_FACE);
      gl.bindVertexArray(previousVao);
    }
    if (this.frame % 30 === 0) this.evict(resources);
  }

  /**
   * Writes BuildingDrawableUBO for every draw, as the native
   * update_uniform_block and binders fill it: the translated tile matrix,
   * the light, the tile's meters per unit, each uniform property's value
   * and each bound property's interpolation factor.
   */
  private writeBlocks(
    resources: Resources,
    draws: readonly Draw[],
    current: CurrentPaint,
    light: ReturnType<typeof lightUniforms>,
    zoom: number,
  ): Float32Array {
    const { gl } = resources;
    const bytes = draws.length * resources.blockStride;
    if (bytes > resources.blockBufferBytes) {
      gl.bindBuffer(gl.UNIFORM_BUFFER, resources.blockBuffer);
      gl.bufferData(gl.UNIFORM_BUFFER, bytes, gl.DYNAMIC_DRAW);
      resources.blockBufferBytes = bytes;
    }
    const blocks = new Float32Array(bytes / 4);
    draws.forEach(({ entry, bucketZoom }, i) => {
      const at = (i * resources.blockStride) / 4;
      const block = blocks.subarray(at, at + DRAWABLE_UBO_BYTES / 4);
      const m = entry.matrix!;
      const [tx, ty] = entry.translate;
      for (let k = 0; k < 16; k++) block[k] = m[k]!;
      // m · translate(tx, ty, 0), as gl-js's translatePosMatrix.
      for (let r = 0; r < 4; r++)
        block[12 + r] = m[12 + r]! + m[r]! * tx + m[4 + r]! * ty;
      block.set(light.color, DRAWABLE_OFFSETS.lightColor / 4);
      block.set(light.position, DRAWABLE_OFFSETS.lightPosition / 4);
      block[DRAWABLE_OFFSETS.metersPerTileUnit / 4] = metersPerTileUnit(
        entry.geometry.canonical,
      );
      for (const name of BOUND_NAMES) {
        const value = current[name];
        const binding = BINDINGS[name];
        if (isFeatureValue(value)) {
          block[binding.interpolationOffset / 4] = value.factor(
            bucketZoom,
            zoom,
          );
        } else {
          const components = name.endsWith("color") ? 4 : 1;
          for (let c = 0; c < components; c++)
            block[binding.uniformOffset / 4 + c] = value[c] ?? 0;
        }
      }
    });
    return blocks;
  }

  /** Draws every tile once with the current GL state. */
  private drawPass(
    gl: WebGL2RenderingContext,
    resources: Resources,
    program: Program,
    draws: readonly Draw[],
    layout: AttributeLayout<BoundName>,
  ): void {
    draws.forEach(({ entry, projection }, i) => {
      gl.bindBufferRange(
        gl.UNIFORM_BUFFER,
        DRAWABLE_BINDING,
        resources.blockBuffer,
        i * resources.blockStride,
        DRAWABLE_UBO_BYTES,
      );
      this.setProjectionUniforms(gl, program, projection);
      if (program.uniforms[TRANSLATE_UNIFORM])
        gl.uniform2f(
          program.uniforms[TRANSLATE_UNIFORM],
          entry.translate[0],
          entry.translate[1],
        );
      this.drawTile(gl, entry, layout);
    });
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
    feature: PolygonFeature,
    canonical: CanonicalTile,
  ): BuildingFeature {
    const result: BuildingFeature = {
      type: "Feature",
      geometry: geometryOf(feature.rings, canonical),
      properties: { ...feature.evaluation.properties },
      source: this.source,
      layer: { id: this.id },
      roof: { ...feature.layout },
    };
    if (feature.id !== undefined) result.id = feature.id;
    if (this.sourceLayer !== undefined) result.sourceLayer = this.sourceLayer;
    return result;
  }

  /**
   * gl-js loads a source's tiles only while a visible built-in layer uses
   * it, and custom layers never count; nor does it apply feature-state to a
   * source no such layer uses. So every layer gets its own hidden fill
   * layer, `<id>-tiles`, with this layer's visibility and zoom range:
   * removing, hiding or zoom-limiting any other layer cannot unload this
   * layer's tiles, and they load exactly when the native layer's would.
   */
  private addHelperLayer(map: MaplibreMap): void {
    if (!map.getSource(this.source)) return;
    // A style restored after context loss keeps the helper but drops this
    // layer; adopt it so it goes away with the layer again. A layer of the
    // same id without this layer's mark belongs to the style, so take the
    // next free id instead of touching it.
    let id = `${this.id}-tiles`;
    for (let n = 2; map.getLayer(id); n++) {
      const metadata = (map.getLayer(id) as { metadata?: unknown }).metadata;
      if (
        typeof metadata === "object" &&
        metadata !== null &&
        (metadata as Record<string, unknown>)[HELPER_OF] === this.id
      ) {
        this.helperLayer = id;
        this.syncHelperLayer(map);
        return;
      }
      id = `${this.id}-tiles-${n}`;
    }
    const helper: FillLayerSpecification = {
      id,
      type: "fill",
      source: this.source,
      // No feature passes, so the worker builds no fills; the tiles and
      // their raw data still load, since that depends only on the layer
      // not being hidden.
      filter: false,
      metadata: { [HELPER_OF]: this.id },
      layout: { visibility: this.visibility },
      paint: { "fill-opacity": 0 },
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
    layout: AttributeLayout<BoundName>,
    generation: number,
  ): TileEntry {
    const { gl } = resources;
    const data = tiles.tile(coord.key);
    const raw = data?.raw ?? null;
    const sfs = tiles.featureState();
    let entry = resources.tiles.get(coord.key);
    if (!entry || entry.geometry.raw !== raw) {
      if (entry) this.releaseTile(resources, entry);
      const geometry = this.tileGeometry(resources, data, tiles.type, coord);
      geometry.references++;
      entry = {
        geometry,
        statedKeys: new Set(),
        sfs: null,
        rev: -1,
        gen: -1,
        layoutKey: "",
        floats: new Float32Array(0),
        packed: new ArrayBuffer(0),
        packedLayout: null,
        vao: null,
        paintBuffer: null,
        enabledKey: "",
        matrix: null,
        translate: [0, 0],
        lastUsed: this.frame,
      };
      if (geometry.vertexCount > 0) {
        entry.vao = gl.createVertexArray();
        gl.bindVertexArray(entry.vao);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, geometry.indexBuffer);
        gl.enableVertexAttribArray(POS_LOCATION);
        gl.enableVertexAttribArray(ROOF_LOCATION);
        gl.bindVertexArray(null);
      }
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

  /** Walls and roofs for the polygons of a tile, segmented like the native bucket. */
  private tileGeometry(
    resources: Resources,
    data: TileData | null,
    sourceType: string,
    coord: OverscaledTileID,
  ): TileGeometry {
    const { gl } = resources;
    const { z, x, y } = coord.canonical;
    // Zoom expressions in filters/layout must keep their existing bucket semantics.
    const zoomDependent =
      readsZoom(this.filterJson) ||
      Object.values(this.layout.toJson()).some(readsZoom);
    const key = `${z}/${x}/${y}${zoomDependent ? `@${coord.overscaledZ}` : ""}`;
    const raw = data?.raw ?? null;
    let shared = resources.geometry.get(key);
    for (const geometry of shared ?? []) {
      if (geometry.raw === raw) return geometry;
    }
    const sourceLayer = this.sourceLayer ?? GEOJSON_SOURCE_LAYER;
    const tile = layoutTile(data?.layers()[sourceLayer], {
      geojson: sourceType === "geojson",
      filter: this.filter,
      zoom: coord.overscaledZ,
      canonical: coord.canonical,
      layout: this.layout,
      stateId: (feature) => data?.stateId(feature, sourceLayer),
    });
    const { features, layout } = tile;
    const byKey = new Map<string, number[]>();
    layout.ranges.forEach((range, r) => {
      const key = features[range.featureIndex]?.stateKey;
      if (key === undefined) return;
      const list = byKey.get(key);
      if (list) list.push(r);
      else byKey.set(key, [r]);
    });
    const geometry: TileGeometry = {
      key,
      references: 0,
      raw,
      canonical: { z, x, y },
      features,
      ranges: layout.ranges,
      segments: layout.segments,
      vertexCount: tile.vertices.length / FLOATS_PER_VERTEX,
      byKey,
      vertexBuffer: null,
      indexBuffer: null,
    };
    if (geometry.vertexCount > 0) {
      gl.bindVertexArray(null);
      geometry.vertexBuffer = gl.createBuffer();
      geometry.indexBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, geometry.vertexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, tile.vertices, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, geometry.indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, tile.indices, gl.STATIC_DRAW);
    }
    if (!shared) {
      shared = new Set();
      resources.geometry.set(key, shared);
    }
    shared.add(geometry);
    return geometry;
  }

  /** What the paint binder reads of a tile's features and their states. */
  private featureSource(
    entry: TileEntry,
    sfs: FeatureStateLike,
  ): FeatureSource {
    const states = sfs.state[this.sourceLayer ?? GEOJSON_SOURCE_LAYER];
    return {
      feature: (index) => entry.geometry.features[index]?.evaluation,
      stateKey: (index) => entry.geometry.features[index]?.stateKey,
      state: (key) => states?.[key] as FeatureState | undefined,
    };
  }

  /** Fills every bound attribute of a tile and uploads the buffer. */
  private fill(
    gl: WebGL2RenderingContext,
    entry: TileEntry,
    sfs: FeatureStateLike,
    current: CurrentPaint,
    layout: AttributeLayout<BoundName>,
    generation: number,
    bucketZoom: number,
  ): void {
    const floats = entry.geometry.vertexCount * layout.stride;
    if (entry.floats.length !== floats) entry.floats = new Float32Array(floats);
    const packed = packedLayout(layout);
    const bytes = entry.geometry.vertexCount * packed.stride;
    if (entry.packed.byteLength !== bytes)
      entry.packed = new ArrayBuffer(bytes);
    entry.packedLayout = packed;
    if (floats > 0) {
      fillAttributes(
        entry.floats,
        layout,
        current,
        entry.geometry.ranges,
        this.featureSource(entry, sfs),
        bucketZoom,
      );
      packAttributes(entry.floats, layout, entry.packed);
      entry.paintBuffer ??= gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.paintBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, entry.packed, gl.DYNAMIC_DRAW);
    }
    const states = sfs.state[this.sourceLayer ?? GEOJSON_SOURCE_LAYER];
    entry.statedKeys = new Set();
    for (const key of entry.geometry.byKey.keys()) {
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
    layout: AttributeLayout<BoundName>,
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
      if (entry.geometry.byKey.has(key)) keys.add(key);
    }
    if (keys.size === 0) return;
    const span = fillAttributes(
      entry.floats,
      layout,
      current,
      entry.geometry.ranges,
      this.featureSource(entry, sfs),
      bucketZoom,
      { keys, stateOnly: true },
    );
    if (span && entry.paintBuffer && entry.packedLayout) {
      packAttributes(entry.floats, layout, entry.packed, span.first, span.end);
      const stride = entry.packedLayout.stride;
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.paintBuffer);
      gl.bufferSubData(
        gl.ARRAY_BUFFER,
        span.first * stride,
        new Uint8Array(entry.packed),
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
    layout: AttributeLayout<BoundName>,
  ): void {
    const packed = entry.packedLayout;
    gl.bindVertexArray(entry.vao);
    if (entry.enabledKey !== layout.key) {
      const enabled = new Set(packed?.attributes.map((a) => a.location));
      for (const name of BOUND_NAMES) {
        const binding = BINDINGS[name];
        for (const location of new Set([
          binding.minimumAttribute,
          binding.maximumAttribute,
        ])) {
          if (enabled.has(location)) gl.enableVertexAttribArray(location);
          else gl.disableVertexAttribArray(location);
        }
      }
      entry.enabledKey = layout.key;
    }
    for (const segment of entry.geometry.segments) {
      // Indices are segment-relative, as in the native bucket, so each
      // segment re-bases the attribute pointers.
      const base = segment.vertexOffset * VERTEX_STRIDE;
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.geometry.vertexBuffer);
      gl.vertexAttribPointer(
        POS_LOCATION,
        3,
        gl.FLOAT,
        false,
        VERTEX_STRIDE,
        base,
      );
      gl.vertexAttribPointer(
        ROOF_LOCATION,
        4,
        gl.FLOAT,
        false,
        VERTEX_STRIDE,
        base + 12,
      );
      if (packed && packed.stride > 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, entry.paintBuffer);
        const paintBase = segment.vertexOffset * packed.stride;
        for (const attribute of packed.attributes) {
          if (attribute.kind === "float2") {
            gl.vertexAttribPointer(
              attribute.location,
              2,
              gl.FLOAT,
              false,
              packed.stride,
              paintBase + attribute.offset,
            );
          } else {
            gl.vertexAttribPointer(
              attribute.location,
              4,
              gl.UNSIGNED_BYTE,
              true,
              packed.stride,
              paintBase + attribute.offset,
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
      this.releaseTile(resources, entry);
      resources.tiles.delete(key);
    }
  }

  private dropTiles(): void {
    const resources = this.resources;
    if (!resources) return;
    for (const entry of resources.tiles.values())
      this.releaseTile(resources, entry);
    resources.tiles.clear();
    this.lastView = null;
  }

  private releaseTile(resources: Resources, entry: TileEntry): void {
    const { gl } = resources;
    if (entry.vao) gl.deleteVertexArray(entry.vao);
    if (entry.paintBuffer) gl.deleteBuffer(entry.paintBuffer);
    entry.vao = entry.paintBuffer = null;
    entry.matrix = null;
    const geometry = entry.geometry;
    if (--geometry.references === 0) {
      if (geometry.vertexBuffer) gl.deleteBuffer(geometry.vertexBuffer);
      if (geometry.indexBuffer) gl.deleteBuffer(geometry.indexBuffer);
      const shared = resources.geometry.get(geometry.key)!;
      shared.delete(geometry);
      if (shared.size === 0) resources.geometry.delete(geometry.key);
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

  /** Creates the GL objects, from render only: gl-js does not restore its state after onAdd. */
  private acquire(gl: WebGL2RenderingContext): Resources {
    const alignment = Number(
      gl.getParameter(gl.UNIFORM_BUFFER_OFFSET_ALIGNMENT) ?? 256,
    );
    const align = alignment > 0 ? alignment : 256;
    const blockStride = Math.ceil(DRAWABLE_UBO_BYTES / align) * align;
    const blockBuffer = gl.createBuffer();
    this.resources = {
      gl,
      programs: new globalThis.Map(),
      tiles: new globalThis.Map(),
      geometry: new globalThis.Map(),
      blockBuffer,
      blockBufferBytes: 0,
      blockStride,
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
    for (const entry of r.tiles.values()) this.releaseTile(r, entry);
    r.gl.deleteBuffer(r.blockBuffer);
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
      vertexSource(vertexShaderPrelude, define, layoutKey),
    );
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const handle = gl.createProgram();
    gl.attachShader(handle, vertex);
    gl.attachShader(handle, fragment);
    gl.linkProgram(handle);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(handle, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(handle) ?? "";
      gl.deleteProgram(handle);
      throw new Error(`building program link failed: ${log}`);
    }
    const index = gl.getUniformBlockIndex(handle, DRAWABLE_BLOCK);
    if (index !== gl.INVALID_INDEX)
      gl.uniformBlockBinding(handle, index, DRAWABLE_BINDING);
    const program: Program = { handle, uniforms: {} };
    for (const name of [...PROJECTION_UNIFORMS, TRANSLATE_UNIFORM] as const)
      program.uniforms[name] = gl.getUniformLocation(handle, name);
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

/** A tile point as [longitude, latitude]. */
function lngLat(canonical: CanonicalTile, p: Point): Position {
  const size = EXTENT * 2 ** canonical.z;
  const x = (canonical.x * EXTENT + p.x) / size;
  const y = (canonical.y * EXTENT + p.y) / size;
  return [
    x * 360 - 180,
    (360 / Math.PI) * Math.atan(Math.exp((1 - 2 * y) * Math.PI)) - 90,
  ];
}

/**
 * A feature's rings as GeoJSON, grouped as core's classifyRings does: the
 * first ring's winding marks exteriors. Coordinates are the tile's, so a
 * footprint the tile clipped comes back clipped.
 */
function geometryOf(
  rings: readonly (readonly Point[])[],
  canonical: CanonicalTile,
): Polygon | MultiPolygon {
  const polygons: Position[][][] = [];
  let sign = 0;
  for (const ring of rings) {
    const area = signedArea2(ring);
    if (area === 0) continue;
    if (sign === 0) sign = Math.sign(area);
    const coordinates = ring.map((p) => lngLat(canonical, p));
    // y runs down in tiles and up in latitude, so the tile's exteriors
    // come out counterclockwise, as RFC 7946 asks.
    if (Math.sign(area) === sign || polygons.length === 0)
      polygons.push([coordinates]);
    else polygons[polygons.length - 1]!.push(coordinates);
  }
  return polygons.length === 1
    ? { type: "Polygon", coordinates: polygons[0]! }
    : { type: "MultiPolygon", coordinates: polygons };
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("building: cannot create shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "";
    gl.deleteShader(shader);
    throw new Error(`building shader compile failed: ${log}`);
  }
  return shader;
}

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

/** Conservative check: even legacy zoom stops must keep separate layouts. */
function readsZoom(value: unknown): boolean {
  if (Array.isArray(value)) {
    return (
      value[0] !== "literal" && (value[0] === "zoom" || value.some(readsZoom))
    );
  }
  if (value && typeof value === "object") {
    return "stops" in value || Object.values(value).some(readsZoom);
  }
  return false;
}
