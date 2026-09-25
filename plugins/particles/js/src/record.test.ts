// The emitter's CPU half (record.ts) against fixtures/record.json, whose
// expected rows, pool sizes and weather pools come from native/src/record.zig,
// plus the lane map's coverage and the header layout.

import { readFileSync } from "node:fs";

import {
  DEFAULT_TRANSITION,
  type PaintPropertySpec,
  type Vector,
} from "@maplibre-plugins/paint";
import { describe, expect, it } from "vite-plus/test";

import { weatherPools as modelWeatherPools, prefix } from "./model.ts";
import { createEmitterPaintState, type EmitterPaint } from "./paint.ts";
import {
  CLOCK_WRAP,
  emitterLanes,
  emitterOffset,
  Header,
  header,
  HEADER_VEC4S,
  Lane,
  MAX_COUNT,
  MAX_POOL,
  mercator,
  pack,
  poolSize,
  prefixRanks,
  ROW_VEC4S,
  weatherPools,
  worldSize,
  wrapClock,
} from "./record.ts";
import { type EmitterPaintName, emitterPaintNames, paintSpec } from "./spec.ts";

interface RecordCase {
  name: string;
  frame: {
    zoom: number;
    center: [number, number];
    pitch: number;
    cameraToCenterDistance: number;
    projMatrix: number[];
  };
  paint: Record<EmitterPaintName, number | string | number[]>;
  expected: {
    visible: boolean;
    poolSize: number;
    header: {
      ppmCam: number;
      eye: [number, number, number, number];
      pool0: number[];
      pool1: number[];
      weights: number[];
    };
    row: number[][] | null;
  };
}

const fixture = JSON.parse(
  readFileSync(new URL("../../fixtures/record.json", import.meta.url), "utf8"),
) as { cases: RecordCase[] };

/** The fixture's paint as the JS paint state evaluates it: enums as [index], an unknown one at its default. */
function evaluated(paint: RecordCase["paint"]): EmitterPaint {
  const out: Partial<Record<EmitterPaintName, Vector>> = {};
  for (const name of emitterPaintNames) {
    const value = paint[name];
    const spec: PaintPropertySpec = paintSpec[name];
    if (typeof value === "string") {
      const values = spec.type === "enum" ? spec.values : [];
      const index = values.indexOf(value);
      out[name] = [index >= 0 ? index : values.indexOf(String(spec.default))];
    } else {
      out[name] = typeof value === "number" ? [value] : value;
    }
  }
  return out as EmitterPaint;
}

function vec4s(values: Float32Array, from: number, count: number): number[][] {
  return Array.from({ length: count }, (_, i) =>
    Array.from(values.subarray(4 * (from + i), 4 * (from + i + 1))),
  );
}

describe("record fixture", () => {
  it("has cases", () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  for (const c of fixture.cases) {
    describe(c.name, () => {
      const frame = { zoom: c.frame.zoom, center: c.frame.center } as const;
      const packed = pack(evaluated(c.paint), frame);

      it("packs the same row, pool size and visibility as record.zig", () => {
        expect(packed.visible).toBe(c.expected.visible);
        expect(packed.pool).toBe(c.expected.poolSize);
        if (c.expected.row) {
          expect(vec4s(packed.row, 0, ROW_VEC4S)).toEqual(c.expected.row);
        }
      });

      it("computes the same weather pools from the same eye", () => {
        const expected = c.expected.header;
        const origin = mercator(
          c.frame.center[0],
          c.frame.center[1],
          worldSize(c.frame.zoom),
        );
        const h = header({
          time: 0,
          zoom: c.frame.zoom,
          width: 800,
          height: 600,
          pixelRatio: 1,
          cameraToCenterDistance: c.frame.cameraToCenterDistance,
          pixelsPerMeter: expected.ppmCam,
          pitch: c.frame.pitch,
          origin,
          eye: [expected.eye[0], expected.eye[1], expected.eye[2]],
        });
        expect(vec4s(h, Header.eye, 1)).toEqual([expected.eye]);
        expect(vec4s(h, Header.pool0, 3)).toEqual([
          expected.pool0,
          expected.pool1,
          expected.weights,
        ]);
      });
    });
  }
});

describe("lane map", () => {
  it("lists every emitter property in type order", () => {
    expect(Object.keys(emitterLanes)).toEqual(emitterPaintNames);
  });

  it("writes every row component exactly once", () => {
    const writes = Array.from({ length: ROW_VEC4S * 4 }, () => 0);
    for (const name of emitterPaintNames) {
      const entry = emitterLanes[name];
      const at = 4 * entry.lane + entry.component;
      switch (entry.use) {
        case "raw":
        case "clamped": {
          const spec: PaintPropertySpec = paintSpec[name];
          const width = { float: 1, float2: 2, color: 4 }[
            spec.type as "float" | "float2" | "color"
          ];
          expect(width, name).toBeDefined();
          expect(entry.component + width, name).toBeLessThanOrEqual(4);
          for (let i = 0; i < width; i++) writes[at + i]!++;
          break;
        }
        case "identity":
          expect([entry.lane, entry.component], name).toEqual([
            Lane.emission,
            3,
          ]);
          break;
        case "color":
          expect(paintSpec[name].type, name).toBe("color");
          break;
        case "opacity":
          expect(name).toBe("particle-opacity");
          break;
        case "position":
          expect(paintSpec[name].type, name).toBe("double2");
          break;
      }
    }
    // The identity, the two color lanes, and placement x, y (position) and
    // z (pixels per meter) are written by pack itself; extra.yzw stay 0.
    writes[4 * Lane.emission + 3]!++;
    for (let k = 0; k < 4; k++) {
      writes[4 * Lane.color + k]!++;
      writes[4 * Lane.colorEnd + k]!++;
    }
    for (let k = 0; k < 3; k++) writes[4 * Lane.placement + k]!++;
    for (let k = 1; k < 4; k++) writes[4 * Lane.extra + k]!++;
    expect(writes).toEqual(writes.map(() => 1));
  });

  it("packs the identity from the enum indices and the floored seed", () => {
    const state = createEmitterPaintState(DEFAULT_TRANSITION, {
      "emitter-kind": "circle",
      "particle-space": "world",
      "particle-shape": "smoke",
      "particle-seed": 41.9,
    });
    const { row } = pack(state.evaluate(16, 0), {
      zoom: 16,
      center: [0, 0],
    });
    expect(row[4 * Lane.emission + 3]).toBe(41 + 65536 * (8 + 16 * 2 + 64));
  });

  it("rounds its inputs to f32 first, as the host delivers them", () => {
    // 41.999999 is 42 in f32, so the host floors 42.
    const state = createEmitterPaintState(DEFAULT_TRANSITION, {
      "particle-seed": 41.999999,
    });
    const frame = { zoom: 16, center: [0, 0] } as const;
    const seed = (paint: EmitterPaint) =>
      pack(paint, frame).row[4 * Lane.emission + 3]! % 65536;
    expect(seed(state.evaluate(16, 0))).toBe(42);
    // Opacity folds into the f32 colors at f32 too: 0.1 · 0.2 rounds
    // differently from fround(0.1) · fround(0.2).
    const paint: EmitterPaint = {
      ...state.evaluate(16, 0),
      "particle-color": [0.1, 0.2, 0.1, 0.2],
      "particle-opacity": [0.2],
    };
    const host = Math.fround(Math.fround(0.1) * Math.fround(0.2));
    expect(host).not.toBe(Math.fround(0.1 * 0.2));
    expect(pack(paint, frame).row[4 * Lane.color]).toBe(host);
  });

  it("folds opacity into premultiplied colors and paints the end color over", () => {
    const state = createEmitterPaintState(DEFAULT_TRANSITION, {
      "particle-color": "rgba(255, 0, 0, 0.5)",
      "particle-color-end": "rgba(0, 0, 255, 0.25)",
      "particle-opacity": 0.5,
    });
    const { row } = pack(state.evaluate(16, 0), {
      zoom: 16,
      center: [0, 0],
    });
    expect(Array.from(vec4s(row, Lane.color, 2).flat())).toEqual(
      [0.25, 0, 0, 0.25, 0.1875, 0, 0.125, 0.3125].map(Math.fround),
    );
  });
});

describe("emitter position", () => {
  it("picks the copy nearest the frame center", () => {
    const frame = { zoom: 3, center: [10, 179] } as const;
    const offset = emitterOffset([10, -179], frame)!;
    // 2 degrees east of the center, across the antimeridian.
    expect(offset[0]).toBeCloseTo((2 / 360) * worldSize(3), 9);
    expect(offset[1]).toBeCloseTo(0, 9);
  });

  it("places nothing at an unusable position", () => {
    const frame = { zoom: 3, center: [0, 0] } as const;
    expect(emitterOffset([91, 0], frame)).toBeNull();
    expect(emitterOffset([Number.NaN, 0], frame)).toBeNull();
    expect(emitterOffset([0, Infinity], frame)).toBeNull();
  });
});

describe("pool size", () => {
  it("holds the count ramp in a power of two of at least 64 for point and circle", () => {
    const counts = [0, Number.NaN, -5, 1, 60, 61, 64, 600, 1000, 1024];
    counts.push(15420, 15421, 1e9);
    expect(counts.map((n) => poolSize(n, false))).toEqual([
      64, 64, 64, 64, 64, 128, 128, 1024, 2048, 2048, 16384, 16384, 16384,
    ]);
  });

  it("keeps two weather octaves of at least 32 ranks, 8192 at most", () => {
    expect(
      [0, 30, 31, 3500, 7710, 7711, 8192, Infinity].map((n) =>
        poolSize(n, true),
      ),
    ).toEqual([64, 64, 128, 8192, 16384, 16384, 16384, 16384]);
  });

  it("holds the whole count ramp for every count up to where the pool is capped", () => {
    // The ramp reaches furthest at the full count (target = count; a
    // weather octave's target is count x weight, at most the count), so the
    // first rank past the pool must show nothing there. Weather octaves take
    // alternate particles, so each has half the pool's ranks. The last count
    // each cap holds is tight: one more needs more ranks than the cap.
    const counts: number[] = [];
    for (let n = 0; n <= MAX_COUNT; n++) counts.push(n);
    for (let n = 0.3; n <= MAX_COUNT; n += 7.77) counts.push(Math.fround(n));
    for (const [weather, octaves, last] of [
      [false, 1, 15420],
      [true, 2, 7710],
    ] as const) {
      for (const count of counts) {
        const pool = poolSize(count, weather);
        if (count > last) {
          expect(pool, `${count}`).toBe(MAX_POOL);
          continue;
        }
        const ranks = pool / octaves;
        expect(ranks, `${count}`).toBeGreaterThanOrEqual(prefixRanks(count));
        expect(prefix(count, ranks, count), `${count}`).toBe(0);
      }
      expect(octaves * prefixRanks(last)).toBeLessThanOrEqual(MAX_POOL);
      expect(octaves * prefixRanks(last + 1)).toBeGreaterThan(MAX_POOL);
    }
  });
});

describe("weather pools", () => {
  it("match the model's, operation for operation", () => {
    for (const zoom of [0, 3.25, 13.999, 14, 14.001, 18.5]) {
      for (const [x, y, altitude] of [
        [0, 0, 0],
        [123456.789, 98765.4321, 4321.5],
        [-500.25, 1e7, 900],
      ] as const) {
        const pools = weatherPools(zoom, x, y, altitude, 900);
        const model = modelWeatherPools(zoom, x, y, altitude, 900);
        expect(pools).toEqual(model);
      }
    }
  });

  it("hand the weight to the pool anchored at the nearer parity", () => {
    expect(weatherPools(14.25, 0, 0, 0, 900).weights).toEqual([
      0.75, 0.25, 0, 0,
    ]);
    expect(weatherPools(15.25, 0, 0, 0, 900).weights).toEqual([
      0.25, 0.75, 0, 0,
    ]);
  });
});

describe("header", () => {
  const camera = {
    time: 12.5,
    zoom: 15,
    width: 800,
    height: 600,
    pixelRatio: 2,
    cameraToCenterDistance: 900,
    pixelsPerMeter: 1.5,
    pitch: 0.5,
    origin: [1000, 2000],
    eye: [0, -300, 400],
  } as const;
  const h = header(camera);

  it("fills every vec4 but P_rel and the reserved one", () => {
    expect(h.length).toBe(4 * HEADER_VEC4S);
    expect(vec4s(h, 0, 4).flat()).toEqual(Array.from({ length: 16 }, () => 0));
    expect(vec4s(h, Header.clock, 4)).toEqual([
      [12.5, CLOCK_WRAP, 1, 1],
      [Math.fround(2 / 800), Math.fround(-2 / 600), 800, 600],
      [900, 2, 1.5, 0.5].map(Math.fround),
      [0, -300, 400, 900],
    ]);
    expect(vec4s(h, 11, 1).flat()).toEqual([0, 0, 0, 0]);
  });

  it("anchors the pools at the absolute eye", () => {
    const pools = weatherPools(15, 1000, 1700, 600, 900);
    expect(vec4s(h, Header.pool0, 3)).toEqual(
      [pools.pool0, pools.pool1, pools.weights].map((v) => v.map(Math.fround)),
    );
  });
});

describe("clock", () => {
  it("wraps into [0, CLOCK_WRAP)", () => {
    expect(wrapClock(12.5)).toBe(12.5);
    expect(wrapClock(CLOCK_WRAP + 1)).toBe(1);
    expect(wrapClock(-1)).toBe(CLOCK_WRAP - 1);
    expect(wrapClock(Number.NaN)).toBe(0);
  });
});
