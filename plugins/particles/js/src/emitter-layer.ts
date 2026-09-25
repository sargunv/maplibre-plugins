import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MaplibreMap,
} from "maplibre-gl";

import {
  createEmitterPaintState,
  DEFAULT_TRANSITION,
  type EmitterPaintInput,
  type EmitterPaintState,
  type TransitionOptions,
} from "./paint.ts";
import {
  emitterOffset,
  header,
  Lane,
  mercator,
  pack,
  worldSize,
  wrapClock,
} from "./record.ts";
import {
  fragmentSource,
  linkProgram,
  PROJECTION_UNIFORMS,
  type ProjectionUniform,
  setProjectionUniforms,
} from "./shader-common.ts";
import { EMITTER_UNIFORMS, emitterVertexSource } from "./shaders-emitter.ts";
import {
  EMITTER_TYPE,
  type EmitterPaintName,
  EXTENT,
  paintSpec,
} from "./spec.ts";

const MAX_TILE_ZOOM = 22;
/** Quads per draw: 16-bit indices reach 65532 vertices, as in the native segments. */
const SEGMENT_QUADS = 16383;
const WEATHER = paintSpec["emitter-kind"].values.indexOf("weather");

export interface ParticleEmitterLayerOptions {
  id: string;
  paint?: EmitterPaintInput;
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

/** A style-JSON layer object using the `particle-emitter` type, as the native plugin accepts. */
export interface ParticleEmitterLayerJson {
  id: string;
  type: typeof EMITTER_TYPE;
  metadata?: unknown;
  paint?: EmitterPaintInput;
  layout?: { visibility?: "visible" | "none" };
  minzoom?: number;
  maxzoom?: number;
}

type UniformName = ProjectionUniform | (typeof EMITTER_UNIFORMS)[number];

interface Program {
  handle: WebGLProgram;
  uniforms: Partial<Record<UniformName, WebGLUniformLocation | null>>;
}

interface Resources {
  gl: WebGL2RenderingContext;
  vao: WebGLVertexArrayObject;
  vertexBuffer: WebGLBuffer;
  indexBuffer: WebGLBuffer;
  /** Particles the vertex buffer holds; 0 until the first draw. */
  pool: number;
  /** Quads the index buffer's pattern covers. */
  indexQuads: number;
  programs: globalThis.Map<string, Program>;
}

/**
 * A maplibre-gl-js custom layer drawing the same particles as the native
 * `particle-emitter` plugin layer: one emitter at a point, on a disc, or as
 * weather around the camera, from the shared shader core. Add it with
 * `map.addLayer(layer, beforeId)` and drive it through `setPaintProperty`.
 *
 * Like the native layer it keeps static vertex bytes (each particle's index)
 * and sends the paint and the camera as uniforms every frame, so camera moves
 * and paint transitions never rebuild anything. One copy is drawn, the one
 * nearest the map center.
 */
export class ParticleEmitterLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom";
  readonly renderingMode = "2d";

  private readonly paint: EmitterPaintState;
  private readonly clock: () => number;
  private readonly metadata: unknown;
  private minzoom: number;
  private maxzoom: number;
  private visibility: "visible" | "none";

  private map: MaplibreMap | null = null;
  private resources: Resources | null = null;
  private contextLost = false;
  private readonly listeners: Array<() => void> = [];

  /** Throws on invalid paint values. */
  constructor(options: ParticleEmitterLayerOptions) {
    this.id = options.id;
    this.minzoom = options.minzoom ?? 0;
    this.maxzoom = options.maxzoom ?? 24;
    this.visibility = options.visibility ?? "visible";
    this.metadata = options.metadata;
    this.clock = options.clock ?? (() => now() / 1000);
    this.paint = createEmitterPaintState(
      { ...DEFAULT_TRANSITION, ...options.transition },
      options.paint ?? {},
    );
  }

  /** Builds a layer from style-layer JSON of type `particle-emitter`, the form the native plugin consumes. */
  static fromLayerJson(
    json: ParticleEmitterLayerJson,
    options: Pick<ParticleEmitterLayerOptions, "transition" | "clock"> = {},
  ): ParticleEmitterLayer {
    const actual: string = (json as { type: string }).type;
    if (actual !== EMITTER_TYPE) {
      throw new Error(`Expected layer type ${EMITTER_TYPE}, got ${actual}`);
    }
    const layer: ParticleEmitterLayerOptions = { id: json.id, ...options };
    if (json.metadata !== undefined) layer.metadata = json.metadata;
    if (json.paint) layer.paint = json.paint;
    if (json.minzoom !== undefined) layer.minzoom = json.minzoom;
    if (json.maxzoom !== undefined) layer.maxzoom = json.maxzoom;
    if (json.layout?.visibility) layer.visibility = json.layout.visibility;
    return new ParticleEmitterLayer(layer);
  }

  /** The layer as style-layer JSON, with the current raw paint values. */
  toLayerJson(): ParticleEmitterLayerJson {
    const json: ParticleEmitterLayerJson = { id: this.id, type: EMITTER_TYPE };
    if (this.metadata !== undefined) json.metadata = this.metadata;
    json.paint = this.paint.toJson() as EmitterPaintInput;
    if (this.minzoom !== 0) json.minzoom = this.minzoom;
    if (this.maxzoom !== 24) json.maxzoom = this.maxzoom;
    if (this.visibility !== "visible")
      json.layout = { visibility: this.visibility };
    return json;
  }

  getPaintProperty(name: EmitterPaintName): unknown {
    return this.paint.get(name);
  }

  /**
   * Sets a paint property or its `<name>-transition`, animating to the new
   * value like a native style transition. Invalid values, and a transition
   * for a property that takes none, throw and leave the old value in place.
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
  setPaint(paint: EmitterPaintInput, transition?: TransitionOptions): void {
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

    const paint = this.paint.evaluate(zoom, now());
    const center = transform.center;
    const frame = { zoom, center: [center.lat, center.lng] } as const;
    const packed = pack(paint, frame);
    const { width, height } = transform;
    if (!packed.visible || width <= 0 || height <= 0) return;

    // The frame's projection columns are read off maplibre's projection at
    // an anchor: the emitter itself, or the ground below the eye for
    // weather, whose particles surround the eye.
    const size = worldSize(zoom);
    const centerWorld = mercator(center.lat, center.lng, size);
    const camera = transform.getCameraLngLat();
    const eye = mercator(camera.lat, camera.lng, size);
    eye[0] += size * Math.floor((centerWorld[0] - eye[0]) / size + 0.5);
    let anchor = eye;
    if (paint["emitter-kind"][0] !== WEATHER) {
      const offset = emitterOffset(paint["emitter-position"], frame);
      if (!offset) return;
      anchor = [centerWorld[0] + offset[0], centerWorld[1] + offset[1]];
      packed.row[4 * Lane.placement] = 0;
      packed.row[4 * Lane.placement + 1] = 0;
    }
    const headerData = header({
      time: wrapClock(this.clock()),
      zoom,
      width,
      height,
      pixelRatio: gl.drawingBufferWidth / width,
      cameraToCenterDistance: transform.cameraToCenterDistance,
      pixelsPerMeter: transform.pixelsPerMeter,
      pitch: transform.pitchInRadians,
      origin: anchor,
      eye: [
        eye[0] - anchor[0],
        eye[1] - anchor[1],
        transform.getCameraAltitude(),
      ],
    });

    // The anchor's tile at the integer zoom: its projection uniforms, and
    // the anchor in its tile units.
    const tileZoom = Math.min(Math.max(Math.floor(zoom), 0), MAX_TILE_ZOOM);
    const tiles = 2 ** tileZoom;
    const tileX = (anchor[0] / size) * tiles;
    const tileY = (anchor[1] / size) * tiles;
    const x = Math.floor(tileX);
    const y = Math.min(Math.max(Math.floor(tileY), 0), tiles - 1);
    const wrap = Math.floor(x / tiles);
    const projection = args.getProjectionData({
      tileID: { wrap, canonical: { x: x - wrap * tiles, y, z: tileZoom } },
      applyGlobeMatrix: true,
    });

    const resources = this.resources ?? this.acquire(gl);
    const program = this.program(resources, args);
    const previousVao = gl.getParameter(
      gl.VERTEX_ARRAY_BINDING,
    ) as WebGLVertexArrayObject | null;
    try {
      gl.bindVertexArray(resources.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, resources.vertexBuffer);
      if (resources.pool !== packed.pool) this.upload(resources, packed.pool);
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
      const u = program.uniforms;
      setProjectionUniforms(gl, u, projection);
      if (u.u_header) gl.uniform4fv(u.u_header, headerData);
      if (u.u_row) gl.uniform4fv(u.u_row, packed.row);
      if (u.u_anchor) {
        gl.uniform4f(
          u.u_anchor,
          (tileX - x) * EXTENT,
          (tileY - y) * EXTENT,
          (EXTENT * tiles) / size,
          0,
        );
      }
      // The tint quad and the particles, in segments that share the index
      // pattern; WebGL has no base vertex, so each re-bases the attribute.
      const quads = packed.pool + 1;
      for (let first = 0; first < quads; first += SEGMENT_QUADS) {
        const count = Math.min(SEGMENT_QUADS, quads - first);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, first * 4 * 8);
        gl.drawElements(gl.TRIANGLES, 6 * count, gl.UNSIGNED_SHORT, 0);
      }
    } finally {
      gl.bindVertexArray(previousVao);
    }
  }

  /**
   * Fills the vertex buffer for a pool: (vertex index, row 0) per vertex,
   * the tint quad first. Expects the layer's VAO and vertex buffer bound.
   */
  private upload(resources: Resources, pool: number): void {
    const { gl } = resources;
    const quads = pool + 1;
    const vertices = new Float32Array(8 * quads);
    for (let v = 0; v < 4 * quads; v++) vertices[2 * v] = v;
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    const needed = Math.min(quads, SEGMENT_QUADS);
    if (resources.indexQuads < needed) {
      const indices = new Uint16Array(6 * needed);
      for (let k = 0; k < needed; k++) {
        indices.set(
          [4 * k, 4 * k + 1, 4 * k + 2, 4 * k, 4 * k + 2, 4 * k + 3],
          6 * k,
        );
      }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, resources.indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
      resources.indexQuads = needed;
    }
    resources.pool = pool;
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
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.bindVertexArray(previousVao);
    this.resources = {
      gl,
      vao,
      vertexBuffer,
      indexBuffer,
      pool: 0,
      indexQuads: 0,
      programs: new globalThis.Map(),
    };
    return this.resources;
  }

  private release(): void {
    const r = this.resources;
    this.resources = null;
    // maplibre-gl removes custom layers when the context is lost (the app
    // adds them again after the restore); a lost context has nothing to free.
    if (!r || r.gl.isContextLost()) return;
    for (const program of r.programs.values())
      r.gl.deleteProgram(program.handle);
    r.gl.deleteBuffer(r.vertexBuffer);
    r.gl.deleteBuffer(r.indexBuffer);
    r.gl.deleteVertexArray(r.vao);
  }

  private program(
    resources: Resources,
    args: CustomRenderMethodInput,
  ): Program {
    const { gl } = resources;
    const { variantName, vertexShaderPrelude, define } = args.shaderData;
    const cached = resources.programs.get(variantName);
    if (cached) return cached;
    const handle = linkProgram(
      gl,
      emitterVertexSource(vertexShaderPrelude, define),
      fragmentSource,
      EMITTER_TYPE,
    );
    const program: Program = { handle, uniforms: {} };
    for (const name of [...PROJECTION_UNIFORMS, ...EMITTER_UNIFORMS])
      program.uniforms[name] = gl.getUniformLocation(handle, name);
    resources.programs.set(variantName, program);
    return program;
  }
}

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}
