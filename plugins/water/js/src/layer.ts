import type { FilterSpecification } from "@maplibre/maplibre-gl-style-spec";
import type { Feature } from "geojson";
import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MaplibreMap,
  OverscaledTileID,
} from "maplibre-gl";

import { containsPoint, FLOATS_PER_VERTEX } from "./layout.ts";
import {
  createPaintState,
  DEFAULT_TRANSITION,
  type EvaluatedPaint,
  shouldAnimate,
  type TransitionOptions,
  type WaterPaintState,
} from "./paint.ts";
import {
  fragmentSource,
  LAYER_UNIFORMS,
  PROJECTION_UNIFORMS,
  vertexSource,
} from "./shaders.ts";
import { EXTENT, LAYER_TYPE, type PaintName } from "./spec.ts";
import { compileFilter, layoutTile, type TileGeometry } from "./tiles.ts";

const TILE_SIZE = 512;
/** The animation clock wraps like the native plugin's, keeping float precision. */
const TIME_WRAP_SECONDS = 4096;
/** Frames a tile's geometry survives after it stops being rendered. */
const EVICT_AFTER_FRAMES = 120;

/** Raw paint input: literals, CSS colors, or style expressions, keyed by property name. */
export type PaintInput = Partial<Record<PaintName, unknown>> &
  Partial<Record<`${PaintName}-transition`, TransitionOptions>>;

export interface WaterShoreLayerOptions {
  id: string;
  /** A vector source in the map's style. */
  source: string;
  /** The polygon layer inside the source's tiles, e.g. `water`. */
  sourceLayer: string;
  filter?: FilterSpecification;
  paint?: PaintInput;
  minzoom?: number;
  maxzoom?: number;
  visibility?: "visible" | "none";
  /** Default transition for property changes; per-property `<name>-transition` overrides it. */
  transition?: TransitionOptions;
}

/** A style-JSON layer object using the `water-shore` type, as the native plugin accepts. */
export interface WaterShoreLayerJson {
  id: string;
  type: typeof LAYER_TYPE;
  source: string;
  "source-layer": string;
  filter?: FilterSpecification;
  paint?: PaintInput;
  layout?: { visibility?: "visible" | "none" };
  minzoom?: number;
  maxzoom?: number;
}

type UniformName =
  | (typeof PROJECTION_UNIFORMS)[number]
  | (typeof LAYER_UNIFORMS)[number];

interface Program {
  handle: WebGLProgram;
  uniforms: Partial<Record<UniformName, WebGLUniformLocation | null>>;
}

interface TileEntry {
  /** The raw tile the geometry was built from; a reload replaces it. */
  raw: ArrayBuffer;
  geometry: TileGeometry | null;
  vao: WebGLVertexArrayObject | null;
  vertexBuffer: WebGLBuffer | null;
  indexBuffer: WebGLBuffer | null;
  lastUsed: number;
}

interface Resources {
  gl: WebGL2RenderingContext;
  programs: globalThis.Map<string, Program>;
  tiles: globalThis.Map<string, TileEntry>;
}

function mercatorY(latitude: number): number {
  const lat =
    (Math.min(Math.max(latitude, -89.999999), 89.999999) * Math.PI) / 180;
  return (1 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / Math.PI) / 2;
}

/**
 * A maplibre-gl-js custom layer drawing the same animated shoreline as the
 * native `water-shore` plugin layer: it reads the water polygons of a vector
 * source the style already loads, builds a band along every shoreline, and
 * animates crests and wash in it. Add it with `map.addLayer(layer, beforeId)`
 * above the style's water fill.
 */
export class WaterShoreLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom";
  readonly renderingMode = "2d";
  readonly source: string;
  readonly sourceLayer: string;

  private filterJson: FilterSpecification | undefined;
  private filter: ReturnType<typeof compileFilter>;
  private readonly paint: WaterPaintState;
  private minzoom: number;
  private maxzoom: number;
  private visibility: "visible" | "none";

  private map: MaplibreMap | null = null;
  private resources: Resources | null = null;
  private contextLost = false;
  private frame = 0;
  private readonly listeners: Array<() => void> = [];

  constructor(options: WaterShoreLayerOptions) {
    this.id = options.id;
    this.source = options.source;
    this.sourceLayer = options.sourceLayer;
    this.filterJson = options.filter;
    this.filter = compileFilter(options.filter);
    this.minzoom = options.minzoom ?? 0;
    this.maxzoom = options.maxzoom ?? 24;
    this.visibility = options.visibility ?? "visible";
    this.paint = createPaintState(
      { ...DEFAULT_TRANSITION, ...options.transition },
      options.paint ?? {},
    );
  }

  /** Builds a layer from style-layer JSON of type `water-shore`, the form the native plugin consumes. */
  static fromLayerJson(
    json: WaterShoreLayerJson,
    transition?: TransitionOptions,
  ): WaterShoreLayer {
    const actual: string = (json as { type: string }).type;
    if (actual !== LAYER_TYPE) {
      throw new Error(`Expected layer type ${LAYER_TYPE}, got ${actual}`);
    }
    if (!json.source || !json["source-layer"]) {
      throw new Error(`${LAYER_TYPE} layers need a source and a source-layer`);
    }
    const options: WaterShoreLayerOptions = {
      id: json.id,
      source: json.source,
      sourceLayer: json["source-layer"],
    };
    if (json.filter !== undefined) options.filter = json.filter;
    if (json.paint) options.paint = json.paint;
    if (json.minzoom !== undefined) options.minzoom = json.minzoom;
    if (json.maxzoom !== undefined) options.maxzoom = json.maxzoom;
    if (json.layout?.visibility) options.visibility = json.layout.visibility;
    if (transition) options.transition = transition;
    return new WaterShoreLayer(options);
  }

  /** The layer as style-layer JSON, with the current raw paint values. */
  toLayerJson(): WaterShoreLayerJson {
    const json: WaterShoreLayerJson = {
      id: this.id,
      type: LAYER_TYPE,
      source: this.source,
      "source-layer": this.sourceLayer,
    };
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
   * value like a native style transition. Invalid values throw and leave the
   * old value in place.
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
    this.map?.triggerRepaint();
  }

  /** Whether a screen point in logical pixels is over water the layer drew a shore for. */
  hitTest(point: { x: number; y: number }): boolean {
    return this.queryFeature(point) !== null;
  }

  /**
   * The water polygon under a screen point, as GeoJSON, or null. Like the
   * native rendered-feature query this tests the polygons of the tiles the
   * layer last rendered.
   */
  queryFeature(point: { x: number; y: number }): Feature | null {
    const map = this.map;
    const resources = this.resources;
    if (!map || !resources) return null;
    const lngLat = map.unproject([point.x, point.y]);
    const mx = ((((lngLat.lng + 180) / 360) % 1) + 1) % 1;
    const my = mercatorY(lngLat.lat);
    for (const coord of this.visibleTiles()) {
      const entry = resources.tiles.get(coord.key);
      if (!entry?.geometry) continue;
      const { z, x, y } = coord.canonical;
      const tiles = 2 ** z;
      const local = {
        x: (mx * tiles - x) * EXTENT,
        y: (my * tiles - y) * EXTENT,
      };
      if (local.x < 0 || local.y < 0 || local.x >= EXTENT || local.y >= EXTENT)
        continue;
      for (const { rings, feature } of entry.geometry.features) {
        if (containsPoint(rings, local)) return feature.toGeoJSON(x, y, z);
      }
    }
    return null;
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
    const zoom = map.getZoom();
    if (
      this.visibility === "none" ||
      zoom < this.minzoom ||
      zoom >= this.maxzoom
    )
      return;

    const time = now();
    const paint = this.paint.evaluate(zoom, time);
    if (shouldAnimate(paint) || this.paint.active(time)) map.triggerRepaint();
    if ((paint.opacity[0] ?? 0) <= 0 || (paint["shore-width"][0] ?? 0) <= 0)
      return;

    const resources = this.resources ?? this.acquire(gl);
    const coords = this.visibleTiles();
    if (coords.length === 0) return;
    const program = this.program(resources, args);
    const canvas = map.getCanvas();
    const pixelRatio = gl.drawingBufferWidth / Math.max(canvas.clientWidth, 1);
    const seconds = (time / 1000) % TIME_WRAP_SECONDS;

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
      this.setPaintUniforms(gl, program, paint);

      for (const coord of coords) {
        const entry = this.tileEntry(resources, coord);
        if (!entry?.geometry || !entry.vao) continue;
        entry.lastUsed = this.frame;
        const projection = args.getProjectionData({
          tileID: { wrap: coord.wrap, canonical: coord.canonical },
          applyGlobeMatrix: true,
        });
        this.setProjectionUniforms(gl, program, projection);
        const pixelsToTileUnits =
          EXTENT / (TILE_SIZE * 2 ** (zoom - coord.overscaledZ));
        if (program.uniforms.u_camera) {
          gl.uniform4f(
            program.uniforms.u_camera,
            pixelsToTileUnits,
            pixelRatio,
            seconds,
            EXTENT,
          );
        }
        gl.bindVertexArray(entry.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, entry.vertexBuffer);
        const stride = FLOATS_PER_VERTEX * 4;
        for (const segment of entry.geometry.segments) {
          // Indices are segment-relative, as in the native bucket, so each
          // segment re-bases the attribute pointers.
          const base = segment.vertexOffset * stride;
          gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, base);
          gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, base + 8);
          gl.drawElements(
            gl.TRIANGLES,
            segment.indexLength,
            gl.UNSIGNED_SHORT,
            segment.indexOffset * 2,
          );
        }
      }
    } finally {
      gl.bindVertexArray(previousVao);
    }
    if (this.frame % 30 === 0) this.evict(resources);
  }

  private visibleTiles(): OverscaledTileID[] {
    const manager = this.map?.style?.tileManagers?.[this.source];
    if (!manager) return [];
    return manager.getVisibleCoordinates();
  }

  /** The cached geometry for a tile, laid out from the raw tile on first use. */
  private tileEntry(
    resources: Resources,
    coord: OverscaledTileID,
  ): TileEntry | null {
    const manager = this.map?.style?.tileManagers?.[this.source];
    const tile = manager?.getTileByID(coord.key);
    if (!tile?.hasData() || !tile.latestRawTileData) return null;
    const raw = tile.latestRawTileData;
    let entry = resources.tiles.get(coord.key);
    if (entry && entry.raw === raw) return entry;
    if (entry) this.releaseTile(resources.gl, entry);
    const geometry = layoutTile(
      raw,
      this.sourceLayer,
      this.filter,
      coord.overscaledZ,
      coord.canonical,
    );
    entry = {
      raw,
      geometry,
      vao: null,
      vertexBuffer: null,
      indexBuffer: null,
      lastUsed: this.frame,
    };
    if (geometry && geometry.vertices.length > 0) {
      const { gl } = resources;
      entry.vao = gl.createVertexArray();
      entry.vertexBuffer = gl.createBuffer();
      entry.indexBuffer = gl.createBuffer();
      gl.bindVertexArray(entry.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.vertexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, geometry.vertices, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, entry.indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geometry.indices, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.enableVertexAttribArray(1);
    } else {
      entry.geometry = null;
    }
    resources.tiles.set(coord.key, entry);
    return entry;
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
    if (entry.vertexBuffer) gl.deleteBuffer(entry.vertexBuffer);
    if (entry.indexBuffer) gl.deleteBuffer(entry.indexBuffer);
    entry.vao = entry.vertexBuffer = entry.indexBuffer = null;
  }

  private setPaintUniforms(
    gl: WebGL2RenderingContext,
    program: Program,
    paint: EvaluatedPaint,
  ): void {
    const u = program.uniforms;
    const n = (name: PaintName) => paint[name][0] ?? 0;
    const c = (name: PaintName) =>
      paint[name] as [number, number, number, number];
    if (u.u_shore_color) gl.uniform4fv(u.u_shore_color, c("shore-color"));
    if (u.u_foam_color) gl.uniform4fv(u.u_foam_color, c("foam-color"));
    if (u.u_wave) {
      gl.uniform4f(
        u.u_wave,
        n("shore-width"),
        n("wave-count"),
        n("wave-speed"),
        n("wave-wobble"),
      );
    }
    if (u.u_params) {
      gl.uniform3f(
        u.u_params,
        n("foam-length"),
        n("wash-strength"),
        n("opacity"),
      );
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

  private acquire(gl: WebGL2RenderingContext): Resources {
    this.resources = {
      gl,
      programs: new globalThis.Map(),
      tiles: new globalThis.Map(),
    };
    return this.resources;
  }

  private release(): void {
    const r = this.resources;
    if (!r) return;
    for (const program of r.programs.values())
      r.gl.deleteProgram(program.handle);
    for (const entry of r.tiles.values()) this.releaseTile(r.gl, entry);
    this.resources = null;
  }

  private program(
    resources: Resources,
    args: CustomRenderMethodInput,
  ): Program {
    const { gl } = resources;
    const { variantName, vertexShaderPrelude, define } = args.shaderData;
    const cached = resources.programs.get(variantName);
    if (cached) return cached;
    const vertex = compileShader(
      gl,
      gl.VERTEX_SHADER,
      vertexSource(vertexShaderPrelude, define),
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
      throw new Error(`water-shore program link failed: ${log}`);
    }
    const program: Program = { handle, uniforms: {} };
    for (const name of [...PROJECTION_UNIFORMS, ...LAYER_UNIFORMS])
      program.uniforms[name] = gl.getUniformLocation(handle, name);
    resources.programs.set(variantName, program);
    return program;
  }
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("water-shore: cannot create shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "";
    gl.deleteShader(shader);
    throw new Error(`water-shore shader compile failed: ${log}`);
  }
  return shader;
}

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}
