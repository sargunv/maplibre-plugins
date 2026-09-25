// The particle model (model.ts, the port of shaders/particle.glsl): its
// timing, motion, weather and keep properties, and fixtures/model.json, its
// inputs and outputs. The shaders themselves run here too, compiled for the
// CPU: particle.glsl against the fixture (and hash.json), and shape.glsl
// rasterized to check how small particles and ripples land on the pixel grid.
// Regenerate the fixture with `UPDATE_FIXTURES=1 pnpm test`, then
// `pnpm exec dprint fmt` it.
//
// Frames come from a maplibre-style camera: a projection of world pixels
// relative to the map center (x east, y south) and meters up, as the emitter
// row's P_rel and a tile's matrix provide them.

import { readFileSync, writeFileSync } from "node:fs";
import { runInThisContext } from "node:vm";

import { describe, expect, it } from "vite-plus/test";

import shapes from "./generated/shape.glsl.ts";
import { pcg3d } from "./hash.ts";
import {
  clampParams,
  cornerSigns,
  DRAG_SERIES_LIMIT,
  dragFactors,
  emitterSeed,
  featureKeep,
  featureSeed,
  identity,
  packIdentity,
  type ParticleFrame,
  type ParticleParams,
  type ParticleSeed,
  type ParticleState,
  particleState,
  particleTint,
  particleVertex,
  type ParticleVertex,
  type ParticleWeather,
  PARTICLE_W,
  prefix,
  Shape,
  SPRITE_FLOOR,
  STRETCHED_FLOOR,
  timing,
  type Vec2,
  type Vec3,
  type Vec4,
  weatherPools,
  ZERO4,
} from "./model.ts";
import { prefixRanks } from "./record.ts";
import { vertexCore } from "./shader-common.ts";

const FIXTURE = new URL("../../fixtures/model.json", import.meta.url);
const DEG = Math.PI / 180;
const SPACE = { screen: 0, ground: 1, world: 2 } as const;
const KIND = { point: 0, circle: 1, weather: 2, features: 3 } as const;

// --- Camera and frames -----------------------------------------------------

type Mat4 = readonly number[];

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out: number[] = [];
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r]! * b[c * 4 + k]!;
      out.push(sum);
    }
  }
  return out;
}

/** A column-major matrix from its four columns. */
const fromColumns = (...columns: readonly number[][]): Mat4 => columns.flat();
const scaling = (x: number, y: number, z: number): Mat4 =>
  fromColumns([x, 0, 0, 0], [0, y, 0, 0], [0, 0, z, 0], [0, 0, 0, 1]);
const translation = (x: number, y: number, z: number): Mat4 =>
  fromColumns([1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [x, y, z, 1]);
function rotationX(a: number): Mat4 {
  const [c, s] = [Math.cos(a), Math.sin(a)];
  return fromColumns([1, 0, 0, 0], [0, c, s, 0], [0, -s, c, 0], [0, 0, 0, 1]);
}
function rotationZ(a: number): Mat4 {
  const [c, s] = [Math.cos(a), Math.sin(a)];
  return fromColumns([c, s, 0, 0], [-s, c, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]);
}
function perspective(
  fov: number,
  aspect: number,
  near: number,
  far: number,
): Mat4 {
  const f = 1 / Math.tan(fov / 2);
  return fromColumns(
    [f / aspect, 0, 0, 0],
    [0, f, 0, 0],
    [0, 0, (far + near) / (near - far), -1],
    [0, 0, (2 * far * near) / (near - far), 0],
  );
}
function transform(m: Mat4, v: Vec4): Vec4 {
  return [0, 1, 2, 3].map(
    (r) =>
      m[r]! * v[0] + m[4 + r]! * v[1] + m[8 + r]! * v[2] + m[12 + r]! * v[3],
  ) as unknown as Vec4;
}
const column = (m: Mat4, c: number): Vec4 =>
  [m[4 * c]!, m[4 * c + 1]!, m[4 * c + 2]!, m[4 * c + 3]!] as const;
const scale4 = (v: Vec4, s: number): Vec4 => [
  v[0] * s,
  v[1] * s,
  v[2] * s,
  v[3] * s,
];

interface Camera {
  /** P_rel: world px relative to the center (y down), z in meters -> clip. */
  matrix: Mat4;
  ctcd: number;
  width: number;
  height: number;
  ratio: number;
  /** Pixels per meter of the matrix's z column. */
  ppm: number;
}

/** maplibre's camera: 36.87° vertical field of view, center at ctcd. */
function camera(
  options: {
    pitch?: number;
    bearing?: number;
    ppm?: number;
    ratio?: number;
  } = {},
): Camera {
  const { pitch = 0, bearing = 0, ppm = 1, ratio = 1 } = options;
  const [width, height] = [800, 600];
  const fov = 0.6435011087932844;
  const ctcd = (0.5 * height) / Math.tan(fov / 2);
  let m = perspective(fov, width / height, ctcd / 50, ctcd * 20);
  m = multiply(m, scaling(1, -1, 1));
  m = multiply(m, translation(0, 0, -ctcd));
  m = multiply(m, rotationX(pitch * DEG));
  m = multiply(m, rotationZ(-bearing * DEG));
  m = multiply(m, scaling(1, 1, ppm));
  return { matrix: m, ctcd, width, height, ratio, ppm };
}

/** The eye from the camera rows' null space: (x, y px; z m). */
function eyeOf(cam: Camera): Vec3 {
  const m = cam.matrix;
  const rows = [0, 1, 3];
  const a = rows.map((r) => [m[r]!, m[4 + r]!, m[8 + r]!]);
  const b = rows.map((r) => -m[12 + r]!);
  const det = (q: number[][]): number =>
    q[0]![0]! * (q[1]![1]! * q[2]![2]! - q[1]![2]! * q[2]![1]!) -
    q[0]![1]! * (q[1]![0]! * q[2]![2]! - q[1]![2]! * q[2]![0]!) +
    q[0]![2]! * (q[1]![0]! * q[2]![1]! - q[1]![1]! * q[2]![0]!);
  const d = det(a);
  return [0, 1, 2].map(
    (c) => det(a.map((row, r) => row.map((v, k) => (k === c ? b[r]! : v)))) / d,
  ) as unknown as Vec3;
}

function screenOf(cam: Camera): Vec4 {
  return [2 / cam.width, -2 / cam.height, cam.width, cam.height];
}

/** The emitter frames of each space at `anchor` (world px from the center). */
function emitterFrame(
  cam: Camera,
  space: keyof typeof SPACE,
  options: { anchor?: Vec2; scale?: number; ppm?: number } = {},
): ParticleFrame {
  const { anchor = [0, 0], scale = 1, ppm = 1 } = options;
  const screen = screenOf(cam);
  const C = transform(cam.matrix, [anchor[0], anchor[1], 0, 1]);
  const east = column(cam.matrix, 0);
  const north = scale4(column(cam.matrix, 1), -1);
  const up: Vec4 = [0, -screen[1] * cam.ctcd * scale, 0, 0];
  if (space === "screen") {
    return {
      C,
      X: [screen[0] * C[3] * scale, 0, 0, 0],
      Y: ZERO4,
      Z: [0, -screen[1] * C[3] * scale, 0, 0],
      screen,
      view: [cam.ctcd, cam.ratio, scale, 0],
    };
  }
  if (space === "world") {
    return {
      C,
      X: scale4(east, ppm * scale),
      Y: scale4(north, ppm * scale),
      Z: scale4(column(cam.matrix, 2), scale),
      screen,
      view: [cam.ctcd, cam.ratio, ppm * scale, 1],
    };
  }
  return {
    C,
    X: scale4(east, scale),
    Y: scale4(north, scale),
    Z: up,
    screen,
    view: [cam.ctcd, cam.ratio, scale, 1],
  };
}

/** The weather frame: the axes at the eye, in px, scaled. */
function weatherFrame(cam: Camera, scale = 1): ParticleFrame {
  const eye = eyeOf(cam);
  return {
    C: transform(cam.matrix, [eye[0], eye[1], eye[2], 1]),
    X: scale4(column(cam.matrix, 0), scale),
    Y: scale4(column(cam.matrix, 1), -scale),
    Z: scale4(column(cam.matrix, 2), scale / cam.ppm),
    screen: screenOf(cam),
    view: [cam.ctcd, cam.ratio, scale, 1],
  };
}

/**
 * The weather header for a camera whose center sits at `center` (absolute
 * world px at `zoom`).
 */
function weatherOf(cam: Camera, zoom: number, center: Vec2): ParticleWeather {
  const eye = eyeOf(cam);
  const altitude = eye[2] * cam.ppm;
  const pools = weatherPools(
    zoom,
    center[0] + eye[0],
    center[1] + eye[1],
    altitude,
    cam.ctcd,
  );
  return { eye: [eye[0], eye[1], eye[2], cam.ctcd], ...pools };
}

const NO_WEATHER: ParticleWeather = {
  eye: ZERO4,
  pool0: ZERO4,
  pool1: ZERO4,
  weights: ZERO4,
};

/**
 * A tile frame for particle-features: the tile's matrix M = P_rel * T(origin) *
 * S(1 / ptu), evaluated at the anchor (tile units).
 */
function featureFrame(
  cam: Camera,
  origin: Vec2,
  ptu: number,
  anchor: Vec2,
): ParticleFrame {
  const tile = multiply(
    multiply(cam.matrix, translation(origin[0], origin[1], 0)),
    scaling(1 / ptu, 1 / ptu, 1),
  );
  const screen = screenOf(cam);
  return {
    C: transform(tile, [anchor[0], anchor[1], 0, 1]),
    X: scale4(column(tile, 0), ptu),
    Y: scale4(column(tile, 1), -ptu),
    Z: [0, -screen[1] * cam.ctcd, 0, 0],
    screen,
    view: [cam.ctcd, cam.ratio, 1, 1],
  };
}

// --- Paint -----------------------------------------------------------------

/** Spec defaults as ParticleParams, with an identity for kind and space. */
function params(
  overrides: Partial<Record<keyof ParticleParams, Vec4>> = {},
  id: { seed?: number; shape?: number; space?: number; kind?: number } = {},
): ParticleParams {
  const {
    seed = 0,
    shape = Shape.glow,
    space = SPACE.ground,
    kind = KIND.point,
  } = id;
  // The packer resolves a transparent particle-color-end to the start color.
  const color = overrides.color ?? [1, 0.9, 0.6, 1];
  return {
    color,
    colorEnd: color,
    size: [6, 10, 1, 0],
    sizeSpin: [0.5, 128, 0, 0],
    fadeAdd: [0.1, 0.3, 0, 0],
    sparkle: [0, 2, 0, 0],
    timing: [1, 2, 0, 0],
    emission: [256, 0, 1, packIdentity(seed, shape, space, kind)],
    launch: [20, 40, 0, 90],
    cone: [15, 0, 0, 0],
    air: [0, 0, 0, 0.5],
    area: [0, 0, 0, 0],
    ...overrides,
  };
}

const withEmission = (
  P: ParticleParams,
  lane: Partial<{ count: number; explosiveness: number; groups: number }>,
): ParticleParams => ({
  ...P,
  emission: [
    lane.count ?? P.emission[0],
    lane.explosiveness ?? P.emission[1],
    lane.groups ?? P.emission[2],
    P.emission[3],
  ],
});

const corners = (S: ParticleSeed): ParticleSeed[] =>
  [0, 1, 2, 3].map((corner) => ({ ...S, corner }));

/** The time at which a particle is `age` seconds into the life around t0. */
function timeAtAge(
  P: ParticleParams,
  W: ParticleWeather,
  S: ParticleSeed,
  t0: number,
  age: number,
): number {
  const T = timing(clampParams(P), W, S, t0);
  return (T.cycle - 1 + T.phase) * T.period + T.jitter + age;
}

const clamp01 = (x: number): number => Math.min(Math.max(x, 0), 1);
const close = (a: number, b: number, tolerance: number): boolean =>
  Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(b));

// --- Tests -----------------------------------------------------------------

describe("identity and clamps", () => {
  it("packs and unpacks seed, shape, space and kind", () => {
    for (const [seed, shape, space, kind] of [
      [0, 0, 0, 0],
      [65535, 9, 2, 3],
      [1234, Shape.ripple, SPACE.world, KIND.circle],
    ] as const) {
      expect(identity(packIdentity(seed, shape, space, kind))).toEqual([
        seed,
        shape,
        space,
        kind,
      ]);
    }
    // An out-of-range shape index clamps to the last shape.
    expect(identity(packIdentity(0, 12, 1, 0))[1]).toBe(9);
  });

  it("clamps every lane to the @clamp literals and keeps the identity class", () => {
    const P = clampParams(
      params({
        size: [-1, 20000, 99, 5],
        timing: [0, 900, 700, 2],
        emission: [99999, 3, 40, packIdentity(70000, 3, 1, 0)],
        launch: [-5, 2e6, 720, -200],
        cone: [400, 2, -9.8, 90],
        air: [3, 4, -1, 99],
      }),
    );
    expect(P.size).toEqual([0, 10000, 16, 2]);
    expect(P.timing).toEqual([0.05, 600, 600, 1]);
    expect(P.emission.slice(0, 3)).toEqual([16384, 1, 16]);
    // A seed past 65535 carries into the class; clamping keeps the class.
    expect(identity(P.emission[3])).toEqual([4464, 4, 1, 0]);
    expect(P.launch).toEqual([0, 100000, 720, -90]);
    expect(P.cone).toEqual([180, 1, -9.8, 50]);
    expect(P.air).toEqual([3, 4, 0, 30]);
    // An eased (fractional) seed floors to an integer.
    expect(
      clampParams(params({}, { seed: 7.6, shape: 3 })).emission[3] % 65536,
    ).toBe(7);
  });
});

describe("count prefix", () => {
  it("is clamp(target - rank, 0, 1) times the gate at small counts", () => {
    for (const target of [0, 0.5, 1, 3, 5.25, 8]) {
      for (let rank = 0; rank < 10; rank++) {
        const expected = Math.min(Math.max(target - rank, 0), 1);
        const gate = Math.min(Math.max(2 * target, 0), 1);
        expect(prefix(target, rank, 8)).toBeCloseTo(expected * gate, 12);
      }
    }
  });

  it("shows `target` particles in total and fades each over count/8 ranks", () => {
    const count = 4096;
    for (const target of [300, 1000, 2048, 4000]) {
      let mass = 0;
      for (let rank = 0; rank < 8192; rank++)
        mass += prefix(target, rank, count);
      expect(mass).toBeCloseTo(target, 6);
    }
    // One particle's share changes smoothly with the target.
    const rank = 1000;
    let previous = prefix(0, rank, count);
    for (let target = 0; target <= 2000; target += 5) {
      const share = prefix(target, rank, count);
      expect(Math.abs(share - previous)).toBeLessThanOrEqual(5 / 512 + 1e-12);
      previous = share;
    }
    expect(prefix(0, 0, count)).toBe(0);
  });

  it("reaches past the target by half a ramp, and no further than prefixRanks", () => {
    for (const count of [0.3, 5.5, 8, 9, 64, 256, 1000, 1024, 4096, 16384]) {
      const ranks = prefixRanks(count);
      for (const target of [count, 0.97 * count, 0.5 * count]) {
        for (let rank = ranks; rank < ranks + 64; rank++)
          expect(prefix(target, rank, count)).toBe(0);
      }
      // The reach is tight: the last rank shows.
      expect(prefix(count, ranks - 1, count)).toBeGreaterThan(0);
      if (count < 64 || count % 8 !== 0) continue;
      let mass = 0;
      for (let rank = 0; rank < ranks; rank++)
        mass += prefix(count, rank, count);
      expect(mass).toBeCloseTo(count, 9);
    }
    expect(prefixRanks(1024)).toBe(1088);
  });
});

describe("emission timing", () => {
  const W = NO_WEATHER;

  it("snaps the period to divide the clock wrap within D / 2W", () => {
    for (let interval = 0.05; interval <= 600; interval *= 1.137) {
      const P = clampParams(params({ timing: [0.05, 0.05, interval, 0] }));
      const T = timing(P, W, emitterSeed(P, 0, 0), 0);
      expect(Number.isInteger(T.cycles)).toBe(true);
      expect(T.cycles * T.period).toBeCloseTo(PARTICLE_W, 9);
      const requested = Math.max(interval, 0.05);
      expect(Math.abs(T.period - requested) / requested).toBeLessThanOrEqual(
        T.period / (2 * PARTICLE_W) + 1e-12,
      );
    }
  });

  it("never cuts a life short to fit the clock wrap", () => {
    // Rounding W / interval to the nearest whole number of cycles could make
    // the period shorter than the longest life (430 s lived 409.6 s). The
    // period is now the nearest divisor of the wrap that holds it.
    const lifetimes = [0.05, 1.6, 7.3, 300, 430, 512, 546.13, 600];
    for (let L = 0.05; L <= 600; L *= 1.093) lifetimes.push(L);
    for (const L of lifetimes) {
      for (const interval of [0, 1.02 * L, 1.3 * L, 600]) {
        const P = clampParams(params({ timing: [L, L, interval, 0] }));
        const T = timing(P, W, emitterSeed(P, 0, 0), 0);
        const life = P.timing[1];
        expect(T.cycles * T.period).toBeCloseTo(PARTICLE_W, 9);
        expect(T.period).toBeGreaterThanOrEqual(life * (1 - 1e-5));
        expect(T.lifetime).toBeGreaterThanOrEqual(life * (1 - 1e-5));
        const requested = Math.max(P.timing[2], life);
        expect(Math.abs(T.period - requested) / requested).toBeLessThanOrEqual(
          T.period / PARTICLE_W + 1e-5,
        );
      }
    }
  });

  it("runs continuously across the clock wrap", () => {
    const P = clampParams(
      params({ timing: [1.3, 2.9, 0, 0] }, { kind: KIND.circle }),
    );
    let checked = 0;
    for (let i = 0; i < 256; i++) {
      const S = emitterSeed(P, i, 0);
      const before = timing(P, W, S, PARTICLE_W - 0.01);
      const after = timing(P, W, S, 0.02);
      // The same life continues (a birth inside the 30 ms is a new life).
      if (after.age < 0.03) continue;
      checked++;
      expect(after.cycleId).toBe(before.cycleId);
      expect(after.groupId).toBe(before.groupId);
      expect(after.age - before.age).toBeCloseTo(0.03, 9);
      const a = particleState(
        P,
        emitterFrame(camera(), "ground"),
        W,
        S,
        PARTICLE_W - 0.01,
      );
      const b = particleState(P, emitterFrame(camera(), "ground"), W, S, 0.02);
      const moved = Math.hypot(
        b.head[0] - a.head[0],
        b.head[1] - a.head[1],
        b.head[2] - a.head[2],
      );
      expect(moved).toBeLessThan(40 * 0.03 + 1e-9);
    }
    expect(checked).toBeGreaterThan(200);
  });

  it("gives each life a fresh cycle id and randoms", () => {
    const P = clampParams(params());
    const S = emitterSeed(P, 5, 0);
    const T = timing(P, W, S, 100);
    const next = timing(P, W, S, 100 + T.period);
    expect(next.cycleId).toBe((T.cycleId + 1) % T.cycles);
    expect(next.age).toBeCloseTo(T.age, 6);
  });

  it("spreads births evenly without explosiveness", () => {
    const P = clampParams(params({ timing: [2, 2, 0, 0] }));
    const phases = Array.from(
      { length: 256 },
      (_, i) => timing(P, W, emitterSeed(P, i, 0), 0).phase,
    ).sort((a, b) => a - b);
    let gap = phases[0]! + 1 - phases[255]!;
    for (let k = 1; k < 256; k++)
      gap = Math.max(gap, phases[k]! - phases[k - 1]!);
    expect(gap).toBeLessThan(3 / 256);
  });

  it("fires each burst group at once with explosiveness 1", () => {
    const P = clampParams(
      withEmission(
        params(
          {
            timing: [1.8, 2.6, 2.8, 0.9],
            area: [140, 150, 230, 0],
            launch: [52, 68, 0, 0],
            cone: [180, 0, 6, 0.75],
          },
          { kind: KIND.circle, shape: Shape.spark, space: SPACE.world },
        ),
        { count: 2400, explosiveness: 1, groups: 4 },
      ),
    );
    const cam = camera({ pitch: 58, ppm: 2 });
    const F = emitterFrame(cam, "world", { ppm: 2 });
    for (const t of [3.3, 17.9, 2051.25]) {
      for (let g = 0; g < 4; g++) {
        const members = [g, g + 4, g + 40, g + 400, g + 2000].map((i) =>
          emitterSeed(P, i, 0),
        );
        const first = timing(P, W, members[0]!, t);
        for (const S of members) {
          const T = timing(P, W, S, t);
          expect(S.group).toBe(members[0]!.group);
          expect(T.cycle).toBe(first.cycle);
          expect(T.groupId).toBe(first.groupId);
          expect(T.age).toBeCloseTo(first.age, 9);
        }
        // Born together at the burst center.
        const birth = timeAtAge(P, W, members[0]!, t, 1e-7);
        const heads = members.map((S) => particleState(P, F, W, S, birth).head);
        for (const head of heads) {
          for (let c = 0; c < 3; c++)
            expect(head[c]).toBeCloseTo(heads[0]![c]!, 3);
        }
      }
    }
    // Groups are staggered.
    const groupPhases = [0, 1, 2, 3].map(
      (g) => timing(P, W, emitterSeed(P, g, 0), 0).groupPhase,
    );
    expect(new Set(groupPhases).size).toBe(4);
  });

  it("keeps one burst group cycle per life, whatever the explosiveness", () => {
    // The group's jitter, center and hue come from its cycle at this life's
    // birth, so they never change while the particle lives.
    for (const explosiveness of [0, 0.5, 0.9, 1]) {
      const P = clampParams(
        withEmission(params({ timing: [1, 1.5, 2.2, 1] }), {
          explosiveness,
          groups: 3,
        }),
      );
      for (let i = 0; i < 24; i++) {
        const S = emitterSeed(P, i, 0);
        let previous = timing(P, W, S, 0);
        for (let t = 0.01; t < 12; t += 0.01) {
          const T = timing(P, W, S, t);
          if (T.cycle === previous.cycle) {
            expect(T.groupId).toBe(previous.groupId);
            expect(T.jitter).toBe(previous.jitter);
          }
          previous = T;
        }
      }
    }
  });

  it("keeps burst jitter inside the idle gap, so lives never overlap", () => {
    for (const [lifetime, interval, jitter] of [
      [[1.8, 2.6], 2.8, 0.9],
      [[0.5, 1], 6, 1],
      [[3, 3], 1, 1],
    ] as const) {
      const P = clampParams(
        withEmission(
          params({ timing: [lifetime[0], lifetime[1], interval, jitter] }),
          {
            explosiveness: 1,
            groups: 3,
          },
        ),
      );
      for (let i = 0; i < 64; i++) {
        const S = emitterSeed(P, i, 0);
        for (let t = 0; t < 60; t += 0.77) {
          const T = timing(P, W, S, t);
          const lifeMax = Math.max(...lifetime);
          expect(T.jitter).toBeGreaterThanOrEqual(0);
          expect(T.jitter).toBeLessThanOrEqual(
            Math.max(T.period - lifeMax, 0) + 1e-9,
          );
          expect(T.jitter + T.lifetime).toBeLessThanOrEqual(T.period + 1e-9);
        }
      }
    }
  });
});

describe("motion", () => {
  it("switches to the drag series continuously", () => {
    for (const tau of [0.01, 0.5, 3, 40]) {
      const k = DRAG_SERIES_LIMIT / tau;
      const below = dragFactors(k * (1 - 1e-12), tau);
      const above = dragFactors(k * (1 + 1e-12), tau);
      expect(Math.abs(below[0] - above[0]) / above[0]).toBeLessThan(1e-9);
      expect(Math.abs(below[1] - above[1]) / above[1]).toBeLessThan(1e-9);
    }
  });

  it("matches the closed form under drag and is ballistic without", () => {
    for (const x of [1e-6, 1e-3, 0.02, 0.049]) {
      const tau = 2;
      const k = x / tau;
      const [f1, f2] = dragFactors(k, tau);
      // Closed forms via expm1, accurate at small x; the series truncates
      // at x^5 / 720, far below f32 precision.
      const exact1 = -Math.expm1(-x) / k;
      expect(Math.abs(f1 - exact1) / exact1).toBeLessThan(1e-9);
      expect(Math.abs(f2 - (tau - exact1) / k) / f2).toBeLessThan(1e-6);
    }
    expect(dragFactors(0, 3)).toEqual([3, 4.5]);
    const [f1, f2] = dragFactors(50, 600);
    expect(f1).toBeCloseTo(1 / 50, 12);
    expect(f2).toBeCloseTo((600 - 1 / 50) / 50, 9);
  });

  it("flies ballistically at zero drag and settles at gravity / drag", () => {
    const cam = camera();
    const F = emitterFrame(cam, "world");
    const P0 = clampParams(
      params(
        {
          launch: [30, 30, 45, 60],
          cone: [0, 0, 9.8, 0],
          air: [2, -1, 0, 0],
          timing: [5, 5, 0, 0],
          area: [0, 100, 100, 0],
        },
        { space: SPACE.world },
      ),
    );
    const S = emitterSeed(P0, 3, 0);
    const t = timeAtAge(P0, NO_WEATHER, S, 50, 1.5);
    const a = particleState(P0, F, NO_WEATHER, S, t);
    const v = 30;
    const [az, el] = [45 * DEG, 60 * DEG];
    const expected: Vec3 = [
      v * Math.sin(az) * Math.cos(el) * 1.5 + 2 * 1.5,
      v * Math.cos(az) * Math.cos(el) * 1.5 - 1 * 1.5,
      100 + v * Math.sin(el) * 1.5 - 0.5 * 9.8 * 1.5 * 1.5,
    ];
    for (let c = 0; c < 3; c++) expect(a.head[c]).toBeCloseTo(expected[c]!, 9);
    // Tiny drag is the ballistic limit.
    const P1 = { ...P0, cone: [0, 0, 9.8, 1e-7] as Vec4 };
    const b = particleState(P1, F, NO_WEATHER, S, t);
    for (let c = 0; c < 3; c++) expect(b.head[c]).toBeCloseTo(expected[c]!, 4);
    // Strong drag: the velocity settles at wind + gravity / drag.
    const P2 = {
      ...P0,
      cone: [0, 0, 9.8, 4] as Vec4,
      timing: [60, 60, 0, 0] as Vec4,
      area: [0, 1000, 1000, 0] as Vec4,
    };
    const t2 = timeAtAge(P2, NO_WEATHER, S, 70, 20);
    const h0 = particleState(P2, F, NO_WEATHER, S, t2).head;
    const h1 = particleState(P2, F, NO_WEATHER, S, t2 + 0.1).head;
    expect((h1[0] - h0[0]) / 0.1).toBeCloseTo(2, 6);
    expect((h1[1] - h0[1]) / 0.1).toBeCloseTo(-1, 6);
    expect((h1[2] - h0[2]) / 0.1).toBeCloseTo(-9.8 / 4, 6);
  });

  it("launches inside the spread cone, flattened by flatness", () => {
    const F = emitterFrame(camera(), "world");
    const P = clampParams(
      params(
        {
          launch: [10, 10, 30, 20],
          cone: [25, 0, 0, 0],
          timing: [5, 5, 0, 0],
          area: [0, 50, 50, 0],
        },
        { space: SPACE.world },
      ),
    );
    const axis: Vec3 = [
      Math.sin(30 * DEG) * Math.cos(20 * DEG),
      Math.cos(30 * DEG) * Math.cos(20 * DEG),
      Math.sin(20 * DEG),
    ];
    for (let i = 0; i < 64; i++) {
      const S = emitterSeed(P, i, 0);
      const t = timeAtAge(P, NO_WEATHER, S, 10, 0.1);
      const h = particleState(P, F, NO_WEATHER, S, t).head;
      const d: Vec3 = [h[0] / 1, h[1] / 1, (h[2] - 50) / 1];
      const cos =
        (d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2]) / Math.hypot(...d);
      expect(cos).toBeGreaterThanOrEqual(Math.cos(25 * DEG) - 1e-9);
    }
    const flat = { ...P, cone: [180, 1, 0, 0] as Vec4 };
    for (let i = 0; i < 16; i++) {
      const S = emitterSeed(flat, i, 0);
      const t = timeAtAge(flat, NO_WEATHER, S, 10, 1);
      expect(particleState(flat, F, NO_WEATHER, S, t).head[2]).toBeCloseTo(
        50,
        9,
      );
    }
  });

  it("wanders smoothly from zero at birth", () => {
    const F = emitterFrame(camera(), "ground");
    const P = clampParams(
      params({
        launch: [0, 0, 0, 0],
        air: [0, 0, 12, 0.7],
        timing: [8, 8, 0, 0],
        area: [0, 40, 40, 0],
      }),
    );
    const S = emitterSeed(P, 9, 0);
    const born = timeAtAge(P, NO_WEATHER, S, 20, 0);
    const start = particleState(P, F, NO_WEATHER, S, born).head;
    expect(start[0]).toBeCloseTo(0, 9);
    expect(start[1]).toBeCloseTo(0, 9);
    expect(start[2]).toBeCloseTo(40, 9);
    let maxStep = 0;
    let maxOffset = 0;
    for (let age = 0.01; age < 7.9; age += 0.01) {
      const a = particleState(P, F, NO_WEATHER, S, born + age).head;
      const b = particleState(P, F, NO_WEATHER, S, born + age - 0.01).head;
      maxStep = Math.max(
        maxStep,
        Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
      );
      maxOffset = Math.max(maxOffset, Math.hypot(a[0], a[1], a[2] - 40));
    }
    expect(maxOffset).toBeGreaterThan(2);
    expect(maxOffset).toBeLessThanOrEqual(2 * 12 + 1e-9);
    // Speed stays bounded by the octaves' 2 pi f m b sum.
    expect(maxStep / 0.01).toBeLessThan(
      (12 / 1.75) * 2 * Math.PI * 0.7 * (1 + 2.17 * 0.5 + 4.33 * 0.25) * 1.01,
    );
  });
});

describe("look and quads", () => {
  const cam = camera({ pitch: 40, ratio: 2 });
  const F = emitterFrame(cam, "ground");

  /** A visible particle of P, searched from index 0. */
  function visible(
    P: ParticleParams,
    frame: ParticleFrame,
    t: number,
  ): [ParticleSeed, ParticleState] {
    for (let i = 0; i < 512; i++) {
      const S = emitterSeed(P, i, 0);
      const state = particleState(P, frame, NO_WEATHER, S, t);
      if (state.visible) return [S, state];
    }
    throw new Error("no visible particle");
  }

  it("draws a sprite as a spun square around the head", () => {
    const P = clampParams(
      params({ sizeSpin: [0.5, 128, 90, 90] }, { shape: Shape.square }),
    );
    const [S, state] = visible(P, F, 21.5);
    const center = [
      state.headClip[0] / state.headClip[3],
      state.headClip[1] / state.headClip[3],
    ];
    const quad = corners(S).map((s) =>
      particleVertex(P, F, NO_WEATHER, s, 21.5),
    );
    const px = quad.map((v) => [
      (v.position[0] - center[0]!) / F.screen[0],
      (v.position[1] - center[1]!) / F.screen[1],
    ]);
    for (const [x, y] of px)
      expect(Math.hypot(x!, y!)).toBeCloseTo(
        (state.sizePx / 2) * Math.SQRT2,
        9,
      );
    expect(
      Math.hypot(px[0]![0]! - px[1]![0]!, px[0]![1]! - px[1]![1]!),
    ).toBeCloseTo(state.sizePx, 9);
    expect(quad.map((v) => v.uv.slice(0, 2))).toEqual([
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]);
    for (const v of quad) {
      expect(v.position[2]).toBe(-1);
      expect(v.position[3]).toBe(1);
      expect(v.uv[3]).toBeCloseTo(2 / (state.sizePx * 2), 12);
      expect(v.look).toEqual([Shape.square, 0, state.lookSeed, 0]);
    }
  });

  it("stretches spark and streak from the tail to the head", () => {
    const P = clampParams(
      params({ size: [2, 2, 1, 0.05] }, { shape: Shape.streak }),
    );
    const [S, state] = visible(P, F, 33.3);
    expect(state.stretched).toBe(true);
    const toPx = (c: Vec4): Vec2 => [
      c[0] / c[3] / F.screen[0],
      c[1] / c[3] / F.screen[1],
    ];
    const head = toPx(state.headClip);
    const tail = toPx(state.tailClip);
    const span = Math.hypot(head[0] - tail[0], head[1] - tail[1]);
    expect(span).toBeGreaterThan(0.5);
    const h = state.sizePx / 2;
    const quad = corners(S).map((s) =>
      particleVertex(P, F, NO_WEATHER, s, 33.3),
    );
    const px = quad.map((v) => toPx(v.position));
    const dir: Vec2 = [(head[0] - tail[0]) / span, (head[1] - tail[1]) / span];
    const along = px.map(
      ([x, y]) => (x - tail[0]) * dir[0] + (y - tail[1]) * dir[1],
    );
    const across = px.map(
      ([x, y]) => -(x - tail[0]) * dir[1] + (y - tail[1]) * dir[0],
    );
    expect(along[0]).toBeCloseTo(-h, 9);
    expect(along[1]).toBeCloseTo(span + h, 9);
    expect(across[0]).toBeCloseTo(-h, 9);
    expect(across[2]).toBeCloseTo(h, 9);
    expect(quad[1]!.uv).toEqual([
      expect.closeTo((span + h) / h, 9),
      -1,
      expect.closeTo(span / h, 9),
      expect.closeTo(2 / (state.sizePx * 2), 12),
    ]);
  });

  it("sizes by distance and clamps to the pixel limits", () => {
    const flat = emitterFrame(camera(), "ground");
    const P = clampParams(
      params({
        size: [8, 8, 1, 0],
        sizeSpin: [0, 1000, 0, 0],
        launch: [0, 0, 0, 0],
        area: [0, 0, 0, 0],
      }),
    );
    const [, state] = visible(P, flat, 5);
    // At the center, ground px are screen px.
    expect(state.rawPx).toBeCloseTo(8, 9);
    const clamped = { ...P, sizeSpin: [10, 12, 0, 0] as Vec4 };
    expect(visible(clamped, flat, 5)[1].sizePx).toBe(10);
    // Under the floor (physical px, here at pixel ratio 2): drawn at the
    // floor, with the missing area as alpha.
    const tiny = {
      ...P,
      size: [0.2, 0.2, 1, 0] as Vec4,
      sizeSpin: [0, 1000, 0, 0] as Vec4,
      fadeAdd: [0, 0, 0, 0] as Vec4,
    };
    const sized = (size: number, p = tiny) => ({
      ...p,
      size: [size, size, 1, p.size[3]] as Vec4,
    });
    const f = { ...flat, view: [flat.view[0], 2, 1, 1] as Vec4 };
    const [S] = visible(tiny, f, 5);
    const at = (p: ParticleParams) => particleState(p, f, NO_WEATHER, S, 5);
    expect(at(tiny).sizePx).toBeCloseTo(SPRITE_FLOOR / 2, 12);
    expect(at(tiny).color[3] / at(sized(1.5)).color[3]).toBeCloseTo(
      (0.2 / 1.5) ** 2,
      9,
    );
    expect(at(sized(1.5)).color[3] / at(sized(2)).color[3]).toBeCloseTo(
      (1.5 / 2) ** 2,
      9,
    );
    expect(at(sized(3)).sizePx).toBeCloseTo(3, 9);
    // A capsule's floor is its width, and its area grows with its length.
    const streak = {
      ...tiny,
      emission: [
        256,
        0,
        1,
        packIdentity(0, Shape.streak, SPACE.ground, KIND.point),
      ] as Vec4,
      launch: [40, 40, 0, 45] as Vec4,
      size: [0.2, 0.2, 1, 0.1] as Vec4,
    };
    const thin = at(streak);
    expect(thin.stretched).toBe(true);
    expect(thin.sizePx).toBeCloseTo(STRETCHED_FLOOR / 2, 12);
    const [hx, hy] = [0, 1].map(
      (k) => thin.headClip[k]! / thin.headClip[3] / f.screen[k]!,
    );
    const [tx, ty] = [0, 1].map(
      (k) => thin.tailClip[k]! / thin.tailClip[3] / f.screen[k]!,
    );
    const span = Math.hypot(hx! - tx!, hy! - ty!);
    expect(span).toBeGreaterThan(1);
    const area = (d: number) => d * (span + 0.2 * Math.PI * d);
    expect(thin.color[3] / at(sized(0.6, streak)).color[3]).toBeCloseTo(
      area(0.2) / area(0.6),
      6,
    );
  });

  it("paints color over life, rotates hue about gray and turns additive into alpha", () => {
    const P = clampParams(
      params({
        color: [1, 0.5, 0, 1],
        colorEnd: [0, 0, 0.5, 0.5],
        fadeAdd: [0, 0, 1, 0],
        launch: [0, 0, 0, 0],
        timing: [4, 4, 0, 0],
      }),
    );
    const S = emitterSeed(P, 1, 0);
    const t = timeAtAge(P, NO_WEATHER, S, 40, 1);
    const state = particleState(P, F, NO_WEATHER, S, t);
    // l = 0.25: premultiplied mix, additive 0.75 of the way to over.
    expect(state.color[0]).toBeCloseTo(0.75, 9);
    expect(state.color[1]).toBeCloseTo(0.375, 9);
    expect(state.color[2]).toBeCloseTo(0.125, 9);
    expect(state.color[3]).toBeCloseTo(0.875 * 0.25, 9);
    // Hue variation keeps gray gray and premultiplied rgb within alpha.
    const gray = clampParams({
      ...P,
      color: [0.4, 0.4, 0.4, 0.5],
      colorEnd: [0.4, 0.4, 0.4, 0.5],
      sparkle: [0, 0, 180, 180],
      fadeAdd: [0, 0, 0, 0],
    });
    const g = particleState(gray, F, NO_WEATHER, S, t).color;
    expect(g[0]).toBeCloseTo(0.4, 9);
    expect(g[1]).toBeCloseTo(0.4, 9);
    const vivid = {
      ...gray,
      color: [1, 0, 0, 1] as Vec4,
      colorEnd: [1, 0, 0, 1] as Vec4,
    };
    for (let i = 0; i < 32; i++) {
      const c = particleState(
        vivid,
        F,
        NO_WEATHER,
        emitterSeed(vivid, i, 0),
        t,
      ).color;
      if (c[3] === 0) continue;
      for (let k = 0; k < 3; k++) {
        expect(c[k]).toBeGreaterThanOrEqual(0);
        expect(c[k]).toBeLessThanOrEqual(c[3] + 1e-12);
      }
    }
  });

  it("fades particles out below the ground, but not in screen space", () => {
    const P = clampParams(
      params({
        launch: [0, 0, 0, 0],
        cone: [0, 0, 10, 0],
        timing: [10, 10, 0, 0],
        area: [0, 20, 20, 0],
        size: [4, 4, 1, 0],
        fadeAdd: [0, 0, 0, 0],
      }),
    );
    const S = emitterSeed(P, 2, 0);
    // Height 20 - 5 t^2 reaches 0 at t = 2 and -4 (one size) at t = 2.19.
    const at = (age: number, frame: ParticleFrame, p = P) =>
      particleState(
        p,
        frame,
        NO_WEATHER,
        S,
        timeAtAge(p, NO_WEATHER, S, 50, age),
      );
    const flat = emitterFrame(camera(), "ground");
    expect(at(1.9, flat).color[3]).toBeCloseTo(1, 9);
    expect(at(2.1, flat).color[3]).toBeGreaterThan(0);
    expect(at(2.1, flat).color[3]).toBeLessThan(1);
    expect(at(2.2, flat).visible).toBe(false);
    const screenP = clampParams({
      ...P,
      emission: [
        256,
        0,
        1,
        packIdentity(0, Shape.glow, SPACE.screen, KIND.point),
      ],
    });
    expect(at(2.5, emitterFrame(camera(), "screen"), screenP).visible).toBe(
      true,
    );
    // Particles that rest on the ground (flatness 1) stay visible.
    const resting = clampParams({
      ...P,
      cone: [180, 1, 0, 0],
      area: [0, 0, 0, 0],
    });
    expect(at(3, flat, resting).color[3]).toBeCloseTo(1, 9);
  });

  it("collapses dead particles and particles past the count", () => {
    const P = clampParams(withEmission(params(), { count: 40 }));
    for (const S of corners(emitterSeed(P, 100, 0))) {
      expect(particleVertex(P, F, NO_WEATHER, S, 12).position).toEqual([
        2, 2, 2, 1,
      ]);
    }
    const S = emitterSeed(P, 3, 0);
    const T = timing(P, NO_WEATHER, S, 12);
    // Between death and the next birth.
    const gap = timeAtAge(P, NO_WEATHER, S, 12, (T.lifetime + T.period) / 2);
    expect(particleState(P, F, NO_WEATHER, S, gap).visible).toBe(false);
  });

  it("lays ripples flat on the ground axes", () => {
    const P = clampParams(
      params(
        { launch: [0, 0, 0, 0], size: [10, 10, 1, 0] },
        { shape: Shape.ripple },
      ),
    );
    const [S, state] = visible(P, F, 8);
    expect(state.ripple).toBe(true);
    const quad = corners(S).map((s) => particleVertex(P, F, NO_WEATHER, s, 8));
    const half = (0.5 * state.sizeUnits * state.sizePx) / state.rawPx;
    quad.forEach((v, corner) => {
      const [sx, sy] = cornerSigns(corner);
      for (const c of [0, 1, 3]) {
        expect(v.position[c]).toBeCloseTo(
          state.headClip[c]! + sx * half * F.X[c]! + sy * half * F.Y[c]!,
          9,
        );
      }
      expect(v.position[2]).toBeCloseTo(-v.position[3], 12);
    });
    // Under pitch the far edge is deeper than the near one.
    expect(quad[3]!.position[3]).toBeGreaterThan(quad[0]!.position[3]);
  });

  it("covers the screen with the tint quad unless it is transparent", () => {
    const quad = [0, 1, 2, 3].map((c) =>
      particleTint([0.1, 0.1, 0.2, 0.3], 0.5, c),
    );
    expect(quad.map((v) => v.position)).toEqual([
      [-1, -1, -1, 1],
      [1, -1, -1, 1],
      [1, 1, -1, 1],
      [-1, 1, -1, 1],
    ]);
    expect(quad[0]!.look).toEqual([100, 0.5, 0, 0]);
    expect(particleTint([0, 0, 0, 0], 0.5, 0).position).toEqual([2, 2, 2, 1]);
    expect(particleTint([0.1, 0.1, 0.1, 0.3], 0.5, 2, 0).position).toEqual([
      1, 1, 0, 1,
    ]);
  });
});

describe("weather", () => {
  const P = clampParams(
    params(
      {
        timing: [6, 10, 0, 0],
        launch: [35, 80, 0, -90],
        cone: [25, 0, 0, 0],
        air: [20, 8, 16, 0.3],
        size: [2.5, 5, 1, 0],
        sizeSpin: [1.2, 14, -90, 90],
        fadeAdd: [0.25, 0.25, 0.1, 0.1],
        area: [0, 0, 0, 0.4],
      },
      { kind: KIND.weather, shape: Shape.flake },
    ),
  );
  const count = withEmission(P, { count: 3500 });

  /** The camera at `zoom` looking at `center` (absolute world px at that zoom). */
  function view(zoom: number, center: Vec2, pitch = 50) {
    const cam = camera({ pitch, ppm: (512 * 2 ** zoom) / 40075016.68 });
    return { F: weatherFrame(cam), W: weatherOf(cam, zoom, center), cam };
  }

  it("crossfades the octave pools without a pop at integer zoom", () => {
    const zoom = 14;
    const centerAt = (z: number): Vec2 => [
      1_300_000 * 2 ** (z - 10),
      3_100_000 * 2 ** (z - 10),
    ];
    const a = view(zoom - 1e-9, centerAt(zoom - 1e-9));
    const b = view(zoom + 1e-9, centerAt(zoom + 1e-9));
    let compared = 0;
    for (let i = 0; i < 4096; i++) {
      const S = emitterSeed(count, i, 0);
      const va = particleVertex(count, a.F, a.W, S, 77.7);
      const vb = particleVertex(count, b.F, b.W, S, 77.7);
      // Every particle either shows on both sides at the same place or is
      // invisible on both (the pool that re-anchors has weight 0).
      if (Math.max(va.color[3], vb.color[3]) < 1e-6) continue;
      if (va.position.some((v) => Math.abs(v) > 1.5)) continue;
      compared++;
      for (let c = 0; c < 4; c++) {
        expect(Math.abs(va.position[c]! - vb.position[c]!)).toBeLessThan(1e-6);
        expect(Math.abs(va.color[c]! - vb.color[c]!)).toBeLessThan(1e-6);
      }
    }
    expect(compared).toBeGreaterThan(100);
  });

  it("keeps particles fixed to the world when panning and zooming within a level", () => {
    const zoom = 15.3;
    const center: Vec2 = [2_000_000, 5_000_000];
    const base = view(zoom, center);
    // Motion is in screen px per second, so only still particles keep their
    // world position across zoom; panning keeps every particle.
    const still: ParticleParams = {
      ...count,
      launch: [0, 0, 0, -90],
      air: [0, 0, 0, 0],
    };
    /** Absolute position in world px at zoom 0 (y down), altitude up. */
    const worldOf = (
      v: { F: ParticleFrame; W: ParticleWeather },
      S: ParticleSeed,
      c: Vec2,
      z: number,
      P = count,
    ): Vec3 | null => {
      const state = particleState(P, v.F, v.W, S, 30);
      if (!state.visible) return null;
      return [
        (c[0] + v.W.eye[0] + state.head[0]) / 2 ** z,
        (c[1] + v.W.eye[1] - state.head[1]) / 2 ** z,
        (v.W.weights[2] + state.head[2]) / 2 ** z,
      ];
    };
    const panned = view(zoom, [center[0] + 37.5, center[1] - 12.25]);
    const zoomed = view(zoom + 0.2, [
      center[0] * 2 ** 0.2,
      center[1] * 2 ** 0.2,
    ]);
    let [fixed, wrapped] = [0, 0];
    for (let i = 0; i < 1024; i++) {
      const S = emitterSeed(count, i, 0);
      const before = worldOf(base, S, center, zoom);
      const after = worldOf(
        panned,
        S,
        [center[0] + 37.5, center[1] - 12.25],
        zoom,
      );
      if (!before || !after) continue;
      const moved = Math.hypot(
        after[0] - before[0],
        after[1] - before[1],
        after[2] - before[2],
      );
      // The only jump is a wrap across a window face (a whole box), where
      // the edge fade hides the particle.
      if (moved < 1e-9) fixed++;
      else wrapped++;
    }
    expect(fixed).toBeGreaterThan(300);
    expect(wrapped).toBeLessThan(0.1 * fixed);
    let [zoomFixed, zoomWrapped] = [0, 0];
    for (let i = 0; i < 1024; i++) {
      const S = emitterSeed(count, i, 0);
      const before = worldOf(base, S, center, zoom, still);
      const after = worldOf(
        zoomed,
        S,
        [center[0] * 2 ** 0.2, center[1] * 2 ** 0.2],
        zoom + 0.2,
        still,
      );
      if (!before || !after) continue;
      const moved = Math.hypot(
        after[0] - before[0],
        after[1] - before[1],
        after[2] - before[2],
      );
      if (moved < 1e-9) zoomFixed++;
      else zoomWrapped++;
    }
    expect(zoomFixed).toBeGreaterThan(300);
    expect(zoomWrapped).toBeLessThan(0.25 * zoomFixed);
  });

  it("fills a window ahead of the eye and fades at its faces and near the eye", () => {
    const { F, W } = view(14.5, [3e6, 2e6]);
    const forward: Vec3 = [F.X[3], F.Y[3], F.Z[3]];
    const norm = Math.hypot(...forward);
    let [ahead, onScreen] = [0, 0];
    for (let i = 0; i < 2048; i++) {
      const S = emitterSeed(count, i, 0);
      const state = particleState(count, F, W, S, 12);
      const pool = (i & 1) === 0 ? W.pool0 : W.pool1;
      const box = pool[3] * W.eye[3];
      const window = forward.map((v) => (v / norm) * 0.4 * box);
      state.head.forEach((c, k) =>
        expect(Math.abs(c - window[k]!)).toBeLessThanOrEqual(box / 2 + 1e-6),
      );
      if (!state.visible) continue;
      expect(Math.hypot(...state.head)).toBeGreaterThan(0.02 * box);
      ahead++;
      const [x, y, , w] = state.headClip;
      if (Math.abs(x / w) <= 1 && Math.abs(y / w) <= 1) onScreen++;
    }
    // The window puts about a tenth of the particles in view (an
    // eye-centered box managed a fortieth).
    expect(onScreen / 2048).toBeGreaterThan(0.08);
    expect(ahead).toBeGreaterThan(onScreen);
  });

  it("scales the effect with particle-scale but keeps the box on the world", () => {
    const zoom = 14.5;
    const cam = camera({ pitch: 50, ppm: (512 * 2 ** zoom) / 40075016.68 });
    const W = weatherOf(cam, zoom, [3e6, 2e6]);
    for (const scale of [0.5, 2]) {
      const F1 = weatherFrame(cam);
      const Fs = weatherFrame(cam, scale);
      const still = {
        ...count,
        launch: [0, 0, 0, -90] as Vec4,
        air: [0, 0, 0, 0] as Vec4,
      };
      for (let i = 0; i < 64; i++) {
        const S = emitterSeed(still, i, 0);
        const a = particleState(still, F1, W, S, 12);
        const b = particleState(still, Fs, W, S, 12);
        if (!a.visible || !b.visible) continue;
        for (let c = 0; c < 4; c++)
          expect(b.headClip[c]).toBeCloseTo(a.headClip[c]!, 6);
      }
    }
  });
});

describe("features", () => {
  it("keeps more slots as density grows", () => {
    for (const kind of [3, 4, 5]) {
      for (const ptu of [16, 11.3, 8.01]) {
        for (let key = 1; key < 400; key += 7) {
          const k = pcg3d(key, 1, 2)[0];
          let previous = 0;
          for (let density = 0; density <= 100; density += 0.25) {
            const keep = featureKeep(density, kind, key % 16, k, ptu);
            expect(keep).toBeGreaterThanOrEqual(previous);
            previous = keep;
          }
          expect(featureKeep(0, kind, 0, k, ptu)).toBe(0);
        }
      }
    }
    // Points keep `density` slots; the a_emit kind numbering works too.
    expect(
      [0, 1, 2, 3].map((rank) => featureKeep(2.5, 3, rank, 0, 16)),
    ).toEqual([1, 1, 0.5, 0]);
    expect(featureKeep(2.5, 0, 2, 0, 16)).toBe(0.5);
  });

  it("keeps density slots per 100 px of line and per 100 x 100 px of polygon", () => {
    const share = (kind: number, density: number, ptu: number): number => {
      let sum = 0;
      for (let key = 0; key < 4000; key++)
        sum += featureKeep(density, kind, 0, pcg3d(key, 3, 4)[0], ptu);
      return sum / 4000;
    };
    // At s = 1 line slots are 2 px apart (50 per 100 px), polygon cells 8 px.
    expect(share(4, 10, 16)).toBeCloseTo(10 / 50, 1);
    expect(share(5, 10, 16)).toBeCloseTo(10 / 156.25, 1);
    // At s = 1.5 the same density keeps a larger share of the slots.
    expect(share(4, 10, 16 / 1.5)).toBeCloseTo((10 * 1.5) / 50, 1);
  });

  it("decodes a_emit into the seed", () => {
    const ptu = 12;
    const point = featureSeed([100.25, 200.5, 0, 5 * 16 + 2 * 4 + 0], 3, ptu);
    expect(point).toMatchObject({ index: 5, corner: 2, kind: 3, keep: 0 });
    expect(point.key).toBe(pcg3d(401, 802, 5 * 4)[0]);
    const sibling = featureSeed([100.25, 200.5, 0, 7 * 16], 3, ptu);
    expect(sibling.group).toBe(point.group);
    const line = featureSeed(
      [10, 20, 256 * 8192 + 300, 9 * 16 + 3 * 4 + 1],
      50,
      ptu,
    );
    expect(line).toMatchObject({
      index: 9,
      corner: 3,
      kind: 4,
      group: line.key,
    });
    expect(line.extent[0]).toBeCloseTo(300 / ptu, 12);
    expect(line.extent[1]).toBeCloseTo(Math.PI / 2, 12);
    const polygon = featureSeed([64, 64, 0, 2], 5, ptu);
    expect(polygon.kind).toBe(5);
    expect(polygon.extent[0]).toBeCloseTo(64 / ptu, 12);
  });

  it("keeps line particles on their segment", () => {
    const cam = camera({ pitch: 30 });
    const ptu = 16;
    const P = clampParams(
      params(
        {
          launch: [18, 26, 0, 0],
          cone: [0, 1, 0, 0],
          timing: [2, 4, 0, 0],
          size: [1.5, 2.5, 1, 0.35],
          fadeAdd: [0, 0, 0, 0],
        },
        { kind: KIND.features, shape: Shape.streak },
      ),
    );
    // A 60 px segment heading east (azimuth 90°) with its midpoint at (4000, 4000).
    const emit: Vec4 = [4000, 4000, 256 * 8192 + 480, 1];
    let seen = 0;
    for (let slot = 0; slot < 30; slot++) {
      const S = featureSeed(
        [emit[0], emit[1], emit[2], slot * 16 + 1],
        50,
        ptu,
      );
      const F = featureFrame(cam, [-4000 / ptu, -4000 / ptu], ptu, [
        emit[0],
        emit[1],
      ]);
      for (let t = 0; t < 12; t += 0.37) {
        const state = particleState(P, F, NO_WEATHER, S, t);
        if (!state.visible) continue;
        seen++;
        // Along the line (east) within the half length; flow is eastward.
        expect(Math.abs(state.head[0])).toBeLessThanOrEqual(30 + 1e-9);
        expect(Math.abs(state.head[1])).toBeLessThan(1e-9);
      }
    }
    expect(seen).toBeGreaterThan(50);
  });
});

// --- The fixture -----------------------------------------------------------

interface ModelCase {
  name: string;
  params: ParticleParams;
  frame: ParticleFrame;
  weather: ParticleWeather;
  seed: Omit<ParticleSeed, "corner">;
  time: number;
}

interface ModelExpected {
  visible: boolean;
  headClip: Vec4;
  tailClip: Vec4;
  sizePx: number;
  color: Vec4;
  vertices: ParticleVertex[];
}

interface ModelFixture {
  $comment: string;
  zNear: number;
  cases: (ModelCase & { expected: ModelExpected })[];
  tint: {
    tint: Vec4;
    vignette: number;
    corner: number;
    expected: ParticleVertex;
  }[];
  featureKeep: {
    density: number;
    kind: number;
    rank: number;
    key: number;
    ptu: number;
    expected: number;
  }[];
  emitterSeeds: {
    emission: Vec4;
    index: number;
    corner: number;
    expected: ParticleSeed;
  }[];
  featureSeeds: {
    emit: Vec4;
    density: number;
    ptu: number;
    expected: ParticleSeed;
  }[];
}

function evaluate(c: ModelCase): ModelExpected {
  const S: ParticleSeed = { ...c.seed, corner: 0 };
  const state = particleState(c.params, c.frame, c.weather, S, c.time);
  return {
    visible: state.visible,
    headClip: state.headClip,
    tailClip: state.tailClip,
    sizePx: state.sizePx,
    color: state.color,
    vertices: corners(S).map((s) =>
      particleVertex(c.params, c.frame, c.weather, s, c.time),
    ),
  };
}

/**
 * Whether a case is safe to compare with f32 shader math: visibility holds
 * and nothing jumps within a millisecond (the shader clock's rounding at large
 * times), and the outputs are smooth right at the case's time (a vanishing
 * second difference), so no branch or wrap sits at the evaluation point.
 */
function robust(c: ModelCase): boolean {
  const at = (dt: number): ModelExpected =>
    evaluate({ ...c, time: c.time + dt });
  const outputs = (e: ModelExpected): number[] =>
    e.vertices.flatMap((v) => [...v.position, ...v.uv, ...v.color]);
  const base = at(0);
  const values = outputs(base);
  const scale = values.map((v) => Math.max(1, Math.abs(v)));
  for (const dt of [-1e-3, 1e-3]) {
    const other = at(dt);
    if (other.visible !== base.visible) return false;
    const jumped = outputs(other).some(
      (v, k) => Math.abs(v - values[k]!) > 0.05 * scale[k]!,
    );
    if (jumped) return false;
  }
  // A vanishing second difference: no branch or wrap at the case's time.
  const [before, after] = [outputs(at(-1e-5)), outputs(at(1e-5))];
  return values.every(
    (v, k) => Math.abs(before[k]! - 2 * v + after[k]!) <= 1e-5 * scale[k]!,
  );
}

/** A case that must be visible and robust as given. */
function exact(c: ModelCase): ModelCase {
  if (!evaluate(c).visible || !robust(c))
    throw new Error(`case ${c.name} is not robust`);
  return c;
}

const seedOf = (S: ParticleSeed): Omit<ParticleSeed, "corner"> => {
  const { corner: _, ...rest } = S;
  return rest;
};

/** The first robust particle of an emitter case whose visibility is `visible`. */
function pick(
  name: string,
  P: ParticleParams,
  frame: ParticleFrame,
  weather: ParticleWeather,
  time: number,
  options: {
    from?: number;
    visible?: boolean;
    seed?: (i: number) => Omit<ParticleSeed, "corner">;
  } = {},
): ModelCase {
  const { from = 0, visible = true } = options;
  const seedAt = options.seed ?? ((i: number) => seedOf(emitterSeed(P, i, 0)));
  for (let i = from; i < from + 4096; i++) {
    const c: ModelCase = {
      name,
      params: P,
      frame,
      weather,
      seed: seedAt(i),
      time,
    };
    if (evaluate(c).visible === visible && robust(c)) return c;
  }
  throw new Error(`no robust particle for ${name}`);
}

function buildCases(): ModelCase[] {
  const cases: ModelCase[] = [];
  const W0 = NO_WEATHER;

  // Emitter point, ground space, spec defaults.
  const pitched = camera({ pitch: 45, bearing: 20 });
  cases.push(
    pick(
      "point ground, defaults",
      params(),
      emitterFrame(pitched, "ground", { anchor: [35, -20] }),
      W0,
      12.5,
    ),
  );

  // Fire: circle in world space, drag past the series, wander, color-end,
  // hue variation, twinkle and additive over life.
  const fire = params(
    {
      color: [1, 0.824, 0.478, 1],
      colorEnd: [0.9, 0.21, 0.11, 0.9],
      size: [4, 8, 0.3, 0],
      sizeSpin: [2, 200, 0, 0],
      fadeAdd: [0.06, 0.45, 1, 0.4],
      sparkle: [0.3, 8, 10, 0],
      timing: [0.7, 1.3, 0, 0],
      launch: [2, 5, 0, 90],
      cone: [20, 0, -6, 1.2],
      air: [1, 0.3, 1.2, 1.6],
      area: [5, 0, 1, 0],
    },
    { kind: KIND.circle, space: SPACE.world, shape: Shape.glow },
  );
  const close60 = camera({ pitch: 60, ppm: 6.2, ratio: 2 });
  cases.push(
    pick(
      "fire: circle world, drag, wander, color-end",
      withEmission(fire, { count: 600 }),
      emitterFrame(close60, "world", { ppm: 6.2 }),
      W0,
      37.3,
    ),
  );

  // The drag series boundary: k tau just below and above the limit.
  const series = params(
    {
      timing: [2, 2, 0, 0],
      launch: [30, 30, 10, 60],
      cone: [10, 0, 9.8, 0],
      air: [0, 0, 0, 0],
      area: [0, 40, 40, 0],
      size: [5, 5, 1, 0],
      fadeAdd: [0, 0, 0, 0],
    },
    { space: SPACE.world },
  );
  const seriesSeed = emitterSeed(series, 7, 0);
  for (const [label, factor] of [
    ["below", 0.999],
    ["above", 1.001],
  ] as const) {
    const age = 1.25;
    const P = {
      ...series,
      cone: [10, 0, 9.8, (DRAG_SERIES_LIMIT / age) * factor] as Vec4,
    };
    const t = timeAtAge(P, W0, seriesSeed, 300, age);
    cases.push(
      exact({
        name: `drag series ${label} k tau = ${DRAG_SERIES_LIMIT}`,
        params: P,
        frame: emitterFrame(pitched, "world"),
        weather: W0,
        seed: seedOf(seriesSeed),
        time: t,
      }),
    );
  }

  // Across the clock wrap: one life seen just before and just after it.
  const wrap = params({
    timing: [2.5, 3.5, 0, 0],
    launch: [30, 50, 45, 70],
    cone: [30, 0, 5, 0.2],
  });
  cases.push(
    ...(() => {
      for (let i = 0; i < 256; i++) {
        const S = emitterSeed(wrap, i, 0);
        const before: ModelCase = {
          name: "clock wrap, before",
          params: wrap,
          frame: emitterFrame(pitched, "ground"),
          weather: W0,
          seed: seedOf(S),
          time: PARTICLE_W - 0.05,
        };
        const after: ModelCase = {
          ...before,
          name: "clock wrap, after",
          time: 0.05,
        };
        const sameLife =
          timing(clampParams(wrap), W0, S, before.time).cycleId ===
          timing(clampParams(wrap), W0, S, after.time).cycleId;
        if (
          sameLife &&
          [before, after].every((c) => evaluate(c).visible && robust(c))
        )
          return [before, after];
      }
      throw new Error("no particle lives across the clock wrap");
    })(),
  );

  // Fireworks: E = 1 burst groups, spark (stretched), jitter; two members of
  // one group.
  const fireworks = withEmission(
    params(
      {
        color: [1, 0.302, 0.427, 1],
        colorEnd: [1, 0.87, 0.71, 0.8],
        size: [1.2, 1.8, 1, 0.045],
        sizeSpin: [1.6, 7, 0, 0],
        fadeAdd: [0, 0.4, 1, 1],
        sparkle: [0.55, 11, 12, 180],
        timing: [1.8, 2.6, 2.8, 0.9],
        launch: [52, 68, 0, 0],
        cone: [180, 0, 6, 0.75],
        area: [140, 150, 230, 0],
      },
      { kind: KIND.circle, space: SPACE.world, shape: Shape.spark, seed: 17 },
    ),
    { count: 2400, explosiveness: 1, groups: 4 },
  );
  const fw = camera({ pitch: 58, ppm: 0.7 });
  const fwFrame = emitterFrame(fw, "world", { anchor: [0, -150], ppm: 0.7 });
  const burst = pick(
    "fireworks: burst group member",
    fireworks,
    fwFrame,
    W0,
    1000.6,
  );
  cases.push(burst);
  cases.push(
    pick(
      "fireworks: same group, another member",
      fireworks,
      fwFrame,
      W0,
      1000.6,
      {
        seed: (i) =>
          seedOf(emitterSeed(fireworks, burst.seed.index + 4 * (i + 1), 0)),
      },
    ),
  );

  // Screen space: a spinning star on a disc standing in the screen plane.
  const screen = params(
    {
      size: [10, 16, 1.5, 0],
      sizeSpin: [1, 64, -180, 180],
      launch: [30, 60, 90, 10],
      cone: [40, 0, 0, 0],
      area: [30, 0, 20, 0],
    },
    { kind: KIND.circle, space: SPACE.screen, shape: Shape.star },
  );
  cases.push(
    pick(
      "screen space star",
      screen,
      emitterFrame(pitched, "screen", { anchor: [-100, 60], scale: 1.5 }),
      W0,
      64.25,
    ),
  );

  // Smoke: large growth, spin, over-to-over color.
  const smoke = params(
    {
      color: [0.159, 0.159, 0.169, 0.45],
      colorEnd: [0.4, 0.4, 0.41, 0.4],
      size: [6, 10, 4, 0],
      sizeSpin: [2, 480, -25, 25],
      fadeAdd: [0.12, 0.55, 0, 0],
      timing: [5, 8, 0, 0],
      launch: [1.5, 3, 0, 90],
      cone: [12, 0, -0.8, 0.4],
      air: [3, 1, 2.5, 0.25],
      area: [4, 6, 8, 0],
    },
    { kind: KIND.circle, space: SPACE.world, shape: Shape.smoke },
  );
  cases.push(
    pick(
      "smoke: growth and spin",
      smoke,
      emitterFrame(camera({ pitch: 60, ppm: 3.1 }), "world", { ppm: 3.1 }),
      W0,
      211.1,
    ),
  );

  // Sub-pixel: small world particles far from the camera.
  const tinyCam = camera({ pitch: 55, ppm: 0.05, ratio: 2 });
  const tiny = params(
    {
      size: [0.25, 0.4, 1, 0],
      sizeSpin: [0, 4, 0, 0],
      launch: [8, 14, 0, 80],
      cone: [30, 0, 9.8, 0.35],
      timing: [0.8, 1.6, 0, 0],
      area: [0, 1, 2, 0],
    },
    { space: SPACE.world, shape: Shape.circle },
  );
  cases.push(
    pick(
      "sub-pixel world particle",
      tiny,
      emitterFrame(tinyCam, "world", { anchor: [0, -500], ppm: 0.05 }),
      W0,
      99.9,
    ),
  );

  // Weather: snow on both sides of an integer zoom, rain with thinning.
  const snow = withEmission(
    params(
      {
        timing: [6, 10, 0, 0],
        launch: [35, 80, 0, -90],
        cone: [25, 0, 0, 0],
        air: [20, 8, 16, 0.3],
        size: [2.5, 5, 1, 0],
        sizeSpin: [1.2, 14, -90, 90],
        fadeAdd: [0.25, 0.25, 0.1, 0.1],
        color: [0.92, 0.92, 0.92, 0.92],
        area: [0, 0, 0, 0.4],
      },
      { kind: KIND.weather, shape: Shape.flake },
    ),
    { count: 3500 },
  );
  const snowCase = (label: string, zoom: number, first: number) => {
    const cam = camera({ pitch: 50, ppm: (512 * 2 ** zoom) / 40075016.68 });
    const center: Vec2 = [
      2_096_000 * 2 ** (zoom - 12),
      1_266_000 * 2 ** (zoom - 12),
    ];
    // Pool index parity is the pool; step by 2 to stay in it.
    return pick(
      label,
      snow,
      weatherFrame(cam),
      weatherOf(cam, zoom, center),
      520.5,
      {
        seed: (i) => seedOf(emitterSeed(snow, first + 2 * i, 0)),
      },
    );
  };
  const below = snowCase("snow just below zoom 14", 14 - 1e-4, 0);
  cases.push(below);
  cases.push(snowCase("snow just above zoom 14", 14 + 1e-4, below.seed.index));
  cases.push(snowCase("snow, the other pool", 14.62, 1));

  const rain = withEmission(
    params(
      {
        timing: [0.5, 0.8, 0, 0],
        launch: [950, 1150, 20, -82],
        cone: [2, 0, 0, 0],
        air: [40, 0, 0, 0.5],
        size: [1.1, 1.6, 1, 0.035],
        sizeSpin: [0.6, 3, 0, 0],
        fadeAdd: [0.15, 0.15, 0.2, 0.2],
        color: [0.4, 0.42, 0.45, 0.5],
        area: [0, 0, 0, 0.7],
      },
      { kind: KIND.weather, shape: Shape.streak },
    ),
    { count: 6000 },
  );
  const rainCam = camera({
    pitch: 60,
    ppm: (512 * 2 ** 15.5) / 40075016.68,
    ratio: 2,
  });
  cases.push(
    pick(
      "rain streaks with center thinning",
      rain,
      weatherFrame(rainCam, 1.25),
      weatherOf(rainCam, 15.5, [5_242_000, 12_663_000]),
      7.77,
    ),
  );

  // Features: point sparkles, line flow, polygon ripples.
  const tileCam = camera({ pitch: 40, bearing: -15 });
  const ptu = 16 / 2 ** 0.5;
  const origin: Vec2 = [-3000 / ptu, -5000 / ptu];
  const sparkle = params(
    {
      color: [1, 0.83, 0.42, 1],
      colorEnd: [1, 0.83, 0.42, 1],
      size: [2.5, 4.5, 1, 0],
      fadeAdd: [0.1, 0.5, 1, 1],
      sparkle: [0.8, 7, 0, 0],
      timing: [0.8, 1.6, 0, 0],
      launch: [10, 26, 0, 90],
      cone: [60, 0, 18, 0],
      air: [0, 0, 1.5, 1.2],
    },
    { kind: KIND.features, shape: Shape.spark },
  );
  const anchor: Vec2 = [3000.25, 5000.75];
  cases.push(
    pick(
      "feature point sparkle",
      sparkle,
      featureFrame(tileCam, origin, ptu, anchor),
      W0,
      45.6,
      {
        seed: (i) =>
          seedOf(
            featureSeed([anchor[0], anchor[1], 0, (i % 16) * 16], 10, ptu),
          ),
      },
    ),
  );
  const flow = params(
    {
      color: [0.63, 0.78, 0.85, 0.85],
      colorEnd: [0.63, 0.78, 0.85, 0.85],
      size: [1.5, 2.5, 1, 0.35],
      fadeAdd: [0.2, 0.3, 0.5, 0.5],
      timing: [2, 4, 0, 0],
      launch: [18, 26, 0, 0],
      cone: [3, 1, 0, 0],
      air: [0, 0, 1, 0.5],
    },
    { kind: KIND.features, shape: Shape.streak },
  );
  const lineAnchor: Vec2 = [4100.5, 2050.25];
  cases.push(
    pick(
      "feature line flow",
      flow,
      featureFrame(tileCam, origin, ptu, lineAnchor),
      W0,
      3.21,
      {
        seed: (i) =>
          seedOf(
            featureSeed(
              [lineAnchor[0], lineAnchor[1], 301 * 8192 + 700, i * 16 + 1],
              12,
              ptu,
            ),
          ),
      },
    ),
  );
  const ripples = params(
    {
      color: [0.66, 0.69, 0.7, 0.7],
      colorEnd: [0.66, 0.69, 0.7, 0.7],
      size: [2, 5, 1, 0],
      fadeAdd: [0.2, 0.4, 0.2, 0.2],
      timing: [1.5, 3, 0, 0],
      launch: [0, 2, 0, 0],
      cone: [180, 1, 0, 0],
      air: [0, 0, 3, 0.6],
    },
    { kind: KIND.features, shape: Shape.ripple },
  );
  cases.push(
    pick(
      "feature polygon ripple",
      ripples,
      featureFrame(tileCam, origin, ptu, [1000, 7000]),
      W0,
      88.8,
      {
        seed: (i) =>
          seedOf(featureSeed([64 + 128 * (i % 20), 7000 - 64, 0, 2], 3, ptu)),
      },
    ),
  );

  // Collapsed: a dead particle.
  cases.push(
    pick("dead particle", params(), emitterFrame(pitched, "ground"), W0, 12.5, {
      visible: false,
    }),
  );
  return cases;
}

/** Rounds every number to f32, the values the shader receives. */
function f32<T>(value: T): T {
  if (typeof value === "number") return Math.fround(value) as T;
  if (Array.isArray(value)) return value.map(f32) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, f32(v)]),
    ) as T;
  }
  return value;
}

function buildFixture(): ModelFixture {
  // Inputs are rounded to f32 (hash words are exact), so the shader and the
  // model see the same numbers; rounding moves no case off its robust margin.
  const cases = buildCases().map((built) => {
    const c: ModelCase = {
      ...f32(built),
      seed: {
        ...f32(built.seed),
        key: built.seed.key,
        group: built.seed.group,
      },
    };
    const expected = evaluate(c);
    const dead = built.name.startsWith("dead");
    if (expected.visible === dead || !robust(c)) {
      throw new Error(`case ${c.name} is not robust in f32`);
    }
    return { ...c, expected };
  });
  const tint: ModelFixture["tint"] = [];
  for (const [color, vignette] of f32([
    [[0.1, 0.12, 0.2, 0.28], 0.5],
    [[0, 0.02, 0.08, 0.35], 1.4],
    [[0, 0, 0, 0], 0],
  ] as const)) {
    for (let corner = 0; corner < 4; corner++) {
      tint.push({
        tint: color,
        vignette,
        corner,
        expected: particleTint(color, vignette, corner),
      });
    }
  }
  const featureKeepCases: ModelFixture["featureKeep"] = [];
  for (const [density, kind, rank, ptu] of f32([
    [3.5, 3, 2, 16],
    [3.5, 3, 3, 16],
    [12, 4, 0, 16],
    [12, 4, 0, 9.5],
    [40, 5, 0, 12],
    [150, 5, 0, 8.2],
    [-1, 4, 0, 16],
    [8, 1, 0, 16],
  ] as const)) {
    for (const k of [11, 99, 1234]) {
      const key = pcg3d(k, 5, 6)[0];
      featureKeepCases.push({
        density,
        kind,
        rank,
        key,
        ptu,
        expected: featureKeep(density, kind, rank, key, ptu),
      });
    }
  }
  const emitterSeeds: ModelFixture["emitterSeeds"] = [];
  for (const [kind, groups, seed] of [
    [KIND.point, 1, 0],
    [KIND.circle, 4, 17],
    [KIND.weather, 1, 65535],
    [KIND.circle, 16.7, 42.9],
  ] as const) {
    const emission: Vec4 = f32([
      256,
      1,
      groups,
      packIdentity(seed, Shape.spark, SPACE.world, kind),
    ]);
    for (const [index, corner] of [
      [0, 0],
      [5, 1],
      [4095, 3],
      [16383, 2],
    ] as const) {
      emitterSeeds.push({
        emission,
        index,
        corner,
        expected: emitterSeed(params({ emission }), index, corner),
      });
    }
  }
  const featureSeeds: ModelFixture["featureSeeds"] = [];
  for (const [emit, density, ptu] of f32([
    [[100.25, 200.5, 0, 5 * 16 + 2 * 4], 3, 12],
    [[8191.75, 0, 0, 15 * 16 + 3 * 4], 20, 16],
    [[10, 20, 256 * 8192 + 300, 9 * 16 + 3 * 4 + 1], 50, 12],
    [[4000, 4000, 1023 * 8192 + 5793, 1022 * 16 + 1], 7, 8.5],
    [[64.5, 7936.25, 0, 2 * 4 + 2], 4, 11],
    [[5, 5, 0, 3], 4, 11],
  ] as const)) {
    featureSeeds.push({
      emit,
      density,
      ptu,
      expected: featureSeed(emit, density, ptu),
    });
  }
  return {
    $comment:
      "Inputs and outputs of js/src/model.ts, the TypeScript port of shaders/particle.glsl; js/src/model.test.ts also runs the shader, compiled for the CPU, on these inputs, and a GPU run of the shader can compare against them. Inputs are f32-exact, so every side sees the same numbers; positions use zNear (PARTICLE_Z_NEAR of WebGL). cases: particleVertex for all four corners of one particle (seed without corner), with its clip head and tail, drawn size in px, color and whether it shows; tint: particleTint; featureKeep, emitterSeeds (spec-default params with this emission lane) and featureSeeds: the identity helpers. Regenerate with UPDATE_FIXTURES=1 pnpm test in js/.",
    zNear: -1,
    cases,
    tint,
    featureKeep: featureKeepCases,
    emitterSeeds,
    featureSeeds,
  };
}

/** Recursive numeric comparison with a relative tolerance. */
function expectNear(
  actual: unknown,
  expected: unknown,
  path = "",
  tolerance = 1e-9,
): void {
  if (typeof expected === "number") {
    expect(typeof actual, path).toBe("number");
    const ok = close(actual as number, expected, tolerance);
    expect(ok, `${path}: ${String(actual)} vs ${expected}`).toBe(true);
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true);
    expect((actual as unknown[]).length, path).toBe(expected.length);
    expected.forEach((e, k) =>
      expectNear((actual as unknown[])[k], e, `${path}[${k}]`, tolerance),
    );
    return;
  }
  if (expected && typeof expected === "object") {
    for (const [key, e] of Object.entries(expected)) {
      const value = (actual as Record<string, unknown>)[key];
      expectNear(value, e, `${path}.${key}`, tolerance);
    }
    return;
  }
  expect(actual, path).toEqual(expected);
}

describe("fixtures/model.json", () => {
  const fixture = buildFixture();
  if (process.env.UPDATE_FIXTURES) {
    writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
  }
  const stored = JSON.parse(readFileSync(FIXTURE, "utf8")) as ModelFixture;

  it("covers every kind and the design's boundary cases", () => {
    const names = stored.cases.map((c) => c.name);
    for (const needle of [
      "drag series below",
      "drag series above",
      "clock wrap",
      "fireworks",
      "zoom 14",
      "feature line",
      "feature point",
      "feature polygon",
      "screen space",
      "dead",
    ]) {
      expect(
        names.some((n) => n.includes(needle)),
        needle,
      ).toBe(true);
    }
    for (const c of stored.cases)
      expect(c.expected.visible, c.name).toBe(!c.name.startsWith("dead"));
  });

  it("holds the model's outputs for its inputs", () => {
    for (const c of stored.cases) expectNear(evaluate(c), c.expected, c.name);
    for (const c of stored.tint)
      expectNear(
        particleTint(c.tint, c.vignette, c.corner),
        c.expected,
        "tint",
      );
    for (const c of stored.featureKeep)
      expectNear(
        featureKeep(c.density, c.kind, c.rank, c.key, c.ptu),
        c.expected,
        "featureKeep",
      );
    for (const c of stored.emitterSeeds)
      expectNear(
        emitterSeed(params({ emission: c.emission }), c.index, c.corner),
        c.expected,
        "emitterSeed",
      );
    for (const c of stored.featureSeeds)
      expectNear(
        featureSeed(c.emit, c.density, c.ptu),
        c.expected,
        "featureSeed",
      );
  });

  it("is what this file generates", () => {
    expectNear(stored, fixture);
  });

  it("stores seeds as exact uint32 hash words", () => {
    for (const c of stored.cases) {
      for (const word of [c.seed.key, c.seed.group]) {
        expect(Number.isInteger(word) && word >= 0 && word < 2 ** 32).toBe(
          true,
        );
      }
    }
  });
});

// --- The shaders on the CPU ------------------------------------------------
//
// A compiler from the dialect the shared GLSL is written in (the rules at the
// top of shaders/particle.glsl) to JavaScript, so these tests run the shaders
// themselves: particleVertex and its helpers on every input of
// fixtures/model.json and fixtures/hash.json, and particleFragment on the
// pixels a quad covers. It takes bool, int, uint and float scalars and
// vectors (vec and uvec spellings too), structs filled member by member,
// if/else, for loops, #define and the built-ins below; it checks types as
// strictly as the dialect (no implicit conversions) and throws on anything
// else. Floats are f64, or f32 with every result rounded; uints wrap.

/** A GLSL value: a scalar, a vector (array) or a struct (object). */
type Glsl = number | boolean | readonly number[] | { [field: string]: Glsl };

const GLSL_TYPE = /^(float|uint|int|bool)([234])?$/;
const GLSL_ALIASES: Record<string, string> = {
  vec: "float",
  uvec: "uint",
  ivec: "int",
  bvec: "bool",
};
const SWIZZLE = "xyzw rgba stpq";
const scalarOf = (t: string): string => t.replace(/[234]$/, "");
const sizeOf = (t: string): number => Number(/[234]$/.exec(t)?.[0] ?? 1);
const vectorOf = (base: string, n: number): string =>
  n === 1 ? base : `${base}${n}`;

function glslTokens(source: string): string[] {
  const pattern =
    /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|(0[xX][0-9a-fA-F]+[uU]?|(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?[uU]?|\w+|<<=|>>=|[-+*/%&|^!=<>]=|&&|\|\||<<|>>|\+\+|--|[-+*/%&|^!~<>=?:;,.(){}[\]])/y;
  const tokens: string[] = [];
  while (pattern.lastIndex < source.length) {
    const at = pattern.lastIndex;
    const match = pattern.exec(source);
    if (!match)
      throw new Error(`GLSL: bad text at ${source.slice(at, at + 20)}`);
    if (match[1]) tokens.push(match[1]);
  }
  return tokens;
}

/** Tokens with #define macros (object- and function-like) expanded. */
function glslPreprocess(source: string): string[] {
  const macros = new Map<string, { params?: string[]; body: string[] }>();
  const text = source.split("\n").map((line) => {
    const directive = /^\s*#\s*define\s+(\w+)(\(([^)]*)\))?(.*)$/.exec(line);
    if (!directive) {
      if (/^\s*#/.test(line)) throw new Error(`GLSL: unsupported ${line}`);
      return line;
    }
    macros.set(directive[1]!, {
      params: directive[3]?.split(",").map((p) => p.trim()),
      body: glslTokens(directive[4]!),
    });
    return "";
  });
  const expand = (tokens: string[]): string[] => {
    const out: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const macro = macros.get(tokens[i]!);
      if (!macro) out.push(tokens[i]!);
      else if (!macro.params) out.push(...expand(macro.body));
      else {
        const args: string[][] = [[]];
        let depth = 0;
        for (i += 2; depth > 0 || tokens[i] !== ")"; i++) {
          const token = tokens[i]!;
          if (depth === 0 && token === ",") args.push([]);
          else args.at(-1)!.push(token);
          depth += token === "(" ? 1 : token === ")" ? -1 : 0;
        }
        const params = macro.params;
        out.push(
          ...expand(
            macro.body.flatMap((t) =>
              params.includes(t) ? args[params.indexOf(t)]! : [t],
            ),
          ),
        );
      }
    }
    return out;
  };
  return expand(glslTokens(text.join("\n")));
}

/** A compiled expression: its JavaScript, its type and, if assignable, where it is stored. */
interface GlslExpression {
  js: string;
  type: string;
  store?: { js: string; components?: number[] };
}

/**
 * Compiles GLSL sources into their functions. `fwidth`, when given, computes
 * fwidth(x) for the fragment stage.
 */
function compileGlsl(
  sources: readonly string[],
  options: { f32?: boolean; fwidth?: (x: Glsl) => Glsl } = {},
): Record<string, (...args: unknown[]) => unknown> {
  const tokens = glslPreprocess(sources.join("\n"));
  let pos = 0;
  const peek = (ahead = 0): string => tokens[pos + ahead] ?? "";
  const fail = (message: string): never => {
    const near = tokens.slice(Math.max(0, pos - 8), pos + 3).join(" ");
    throw new Error(`GLSL (CPU compiler): ${message} near \`${near}\``);
  };
  const next = (): string => tokens[pos++] ?? fail("unexpected end");
  const expect = (token: string): void => {
    if (next() !== token) fail(`expected ${token}`);
  };
  const same = (a: string, b: string, what: string): void => {
    if (a !== b) fail(`${what}: ${a} vs ${b}`);
  };

  const structs = new Map<string, [string, string][]>();
  const functions = new Map<string, { params: string[]; returns: string }>();
  const scopes: Map<string, string>[] = [new Map()];
  let returns = "void";
  const typeOf = (token: string): string | undefined => {
    const [, prefix = "", n = ""] = /^([a-z]+)([234])$/.exec(token) ?? [];
    const alias = GLSL_ALIASES[prefix];
    const t = alias ? alias + n : token;
    return GLSL_TYPE.test(t) || structs.has(t) || t === "void" ? t : undefined;
  };
  const variable = (name: string): string => {
    for (let s = scopes.length - 1; s >= 0; s--) {
      const type = scopes[s]!.get(name);
      if (type) return type;
    }
    return fail(`unknown name ${name}`);
  };
  const scoped = <T>(body: () => T): T => {
    scopes.push(new Map());
    try {
      return body();
    } finally {
      scopes.pop();
    }
  };
  // Structs are values: stored copies, so members can be assigned in place.
  const copied = (e: GlslExpression): string =>
    structs.has(e.type) ? `$.clone(${e.js})` : e.js;

  function binary(
    op: string,
    a: GlslExpression,
    b: GlslExpression,
  ): GlslExpression {
    if (op === "&&" || op === "||") {
      same(a.type, "bool", op);
      same(b.type, "bool", op);
      return { js: `(${a.js} ${op} ${b.js})`, type: "bool" };
    }
    if (op === "==" || op === "!=") {
      same(a.type, b.type, op);
      return {
        js: `(${op === "!=" ? "!" : ""}$.equal(${a.js}, ${b.js}))`,
        type: "bool",
      };
    }
    const base = scalarOf(a.type);
    same(base, scalarOf(b.type), op);
    const [na, nb] = [sizeOf(a.type), sizeOf(b.type)];
    if (na !== nb && na > 1 && nb > 1) fail(`${op} of ${a.type} and ${b.type}`);
    if (["<", ">", "<=", ">="].includes(op)) {
      if (na > 1 || nb > 1 || base === "bool") fail(`${op} of ${a.type}`);
      return { js: `(${a.js} ${op} ${b.js})`, type: "bool" };
    }
    const operation = GLSL_OPERATORS[op];
    if (!operation || !(operation in GLSL_ARITHMETIC[base]!)) {
      fail(`${op} of ${a.type}`);
    }
    return {
      js: `$.${base}.${operation}(${a.js}, ${b.js})`,
      type: vectorOf(base, Math.max(na, nb)),
    };
  }

  const LEVELS = [
    ["||"],
    ["&&"],
    ["|"],
    ["^"],
    ["&"],
    ["==", "!="],
    ["<", ">", "<=", ">="],
    ["<<", ">>"],
    ["+", "-"],
    ["*", "/", "%"],
  ];
  const levelOf = (token: string): number =>
    LEVELS.findIndex((ops) => ops.includes(token)) + 1;

  function expression(): GlslExpression {
    const condition = binaryAbove(1);
    if (peek() !== "?") return condition;
    next();
    same(condition.type, "bool", "?:");
    const a = expression();
    expect(":");
    const b = expression();
    same(a.type, b.type, "?:");
    return { js: `(${condition.js} ? ${a.js} : ${b.js})`, type: a.type };
  }

  function binaryAbove(minimum: number): GlslExpression {
    let left = unary();
    for (
      let level = levelOf(peek());
      level >= minimum;
      level = levelOf(peek())
    ) {
      left = binary(next(), left, binaryAbove(level + 1));
    }
    return left;
  }

  function unary(): GlslExpression {
    const op = peek();
    if (!["-", "+", "!", "~"].includes(op)) return postfix(primary());
    next();
    const a = unary();
    const base = scalarOf(a.type);
    if (op === "+") return a;
    if (op === "!") same(a.type, "bool", "!");
    else if (base === "bool" || (op === "~" && base === "float")) {
      fail(`${op} of ${a.type}`);
    }
    return {
      js:
        op === "!"
          ? `(!${a.js})`
          : `$.${base}.${op === "-" ? "neg" : "not"}(${a.js})`,
      type: a.type,
    };
  }

  function postfix(value: GlslExpression): GlslExpression {
    while (peek() === ".") {
      next();
      const name = next();
      const field = structs.get(value.type)?.find(([f]) => f === name);
      if (field) {
        const js = `${value.js}.${name}`;
        value = { js, type: field[1], store: value.store && { js } };
        continue;
      }
      const n = sizeOf(value.type);
      const components = name.split("").map((c) => SWIZZLE.indexOf(c) % 5);
      if (n === 1 || components.some((c) => c < 0 || c >= n)) {
        fail(`.${name} of ${value.type}`);
      }
      value = {
        js:
          components.length === 1
            ? `${value.js}[${components[0]}]`
            : `$.swizzle(${value.js}, [${components.join(", ")}])`,
        type: vectorOf(scalarOf(value.type), components.length),
        store:
          value.store && !value.store.components
            ? { js: value.store.js, components }
            : undefined,
      };
    }
    if (peek() === "[") fail("indexing is outside the dialect");
    return value;
  }

  function argumentList(): GlslExpression[] {
    expect("(");
    const args: GlslExpression[] = [];
    while (peek() !== ")") {
      if (args.length > 0) expect(",");
      args.push(expression());
    }
    next();
    return args;
  }

  function primary(): GlslExpression {
    const token = next();
    if (token === "(") {
      const inner = expression();
      expect(")");
      return { js: `(${inner.js})`, type: inner.type };
    }
    if (/^[.\d]/.test(token)) {
      if (/[uU]$/.test(token)) {
        return { js: `${Number(token.slice(0, -1)) >>> 0}`, type: "uint" };
      }
      if (/^(0[xX][\da-fA-F]+|\d+)$/.test(token)) {
        return { js: `${Number(token) | 0}`, type: "int" };
      }
      return { js: `$.R(${Number(token)})`, type: "float" };
    }
    if (token === "true" || token === "false")
      return { js: token, type: "bool" };
    const type = typeOf(token);
    if (type && GLSL_TYPE.test(type)) return construct(type, argumentList());
    if (type) fail(`${type} constructors are outside the dialect`);
    if (peek() === "(") return call(token, argumentList());
    return {
      js: `_${token}`,
      type: variable(token),
      store: { js: `_${token}` },
    };
  }

  function construct(type: string, args: GlslExpression[]): GlslExpression {
    const base = scalarOf(type);
    const n = sizeOf(type);
    const size = args.reduce((sum, a) => sum + sizeOf(a.type), 0);
    if (args.some((a) => !GLSL_TYPE.test(a.type))) fail(`${type} of a struct`);
    if (size !== n && !(args.length === 1 && size === 1)) {
      fail(`${type} from ${size} components`);
    }
    const convert = (a: GlslExpression): string => {
      const from = scalarOf(a.type);
      return from === base ? a.js : `$.convert(${a.js}, "${from}", "${base}")`;
    };
    if (n === 1) return { js: convert(args[0]!), type };
    const parts = args.map((a) =>
      sizeOf(a.type) === 1 ? `[${convert(a)}]` : convert(a),
    );
    return { js: `$.vector(${n}, ${parts.join(", ")})`, type };
  }

  function call(name: string, args: GlslExpression[]): GlslExpression {
    const user = functions.get(name);
    if (user) {
      same(`${args.length}`, `${user.params.length}`, `arguments of ${name}`);
      args.forEach((a, k) =>
        same(a.type, user.params[k]!, `${name} argument ${k}`),
      );
      return {
        js: `_${name}(${args.map((a) => a.js).join(", ")})`,
        type: user.returns,
      };
    }
    const signature = GLSL_BUILTINS[name] ?? fail(`unknown function ${name}`);
    const [first] = args;
    const types = args.map((a) => a.type);
    // "g": a float genType, "n": any numeric genType, then "s" (the same, or
    // its scalar) or "=" (the same) for the other arguments.
    const [pattern, result] = signature.split(" ") as [string, string];
    if (!first || pattern.length !== args.length) fail(`arguments of ${name}`);
    const genType = first!.type;
    const base = scalarOf(genType);
    if (!GLSL_TYPE.test(genType) || base === "bool")
      fail(`${name} of ${genType}`);
    if (pattern[0] === "g" && base !== "float") fail(`${name} of ${genType}`);
    pattern
      .slice(1)
      .split("")
      .forEach((p, k) => {
        const t = types[k + 1]!;
        if (t !== genType && !(p === "s" && t === base))
          fail(`${name}(${types.join(", ")})`);
      });
    if (name === "cross") same(genType, "float3", "cross");
    const type = result === "g" ? genType : result;
    return {
      js: `$.${base}.${name}(${args.map((a) => a.js).join(", ")})`,
      type,
    };
  }

  function assignment(
    target: GlslExpression,
    op: string,
    value: GlslExpression,
  ): string {
    const store = target.store ?? fail("assignment to a value");
    if (op !== "=") value = binary(op.slice(0, -1), target, value);
    same(value.type, target.type, op);
    if (!store.components) return `${store.js} = ${copied(value)};`;
    const components = store.components.join(", ");
    return `${store.js} = $.put(${store.js}, [${components}], ${value.js});`;
  }

  function simpleStatement(): string {
    const type = typeOf(peek());
    if (type && peek(1) !== "(") {
      next();
      const declarations: string[] = [];
      do {
        const name = next();
        let init = `$.zero("${type}")`;
        if (peek() === "=") {
          next();
          const value = expression();
          same(value.type, type, `${name} =`);
          init = copied(value);
        }
        scopes.at(-1)!.set(name, type);
        declarations.push(`let _${name} = ${init};`);
      } while (peek() === "," && next());
      return declarations.join(" ");
    }
    if (peek() === "++" || peek() === "--") {
      const op = next();
      const target = unary();
      return assignment(target, `${op[0]}=`, one(target.type));
    }
    const target = expression();
    const op = next();
    if (op === "++" || op === "--") {
      return assignment(target, `${op[0]}=`, one(target.type));
    }
    if (!/^([-+*/%&|^]|<<|>>)?=$/.test(op)) fail("statement without effect");
    return assignment(target, op, expression());
  }

  const one = (type: string): GlslExpression => ({
    js: "1",
    type: scalarOf(type),
  });

  function statement(): string {
    const token = peek();
    if (token === "{") return block();
    if (token === "if") {
      next();
      expect("(");
      const condition = expression();
      same(condition.type, "bool", "if");
      expect(")");
      const then = scoped(statement);
      if (peek() !== "else") return `if (${condition.js}) { ${then} }`;
      next();
      return `if (${condition.js}) { ${then} } else { ${scoped(statement)} }`;
    }
    if (token === "for") {
      next();
      expect("(");
      return scoped(() => {
        const init = simpleStatement();
        expect(";");
        const condition = expression();
        same(condition.type, "bool", "for");
        expect(";");
        const step = simpleStatement().slice(0, -1);
        expect(")");
        return `for (${init} ${condition.js}; ${step}) { ${scoped(statement)} }`;
      });
    }
    if (token === "return") {
      next();
      const value: GlslExpression =
        peek() === ";" ? { js: "", type: "void" } : expression();
      same(value.type, returns, "return");
      expect(";");
      return `return ${value.js};`;
    }
    const code = simpleStatement();
    expect(";");
    return code;
  }

  function block(): string {
    expect("{");
    return scoped(() => {
      const body: string[] = [];
      while (peek() !== "}") body.push(statement());
      next();
      return body.join("\n");
    });
  }

  const code: string[] = [];
  while (pos < tokens.length) {
    if (peek() === "struct") {
      next();
      const name = next();
      const fields: [string, string][] = [];
      expect("{");
      while (peek() !== "}") {
        const type = typeOf(next()) ?? fail("field type");
        fields.push([next(), type]);
        expect(";");
      }
      next();
      expect(";");
      structs.set(name, fields);
      continue;
    }
    returns = typeOf(next()) ?? fail("expected a type");
    const name = next();
    if (peek() !== "(") fail(`global ${name} is outside the dialect`);
    const params: [string, string][] = [];
    next();
    while (peek() !== ")") {
      if (params.length > 0) expect(",");
      const type = typeOf(next()) ?? fail("parameters take no qualifiers");
      params.push([next(), type]);
    }
    next();
    functions.set(name, { params: params.map(([, t]) => t), returns });
    const body = scoped(() => {
      params.forEach(([p, t]) => scopes.at(-1)!.set(p, t));
      return block();
    });
    const copies = params
      .filter(([, t]) => structs.has(t))
      .map(([p]) => `_${p} = $.clone(_${p});`);
    const list = params.map(([p]) => `_${p}`).join(", ");
    code.push(`function _${name}(${list}) {\n${copies.join(" ")}\n${body}\n}`);
  }
  const exports = [...functions.keys()].map((n) => `${n}: _${n}`).join(", ");
  const module = runInThisContext(
    `($) => {\n${code.join("\n")}\nreturn { ${exports} };\n}`,
    { filename: "compiled.glsl.js" },
  ) as (runtime: unknown) => Record<string, (...args: unknown[]) => unknown>;
  return module(glslRuntime(structs, options));
}

/** Operator names in GLSL_ARITHMETIC. */
const GLSL_OPERATORS: Record<string, string> = {
  "+": "add",
  "-": "sub",
  "*": "mul",
  "/": "div",
  "%": "mod",
  "<<": "shl",
  ">>": "shr",
  "&": "and",
  "|": "or",
  "^": "xor",
};

/**
 * Which arithmetic each scalar type has (the runtime implements these per
 * type); built-ins as "argument pattern, result type" (see call).
 */
const GLSL_ARITHMETIC: Record<string, Record<string, true>> = {
  float: { add: true, sub: true, mul: true, div: true },
  int: { add: true, sub: true, mul: true, div: true },
  uint: {
    add: true,
    sub: true,
    mul: true,
    div: true,
    mod: true,
    shl: true,
    shr: true,
    and: true,
    or: true,
    xor: true,
  },
  bool: {},
};
const GLSL_BUILTINS: Record<string, string> = {
  abs: "n g",
  floor: "g g",
  ceil: "g g",
  fract: "g g",
  sqrt: "g g",
  exp: "g g",
  log: "g g",
  sin: "g g",
  cos: "g g",
  atan: "g= g",
  pow: "g= g",
  min: "ns g",
  max: "ns g",
  clamp: "nss g",
  mix: "g=s g",
  length: "g float",
  dot: "g= float",
  cross: "g= float3",
  normalize: "g g",
  fwidth: "g g",
};

/** The runtime compiled shaders call as `$`. */
function glslRuntime(
  structs: ReadonlyMap<string, [string, string][]>,
  options: { f32?: boolean; fwidth?: (x: Glsl) => Glsl },
): unknown {
  type V = number | readonly number[];
  const R = options.f32 ? Math.fround : (x: number): number => x;
  // A scalar function applied per component; scalar arguments broadcast.
  const each =
    (f: (...x: number[]) => number) =>
    (...args: V[]): V => {
      const vector = args.find((a) => typeof a !== "number");
      const at = (a: V, k: number): number =>
        typeof a === "number" ? a : a[k]!;
      return vector === undefined
        ? f(...(args as number[]))
        : vector.map((_, k) => f(...args.map((a) => at(a, k))));
    };
  const wrap = (f: (...x: number[]) => number, bits: (x: number) => number) =>
    each((...x) => bits(f(...x)));
  const uint = (f: (...x: number[]) => number) => wrap(f, (x) => x >>> 0);
  const int = (f: (...x: number[]) => number) => wrap(f, (x) => x | 0);
  const rounded = (f: (...x: number[]) => number) => wrap(f, R);
  const dot = (a: V, b: V): number =>
    typeof a === "number"
      ? R(a * (b as number))
      : a.reduce(
          (sum, x, k) => R(sum + R(x * (b as readonly number[])[k]!)),
          0,
        );
  const length = (a: V): number => R(Math.sqrt(dot(a, a)));
  const clamp = each((x, lo, hi) => Math.min(Math.max(x, lo), hi));
  const ordered = { min: each(Math.min), max: each(Math.max), clamp };
  const zero = (type: string): Glsl => {
    const fields = structs.get(type);
    if (fields) return Object.fromEntries(fields.map(([f, t]) => [f, zero(t)]));
    const scalar = scalarOf(type) === "bool" ? false : 0;
    return sizeOf(type) === 1
      ? scalar
      : Array.from({ length: sizeOf(type) }, () => 0);
  };
  const clone = (value: Glsl): Glsl =>
    typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]))
      : value;
  return {
    R,
    zero,
    clone,
    vector: (n: number, ...parts: readonly number[][]) => {
      const flat = parts.flat();
      return flat.length === 1
        ? Array.from({ length: n }, () => flat[0]!)
        : flat;
    },
    convert: (x: Glsl, from: string, to: string): Glsl => {
      if (to === "bool") return x !== 0;
      const value = from === "bool" ? Number(x) : (x as V);
      if (to === "float") return rounded((y) => y)(value);
      return (to === "uint" ? uint : int)(Math.trunc)(value);
    },
    swizzle: (a: readonly number[], c: readonly number[]) =>
      c.map((k) => a[k]!),
    put: (a: readonly number[], c: readonly number[], value: V) => {
      const out = [...a];
      c.forEach(
        (k, j) => (out[k] = typeof value === "number" ? value : value[j]!),
      );
      return out;
    },
    equal: (a: Glsl, b: Glsl): boolean =>
      Array.isArray(a)
        ? a.every((x, k) => x === (b as readonly number[])[k])
        : a === b,
    float: {
      add: rounded((x, y) => x + y),
      sub: rounded((x, y) => x - y),
      mul: rounded((x, y) => x * y),
      div: rounded((x, y) => x / y),
      neg: each((x) => -x),
      abs: each(Math.abs),
      floor: each(Math.floor),
      ceil: each(Math.ceil),
      fract: rounded((x) => x - Math.floor(x)),
      sqrt: rounded(Math.sqrt),
      exp: rounded(Math.exp),
      log: rounded(Math.log),
      sin: rounded(Math.sin),
      cos: rounded(Math.cos),
      atan: rounded(Math.atan2),
      pow: rounded((x, y) => x ** y),
      mix: rounded((x, y, a) => R(x * R(1 - a)) + R(y * a)),
      ...ordered,
      length,
      dot,
      cross: (a: readonly number[], b: readonly number[]) =>
        [1, 2, 0].map((j, i) => {
          const k = (i + 2) % 3;
          return R(R(a[j]! * b[k]!) - R(a[k]! * b[j]!));
        }),
      normalize: (a: V) => rounded((x) => x / length(a))(a),
      fwidth: (a: V): Glsl => {
        if (!options.fwidth) throw new Error("GLSL: fwidth outside a fragment");
        return options.fwidth(a);
      },
    },
    uint: {
      add: uint((x, y) => x + y),
      sub: uint((x, y) => x - y),
      mul: uint(Math.imul),
      div: uint((x, y) => Math.floor(x / y)),
      mod: uint((x, y) => x % y),
      shl: uint((x, y) => x << y),
      shr: uint((x, y) => x >>> y),
      and: uint((x, y) => x & y),
      or: uint((x, y) => x | y),
      xor: uint((x, y) => x ^ y),
      neg: uint((x) => -x),
      not: uint((x) => ~x),
      abs: each((x) => x),
      ...ordered,
    },
    int: {
      add: int((x, y) => x + y),
      sub: int((x, y) => x - y),
      mul: int(Math.imul),
      div: int((x, y) => x / y),
      neg: int((x) => -x),
      not: int((x) => ~x),
      abs: each(Math.abs),
      ...ordered,
    },
  };
}

/** The functions of shaders/particle.glsl and shape.glsl these tests call. */
interface ShaderCore {
  particleVertex(
    P: ParticleParams,
    F: ParticleFrame,
    W: ParticleWeather,
    S: ParticleSeed,
    time: number,
  ): ParticleVertex;
  particleTint(tint: Vec4, vignette: number, corner: number): ParticleVertex;
  particleFeatureKeep(
    density: number,
    kind: number,
    rank: number,
    key: number,
    ptu: number,
  ): number;
  particleEmitterSeed(
    P: ParticleParams,
    index: number,
    corner: number,
  ): ParticleSeed;
  particleFeatureSeed(emit: Vec4, density: number, ptu: number): ParticleSeed;
  particlePrefix(target: number, rank: number, count: number): number;
  particleHash(v: readonly number[]): number[];
  particleUnit(h: number): number;
  particleWeyl(k: number): number;
  particleFragment(uv: Vec4, color: Vec4, look: Vec4): Vec4;
}

// fwidth over a 2 x 2 fragment quad, as the GPU runs it: each lane runs once
// recording its fwidth arguments, then again reading its neighbors'.
const fragmentQuad = {
  lane: 0,
  call: 0,
  replay: false,
  recorded: [[], [], [], []] as Glsl[][],
};
function quadFwidth(x: Glsl): Glsl {
  const q = fragmentQuad;
  const k = q.call++;
  const at = (lane: number): number | readonly number[] =>
    q.recorded[lane]![k] as number | readonly number[];
  if (!q.replay) {
    q.recorded[q.lane]![k] = x;
    return typeof x === "number" ? 0 : (x as readonly number[]).map(() => 0);
  }
  const [here, dx, dy] = [at(q.lane), at(q.lane ^ 1), at(q.lane ^ 2)];
  const width = (v: number, x1: number, y1: number): number =>
    Math.abs(x1 - v) + Math.abs(y1 - v);
  return typeof here === "number"
    ? width(here, dx as number, dy as number)
    : here.map((v, i) =>
        width(v, (dx as readonly number[])[i]!, (dy as readonly number[])[i]!),
      );
}

let compiled: readonly [ShaderCore, ShaderCore] | undefined;
/**
 * particle.glsl and shape.glsl as WebGL compiles them (the JS layers' macros),
 * in f64 with fragment derivatives, and in f32. Compiled on first use, so a
 * shader the compiler rejects fails only the tests that run it.
 */
function cpuShaders(): readonly [f64: ShaderCore, f32: ShaderCore] {
  const sources = [vertexCore, shapes];
  compiled ??= [
    compileGlsl(sources, { fwidth: quadFwidth }) as unknown as ShaderCore,
    compileGlsl(sources, { f32: true }) as unknown as ShaderCore,
  ];
  return compiled;
}

/**
 * Draws one particle quad (its four corners from particleVertex, a
 * parallelogram in clip space) into F's viewport in physical pixels: every
 * 2 x 2 pixel quad it touches runs particleFragment, perspective-correct, and
 * the covered pixels add up the fragments' red (light, premultiplied), each
 * weighted by `weight` of its uv.
 */
function rasterize(
  F: ParticleFrame,
  quad: readonly ParticleVertex[],
  weight: (uv: Vec4) => number = () => 1,
): number {
  const [v0, v1, v2, v3] = quad as [
    ParticleVertex,
    ParticleVertex,
    ParticleVertex,
    ParticleVertex,
  ];
  if (v0.position[0] === 2 && v0.position[3] === 1) return 0;
  const half = (a: Vec4, b: Vec4): Vec4 =>
    [0, 1, 2, 3].map((k) => (b[k]! - a[k]!) / 2) as unknown as Vec4;
  const mid = (a: Vec4, b: Vec4): Vec4 =>
    [0, 1, 2, 3].map((k) => (a[k]! + b[k]!) / 2) as unknown as Vec4;
  // clip(alpha, beta) = c + alpha a + beta b, and uv the same way.
  const [c, a, b] = [
    mid(v0.position, v2.position),
    half(v0.position, v1.position),
    half(v0.position, v3.position),
  ];
  const [uc, ua, ub] = [
    mid(v0.uv, v2.uv),
    half(v0.uv, v1.uv),
    half(v0.uv, v3.uv),
  ];
  const skew = mid(v1.position, v3.position).map((x, k) => Math.abs(x - c[k]!));
  if (Math.max(...skew) > 1e-6 * Math.max(1, ...c.map(Math.abs))) {
    throw new Error("the quad is not a parallelogram");
  }
  const ratio = F.view[1];
  const [width, height] = [F.screen[2] * ratio, F.screen[3] * ratio];
  const pixels = quad.map(({ position: p }) => [
    ((p[0] / p[3] + 1) / 2) * width,
    ((1 - p[1] / p[3]) / 2) * height,
  ]);
  const xs = pixels.map(([x]) => x!);
  const ys = pixels.map(([, y]) => y!);
  const [shader] = cpuShaders();
  let light = 0;
  for (
    let qy = 2 * Math.floor(Math.min(...ys) / 2 - 1);
    qy <= Math.max(...ys) + 1;
    qy += 2
  ) {
    for (
      let qx = 2 * Math.floor(Math.min(...xs) / 2 - 1);
      qx <= Math.max(...xs) + 1;
      qx += 2
    ) {
      const lanes = [0, 1, 2, 3].map((lane) => {
        const nx = (2 * (qx + (lane & 1) + 0.5)) / width - 1;
        const ny = 1 - (2 * (qy + (lane >> 1) + 0.5)) / height;
        const [m11, m12, r1] = [
          a[0] - nx * a[3],
          b[0] - nx * b[3],
          nx * c[3] - c[0],
        ];
        const [m21, m22, r2] = [
          a[1] - ny * a[3],
          b[1] - ny * b[3],
          ny * c[3] - c[1],
        ];
        const det = m11 * m22 - m12 * m21;
        const alpha = (r1 * m22 - m12 * r2) / det;
        const beta = (m11 * r2 - r1 * m21) / det;
        const uv = [0, 1, 2, 3].map(
          (k) => uc[k]! + alpha * ua[k]! + beta * ub[k]!,
        ) as unknown as Vec4;
        const inside = alpha >= -1 && alpha < 1 && beta >= -1 && beta < 1;
        return { uv, inside };
      });
      if (!lanes.some((lane) => lane.inside)) continue;
      for (const replay of [false, true]) {
        fragmentQuad.replay = replay;
        lanes.forEach(({ uv, inside }, lane) => {
          fragmentQuad.lane = lane;
          fragmentQuad.call = 0;
          const color = shader.particleFragment(uv, v0.color, v0.look);
          if (replay && inside) light += weight(uv) * color[0];
        });
      }
    }
  }
  return light;
}

describe("shaders/particle.glsl, compiled for the CPU", () => {
  const model = JSON.parse(readFileSync(FIXTURE, "utf8")) as ModelFixture;
  const hashes = JSON.parse(
    readFileSync(new URL("../../fixtures/hash.json", import.meta.url), "utf8"),
  ) as {
    cases: { input: number[]; hash: number[]; unit: number[] }[];
    weyl: { k: number; value: number }[];
  };

  // In f64 the shader agrees with the f64 model to rounding; in f32 within
  // 1e-3, the tolerance GPU runs of the shader on this fixture meet.
  for (const [label, precision, tolerance] of [
    ["f64", 0, 1e-9],
    ["f32", 1, 1e-3],
  ] as const) {
    it(`matches model.ts on every input of model.json (${label})`, () => {
      const core = cpuShaders()[precision];
      for (const c of model.cases) {
        c.expected.vertices.forEach((v, corner) => {
          const S = { ...c.seed, corner };
          const out = core.particleVertex(
            c.params,
            c.frame,
            c.weather,
            S,
            c.time,
          );
          expectNear(out, v, `${c.name} corner ${corner}`, tolerance);
        });
      }
      for (const t of model.tint) {
        const out = core.particleTint(t.tint, t.vignette, t.corner);
        expectNear(out, t.expected, "tint", tolerance);
      }
      for (const k of model.featureKeep) {
        const out = core.particleFeatureKeep(
          k.density,
          k.kind,
          k.rank,
          k.key,
          k.ptu,
        );
        expectNear(out, k.expected, "featureKeep", tolerance);
      }
      const seeds = [
        ...model.emitterSeeds.map((s) => [
          core.particleEmitterSeed(
            params({ emission: s.emission }),
            s.index,
            s.corner,
          ),
          s.expected,
        ]),
        ...model.featureSeeds.map((s) => [
          core.particleFeatureSeed(s.emit, s.density, s.ptu),
          s.expected,
        ]),
      ] as [ParticleSeed, ParticleSeed][];
      for (const [out, expected] of seeds) {
        expect([out.key, out.group]).toEqual([expected.key, expected.group]);
        expectNear(out, expected, "seed", tolerance);
      }
    });
  }

  it("reaches exactly prefixRanks, which sizes the emitter pools (f64 and f32)", () => {
    // record.ts and record.zig size each pool to hold the ramp's reach at
    // the full count, so the shader's own ramp must end there: the last
    // rank shows and the next does not, at every precision.
    const counts = [0.3, 5.5, 8, 9, 60, 61, 64, 256, 600, 1000, 1024, 3500];
    counts.push(4095.9, 4096, 7710, 7711, 8192, 15420, 15421, 16384);
    for (const core of cpuShaders()) {
      for (const count of counts) {
        const ranks = prefixRanks(count);
        for (const target of [count, 0.97 * count, 0.5 * count])
          expect(core.particlePrefix(target, ranks, count), `${count}`).toBe(0);
        expect(core.particlePrefix(count, ranks - 1, count)).toBeGreaterThan(0);
        for (const rank of [0, ranks / 2, ranks - 1].map(Math.floor))
          expect(core.particlePrefix(count, rank, count)).toBeCloseTo(
            prefix(count, rank, count),
            5,
          );
      }
    }
  });

  it("hashes as hash.ts on every vector of hash.json", () => {
    const [, shaderF32] = cpuShaders();
    for (const { input, hash, unit } of hashes.cases) {
      expect(shaderF32.particleHash(input)).toEqual(hash);
      expect(hash.map((h) => shaderF32.particleUnit(h))).toEqual(unit);
    }
    for (const { k, value } of hashes.weyl)
      expect(shaderF32.particleWeyl(k)).toBe(value);
  });

  it("rejects GLSL outside the dialect", () => {
    for (const source of [
      "float f(float x) { return x * 2; }",
      "float g = 1.0;",
      "float f(float x) { return mod(x, 2.0); }",
      "void f(out float x) { x = 1.0; }",
      "float f(uint x) { return float(x) + x; }",
    ]) {
      expect(() => compileGlsl([source]), source).toThrow(/GLSL/);
    }
  });
});

describe("small particles on the pixel grid", () => {
  // Particles holding still in screen space at the center of a pitch-0
  // camera (pixel ratio 1), nudged across a pixel in quarter-pixel steps. A
  // particle's light should not depend on where it sits between pixel
  // centers, and below the floor it should follow the particle's area.
  const cam = camera();
  const still = (shape: number, size: number, overrides = {}) =>
    clampParams(
      params(
        {
          color: [1, 1, 1, 1],
          size: [size, size, 1, 0],
          sizeSpin: [0, 4096, 0, 0],
          fadeAdd: [0, 0, 0, 0],
          timing: [5, 5, 0, 0],
          launch: [0, 0, 0, 0],
          cone: [0, 0, 0, 0],
          air: [0, 0, 0, 0],
          ...overrides,
        },
        { shape, space: SPACE.screen },
      ),
    );
  const quarters = [0, 0.25, 0.5, 0.75];

  /** The light particle S of P draws at each offset (logical px) from the center. */
  function lights(
    P: ParticleParams,
    S: ParticleSeed,
    time: number,
    offsets: readonly Vec2[],
  ): number[] {
    const [shader] = cpuShaders();
    return offsets.map((anchor) => {
      const F = emitterFrame(cam, "screen", { anchor });
      const quad = corners(S).map((s) =>
        shader.particleVertex(P, F, NO_WEATHER, s, time),
      );
      return rasterize(F, quad);
    });
  }
  const mean = (values: readonly number[]): number =>
    values.reduce((sum, v) => sum + v, 0) / values.length;

  // The largest max/min light ratio over the offsets, per shape: glow and
  // circle hold within a few percent, shapes with thin arms within their
  // spread at the floor size.
  const SPREAD: [number, number][] = [
    [Shape.glow, 1.06],
    [Shape.circle, 1.08],
    [Shape.square, 1.1],
    [Shape.ring, 1.25],
    [Shape.star, 1.55],
    [Shape.flake, 1.45],
    [Shape.smoke, 1.65],
  ];

  it("draws sprites under the floor at the floor, with their area's light", () => {
    const offsets = quarters.flatMap((x) => quarters.map((y): Vec2 => [x, y]));
    for (const [shape, spread] of SPREAD) {
      // Two particles, so two spin angles.
      for (const index of [0, 1]) {
        const perArea = (size: number): number => {
          const P = still(shape, size);
          const light = lights(P, emitterSeed(P, index, 0), 2, offsets);
          const label = `shape ${shape} size ${size}: ${light.join(" ")}`;
          expect(Math.min(...light), label).toBeGreaterThan(0);
          expect(Math.max(...light) / Math.min(...light), label).toBeLessThan(
            spread,
          );
          return mean(light) / (size * size);
        };
        const atFloor = perArea(SPRITE_FLOOR);
        for (const size of [0.3, 0.8, 1.5, 2.5]) {
          expect(perArea(size) / atFloor).toBeCloseTo(1, 1);
        }
      }
    }
  });

  it("draws streaks under the floor width at the floor, with their area's light", () => {
    // A streak flying east at 300 px/s trails 15 px (stretch 0.05); nudged
    // across its width in eighths of a pixel.
    const offsets = Array.from({ length: 8 }, (_, k): Vec2 => [0.3, k / 8]);
    const perArea = (width: number): number => {
      const P = still(Shape.streak, width, {
        launch: [300, 300, 90, 0],
        size: [width, width, 1, 0.05],
      });
      const S = emitterSeed(P, 0, 0);
      const light = lights(P, S, timeAtAge(P, NO_WEATHER, S, 50, 0.5), offsets);
      const label = `width ${width}: ${light.join(" ")}`;
      expect(Math.max(...light) / Math.min(...light), label).toBeLessThan(1.3);
      return mean(light) / (width * (15 + 0.2 * Math.PI * width));
    };
    const wide = perArea(3);
    for (const width of [0.4, 0.8, 1.5, STRETCHED_FLOOR]) {
      expect(perArea(width) / wide).toBeCloseTo(1, 1);
    }
  });
});

describe("ripples on the pixel grid", () => {
  const ripple = (size: number) =>
    clampParams(
      params(
        {
          color: [1, 1, 1, 1],
          size: [size, size, 1, 0],
          sizeSpin: [0, 4096, 0, 0],
          fadeAdd: [0, 0, 0, 0],
          timing: [5, 5, 0, 0],
          launch: [0, 0, 0, 0],
          air: [0, 0, 0, 0],
        },
        { shape: Shape.ripple },
      ),
    );
  /** The light of a ripple drifting across a pixel on the ground. */
  function drift(pitch: number, size: number, weight?: (uv: Vec4) => number) {
    const cam = camera({ pitch });
    const P = ripple(size);
    const S = emitterSeed(P, 0, 0);
    const [shader] = cpuShaders();
    return Array.from({ length: 24 }, (_, k) => {
      const anchor: Vec2 = [0.37 + 0.061 * k, 40 + k / 8];
      const F = emitterFrame(cam, "ground", { anchor });
      const quad = corners(S).map((s) =>
        shader.particleVertex(P, F, NO_WEATHER, s, 2),
      );
      return rasterize(F, quad, weight);
    });
  }

  it("keep their far arc whole under pitch as they drift between pixels", () => {
    // Under pitch the ring's far arc is foreshortened across the view; its
    // light (weighted by how directly it faces away) must not break up.
    const far = (uv: Vec4): number =>
      clamp01((uv[1] / Math.max(Math.hypot(uv[0], uv[1]), 1e-6) - 0.7) / 0.3);
    for (const [pitch, size] of [
      [45, 10],
      [60, 16],
    ] as const) {
      const light = drift(pitch, size, far);
      const label = `pitch ${pitch} size ${size}: ${light.join(" ")}`;
      expect(Math.min(...light) / Math.max(...light), label).toBeGreaterThan(
        0.75,
      );
    }
  });

  it("keep the light of their bands when thinner than a pixel", () => {
    // The bands' area: 0.1 wide at radius 0.8, half as bright 0.08 wide at
    // 0.5, in a quad of half-size size / 2 px.
    for (const size of [10, 16, 30]) {
      const area =
        (size / 2) ** 2 * 2 * Math.PI * (0.8 * 0.1 + 0.5 * 0.5 * 0.08);
      const light = drift(0, size);
      const mean = light.reduce((sum, l) => sum + l, 0) / light.length;
      expect(mean / area, `size ${size}`).toBeCloseTo(1, 1);
    }
  });
});
