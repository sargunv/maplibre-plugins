// The particle model in TypeScript: a line-by-line port of the vertex-stage
// core in ../../shaders/particle.glsl (timing, spawn, launch, motion, weather,
// feature keep, look and projection), in f64. It is the reference the shader
// is checked against: fixtures/model.json holds its outputs, and model.test.ts
// compiles the GLSL for the CPU and evaluates it on the same inputs. The
// layers never run it; they draw with the shader. Change both files together.
//
// Units follow the shader: positions are east, north, up in the effect's
// space units, clip positions come from the frame axes, and time is the
// plugin clock modulo PARTICLE_W seconds.

import { pcg3d, u01, weyl } from "./hash.ts";

export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];
export type Vec4 = readonly [number, number, number, number];

/** Clock wrap in seconds; every emission period divides it. */
export const PARTICLE_W = 4096;
/** Below this drag * age the drag integrals use their series. */
export const DRAG_SERIES_LIMIT = 0.05;
/** PARTICLE_SPRITE_FLOOR: the smallest diameter a sprite is drawn at, physical px. */
export const SPRITE_FLOOR = 4;
/** PARTICLE_STRETCHED_FLOOR: the smallest width a capsule is drawn at, physical px. */
export const STRETCHED_FLOOR = 2;
const TAU = 2 * Math.PI;
const DEGREES = TAU / 360;
const EPSILON = 0.000001;

/** Lanes 1-12 of an emitter row, raw spec units. */
export interface ParticleParams {
  /** Premultiplied particle-color with particle-opacity folded in. */
  readonly color: Vec4;
  /** Premultiplied end color, already painted over color. */
  readonly colorEnd: Vec4;
  /** size.min, size.max, growth, stretch */
  readonly size: Vec4;
  /** size-clamp.min, size-clamp.max, spin.min, spin.max */
  readonly sizeSpin: Vec4;
  /** fade.in, fade.out, additive.start, additive.end */
  readonly fadeAdd: Vec4;
  /** twinkle.amount, twinkle.hz, color-variation.particle, color-variation.burst */
  readonly sparkle: Vec4;
  /** lifetime.min, lifetime.max, burst-interval.seconds, burst-interval.jitter */
  readonly timing: Vec4;
  /** count, explosiveness, burst-groups, identity */
  readonly emission: Vec4;
  /** speed.min, speed.max, direction.azimuth, direction.elevation */
  readonly launch: Vec4;
  /** spread.angle, spread.flatness, gravity, drag */
  readonly cone: Vec4;
  /** wind.east, wind.north, wander.amplitude, wander.hz */
  readonly air: Vec4;
  /** emitter-radius, emitter-height.min, emitter-height.max, emitter-center-thinning */
  readonly area: Vec4;
}

/** Clip-space frame: head = C + east * X + north * Y + up * Z. */
export interface ParticleFrame {
  readonly C: Vec4;
  readonly X: Vec4;
  readonly Y: Vec4;
  readonly Z: Vec4;
  /** pixels_to_gl_units.xy, viewport width, height */
  readonly screen: Vec4;
  /** camera-to-center distance, pixel ratio, size unit, perspective (0 or 1) */
  readonly view: Vec4;
}

/** The camera's weather volume; zeros unless the emitter is weather. */
export interface ParticleWeather {
  /** eye x, y (world px from the frame center), eye z (m), box size (px) */
  readonly eye: Vec4;
  /** phase east, north, up in [0, 1), scale */
  readonly pool0: Vec4;
  readonly pool1: Vec4;
  /** pool 0 weight, pool 1 weight, eye altitude (px), 0 */
  readonly weights: Vec4;
}

export interface ParticleSeed {
  readonly key: number;
  readonly group: number;
  /** Emitter pool index, or feature slot rank. */
  readonly index: number;
  /** 0..3 */
  readonly corner: number;
  /** 0 point, 1 circle, 2 weather, 3 feature point, 4 feature line, 5 feature polygon */
  readonly kind: number;
  /** Wrapper cull weight (features keep); 1 on the emitter. */
  readonly keep: number;
  /** line: (halfLen px, tangent azimuth rad, 0, 0); polygon: (halfCell px, 0, 0, 0) */
  readonly extent: Vec4;
}

export interface ParticleVertex {
  readonly position: Vec4;
  readonly uv: Vec4;
  readonly color: Vec4;
  readonly look: Vec4;
}

export const ZERO4: Vec4 = [0, 0, 0, 0];

/** The shape indices of particle-shape. */
export const Shape = {
  circle: 0,
  glow: 1,
  star: 2,
  spark: 3,
  streak: 4,
  flake: 5,
  ring: 6,
  ripple: 7,
  smoke: 8,
  square: 9,
} as const;

// GLSL built-ins, with GLSL's definitions.
const clamp = (x: number, lo: number, hi: number): number =>
  Math.min(Math.max(x, lo), hi);
const mix = (x: number, y: number, a: number): number => x * (1 - a) + y * a;
const fract = (x: number): number => x - Math.floor(x);
const add3 = (a: Vec3, b: Vec3): Vec3 => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
];
const sub3 = (a: Vec3, b: Vec3): Vec3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
const scale3 = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot3 = (a: Vec3, b: Vec3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length3 = (a: Vec3): number => Math.sqrt(dot3(a, a));
const normalize3 = (a: Vec3): Vec3 => scale3(a, 1 / length3(a));
const mix3 = (a: Vec3, b: Vec3, t: number): Vec3 => [
  mix(a[0], b[0], t),
  mix(a[1], b[1], t),
  mix(a[2], b[2], t),
];
const mix4 = (a: Vec4, b: Vec4, t: number): Vec4 => [
  mix(a[0], b[0], t),
  mix(a[1], b[1], t),
  mix(a[2], b[2], t),
  mix(a[3], b[3], t),
];
const clamp4 = (a: Vec4, lo: Vec4, hi: Vec4): Vec4 => [
  clamp(a[0], lo[0], hi[0]),
  clamp(a[1], lo[1], hi[1]),
  clamp(a[2], lo[2], hi[2]),
  clamp(a[3], lo[3], hi[3]),
];
/** A clip position from the frame: C + x * X + y * Y + z * Z. */
function project(F: ParticleFrame, p: Vec3): Vec4 {
  return [0, 1, 2, 3].map(
    (c) => F.C[c]! + p[0] * F.X[c]! + p[1] * F.Y[c]! + p[2] * F.Z[c]!,
  ) as unknown as Vec4;
}

/** S(x) = x^2 (3 - 2x) on clamp(x, 0, 1). */
export function smooth(x: number): number {
  const c = clamp(x, 0, 1);
  return c * c * (3 - 2 * c);
}

/** particleClampParams: every lane clamped to the shader's @clamp literals. */
export function clampParams(p: ParticleParams): ParticleParams {
  const [count, explosiveness, groups, packed] = p.emission;
  const upper = Math.floor(packed / 65536);
  return {
    ...p,
    size: clamp4(p.size, [0, 0, 0, 0], [10000, 10000, 16, 2]),
    sizeSpin: clamp4(
      p.sizeSpin,
      [0, 0, -3600, -3600],
      [4096, 4096, 3600, 3600],
    ),
    fadeAdd: clamp4(p.fadeAdd, [0, 0, 0, 0], [1, 1, 1, 1]),
    sparkle: clamp4(p.sparkle, [0, 0, 0, 0], [1, 60, 180, 180]),
    timing: clamp4(p.timing, [0.05, 0.05, 0, 0], [600, 600, 600, 1]),
    emission: [
      clamp(count, 0, 16384),
      clamp(explosiveness, 0, 1),
      clamp(groups, 1, 16),
      65536 * upper + clamp(Math.floor(packed - 65536 * upper), 0, 65535),
    ],
    launch: [
      clamp(p.launch[0], 0, 100000),
      clamp(p.launch[1], 0, 100000),
      p.launch[2],
      clamp(p.launch[3], -90, 90),
    ],
    cone: [
      clamp(p.cone[0], 0, 180),
      clamp(p.cone[1], 0, 1),
      p.cone[2],
      clamp(p.cone[3], 0, 50),
    ],
    air: [
      p.air[0],
      p.air[1],
      clamp(p.air[2], 0, 100000),
      clamp(p.air[3], 0, 30),
    ],
    area: [
      Math.max(p.area[0], 0),
      clamp(p.area[1], -10000, 10000),
      clamp(p.area[2], -10000, 10000),
      clamp(p.area[3], 0, 1),
    ],
  };
}

/** The packed identity lane: seed + 65536 * (shape + 16 * space + 64 * kind). */
export function packIdentity(
  seed: number,
  shape: number,
  space: number,
  kind: number,
): number {
  return seed + 65536 * (shape + 16 * space + 64 * kind);
}

/** particleIdentity: (seed, shape, space, kind), each clamped to its range. */
export function identity(packed: number): Vec4 {
  const upper = Math.floor(packed / 65536);
  const seed = packed - 65536 * upper;
  const kind = Math.floor(upper / 64);
  const rest = upper - 64 * kind;
  const space = Math.floor(rest / 16);
  const shape = rest - 16 * space;
  return [
    clamp(Math.floor(seed), 0, 65535),
    clamp(shape, 0, 9),
    clamp(space, 0, 2),
    clamp(kind, 0, 3),
  ];
}

/**
 * particlePrefix: how much of the particle at `rank` shows when `target` of
 * `count` should; a ramp count / 8 ranks wide centered on target, whose shares
 * add up to target past half a ramp. At count <= 8 it is
 * clamp(target - rank, 0, 1) * clamp(2 target, 0, 1).
 */
export function prefix(target: number, rank: number, count: number): number {
  const ramp = Math.max(1, 0.125 * count);
  return (
    clamp((target - rank - 0.5) / ramp + 0.5, 0, 1) *
    clamp((2 * target) / ramp, 0, 1)
  );
}

/** particleFeatureKeep: the share of a feature slot kept at this density and zoom. */
export function featureKeep(
  density: number,
  kind: number,
  rank: number,
  key: number,
  ptu: number,
): number {
  const d = clamp(density, 0, 100);
  const k = kind > 2.5 ? kind - 3 : kind;
  if (k < 0.5) return clamp(d - rank, 0, 1);
  const s = 16 / Math.max(ptu, EPSILON);
  const share = k < 1.5 ? d * s * (1 / 50) : d * s * s * (1 / 156.25);
  const threshold = u01(pcg3d(key, 0x4b, 0)[0]);
  return clamp((share - threshold) * 50, 0, 1);
}

/** particleEmitterSeed: the identity of emitter particle `index` (kinds 0-2). */
export function emitterSeed(
  params: ParticleParams,
  index: number,
  corner: number,
): ParticleSeed {
  const P = clampParams(params);
  const [seed, , , kind] = identity(P.emission[3]);
  const i = index >>> 0;
  const key = pcg3d(i, seed, 0x5eed)[0];
  const groups = Math.floor(P.emission[2]);
  return {
    key,
    group: kind > 1.5 ? key : pcg3d(i % groups, seed, 0x6a09)[0],
    index,
    corner,
    kind: Math.min(kind, 2),
    keep: 1,
    extent: ZERO4,
  };
}

/**
 * particleFeatureSeed: the identity of a particle-features vertex from its
 * a_emit attribute, the evaluated particle-density and the tile's
 * pixels-to-tile-units.
 */
export function featureSeed(
  emit: Vec4,
  density: number,
  ptu: number,
): ParticleSeed {
  const code = Math.max(emit[3], 0) >>> 0;
  const kind = code & 3;
  const slot = code >>> 4;
  const x = Math.max(emit[0] * 4, 0) >>> 0;
  const y = Math.max(emit[1] * 4, 0) >>> 0;
  const pixels = 1 / Math.max(ptu, EPSILON);
  const key = pcg3d(x, y, (slot * 4 + kind) >>> 0)[0];
  let extent: Vec4 = ZERO4;
  if (kind === 1) {
    const direction = Math.floor(emit[2] / 8192);
    extent = [
      (emit[2] - 8192 * direction) * pixels,
      direction * (TAU / 1024),
      0,
      0,
    ];
  } else if (kind === 2) {
    extent = [64 * pixels, 0, 0, 0];
  }
  return {
    key,
    group: kind === 0 ? pcg3d(x, y, 0xb0b)[0] : key,
    index: slot,
    corner: (code >>> 2) & 3,
    kind: 3 + kind,
    keep: kind === 3 ? 0 : featureKeep(density, 3 + kind, slot, key, ptu),
    extent,
  };
}

/** particleRandom: three uniforms from stream n of (key, cycle). */
function random(key: number, cycle: number, n: number): Vec3 {
  const h = pcg3d(key, cycle, n);
  return [u01(h[0]), u01(h[1]), u01(h[2])];
}

/** particleDirection: a uniformly random unit vector from two uniforms. */
function direction(u: number, v: number): Vec3 {
  const z = 2 * u - 1;
  const r = 2 * Math.sqrt(Math.max(0, u * (1 - u)));
  return [r * Math.cos(TAU * v), r * Math.sin(TAU * v), z];
}

/** particleDrag: (F1, F2), so velocity integrates to v0 * F1 and gravity to -g * F2. */
export function dragFactors(k: number, tau: number): Vec2 {
  const x = k * tau;
  if (x < DRAG_SERIES_LIMIT) {
    return [
      tau * (1 + x * (-0.5 + x * (1 / 6 + x * (-1 / 24 + x * (1 / 120))))),
      tau *
        tau *
        (0.5 + x * (-1 / 6 + x * (1 / 24 + x * (-1 / 120 + x * (1 / 720))))),
    ];
  }
  const f1 = (1 - Math.exp(-x)) / k;
  return [f1, (tau - f1) / k];
}

/** The per-life motion constants of one particle. */
interface Launch {
  origin: Vec3;
  v0: Vec3;
  e0: Vec3;
  e1: Vec3;
  e2: Vec3;
  rho: Vec3;
}

/** particleMotion: the position at age tau (ENU, space units). */
function motion(P: ParticleParams, m: Launch, tau: number): Vec3 {
  const [f1, f2] = dragFactors(P.cone[3], tau);
  const [windEast, windNorth, amplitude, hz] = P.air;
  let p = add3(
    add3(m.origin, [windEast * tau, windNorth * tau, 0]),
    scale3(m.v0, f1),
  );
  p = [p[0], p[1], p[2] - P.cone[2] * f2];
  const f = hz * tau;
  const [r0, r1, r2] = m.rho;
  let wander = scale3(m.e0, Math.sin(TAU * fract(f + r0)) - Math.sin(TAU * r0));
  wander = add3(
    wander,
    scale3(
      m.e1,
      0.5 * (Math.sin(TAU * fract(2.17 * f + r1)) - Math.sin(TAU * r1)),
    ),
  );
  wander = add3(
    wander,
    scale3(
      m.e2,
      0.25 * (Math.sin(TAU * fract(4.33 * f + r2)) - Math.sin(TAU * r2)),
    ),
  );
  return add3(p, scale3(wander, amplitude * (1 / 1.75)));
}

/** particleHueRotate: rotation about the gray axis by angle radians. */
function hueRotate(rgb: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = 0.5773502691896258;
  const axis: Vec3 = [k, k, k];
  return add3(
    add3(scale3(rgb, c), scale3(cross3(axis, rgb), s)),
    scale3(axis, dot3(axis, rgb) * (1 - c)),
  );
}

/** Emission timing of one particle at one time. */
export interface Timing {
  /** Birth phase of this particle and of its burst group, in cycles. */
  phase: number;
  groupPhase: number;
  /** Count prefix times the seed's keep: how much of the particle shows. */
  keep: number;
  /** Cycles per clock wrap and the cycle period in seconds. */
  cycles: number;
  period: number;
  /** Unwrapped cycle number and its id modulo cycles. */
  cycle: number;
  cycleId: number;
  /** The burst group's cycle id at this life's birth. */
  groupId: number;
  jitter: number;
  age: number;
  lifetime: number;
}

/** The timing half of particleVertex, for P already clamped. */
export function timing(
  P: ParticleParams,
  W: ParticleWeather,
  S: ParticleSeed,
  time: number,
): Timing {
  const [seed] = identity(P.emission[3]);
  const weather = S.kind > 1.5 && S.kind < 2.5;
  const i = S.index >>> 0;
  const [count, explosiveness] = P.emission;
  const base = u01(pcg3d(seed, 0, 7)[0]);
  let phase = 0;
  let groupPhase = 0;
  let share = 1;
  if (S.kind < 1.5) {
    const groups = Math.floor(P.emission[2]);
    groupPhase = fract(0.6180339887 * (i % groups) + base);
    phase = fract(
      groupPhase + (1 - explosiveness) * weyl(Math.floor(i / groups)),
    );
    share = prefix(count, S.index, count);
  } else if (weather) {
    phase = fract(base + (1 - explosiveness) * weyl(i >>> 1));
    groupPhase = phase;
    const weight = (i & 1) === 0 ? W.weights[0] : W.weights[1];
    share = prefix(count * weight, i >>> 1, count);
  } else if (S.kind < 3.5) {
    groupPhase = u01(S.group);
    phase = fract(groupPhase + weyl(i));
  } else {
    groupPhase = u01(S.key);
    phase = groupPhase;
  }

  const lifeMax = Math.max(P.timing[0], P.timing[1]);
  const lifeMin = Math.min(P.timing[0], P.timing[1]);
  const interval = P.timing[2] < lifeMax ? lifeMax : P.timing[2];
  // The nearest period dividing the wrap that still holds the longest life.
  const cycles = Math.max(
    1,
    Math.min(
      Math.floor(PARTICLE_W / interval + 0.5),
      Math.floor((PARTICLE_W * 1.00001) / lifeMax),
    ),
  );
  const period = PARTICLE_W / cycles;
  const u = time * cycles * (1 / PARTICLE_W) + 1 - phase;
  const cycle = Math.floor(u);
  const cycleId = cycle - cycles * Math.floor((cycle + 0.5) / cycles);
  const groupCycle = cycle - (phase < groupPhase ? 1 : 0);
  const groupId = groupCycle - cycles * Math.floor((groupCycle + 0.5) / cycles);
  const burst = pcg3d(S.group, groupId, 0x71);
  const jitter = P.timing[3] * u01(burst[0]) * Math.max(period - lifeMax, 0);
  const rLife = random(S.key, cycleId, 0);
  return {
    phase,
    groupPhase,
    keep: S.keep * share,
    cycles,
    period,
    cycle,
    cycleId,
    groupId,
    jitter,
    age: (u - cycle) * period - jitter,
    lifetime: Math.min(mix(lifeMin, lifeMax, rLife[0]), period),
  };
}

/** Everything particleVertex computes for one particle, before the corner. */
export interface ParticleState {
  /** False when the particle's quad collapses (dead, culled, behind the camera or invisible). */
  visible: boolean;
  timing: Timing;
  /** Life fraction in [0, 1]. */
  life: number;
  /** Head and tail positions (ENU space units; weather: box-relative). */
  head: Vec3;
  tail: Vec3;
  /** Head and tail clip positions. */
  headClip: Vec4;
  tailClip: Vec4;
  /** Diameter in space units, the unclamped and drawn diameters in px. */
  sizeUnits: number;
  rawPx: number;
  sizePx: number;
  /** Output color (premultiplied, faded, additive applied). */
  color: Vec4;
  shape: number;
  stretched: boolean;
  ripple: boolean;
  /** Spin angle of an unstretched sprite, radians. */
  spin: number;
  /** Per-life random seed for shape.glsl's smoke. */
  lookSeed: number;
}

/** The particle-level part of particleVertex. */
export function particleState(
  params: ParticleParams,
  F: ParticleFrame,
  W: ParticleWeather,
  S: ParticleSeed,
  time: number,
): ParticleState {
  const P = clampParams(params);
  const [, shape, space] = identity(P.emission[3]);
  const weather = S.kind > 1.5 && S.kind < 2.5;
  const screen = !weather && S.kind < 2.5 && space < 0.5;
  const line = S.kind > 3.5 && S.kind < 4.5;
  const polygon = S.kind > 4.5;
  const i = S.index >>> 0;
  const explosiveness = P.emission[1];
  const T = timing(P, W, S, time);

  const lifeId = T.cycleId;
  const rLife = random(S.key, lifeId, 0);
  const rSpawn = random(S.key, lifeId, 1);
  const rLaunch = random(S.key, lifeId, 2);
  const rWander0 = random(S.key, lifeId, 3);
  const rWander1 = random(S.key, lifeId, 4);
  const rPhase = random(S.key, lifeId, 5);
  const rSpin = random(S.key, lifeId, 6);
  const rColor = random(S.key, lifeId, 7);
  const rGroup = random(S.group, T.groupId, 0x9e37);
  const burst = pcg3d(S.group, T.groupId, 0x71);

  let alive = T.age >= 0 && T.age < T.lifetime && T.keep > 0;
  const tau = Math.max(T.age, 0);
  const l = clamp(tau / T.lifetime, 0, 1);

  // Spawn.
  const [radius, heightMin, heightMax, thinning] = P.area;
  let origin: Vec3 = [0, 0, 0];
  let lineAngle = 0;
  if (S.kind < 1.5) {
    let own: Vec3 = [0, 0, mix(heightMin, heightMax, rSpawn[0])];
    let center: Vec3 = [0, 0, mix(heightMin, heightMax, rGroup[0])];
    if (S.kind > 0.5) {
      const ownRadius = radius * Math.sqrt(rSpawn[0]);
      const centerRadius = radius * Math.sqrt(rGroup[0]);
      own = [
        ownRadius * Math.sin(TAU * rSpawn[1]),
        ownRadius * Math.cos(TAU * rSpawn[1]),
        mix(heightMin, heightMax, rSpawn[2]),
      ];
      center = [
        centerRadius * Math.sin(TAU * rGroup[1]),
        centerRadius * Math.cos(TAU * rGroup[1]),
        mix(heightMin, heightMax, rGroup[2]),
      ];
    }
    origin = mix3(own, center, explosiveness);
    if (screen) origin = [origin[0], 0, origin[2] + origin[1]];
  } else if (line) {
    lineAngle = S.extent[1];
    const along = (2 * rSpawn[0] - 1) * S.extent[0];
    origin = [along * Math.sin(lineAngle), along * Math.cos(lineAngle), 0];
  } else if (polygon) {
    origin = [
      (2 * rSpawn[0] - 1) * S.extent[0],
      (2 * rSpawn[1] - 1) * S.extent[0],
      0,
    ];
  }

  // Launch.
  const [spreadAngle, flatness] = P.cone;
  const azimuth = P.launch[2] * DEGREES + lineAngle;
  const elevation = P.launch[3] * DEGREES;
  const axis: Vec3 = [
    Math.sin(azimuth) * Math.cos(elevation),
    Math.cos(azimuth) * Math.cos(elevation),
    Math.sin(elevation),
  ];
  // 1 - cos(theta) of the launch direction, uniform over the spread cap.
  const halfSpread = Math.sin(spreadAngle * (DEGREES / 2));
  const offAxis = 2 * rLaunch[0] * halfSpread * halfSpread;
  const cosCone = 1 - offAxis;
  const sinCone = Math.sqrt(Math.max(0, offAxis * (2 - offAxis)));
  const t1 = normalize3(
    cross3(Math.abs(axis[2]) < 0.999 ? [0, 0, 1] : [1, 0, 0], axis),
  );
  const t2 = cross3(axis, t1);
  const coneTurn = TAU * rLaunch[1];
  const launch = add3(
    scale3(axis, cosCone),
    scale3(
      add3(scale3(t1, Math.cos(coneTurn)), scale3(t2, Math.sin(coneTurn))),
      sinCone,
    ),
  );
  const flat = (v: Vec3): Vec3 => [v[0], v[1], v[2] * (1 - flatness)];
  const m: Launch = {
    origin,
    v0: scale3(flat(launch), mix(P.launch[0], P.launch[1], rLaunch[2])),
    e0: flat(direction(rWander0[0], rWander0[1])),
    e1: flat(direction(rWander0[2], rWander1[0])),
    e2: flat(direction(rWander1[1], rWander1[2])),
    rho: rPhase,
  };

  // Head and tail.
  const velocityShape = shape > 2.5 && shape < 4.5;
  const ripple = shape > 6.5 && shape < 7.5 && !screen;
  const stretch = P.size[3];
  const trail = velocityShape ? Math.max(stretch, 1 / 30) : stretch;
  const stretched = (stretch > 0 || velocityShape) && !ripple;
  let head = motion(P, m, tau);
  let tail = motion(P, m, Math.max(tau - trail, 0));
  const sizeUnits = mix(P.size[0], P.size[1], rSpin[2]) * mix(1, P.size[2], l);

  let fade = 1;
  let altitude = head[2];
  let groundSize = sizeUnits;
  if (line) {
    const along =
      Math.abs(head[0] * Math.sin(lineAngle) + head[1] * Math.cos(lineAngle)) /
      Math.max(S.extent[0], EPSILON);
    alive = alive && along <= 1;
    fade *= 1 - smooth((along - 0.8) * 5);
  }
  if (weather) {
    const unit = Math.max(F.view[2], EPSILON);
    const pool = (i & 1) === 0 ? W.pool0 : W.pool1;
    const box = Math.max((pool[3] * W.eye[3]) / unit, EPSILON);
    // The window ahead of the eye along the frame's w gradient.
    const forward: Vec3 = [F.X[3], F.Y[3], F.Z[3]];
    const window = scale3(
      forward,
      (0.4 * box) / Math.max(length3(forward), EPSILON),
    );
    const rel: Vec3 = [0, 1, 2].map(
      (c) =>
        box *
          (fract(rSpawn[c]! - pool[c]! + 0.5 + (head[c]! - window[c]!) / box) -
            0.5) +
        window[c]!,
    ) as unknown as Vec3;
    tail = sub3(rel, sub3(head, tail));
    head = rel;
    altitude = W.weights[2] + rel[2] * unit;
    groundSize = sizeUnits * unit;
    const inWindow = sub3(rel, window).map(Math.abs);
    const edge = Math.max(...inWindow) / (0.5 * box);
    fade *= 1 - smooth((edge - 0.8) * 5);
    fade *= smooth((length3(rel) / box - 0.02) * (1 / 0.06));
  }
  if (!screen) {
    const ground = 1 + altitude / Math.max(groundSize, EPSILON);
    alive = alive && ground > 0;
    fade *= smooth(ground);
  }

  // Projection.
  const headClip = project(F, head);
  const tailClip = project(F, tail);
  const hidden: ParticleState = {
    visible: false,
    timing: T,
    life: l,
    head,
    tail,
    headClip,
    tailClip,
    sizeUnits,
    rawPx: 0,
    sizePx: 0,
    color: ZERO4,
    shape,
    stretched,
    ripple,
    spin: 0,
    lookSeed: rLife[1],
  };
  if (
    !alive ||
    headClip[3] <= EPSILON ||
    (stretched && tailClip[3] <= EPSILON)
  ) {
    return hidden;
  }
  const ndcHead: Vec2 = [headClip[0] / headClip[3], headClip[1] / headClip[3]];
  if (weather) {
    const vanish = project({ ...F, C: ZERO4 }, axis);
    if (vanish[3] > EPSILON) {
      const ox =
        ((ndcHead[0] - vanish[0] / vanish[3]) * F.screen[2]) /
        Math.max(F.screen[3], 1);
      const oy = ndcHead[1] - vanish[1] / vanish[3];
      fade *= mix(
        1,
        smooth((Math.sqrt(ox * ox + oy * oy) - 0.05) * (1 / 0.55)),
        thinning,
      );
    }
  }
  const rawPx =
    sizeUnits * F.view[2] * (F.view[3] > 0.5 ? F.view[0] / headClip[3] : 1);
  let sizePx = Math.min(Math.max(rawPx, P.sizeSpin[0]), P.sizeSpin[1]);
  const ratio = Math.max(F.view[1], EPSILON);
  // Below the floor size a quad is drawn at the floor, with the missing area
  // as alpha; a capsule's area goes as size * (span + 0.2 pi size).
  const span = stretched ? screenSpan(F, headClip, tailClip) : 0;
  const floorPx = (stretched ? STRETCHED_FLOOR : SPRITE_FLOOR) / ratio;
  if (sizePx < floorPx) {
    const scale = sizePx / floorPx;
    fade *= stretched
      ? (scale * (span + 0.6283185 * sizePx)) / (span + 0.6283185 * floorPx)
      : scale * scale;
    sizePx = floorPx;
  }

  // Look over life.
  const color = mix4(P.color, P.colorEnd, l);
  const hue =
    ((2 * rColor[0] - 1) * P.sparkle[2] +
      (2 * u01(burst[1]) - 1) * P.sparkle[3]) *
    DEGREES;
  const alpha = color[3];
  const rgb = hueRotate([color[0], color[1], color[2]], hue).map((c) =>
    Math.min(Math.max(c, 0), alpha),
  );
  const fadeIn = P.fadeAdd[0] > 0 ? smooth(l / P.fadeAdd[0]) : 1;
  const fadeOut = P.fadeAdd[1] > 0 ? smooth((1 - l) / P.fadeAdd[1]) : 1;
  const amount = P.sparkle[0];
  const wave =
    0.5 +
    0.5 *
      Math.sin(
        TAU *
          fract(P.sparkle[1] * (1 + 0.6 * (rColor[1] - 0.5)) * tau + rColor[2]),
      );
  const twinkle = 1 - amount + amount * Math.max(wave, 0) ** (1 + 3 * amount);
  const strength = fadeIn * fadeOut * twinkle * T.keep * fade;
  if (strength <= 0) return { ...hidden, rawPx, sizePx };
  const additive = clamp(mix(P.fadeAdd[2], P.fadeAdd[3], l), 0, 1);
  const state: ParticleState = {
    ...hidden,
    visible: true,
    rawPx,
    sizePx,
    color: [
      rgb[0]! * strength,
      rgb[1]! * strength,
      rgb[2]! * strength,
      alpha * strength * (1 - additive),
    ],
    spin:
      TAU *
      fract(
        rSpin[0] +
          mix(P.sizeSpin[2], P.sizeSpin[3], rSpin[1]) * (1 / 360) * tau,
      ),
  };
  if (ripple) {
    const halfUnits = (0.5 * sizeUnits * sizePx) / Math.max(rawPx, EPSILON);
    if (
      headClip[3] -
        Math.abs(F.X[3] * halfUnits) -
        Math.abs(F.Y[3] * halfUnits) <=
      EPSILON
    ) {
      return { ...hidden, rawPx, sizePx };
    }
  }
  return state;
}

/** A clip position in logical px from the viewport center (y down). */
function toPx(F: ParticleFrame, clip: Vec4): Vec2 {
  return [clip[0] / clip[3] / F.screen[0], clip[1] / clip[3] / F.screen[1]];
}

/** How far a stretched particle's head is from its tail, logical px. */
function screenSpan(F: ParticleFrame, headClip: Vec4, tailClip: Vec4): number {
  const [hx, hy] = toPx(F, headClip);
  const [tx, ty] = toPx(F, tailClip);
  return Math.sqrt((hx - tx) * (hx - tx) + (hy - ty) * (hy - ty));
}

/** Where corner 0..3 sits on the quad: (-1, -1), (1, -1), (1, 1), (-1, 1). */
export function cornerSigns(corner: number): Vec2 {
  return [corner > 0.5 && corner < 2.5 ? 1 : -1, corner > 1.5 ? 1 : -1];
}

const COLLAPSED: ParticleVertex = {
  position: [2, 2, 2, 1],
  uv: ZERO4,
  color: ZERO4,
  look: ZERO4,
};

/**
 * particleVertex: one corner of one particle's quad. zNear is
 * PARTICLE_Z_NEAR: -1 on OpenGL and WebGL, 0 on Vulkan and Metal.
 */
export function particleVertex(
  P: ParticleParams,
  F: ParticleFrame,
  W: ParticleWeather,
  S: ParticleSeed,
  time: number,
  zNear = -1,
): ParticleVertex {
  const state = particleState(P, F, W, S, time);
  if (!state.visible) return COLLAPSED;
  const ratio = Math.max(F.view[1], EPSILON);
  const { sizePx, headClip, tailClip } = state;
  const halfPx = 0.5 * sizePx;
  const aa = 2 / (sizePx * ratio);
  const look: Vec4 = [state.shape, 0, state.lookSeed, 0];
  const [sx, sy] = cornerSigns(S.corner);
  if (state.ripple) {
    const halfUnits =
      (0.5 * state.sizeUnits * sizePx) / Math.max(state.rawPx, EPSILON);
    const c = [0, 1, 2, 3].map(
      (k) => headClip[k]! + sx * F.X[k]! * halfUnits + sy * F.Y[k]! * halfUnits,
    ) as unknown as Vec4;
    return {
      position: [c[0], c[1], zNear * c[3], c[3]],
      uv: [sx, sy, 0, aa],
      color: state.color,
      look,
    };
  }
  const [ptgx, ptgy] = F.screen;
  const pxHead = toPx(F, headClip);
  let px: Vec2;
  let uv: Vec4;
  if (state.stretched) {
    const pxTail = toPx(F, tailClip);
    const dx = pxHead[0] - pxTail[0];
    const dy = pxHead[1] - pxTail[1];
    const span = Math.sqrt(dx * dx + dy * dy);
    const dir: Vec2 = span > 0.001 ? [dx / span, dy / span] : [0, -1];
    const along = sx < 0 ? -halfPx : span + halfPx;
    const across = sy * halfPx;
    px = [
      pxTail[0] + dir[0] * along - dir[1] * across,
      pxTail[1] + dir[1] * along + dir[0] * across,
    ];
    uv = [along / halfPx, sy, span / halfPx, aa];
  } else {
    const c = Math.cos(state.spin);
    const s = Math.sin(state.spin);
    px = [
      pxHead[0] + (c * sx - s * sy) * halfPx,
      pxHead[1] + (s * sx + c * sy) * halfPx,
    ];
    uv = [sx, sy, 0, aa];
  }
  return {
    position: [px[0] * ptgx, px[1] * ptgy, zNear, 1],
    uv,
    color: state.color,
    look,
  };
}

/** particleTint: one corner of the full-screen emitter-screen-tint quad. */
export function particleTint(
  tint: Vec4,
  vignette: number,
  corner: number,
  zNear = -1,
): ParticleVertex {
  if (tint[3] <= 0) return COLLAPSED;
  const [sx, sy] = cornerSigns(corner);
  return {
    position: [sx, sy, zNear, 1],
    uv: [sx, sy, 0, 0],
    color: tint,
    look: [100, clamp(vignette, 0, 1), 0, 0],
  };
}

/**
 * The CPU half of the weather volume: each parity pool's anchor
 * octave, scale, weight and phase, from the eye's absolute world position in
 * px at `zoom` (y down), its altitude in px, and the box size in px (the
 * camera-to-center distance). Returns the header's pool0, pool1 and weights.
 */
export function weatherPools(
  zoom: number,
  eyeX: number,
  eyeY: number,
  eyeAltitude: number,
  box: number,
): Pick<ParticleWeather, "pool0" | "pool1" | "weights"> {
  const n = Math.floor(zoom);
  const f = zoom - n;
  const pools = [0, 1].map((p) => {
    const anchor = (n & 1) === p ? n : n + 1;
    const scale = 2 ** (zoom - anchor);
    const weight = anchor === n ? 1 - f : f;
    const pool: Vec4 = [
      fract(eyeX / scale / box),
      fract(-eyeY / scale / box),
      fract(eyeAltitude / (scale * box)),
      scale,
    ];
    return { pool, weight };
  });
  const [p0, p1] = pools as [(typeof pools)[0], (typeof pools)[0]];
  return {
    pool0: p0.pool,
    pool1: p1.pool,
    weights: [p0.weight, p1.weight, eyeAltitude, 0],
  };
}
