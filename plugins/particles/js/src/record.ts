// The emitter's CPU half, in f64: one layer's frame-table row from its
// evaluated paint, its pool size, and the camera part of the table header.
//
// Twin of ../../native/src/record.zig. The row, the pool size and the weather
// pools must agree between the two: ../../fixtures/record.json holds the
// shared cases, its expected outputs come from the Zig side, and
// record.test.ts checks this file against them.
//
// The header follows the native table's layout (shaders/particle.glsl reads
// both the same way) with one difference. maplibre-gl-js hands custom layers
// no camera matrix that also covers the globe, so the JS layer builds the
// projection columns in the vertex shader from maplibre's
// projectTileWithElevation at an anchor point (the emitter, or the ground
// below the eye for weather). P_rel (h0-h3) therefore stays zero, and the eye
// is measured from that anchor rather than from the frame center.

import type { PaintPropertySpec, Vector } from "@maplibre-plugins/paint";

import type { EmitterPaint } from "./paint.ts";
import { type EmitterPaintName, emitterPaintNames, paintSpec } from "./spec.ts";

export const TILE_SIZE = 512;
/** MapLibre Native's Earth radius (util::EARTH_RADIUS_M), which sets its pixels per meter. */
export const EARTH_RADIUS = 6378137;
/** Web Mercator's latitude limit in degrees. */
export const MAX_LATITUDE = 85.051128779806604;
/** Pool sizes are powers of two up to this many particles. */
export const MAX_POOL = 16384;
/** particle-count's maximum, where the shader clamps it (@clamp particle-count). */
export const MAX_COUNT = paintSpec["particle-count"].maximum;
/** The particle clock wraps at this many seconds; every emission period divides it. */
export const CLOCK_WRAP = 4096;

export const HEADER_VEC4S = 12;
export const ROW_VEC4S = 15;

/**
 * Header vec4s. h0-h3 hold P_rel on native and zeros here; h11 is reserved.
 * clock: (time mod CLOCK_WRAP, CLOCK_WRAP, row count, 1); screen:
 * (pixels_to_gl_units.xy, viewport width, height); view: (camera-to-center
 * distance, pixel ratio, pixels per meter of the projection, pitch); eye:
 * (x, y world px from the origin, z m, box px); pool0/pool1: (phase east,
 * north, up, scale); weights: (pool 0 weight, pool 1 weight, eye altitude px, 0).
 */
export const Header = {
  clock: 4,
  screen: 5,
  view: 6,
  eye: 7,
  pool0: 8,
  pool1: 9,
  weights: 10,
} as const;

/**
 * Row vec4s. color..area are the lanes of ParticleParams in
 * shaders/particle.glsl, in its member order. placement: (E_rel.x, E_rel.y
 * world px, pixels per meter at the emitter, particle-scale).
 */
export const Lane = {
  placement: 0,
  color: 1,
  colorEnd: 2,
  size: 3,
  sizeSpin: 4,
  fadeAdd: 5,
  sparkle: 6,
  timing: 7,
  emission: 8,
  launch: 9,
  cone: 10,
  air: 11,
  area: 12,
  tint: 13,
  extra: 14,
} as const;

/** How an emitter property reaches its row (native properties.Use). */
export type LaneUseKind =
  /** The value's components, raw in spec units, from lane.component on. */
  | "raw"
  /** As raw, clamped to the spec bounds here (no shader clamp). */
  | "clamped"
  /** Packed into the identity (emission.w) as weight times the value. */
  | "identity"
  /** particle-color and particle-color-end, times opacity, end painted over. */
  | "color"
  /** particle-opacity: folded into the color lanes, clamped. */
  | "opacity"
  /** emitter-position: E_rel from the frame center (placement.xy). */
  | "position";

export interface LaneUse {
  readonly use: LaneUseKind;
  readonly lane: number;
  readonly component: number;
  /** identity only: the value's weight in seed + 65536 · (shape + 16 · space + 64 · kind). */
  readonly weight?: number;
}

const IDENTITY_SHAPE = 65536;
const IDENTITY_SPACE = 65536 * 16;
const IDENTITY_KIND = 65536 * 64;

/** Every emitter property, in type order, and where it goes in the row (native properties.emitter_lanes). */
export const emitterLanes = {
  "emitter-kind": {
    use: "identity",
    lane: Lane.emission,
    component: 3,
    weight: IDENTITY_KIND,
  },
  "emitter-position": { use: "position", lane: Lane.placement, component: 0 },
  "emitter-radius": { use: "raw", lane: Lane.area, component: 0 },
  "emitter-height": { use: "raw", lane: Lane.area, component: 1 },
  "particle-space": {
    use: "identity",
    lane: Lane.emission,
    component: 3,
    weight: IDENTITY_SPACE,
  },
  "particle-scale": { use: "raw", lane: Lane.placement, component: 3 },
  "particle-count": { use: "raw", lane: Lane.emission, component: 0 },
  "particle-lifetime": { use: "raw", lane: Lane.timing, component: 0 },
  "particle-explosiveness": { use: "raw", lane: Lane.emission, component: 1 },
  "particle-burst-interval": { use: "raw", lane: Lane.timing, component: 2 },
  "particle-burst-groups": { use: "raw", lane: Lane.emission, component: 2 },
  "particle-seed": {
    use: "identity",
    lane: Lane.emission,
    component: 3,
    weight: 1,
  },
  "particle-speed": { use: "raw", lane: Lane.launch, component: 0 },
  "particle-direction": { use: "raw", lane: Lane.launch, component: 2 },
  "particle-spread": { use: "raw", lane: Lane.cone, component: 0 },
  "particle-gravity": { use: "raw", lane: Lane.cone, component: 2 },
  "particle-drag": { use: "raw", lane: Lane.cone, component: 3 },
  "particle-wind": { use: "raw", lane: Lane.air, component: 0 },
  "particle-wander": { use: "raw", lane: Lane.air, component: 2 },
  "particle-spin": { use: "raw", lane: Lane.sizeSpin, component: 2 },
  "particle-shape": {
    use: "identity",
    lane: Lane.emission,
    component: 3,
    weight: IDENTITY_SHAPE,
  },
  "particle-size": { use: "raw", lane: Lane.size, component: 0 },
  "particle-growth": { use: "raw", lane: Lane.size, component: 2 },
  "particle-size-clamp": { use: "raw", lane: Lane.sizeSpin, component: 0 },
  "particle-stretch": { use: "raw", lane: Lane.size, component: 3 },
  "particle-color": { use: "color", lane: Lane.color, component: 0 },
  "particle-color-end": { use: "color", lane: Lane.colorEnd, component: 0 },
  "particle-color-variation": { use: "raw", lane: Lane.sparkle, component: 2 },
  "particle-opacity": { use: "opacity", lane: Lane.color, component: 0 },
  "particle-fade": { use: "raw", lane: Lane.fadeAdd, component: 0 },
  "particle-additive": { use: "raw", lane: Lane.fadeAdd, component: 2 },
  "particle-twinkle": { use: "raw", lane: Lane.sparkle, component: 0 },
  "emitter-center-thinning": { use: "raw", lane: Lane.area, component: 3 },
  "emitter-screen-tint": { use: "raw", lane: Lane.tint, component: 0 },
  "emitter-vignette": { use: "clamped", lane: Lane.extra, component: 0 },
} as const satisfies Record<EmitterPaintName, LaneUse>;

const WEATHER = paintSpec["emitter-kind"].values.indexOf("weather");
const WORLD = paintSpec["particle-space"].values.indexOf("world");

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}

/** A property's bounds, infinite where it has none. */
function bounds(spec: PaintPropertySpec): [number, number] {
  return spec.type === "enum"
    ? [-Infinity, Infinity]
    : [spec.minimum ?? -Infinity, spec.maximum ?? Infinity];
}

function fract(x: number): number {
  return x - Math.floor(x);
}

export function worldSize(zoom: number): number {
  return TILE_SIZE * 2 ** zoom;
}

/** Web Mercator world pixels (x east, y south) at this world size, from degrees. */
export function mercator(
  latitude: number,
  longitude: number,
  size: number,
): [number, number] {
  const phi = (clamp(latitude, -MAX_LATITUDE, MAX_LATITUDE) * Math.PI) / 180;
  return [
    ((longitude + 180) / 360) * size,
    (0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI)) * size,
  ];
}

/** World pixels per meter on the ground at this latitude, as MapLibre Native scales heights. */
export function pixelsPerMeter(latitude: number, size: number): number {
  const phi = (clamp(latitude, -MAX_LATITUDE, MAX_LATITUDE) * Math.PI) / 180;
  return size / (2 * Math.PI * EARTH_RADIUS * Math.cos(phi));
}

/** The frame fields the row depends on. */
export interface RecordFrame {
  readonly zoom: number;
  /** [latitude, longitude] in degrees; the longitude may be unwrapped. */
  readonly center: readonly [number, number];
}

/**
 * An emitter-position's world pixels from the frame center, at its copy
 * nearest the center (one copy is drawn), or null for a position that
 * places nothing: a non-finite value or a latitude past ±90.
 */
export function emitterOffset(
  position: Vector,
  frame: RecordFrame,
): [number, number] | null {
  const [latitude = Number.NaN, longitude = Number.NaN] = position;
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90
  )
    return null;
  const size = worldSize(frame.zoom);
  const center = mercator(frame.center[0], frame.center[1], size);
  const e = mercator(latitude, longitude, size);
  e[0] += size * Math.floor((center[0] - e[0]) / size + 0.5);
  return [e[0] - center[0], e[1] - center[1]];
}

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * The ranks the count prefix can show for any target up to `count`
 * (particlePrefix in shaders/particle.glsl, prefix in model.ts): its ramp,
 * max(1, count / 8) ranks wide and centered on the target, reaches rank
 * target - 0.5 + max(0.5, count / 16), so a pool with fewer ranks cuts off
 * particles that should show. Twin of prefixRanks in record.zig.
 */
export function prefixRanks(count: number): number {
  return Math.ceil(count - 0.5 + Math.max(0.5, count / 16));
}

/**
 * The particles a layer's vertex buffer carries: the ranks of the count
 * prefix's whole ramp (prefixRanks), rounded up to a power of two of at
 * least 64 for point and circle emitters. Weather draws two octaves from
 * one pool, alternate particles each, so it keeps twice a power of two of at
 * least 32 ranks. Both stop at MAX_POOL particles, which holds the whole ramp
 * up to a count of 15420, or 7710 for weather; past that the pool cuts the
 * top of the ramp, and a weather octave shows at most 8192 particles.
 */
export function poolSize(count: number, weather: boolean): number {
  const ranks = prefixRanks(count > 0 ? Math.min(count, MAX_COUNT) : 0);
  if (weather)
    return Math.min(2 * nextPowerOfTwo(Math.max(ranks, 32)), MAX_POOL);
  return Math.min(nextPowerOfTwo(Math.max(ranks, 64)), MAX_POOL);
}

export interface PackedEmitter {
  /** The row: ROW_VEC4S vec4s (Lane), f32. */
  readonly row: Float32Array;
  /** Pool size in particles. */
  readonly pool: number;
  /**
   * Whether the layer draws anything. False with no particles (count or
   * opacity 0) and no screen tint, or for a point or circle emitter at an
   * unusable position.
   */
  readonly visible: boolean;
}

/**
 * Packs one emitter layer's row (Lane) from its evaluated paint. Every lane
 * holds the raw value in spec units, with three exceptions:
 *   - color and colorEnd: the premultiplied colors times the clamped
 *     particle-opacity, with particle-color-end painted over particle-color
 *     (end + color · (1 - end.a));
 *   - emission.w: the identity, seed + 65536 · (shape + 16 · space + 64 ·
 *     kind), exact in f32; the seed is floored into [0, 65535];
 *   - placement: the emitter's world pixels from the frame center at its
 *     nearest copy (0 for weather), and its pixels per meter in world space
 *     (else 1).
 * emitter-vignette is clamped to its bounds, as particle-opacity is; the
 * shader clamps everything else. Every value but emitter-position is first
 * rounded to f32, the precision the host hands build_frame, so a seed just
 * below an integer floors as on native. Arithmetic is then f64 with one
 * rounding to f32.
 */
export function pack(paint: EmitterPaint, frame: RecordFrame): PackedEmitter {
  const row = new Float64Array(ROW_VEC4S * 4);
  let identity = 0;
  let kind = 0;
  let space = 0;
  let color: Vector = [0, 0, 0, 0];
  let colorEnd: Vector = [0, 0, 0, 0];
  let opacity = 1;
  let position: Vector = [0, 0];
  for (const name of emitterPaintNames) {
    const entry: LaneUse = emitterLanes[name];
    const spec: PaintPropertySpec = paintSpec[name];
    // The host delivers floats, pairs and colors as f32, positions as f64.
    const value =
      spec.type === "double2" ? paint[name] : paint[name].map(Math.fround);
    const at = 4 * entry.lane + entry.component;
    switch (entry.use) {
      case "raw":
        row.set(value, at);
        break;
      case "clamped":
        row[at] = clamp(value[0] ?? 0, ...bounds(spec));
        break;
      case "identity": {
        const part =
          spec.type === "enum"
            ? (value[0] ?? 0)
            : Math.floor(clamp(value[0] ?? 0, ...bounds(spec)));
        identity += (entry.weight ?? 1) * part;
        if (name === "emitter-kind") kind = part;
        if (name === "particle-space") space = part;
        break;
      }
      case "color":
        if (entry.lane === Lane.color) color = value;
        else colorEnd = value;
        break;
      case "opacity":
        opacity = clamp(value[0] ?? 0, 0, 1);
        break;
      case "position":
        position = value;
        break;
    }
  }
  row[4 * Lane.emission + 3] = identity;
  const endAlpha = colorEnd[3] ?? 0;
  for (let k = 0; k < 4; k++) {
    const c = color[k] ?? 0;
    row[4 * Lane.color + k] = c * opacity;
    row[4 * Lane.colorEnd + k] =
      ((colorEnd[k] ?? 0) + c * (1 - endAlpha)) * opacity;
  }

  const weather = kind === WEATHER;
  const placement = 4 * Lane.placement;
  row[placement] = 0;
  row[placement + 1] = 0;
  row[placement + 2] = 1;
  let positioned = true;
  if (!weather) {
    const offset = emitterOffset(position, frame);
    positioned = offset !== null;
    if (offset) {
      row.set(offset, placement);
      if (space === WORLD)
        row[placement + 2] = pixelsPerMeter(
          position[0] ?? 0,
          worldSize(frame.zoom),
        );
    }
  }

  const out = Float32Array.from(row);
  const count = out[4 * Lane.emission] ?? 0;
  const particles = count > 0 && opacity > 0;
  const tinted = (out[4 * Lane.tint + 3] ?? 0) > 0;
  return {
    row: out,
    pool: poolSize(count, weather),
    visible: positioned && (particles || tinted),
  };
}

export interface WeatherPools {
  /** (phase east, phase north, phase up in [0, 1), scale s_p) */
  readonly pool0: readonly [number, number, number, number];
  readonly pool1: readonly [number, number, number, number];
  /** (pool 0 weight, pool 1 weight, eye altitude px, 0) */
  readonly weights: readonly [number, number, number, number];
}

/**
 * The two weather octave pools. Pool p is anchored at the absolute zoom of
 * parity p nearest below or above (Z_p), scales its box by s_p = 2^(zoom -
 * Z_p) and fades with the zoom's distance from Z_p, so crossing an integer
 * zoom re-anchors only the pool whose weight is 0. Each pool's phase is the
 * eye's position in its lattice of boxes, box pixels wide at Z_p, which keeps
 * the particles fixed to the world. eyeX and eyeY are absolute world pixels
 * at `zoom`; eyeAltitude is in pixels. Operation for operation the same as
 * weatherPools in record.zig and model.ts.
 */
export function weatherPools(
  zoom: number,
  eyeX: number,
  eyeY: number,
  eyeAltitude: number,
  box: number,
): WeatherPools {
  const n = Math.floor(zoom);
  const f = zoom - n;
  const pool = (p: number) => {
    const anchor = (n & 1) === p ? n : n + 1;
    const scale = 2 ** (zoom - anchor);
    return {
      phases: [
        fract(eyeX / scale / box),
        fract(-eyeY / scale / box),
        fract(eyeAltitude / (scale * box)),
        scale,
      ] as const,
      weight: anchor === n ? 1 - f : f,
    };
  };
  const [p0, p1] = [pool(0), pool(1)];
  return {
    pool0: p0.phases,
    pool1: p1.phases,
    weights: [p0.weight, p1.weight, eyeAltitude, 0],
  };
}

/** Wraps seconds into the particle clock's [0, CLOCK_WRAP), as the native plugin clock does. */
export function wrapClock(seconds: number): number {
  if (!Number.isFinite(seconds)) return 0;
  const t = seconds % CLOCK_WRAP;
  return t < 0 ? t + CLOCK_WRAP : t;
}

/** The camera and clock state of one frame, for the header. */
export interface HeaderCamera {
  /** Particle clock in seconds, in [0, CLOCK_WRAP). */
  readonly time: number;
  readonly zoom: number;
  /** Viewport in logical pixels. */
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  readonly cameraToCenterDistance: number;
  /** World pixels per meter of the projection's up axis. */
  readonly pixelsPerMeter: number;
  /** Radians. */
  readonly pitch: number;
  /** The absolute world pixel (at `zoom`) the frame's columns are built at. */
  readonly origin: readonly [number, number];
  /** The eye: world pixels east and south of `origin`, and meters above sea level. */
  readonly eye: readonly [number, number, number];
}

/**
 * The header of one frame (Header), with one row. The weather box is the
 * camera distance, and the pool phases come from the eye as the shader
 * projects it (its f32 value), so the lattice stays fixed to the world to the
 * last bit, as in record.zig.
 */
export function header(camera: HeaderCamera): Float32Array {
  const h = new Float32Array(HEADER_VEC4S * 4);
  const box = camera.cameraToCenterDistance;
  h.set([camera.time, CLOCK_WRAP, 1, 1], 4 * Header.clock);
  h.set(
    [2 / camera.width, -2 / camera.height, camera.width, camera.height],
    4 * Header.screen,
  );
  h.set(
    [box, camera.pixelRatio, camera.pixelsPerMeter, camera.pitch],
    4 * Header.view,
  );
  h.set([...camera.eye, box], 4 * Header.eye);
  const eyeX = h[4 * Header.eye] ?? 0;
  const eyeY = h[4 * Header.eye + 1] ?? 0;
  const altitude = (h[4 * Header.eye + 2] ?? 0) * (h[4 * Header.view + 2] ?? 0);
  const pools = weatherPools(
    camera.zoom,
    camera.origin[0] + eyeX,
    camera.origin[1] + eyeY,
    altitude,
    box,
  );
  h.set(pools.pool0, 4 * Header.pool0);
  h.set(pools.pool1, 4 * Header.pool1);
  h.set(pools.weights, 4 * Header.weights);
  return h;
}
