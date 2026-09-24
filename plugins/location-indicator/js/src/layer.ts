import type { Feature, Point as GeoJsonPoint } from "geojson";
import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MaplibreMap,
} from "maplibre-gl";

import {
  buildFrame,
  containsPoint,
  destination,
  FLOATS_PER_VERTEX,
  type FrameGeometry,
  type Point,
} from "./geometry.ts";
import {
  compile,
  DEFAULT_TRANSITION,
  type EvaluatedPaint,
  PaintValue,
  type TransitionOptions,
} from "./paint.ts";
import {
  fragmentSource,
  PROJECTION_UNIFORMS,
  vertexSource,
} from "./shaders.ts";
import {
  isPaintName,
  LAYER_TYPE,
  type PaintName,
  paintNames,
  paintSpec,
} from "./spec.ts";

const EXTENT = 8192;
const TILE_SIZE = 512;
const MAX_TILE_ZOOM = 22;

/** Raw paint input: literals, CSS colors, or style expressions, keyed by property name. */
export type PaintInput = Partial<Record<PaintName, unknown>> &
  Partial<Record<`${PaintName}-transition`, TransitionOptions>>;

export interface LocationPuckLayerOptions {
  id: string;
  paint?: PaintInput;
  minzoom?: number;
  maxzoom?: number;
  visibility?: "visible" | "none";
  /** Default transition for property changes; per-property `<name>-transition` overrides it. */
  transition?: TransitionOptions;
}

/** A style-JSON layer object using the `location-puck` type, as the native plugin accepts. */
export interface LocationPuckLayerJson {
  id: string;
  type: typeof LAYER_TYPE;
  paint?: PaintInput;
  layout?: { visibility?: "visible" | "none" };
  minzoom?: number;
  maxzoom?: number;
}

interface Program {
  handle: WebGLProgram;
  uniforms: Partial<
    Record<(typeof PROJECTION_UNIFORMS)[number], WebGLUniformLocation | null>
  >;
}

interface Resources {
  gl: WebGL2RenderingContext;
  vao: WebGLVertexArrayObject;
  vertexBuffer: WebGLBuffer;
  indexBuffer: WebGLBuffer;
  programs: globalThis.Map<string, Program>;
}

interface RenderedFrame {
  geometry: FrameGeometry;
  worldSize: number;
  centerLongitude: number;
}

function mercatorY(latitude: number): number {
  const lat =
    (Math.min(Math.max(latitude, -89.999999), 89.999999) * Math.PI) / 180;
  return (1 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / Math.PI) / 2;
}

/**
 * A maplibre-gl-js custom layer drawing the same procedural location
 * indicator as the native `location-puck` plugin layer. Add it with
 * `map.addLayer(layer, beforeId)` and drive it through `setPaintProperty`.
 */
export class LocationPuckLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom";
  readonly renderingMode = "2d";

  private readonly values: globalThis.Map<PaintName, PaintValue>;
  private readonly raw: globalThis.Map<PaintName, unknown>;
  private readonly transitions: globalThis.Map<PaintName, TransitionOptions>;
  private defaultTransition: Required<TransitionOptions>;
  private minzoom: number;
  private maxzoom: number;
  private visibility: "visible" | "none";

  private map: MaplibreMap | null = null;
  private resources: Resources | null = null;
  private contextLost = false;
  private lastFrame: RenderedFrame | null = null;
  private readonly listeners: Array<() => void> = [];

  constructor(options: LocationPuckLayerOptions) {
    this.id = options.id;
    this.minzoom = options.minzoom ?? 0;
    this.maxzoom = options.maxzoom ?? 24;
    this.visibility = options.visibility ?? "visible";
    this.defaultTransition = { ...DEFAULT_TRANSITION, ...options.transition };
    this.values = new globalThis.Map();
    this.raw = new globalThis.Map();
    this.transitions = new globalThis.Map();
    const paint = options.paint ?? {};
    for (const name of paintNames) {
      const value = paint[name] ?? paintSpec[name].default;
      this.raw.set(name, value);
      this.values.set(name, new PaintValue(name, compile(name, value)));
      const transition = paint[`${name}-transition`];
      if (transition) this.transitions.set(name, transition);
    }
  }

  /** Builds a layer from style-layer JSON of type `location-puck`, the form the native plugin consumes. */
  static fromLayerJson(
    json: LocationPuckLayerJson,
    transition?: TransitionOptions,
  ): LocationPuckLayer {
    const actual: string = (json as { type: string }).type;
    if (actual !== LAYER_TYPE) {
      throw new Error(`Expected layer type ${LAYER_TYPE}, got ${actual}`);
    }
    const options: LocationPuckLayerOptions = { id: json.id };
    if (json.paint) options.paint = json.paint;
    if (json.minzoom !== undefined) options.minzoom = json.minzoom;
    if (json.maxzoom !== undefined) options.maxzoom = json.maxzoom;
    if (json.layout?.visibility) options.visibility = json.layout.visibility;
    if (transition) options.transition = transition;
    return new LocationPuckLayer(options);
  }

  /** The layer as style-layer JSON, with the current raw paint values. */
  toLayerJson(): LocationPuckLayerJson {
    const paint: PaintInput = {};
    for (const name of paintNames) paint[name] = this.raw.get(name);
    for (const [name, transition] of this.transitions)
      paint[`${name}-transition`] = transition;
    const json: LocationPuckLayerJson = {
      id: this.id,
      type: LAYER_TYPE,
      paint,
    };
    if (this.minzoom !== 0) json.minzoom = this.minzoom;
    if (this.maxzoom !== 24) json.maxzoom = this.maxzoom;
    if (this.visibility !== "visible")
      json.layout = { visibility: this.visibility };
    return json;
  }

  getPaintProperty(name: PaintName): unknown {
    return this.raw.get(name);
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
    if (name.endsWith("-transition")) {
      const property = name.slice(0, -"-transition".length);
      if (!isPaintName(property))
        throw new Error(`Unknown paint property ${property}`);
      if (value === undefined || value === null)
        this.transitions.delete(property);
      else this.transitions.set(property, value as TransitionOptions);
      return;
    }
    if (!isPaintName(name)) throw new Error(`Unknown paint property ${name}`);
    const raw =
      value === undefined || value === null ? paintSpec[name].default : value;
    const compiled = compile(name, raw);
    this.raw.set(name, raw);
    const options = {
      ...this.defaultTransition,
      ...this.transitions.get(name),
      ...transition,
    };
    this.values.get(name)!.retarget(compiled, now(), options);
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

  setZoomRange(minzoom: number, maxzoom: number): void {
    this.minzoom = minzoom;
    this.maxzoom = maxzoom;
    this.map?.triggerRepaint();
  }

  /** Whether a screen point in logical pixels is over the puck or the arrow, per the last rendered frame. */
  hitTest(point: { x: number; y: number }): boolean {
    return this.queryFeature(point) !== null;
  }

  /** The rendered feature under a screen point, like the native frame query, or null. */
  queryFeature(point: { x: number; y: number }): Feature<GeoJsonPoint> | null {
    const frame = this.lastFrame;
    if (!frame || !this.map || !frame.geometry.feature) return null;
    const lngLat = this.map.unproject([point.x, point.y]);
    const world = this.projectMercator(
      lngLat.lat,
      lngLat.lng,
      frame.worldSize,
      frame.centerLongitude,
    );
    for (const polygon of frame.geometry.queryPolygons) {
      if (containsPoint(polygon, world)) return frame.geometry.feature;
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
    this.lastFrame = null;
    this.map = null;
  }

  render(gl: WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    const map = this.map;
    if (!map || this.contextLost || gl.isContextLost()) return;
    this.lastFrame = null;
    const zoom = map.getZoom();
    if (
      this.visibility === "none" ||
      zoom < this.minzoom ||
      zoom >= this.maxzoom
    )
      return;

    const time = now();
    const paint = this.evaluate(zoom, time);
    if (this.active(time)) map.triggerRepaint();

    const worldSize = TILE_SIZE * 2 ** zoom;
    const canvas = map.getCanvas();
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width <= 0 || height <= 0) return;
    const centerLongitude = map.getCenter().lng;
    const projectMercator = (lat: number, lon: number): Point =>
      this.projectMercator(lat, lon, worldSize, centerLongitude);
    // mainMatrix maps unit Mercator coordinates to clip space; its w is the
    // depth the built-in shaders divide the camera distance by.
    const m = args.defaultProjectionData.mainMatrix;
    const clipW = (x: number, y: number) =>
      (m[3] ?? 0) * (x / worldSize) +
      (m[7] ?? 0) * (y / worldSize) +
      (m[15] ?? 0);

    const geometry = buildFrame({
      paint,
      pitch: (map.getPitch() * Math.PI) / 180,
      bearing: map.getBearing(),
      cameraToCenterDistance: (0.5 * height) / Math.tan(args.fov / 2),
      pixelRatio: gl.drawingBufferWidth / width,
      projectMercator,
      clipW,
      destination,
    });
    this.lastFrame = { geometry, worldSize, centerLongitude };
    if (geometry.vertexCount === 0) return;

    const resources = this.resources ?? this.acquire(gl);
    const program = this.program(resources, args);
    const globe = args.defaultProjectionData.projectionTransition > 0;

    // Tile-local coordinates keep sub-pixel precision at high zoom. The tile
    // holding the indicator is the same for every world copy, so the vertex
    // data uploads once and each copy only changes the projection uniforms.
    const tileZoom = Math.min(Math.max(Math.floor(zoom), 0), MAX_TILE_ZOOM);
    const tiles = 2 ** tileZoom;
    const [originX, originY] = geometry.origin;
    const tileX = Math.floor((originX / worldSize) * tiles);
    const tileY = Math.min(
      Math.max(Math.floor((originY / worldSize) * tiles), 0),
      tiles - 1,
    );
    const localScale = (tiles * EXTENT) / worldSize;
    const localOriginX = ((originX / worldSize) * tiles - tileX) * EXTENT;
    const localOriginY = ((originY / worldSize) * tiles - tileY) * EXTENT;
    const vertices = this.vertices(
      geometry,
      localScale,
      localOriginX,
      localOriginY,
    );
    const baseWrap = Math.floor(tileX / tiles);
    const canonicalX = ((tileX % tiles) + tiles) % tiles;

    let copies: number[];
    if (globe || !map.getRenderWorldCopies()) {
      copies = [0];
    } else {
      const count = Math.ceil(width / worldSize) + 1;
      copies = [];
      for (let i = -count; i <= count; i++) copies.push(i);
    }

    const previousVao = gl.getParameter(
      gl.VERTEX_ARRAY_BINDING,
    ) as WebGLVertexArrayObject | null;
    try {
      gl.useProgram(program.handle);
      gl.bindVertexArray(resources.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, resources.vertexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, resources.indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geometry.indices, gl.DYNAMIC_DRAW);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.STENCIL_TEST);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      for (const copy of copies) {
        const projection = args.getProjectionData({
          tileID: {
            wrap: baseWrap + copy,
            canonical: { x: canonicalX, y: tileY, z: tileZoom },
          },
          applyGlobeMatrix: true,
        });
        const u = program.uniforms;
        if (u.u_projection_matrix)
          gl.uniformMatrix4fv(
            u.u_projection_matrix,
            false,
            projection.mainMatrix,
          );
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
          gl.uniform4fv(
            u.u_projection_clipping_plane,
            projection.clippingPlane,
          );
        }
        if (u.u_projection_transition) {
          gl.uniform1f(
            u.u_projection_transition,
            projection.projectionTransition,
          );
        }
        gl.drawElements(
          gl.TRIANGLES,
          geometry.indexCount,
          gl.UNSIGNED_SHORT,
          0,
        );
      }
    } finally {
      gl.bindVertexArray(previousVao);
    }
  }

  private projectMercator(
    lat: number,
    lon: number,
    worldSize: number,
    centerLongitude: number,
  ): Point {
    const unwrapped = lon + 360 * Math.round((centerLongitude - lon) / 360);
    return [((unwrapped + 180) / 360) * worldSize, mercatorY(lat) * worldSize];
  }

  private evaluate(zoom: number, time: number): EvaluatedPaint {
    const paint: Partial<Record<PaintName, readonly number[]>> = {};
    for (const [name, value] of this.values)
      paint[name] = value.value(zoom, time);
    return paint as EvaluatedPaint;
  }

  private active(time: number): boolean {
    for (const value of this.values.values())
      if (value.active(time)) return true;
    return false;
  }

  private vertices(
    geometry: FrameGeometry,
    localScale: number,
    localOriginX: number,
    localOriginY: number,
  ): Float32Array {
    const source = geometry.vertices;
    const out = new Float32Array(source.length);
    for (let i = 0; i < source.length; i += FLOATS_PER_VERTEX) {
      out[i] = localOriginX + source[i]! * localScale;
      out[i + 1] = localOriginY + source[i + 1]! * localScale;
      for (let j = 2; j < FLOATS_PER_VERTEX; j++) out[i + j] = source[i + j]!;
    }
    return out;
  }

  private acquire(gl: WebGL2RenderingContext): Resources {
    const vao = gl.createVertexArray();
    const vertexBuffer = gl.createBuffer();
    const indexBuffer = gl.createBuffer();
    const previousVao = gl.getParameter(
      gl.VERTEX_ARRAY_BINDING,
    ) as WebGLVertexArrayObject | null;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    const stride = FLOATS_PER_VERTEX * 4;
    const sizes = [2, 2, 4, 4, 4];
    let offset = 0;
    sizes.forEach((size, location) => {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
      offset += size * 4;
    });
    gl.bindVertexArray(previousVao);
    this.resources = {
      gl,
      vao,
      vertexBuffer,
      indexBuffer,
      programs: new globalThis.Map(),
    };
    return this.resources;
  }

  private release(): void {
    const r = this.resources;
    if (!r) return;
    for (const program of r.programs.values())
      r.gl.deleteProgram(program.handle);
    r.gl.deleteBuffer(r.vertexBuffer);
    r.gl.deleteBuffer(r.indexBuffer);
    r.gl.deleteVertexArray(r.vao);
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
      throw new Error(`location-puck program link failed: ${log}`);
    }
    const program: Program = { handle, uniforms: {} };
    for (const name of PROJECTION_UNIFORMS)
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
  if (!shader) throw new Error("location-puck: cannot create shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "";
    gl.deleteShader(shader);
    throw new Error(`location-puck shader compile failed: ${log}`);
  }
  return shader;
}

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}
