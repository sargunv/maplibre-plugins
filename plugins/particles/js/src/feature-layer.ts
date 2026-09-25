import {
  type AttributeLayout,
  attributeLayout,
  type FeatureValue,
  isFeatureValue,
} from "@maplibre-plugins/paint";
import type { FilterSpecification } from "@maplibre/maplibre-gl-style-spec";
import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MaplibreMap,
  OverscaledTileID,
} from "maplibre-gl";

import {
  createFeaturesPaintState,
  DEFAULT_TRANSITION,
  type FeaturesCurrent,
  type FeaturesPaintInput,
  type FeaturesPaintState,
  type TransitionOptions,
} from "./paint.ts";
import { TILE_SIZE, wrapClock } from "./record.ts";
import {
  fragmentSource,
  linkProgram,
  PROJECTION_UNIFORMS,
  type ProjectionUniform,
  setProjectionUniforms,
} from "./shader-common.ts";
import {
  type DataDrivenAttribute,
  dataDrivenAttributes,
  type DataDrivenName,
  FEATURE_UNIFORMS,
  featureBindings,
  featuresVertexSource,
  type FeatureUniform,
  valueWidth,
  variantMask,
} from "./shaders-features.ts";
import {
  EXTENT,
  featuresDataDriven,
  FEATURES_TYPE,
  type FeaturesPaintName,
  featuresLayout,
} from "./spec.ts";
import {
  compileFilter,
  GEOJSON_SOURCE_LAYER,
  layoutTile,
  tileAttributes,
  type TileSlots,
} from "./tiles.ts";

/** Frames a tile's particles survive after it stops being rendered. */
const EVICT_AFTER_FRAMES = 120;
/** A tile's one segment of 16-bit indices holds this many quads at most. */
const SEGMENT_QUADS = featuresLayout.maxParticlesPerTile;

export interface ParticleFeaturesLayerOptions {
  id: string;
  /** A vector or GeoJSON source in the map's style. */
  source: string;
  /**
   * The layer inside the source's tiles whose points, lines and polygons
   * emit. Leave it out for a GeoJSON source.
   */
  sourceLayer?: string;
  filter?: FilterSpecification;
  paint?: FeaturesPaintInput;
  minzoom?: number;
  maxzoom?: number;
  visibility?: "visible" | "none";
  /** Default transition for property changes; per-property `<name>-transition` overrides it. */
  transition?: TransitionOptions;
  /** Style-layer metadata, carried through toLayerJson. */
  metadata?: unknown;
  /**
   * The particle clock in seconds, read once per frame and wrapped at 4096 s
   * like the native plugin's. Defaults to the page's monotonic clock; return
   * a constant for deterministic frames.
   */
  clock?: () => number;
}

/** A style-JSON layer object using the `particle-features` type, as the native plugin accepts. */
export interface ParticleFeaturesLayerJson {
  id: string;
  type: typeof FEATURES_TYPE;
  source: string;
  "source-layer"?: string;
  filter?: FilterSpecification;
  metadata?: unknown;
  paint?: FeaturesPaintInput;
  layout?: { visibility?: "visible" | "none" };
  minzoom?: number;
  maxzoom?: number;
}

type UniformName = ProjectionUniform | FeatureUniform;

interface Program {
  handle: WebGLProgram;
  uniforms: Partial<Record<UniformName, WebGLUniformLocation | null>>;
}

interface TileEntry {
  /** The raw tile the layout was built from; a reload replaces it. */
  raw: ArrayBuffer;
  /** The tile's overscaled zoom: its filter's zoom, and where its data-driven values are evaluated. */
  zoom: number;
  /** The tile's slots, without the vertices uploaded to emitBuffer; null when none are kept. */
  layout: TileSlots | null;
  vao: WebGLVertexArrayObject | null;
  emitBuffer: WebGLBuffer | null;
  /** The data-driven properties' (min, max) per vertex, interleaved as the attribute layout says. */
  paintBuffer: WebGLBuffer | null;
  /** The paint generation and attribute layout paintBuffer was filled for. */
  gen: number;
  layoutKey: string;
  lastUsed: number;
}

interface Resources {
  gl: WebGL2RenderingContext;
  /** The quad pattern {4k, 4k+1, 4k+2, 4k, 4k+2, 4k+3} every tile's one segment draws. */
  indexBuffer: WebGLBuffer | null;
  programs: globalThis.Map<string, Program>;
  tiles: globalThis.Map<string, TileEntry>;
}

/**
 * A maplibre-gl-js custom layer drawing the same particles as the native
 * `particle-features` plugin layer: particles from every point, line and
 * polygon of a vector source layer the style already loads, from the shared
 * shader core. Add it with `map.addLayer(layer, beforeId)`; the source needs
 * another visible style layer, or maplibre-gl loads none of its tiles.
 *
 * Like the native layer it lays each tile out once into static slots (layout.ts)
 * and sends the paint as uniforms every frame. particle-density, -shape, -size
 * and -color may depend on the feature: those per-feature values fill one
 * buffer per tile through the shared paint binder, refilled only when a
 * data-driven value changes.
 *
 * Past a vector source's maxzoom MapLibre Native overscales the maxzoom tile,
 * while maplibre-gl by default splits it into smaller tiles (its
 * `zoomLevelsToOverscale` map option, up to the map's maxZoom - 4). Particles
 * are laid out per tile, so there they land elsewhere than native's and keep
 * their screen density further. Create the map with
 * `zoomLevelsToOverscale: undefined` for the native placement.
 */
export class ParticleFeaturesLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom";
  readonly renderingMode = "2d";
  readonly source: string;
  readonly sourceLayer: string | undefined;

  private filterJson: FilterSpecification | undefined;
  private filter: ReturnType<typeof compileFilter>;
  private readonly paint: FeaturesPaintState;
  private readonly clock: () => number;
  private readonly metadata: unknown;
  private minzoom: number;
  private maxzoom: number;
  private visibility: "visible" | "none";

  private map: MaplibreMap | null = null;
  private resources: Resources | null = null;
  private contextLost = false;
  private frame = 0;
  private readonly listeners: Array<() => void> = [];

  /** Throws on invalid paint values or filters. */
  constructor(options: ParticleFeaturesLayerOptions) {
    this.id = options.id;
    this.source = options.source;
    this.sourceLayer = options.sourceLayer;
    this.filterJson = options.filter;
    this.filter = compileFilter(options.filter);
    this.minzoom = options.minzoom ?? 0;
    this.maxzoom = options.maxzoom ?? 24;
    this.visibility = options.visibility ?? "visible";
    this.metadata = options.metadata;
    this.clock = options.clock ?? (() => now() / 1000);
    this.paint = createFeaturesPaintState(
      { ...DEFAULT_TRANSITION, ...options.transition },
      options.paint ?? {},
    );
  }

  /** Builds a layer from style-layer JSON of type `particle-features`, the form the native plugin consumes. */
  static fromLayerJson(
    json: ParticleFeaturesLayerJson,
    options: Pick<ParticleFeaturesLayerOptions, "transition" | "clock"> = {},
  ): ParticleFeaturesLayer {
    const actual: string = (json as { type: string }).type;
    if (actual !== FEATURES_TYPE) {
      throw new Error(`Expected layer type ${FEATURES_TYPE}, got ${actual}`);
    }
    if (!json.source) throw new Error(`${FEATURES_TYPE} layers need a source`);
    const layer: ParticleFeaturesLayerOptions = {
      id: json.id,
      source: json.source,
      ...options,
    };
    if (json["source-layer"] !== undefined)
      layer.sourceLayer = json["source-layer"];
    if (json.filter !== undefined) layer.filter = json.filter;
    if (json.metadata !== undefined) layer.metadata = json.metadata;
    if (json.paint) layer.paint = json.paint;
    if (json.minzoom !== undefined) layer.minzoom = json.minzoom;
    if (json.maxzoom !== undefined) layer.maxzoom = json.maxzoom;
    if (json.layout?.visibility) layer.visibility = json.layout.visibility;
    return new ParticleFeaturesLayer(layer);
  }

  /** The layer as style-layer JSON, with the current raw paint values. */
  toLayerJson(): ParticleFeaturesLayerJson {
    const json: ParticleFeaturesLayerJson = {
      id: this.id,
      type: FEATURES_TYPE,
      source: this.source,
    };
    if (this.sourceLayer !== undefined) json["source-layer"] = this.sourceLayer;
    if (this.filterJson !== undefined) json.filter = this.filterJson;
    if (this.metadata !== undefined) json.metadata = this.metadata;
    json.paint = this.paint.toJson() as FeaturesPaintInput;
    if (this.minzoom !== 0) json.minzoom = this.minzoom;
    if (this.maxzoom !== 24) json.maxzoom = this.maxzoom;
    if (this.visibility !== "visible")
      json.layout = { visibility: this.visibility };
    return json;
  }

  getPaintProperty(name: FeaturesPaintName): unknown {
    return this.paint.get(name);
  }

  /**
   * Sets a paint property or its `<name>-transition`, animating to the new
   * value like a native style transition; a feature-dependent value takes
   * effect at once, as the host's binders do. Invalid values, and a
   * transition for a property that takes none, throw and leave the old value
   * in place.
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
  setPaint(paint: FeaturesPaintInput, transition?: TransitionOptions): void {
    for (const [name, value] of Object.entries(paint)) {
      this.setPaintProperty(name, value, transition);
    }
  }

  setLayoutProperty(name: "visibility", value: "visible" | "none"): void {
    if (name !== "visibility")
      throw new Error(`Unknown layout property ${String(name)}`);
    this.visibility = value;
    this.map?.triggerRepaint();
  }

  /** Replaces the feature filter; tiles lay out again on their next frame. Throws on invalid filters. */
  setFilter(filter: FilterSpecification | undefined): void {
    this.filter = compileFilter(filter);
    this.filterJson = filter;
    this.dropTiles();
    this.map?.triggerRepaint();
  }

  setZoomRange(minzoom: number, maxzoom: number): void {
    this.minzoom = minzoom;
    this.maxzoom = maxzoom;
    this.map?.triggerRepaint();
  }

  onAdd(map: MaplibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.contextLost = false;
    this.acquire(gl);
    const lost = () => {
      this.contextLost = true;
      this.resources = null;
    };
    const restored = () => {
      this.contextLost = false;
      map.triggerRepaint();
    };
    map.on("webglcontextlost", lost);
    map.on("webglcontextrestored", restored);
    this.listeners.push(
      () => map.off("webglcontextlost", lost),
      () => map.off("webglcontextrestored", restored),
    );
  }

  onRemove(): void {
    for (const remove of this.listeners.splice(0)) remove();
    if (!this.contextLost) this.release();
    this.resources = null;
    this.map = null;
  }

  render(gl: WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    const map = this.map;
    if (!map || this.contextLost || gl.isContextLost()) return;
    this.frame++;
    // The cache ages on every frame the map renders, drawn or not, so a
    // layer that is hidden, out of its zoom range or showing no tiles lets
    // its tiles go after EVICT_AFTER_FRAMES.
    if (this.frame % 30 === 0 && this.resources) this.evict(this.resources);
    const transform = map.painter.transform;
    const zoom = transform.zoom;
    if (
      this.visibility === "none" ||
      zoom < this.minzoom ||
      zoom >= this.maxzoom
    )
      return;
    // Particles move every frame, like the native should_animate = 1.
    map.triggerRepaint();

    const { width, height } = transform;
    const manager = map.style?.tileManagers?.[this.source];
    // A removed source's tiles are gone for good: added again, it loads
    // new ones.
    if (!manager) this.dropTiles();
    const coords = manager?.getVisibleCoordinates() ?? [];
    if (coords.length === 0 || width <= 0 || height <= 0) return;
    const time = now();
    const current = this.paint.current(zoom, time);
    // The feature-dependent values in effect choose the program variant and
    // the attributes each tile carries.
    const layout = attributeLayout(featuresDataDriven, current);
    const generation = this.paint.generation;

    const resources = this.resources ?? this.acquire(gl);
    const program = this.program(resources, args, variantMask(layout.bound));
    const u = program.uniforms;
    const pixelRatio = gl.drawingBufferWidth / width;
    const seconds = wrapClock(this.clock());
    const ctcd = transform.cameraToCenterDistance;

    const previousVao = gl.getParameter(
      gl.VERTEX_ARRAY_BINDING,
    ) as WebGLVertexArrayObject | null;
    try {
      gl.useProgram(program.handle);
      // Depth stays as maplibre sets it for a 2D custom layer: tested and
      // read-only at the layer's sublayer depth, like the native drawables.
      // An opaque fill above the layer, which maplibre draws in the earlier
      // opaque pass, then still covers the particles, as on native.
      gl.disable(gl.STENCIL_TEST);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      if (u["u.screen"])
        gl.uniform4f(u["u.screen"], 2 / width, -2 / height, width, height);
      this.setPaintUniforms(gl, program, current, zoom);

      const interpolation = new Float32Array(16);
      for (const coord of coords) {
        const entry = this.tileEntry(resources, coord);
        if (!entry) continue;
        entry.lastUsed = this.frame;
        if (!entry.layout || !entry.vao) continue;
        gl.bindVertexArray(entry.vao);
        this.syncData(resources, entry, current, layout, generation);

        setProjectionUniforms(
          gl,
          u,
          args.getProjectionData({
            tileID: { wrap: coord.wrap, canonical: coord.canonical },
            applyGlobeMatrix: true,
          }),
        );
        // Pixels to tile units at the canonical tile's zoom, as the host's
        // uniform context has it: an overscaled tile keeps its source tile's
        // units.
        const ptu = EXTENT / (TILE_SIZE * 2 ** (zoom - coord.canonical.z));
        if (u["u.camera"])
          gl.uniform4f(u["u.camera"], ptu, pixelRatio, seconds, ctcd);
        // A zoom-and-feature value mixes its values at the tile's zoom and
        // the next by where the map's zoom sits between them.
        interpolation.fill(0);
        for (const attribute of dataDrivenAttributes) {
          if (layout.offsets[attribute.name] === undefined) continue;
          const value = current[attribute.name] as FeatureValue;
          interpolation[attribute.binding] = value.factor(entry.zoom, zoom);
        }
        for (let i = 0; i < 4; i++) {
          const location = u[`u.interpolation${i}` as FeatureUniform];
          if (location)
            gl.uniform4fv(location, interpolation.subarray(4 * i, 4 * i + 4));
        }
        gl.drawElements(
          gl.TRIANGLES,
          6 * entry.layout.quads,
          gl.UNSIGNED_SHORT,
          0,
        );
      }
    } finally {
      gl.bindVertexArray(previousVao);
    }
  }

  /** The cached particle slots of a tile, laid out from the raw tile on first use. */
  private tileEntry(
    resources: Resources,
    coord: OverscaledTileID,
  ): TileEntry | null {
    const manager = this.map?.style?.tileManagers?.[this.source];
    const tile = manager?.getTileByID(coord.key);
    // MapLibre Tiles (MLT) are not parsed here.
    if (
      !tile?.hasData() ||
      !tile.latestRawTileData ||
      tile.latestEncoding === "mlt"
    )
      return null;
    const raw = tile.latestRawTileData;
    let entry = resources.tiles.get(coord.key);
    if (entry && entry.raw === raw) return entry;
    if (entry) this.releaseTile(resources.gl, entry);
    const layout = layoutTile(
      raw,
      this.sourceLayer ?? GEOJSON_SOURCE_LAYER,
      this.filter,
      coord.overscaledZ,
      coord.canonical,
    );
    entry = {
      raw,
      zoom: coord.overscaledZ,
      layout: null,
      vao: null,
      emitBuffer: null,
      paintBuffer: null,
      gen: -1,
      layoutKey: "",
      lastUsed: this.frame,
    };
    if (layout && layout.quads > 0) {
      // The vertices go to the GPU once; the entry keeps only the slots, as
      // maplibre-gl frees its own arrays after a static upload.
      const { vertices, ...slots } = layout;
      entry.layout = slots;
      const { gl } = resources;
      entry.vao = gl.createVertexArray();
      entry.emitBuffer = gl.createBuffer();
      gl.bindVertexArray(entry.vao);
      this.bindIndices(resources);
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.emitBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
    }
    resources.tiles.set(coord.key, entry);
    return entry;
  }

  /**
   * Brings a tile's data-driven attributes in line with the values in
   * effect: refills the tile's paint buffer when the paint generation or the
   * attribute layout changed since the last fill, and points each bound
   * property's locations into it. Expects the tile's VAO bound.
   */
  private syncData(
    resources: Resources,
    entry: TileEntry,
    current: FeaturesCurrent,
    layout: AttributeLayout<DataDrivenName>,
    generation: number,
  ): void {
    if (entry.gen === generation && entry.layoutKey === layout.key) return;
    const { gl } = resources;
    entry.gen = generation;
    entry.layoutKey = layout.key;
    if (layout.stride > 0) {
      entry.paintBuffer ??= gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.paintBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        tileAttributes(entry.layout!, layout, current, entry.zoom),
        gl.STATIC_DRAW,
      );
    } else if (entry.paintBuffer) {
      gl.deleteBuffer(entry.paintBuffer);
      entry.paintBuffer = null;
    }
    const stride = 4 * layout.stride;
    for (const attribute of dataDrivenAttributes) {
      const offset = layout.offsets[attribute.name];
      const locations = attributeLocations(attribute);
      if (offset === undefined) {
        for (const location of locations) gl.disableVertexAttribArray(location);
        continue;
      }
      // (min, max) per vertex: floats and enums as a vec2, pairs as a vec4,
      // colors as two vec4s.
      const size = attribute.width === 4 ? 4 : 2 * attribute.width;
      locations.forEach((location, i) => {
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(
          location,
          size,
          gl.FLOAT,
          false,
          stride,
          4 * offset + 16 * i,
        );
      });
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
  }

  private releaseTile(gl: WebGL2RenderingContext, entry: TileEntry): void {
    if (entry.vao) gl.deleteVertexArray(entry.vao);
    if (entry.emitBuffer) gl.deleteBuffer(entry.emitBuffer);
    if (entry.paintBuffer) gl.deleteBuffer(entry.paintBuffer);
    entry.vao = entry.emitBuffer = entry.paintBuffer = null;
    entry.gen = -1;
    entry.layoutKey = "";
  }

  /**
   * The uniform value of every property; the data-driven ones in the variant
   * read their attributes instead, and get the value the host evaluates
   * without a feature.
   */
  private setPaintUniforms(
    gl: WebGL2RenderingContext,
    program: Program,
    current: FeaturesCurrent,
    zoom: number,
  ): void {
    for (const binding of featureBindings) {
      const location = program.uniforms[`u.${binding.field}` as FeatureUniform];
      if (!location) continue;
      const bound = current[binding.name];
      const value = isFeatureValue(bound) ? bound.withoutFeature(zoom) : bound;
      const width = valueWidth(binding.name);
      if (width === 4)
        gl.uniform4f(
          location,
          value[0] ?? 0,
          value[1] ?? 0,
          value[2] ?? 0,
          value[3] ?? 0,
        );
      else if (width === 2)
        gl.uniform2f(location, value[0] ?? 0, value[1] ?? 0);
      else gl.uniform1f(location, value[0] ?? 0);
    }
  }

  private acquire(gl: WebGL2RenderingContext): Resources {
    this.resources = {
      gl,
      indexBuffer: null,
      programs: new globalThis.Map(),
      tiles: new globalThis.Map(),
    };
    return this.resources;
  }

  /**
   * Binds the shared quad pattern to the bound VAO, uploading it on first
   * use; binding it inside a tile's VAO keeps maplibre's own VAOs untouched.
   */
  private bindIndices(resources: Resources): void {
    const { gl } = resources;
    if (resources.indexBuffer) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, resources.indexBuffer);
      return;
    }
    const indices = new Uint16Array(6 * SEGMENT_QUADS);
    for (let k = 0; k < SEGMENT_QUADS; k++) {
      indices.set(
        [4 * k, 4 * k + 1, 4 * k + 2, 4 * k, 4 * k + 2, 4 * k + 3],
        6 * k,
      );
    }
    resources.indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, resources.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
  }

  private release(): void {
    const r = this.resources;
    this.resources = null;
    // maplibre-gl removes custom layers when the context is lost (the app
    // adds them again after the restore); a lost context has nothing to free.
    if (!r || r.gl.isContextLost()) return;
    for (const program of r.programs.values())
      r.gl.deleteProgram(program.handle);
    for (const entry of r.tiles.values()) this.releaseTile(r.gl, entry);
    if (r.indexBuffer) r.gl.deleteBuffer(r.indexBuffer);
  }

  /** The program for a projection variant and a data-driven mask, compiled on first use. */
  private program(
    resources: Resources,
    args: CustomRenderMethodInput,
    mask: number,
  ): Program {
    const { gl } = resources;
    const { variantName, vertexShaderPrelude, define } = args.shaderData;
    const key = `${variantName}/${mask}`;
    const cached = resources.programs.get(key);
    if (cached) return cached;
    const handle = linkProgram(
      gl,
      featuresVertexSource(vertexShaderPrelude, define, mask),
      fragmentSource,
      FEATURES_TYPE,
    );
    const program: Program = { handle, uniforms: {} };
    for (const name of [...PROJECTION_UNIFORMS, ...FEATURE_UNIFORMS])
      program.uniforms[name] = gl.getUniformLocation(handle, name);
    resources.programs.set(key, program);
    return program;
  }
}

/** A data-driven attribute's locations: one, or a color's min and max. */
function attributeLocations(attribute: DataDrivenAttribute): number[] {
  return attribute.width === 4
    ? [attribute.location, attribute.location + 1]
    : [attribute.location];
}

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}
