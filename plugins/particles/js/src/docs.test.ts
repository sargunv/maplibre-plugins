// What ../../README.md and ../../spec.json promise, checked against the code:
// the native viewer commands for the presets open each at its own camera, a
// zoom-faded preset draws nothing where it has faded out, and the numbers the
// docs give for alive particles, the count ramp and feature densities. A
// change that breaks one of these needs the docs changed with it.

import { readdirSync, readFileSync } from "node:fs";

import { DEFAULT_TRANSITION } from "@maplibre-plugins/paint";
import { describe, expect, it } from "vite-plus/test";

import {
  clampParams,
  emitterSeed,
  featureKeep,
  packIdentity,
  type ParticleParams,
  type ParticleWeather,
  prefix,
  Shape,
  timing,
  type Vec2,
  ZERO4,
} from "./model.ts";
import { createEmitterPaintState } from "./paint.ts";
import { pack, poolSize } from "./record.ts";
import { EMITTER_TYPE, EXTENT, featuresLayout } from "./spec.ts";

const pluginRoot = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, pluginRoot), "utf8");

interface Camera {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
}

interface Preset {
  type: string;
  metadata: {
    "maplibre-plugins:camera": Camera;
    "maplibre-plugins:before"?: string;
  };
  paint: Record<string, unknown>;
}

const files = readdirSync(new URL("examples/", pluginRoot)).filter((file) =>
  file.endsWith(".json"),
);
const presets = new Map(
  files.map((file) => [file, JSON.parse(read(`examples/${file}`)) as Preset]),
);

/** `--name value` pairs; a repeated or valueless flag fails the test. */
function parseFlags(text: string): Map<string, string> {
  const tokens = text.trim().split(/\s+/);
  const flags = new Map<string, string>();
  for (let i = 0; i < tokens.length; i += 2) {
    const [name, value] = [tokens[i]!, tokens[i + 1]];
    expect(name, text).toMatch(/^--[a-z]+$/);
    expect(value, `${name} in ${text}`).toBeDefined();
    expect(flags.has(name), `${name} twice in ${text}`).toBe(false);
    flags.set(name, value!);
  }
  return flags;
}

/**
 * Viewer flags that open `file` at its own camera. The viewer does not read
 * the metadata, and its defaults (bearing 12, pitch 30) are not a preset's,
 * so every camera flag must be there. `mise run //apps/native-viewer:run
 * particles` passes layer.json, so only that file may leave out --layer.
 */
function expectOpensAtCamera(file: string, flags: Map<string, string>) {
  const preset = presets.get(file);
  expect(preset, file).toBeDefined();
  const camera = preset!.metadata["maplibre-plugins:camera"];
  const before = preset!.metadata["maplibre-plugins:before"];
  const expected = new Map<string, string>([
    ["--center", camera.center.join(",")],
    ["--zoom", String(camera.zoom)],
    ["--bearing", String(camera.bearing)],
    ["--pitch", String(camera.pitch)],
  ]);
  if (file !== "layer.json" || flags.has("--layer"))
    expected.set("--layer", `../../plugins/particles/examples/${file}`);
  if (before !== undefined) expected.set("--before", before);
  expect(Object.fromEntries(flags), file).toEqual(Object.fromEntries(expected));
}

describe("the README presets table", () => {
  const readme = read("README.md");
  const section = readme.slice(
    readme.indexOf("## Presets"),
    readme.indexOf("## How it works"),
  );
  const rows = section
    .split("\n")
    .filter((line) => /^\| `[\w-]+\.json`/.test(line))
    .map((line) => {
      const cells = line.split("|").map((cell) => cell.trim());
      return {
        file: /`([\w-]+\.json)`/.exec(cells[1]!)![1]!,
        flags: /^`(.*)`$/.exec(cells[4]!)?.[1],
      };
    });

  it("lists every preset once", () => {
    expect(rows.map((row) => row.file).sort()).toEqual([...files].sort());
  });

  for (const { file, flags } of rows) {
    it(`opens ${file} at its own camera`, () => {
      expect(flags, file).toBeDefined();
      expectOpensAtCamera(file, parseFlags(flags!));
    });
  }
});

describe("the root README", () => {
  it("opens particle presets at their own camera", () => {
    const text = read("../../README.md").replace(/\\\n/g, " ");
    const commands = [
      ...text.matchAll(
        /mise run \/\/apps\/native-viewer:run particles -- (.*)/g,
      ),
    ];
    expect(commands.length).toBeGreaterThan(0);
    for (const [, args] of commands) {
      const flags = parseFlags(args!);
      const layer = /examples\/([\w-]+\.json)$/.exec(
        flags.get("--layer") ?? "examples/layer.json",
      );
      expectOpensAtCamera(layer![1]!, flags);
    }
  });
});

describe("zoom-faded presets", () => {
  it("draw nothing, tint included, where their particles have faded out", () => {
    const faded: string[] = [];
    for (const [file, preset] of presets) {
      if (preset.type !== EMITTER_TYPE) continue;
      const state = createEmitterPaintState(DEFAULT_TRANSITION, preset.paint);
      const center = preset.metadata["maplibre-plugins:camera"].center;
      for (let zoom = 0; zoom <= 22; zoom += 0.25) {
        const paint = state.evaluate(zoom, 0);
        const count = paint["particle-count"][0]!;
        const opacity = paint["particle-opacity"][0]!;
        if (count > 0 && opacity > 0) continue;
        if (!faded.includes(file)) faded.push(file);
        expect(pack(paint, { zoom, center }).visible, `${file} z${zoom}`).toBe(
          false,
        );
      }
    }
    // The README's example of a zoom-faded effect.
    expect(faded).toContain("rain.json");
  });
});

describe("particle-count", () => {
  const NO_WEATHER: ParticleWeather = {
    eye: ZERO4,
    pool0: ZERO4,
    pool1: ZERO4,
    weights: ZERO4,
  };
  const params = (count: number, lifetime: Vec2, interval = 0) =>
    clampParams({
      color: [1, 0.9, 0.6, 1],
      colorEnd: [1, 0.9, 0.6, 1],
      size: [6, 10, 1, 0],
      sizeSpin: [0.5, 128, 0, 0],
      fadeAdd: [0.1, 0.3, 0, 0],
      sparkle: [0, 2, 0, 0],
      timing: [lifetime[0], lifetime[1], interval, 0],
      emission: [count, 0, 1, packIdentity(0, Shape.glow, 1, 0)],
      launch: [20, 40, 0, 90],
      cone: [15, 0, 0, 0],
      air: [0, 0, 0, 0.5],
      area: [0, 0, 0, 0],
    } satisfies ParticleParams);

  /** Alive particles, averaged over a minute, as a share of the count. */
  function aliveShare(lifetime: Vec2, interval = 0): number {
    const count = 900;
    const P = params(count, lifetime, interval);
    const pool = poolSize(count, false);
    let alive = 0;
    let samples = 0;
    for (let time = 0; time < 60; time += 0.37, samples++) {
      for (let index = 0; index < pool; index++) {
        const T = timing(P, NO_WEATHER, emitterSeed(P, index, 0), time);
        if (T.age >= 0 && T.age < T.lifetime) alive += T.keep;
      }
    }
    return alive / samples / count;
  }

  it("keeps about count x mean lifetime / period alive", () => {
    // 75% with the default lifetime [1, 2].
    expect(aliveShare([1, 2])).toBeCloseTo(0.75, 1);
    expect(aliveShare([2, 2])).toBeCloseTo(1, 1);
    // A burst interval longer than every life stretches the period.
    expect(aliveShare([1, 2], 6)).toBeCloseTo(0.25, 1);
  });

  it("shows the whole count up to 15420, and count / 64 fewer at the cap", () => {
    // What a pool of poolSize(count) ranks shows of the count prefix at an
    // integer zoom; a weather octave has half the pool's ranks. These are
    // the numbers of the README (The particle model, Counts) and the
    // particle-count doc.
    const shown = (count: number, weather: boolean) => {
      const ranks = poolSize(count, weather) / (weather ? 2 : 1);
      let sum = 0;
      for (let rank = 0; rank < ranks; rank++)
        sum += prefix(count, rank, count);
      return sum;
    };
    for (const count of [1, 5.5, 60, 64, 256, 1000, 1024, 4096, 15420])
      expect(shown(count, false)).toBeCloseTo(count, 6);
    expect(shown(16384, false)).toBeCloseTo(16128, 6);
    for (const count of [1, 64, 3500, 4096, 7710])
      expect(shown(count, true)).toBeCloseTo(count, 6);
    expect(shown(8192, true)).toBeCloseTo(8064, 6);
    expect(shown(16384, true)).toBeCloseTo(8192, 6);
  });
});

describe("particle-density", () => {
  /**
   * Particles per 100 px of line (kind 4) or per 100 x 100 px of polygon
   * (kind 5), when the covering tile is drawn s times its own size: s runs
   * from 1 at an integer zoom to 2 just below the next.
   */
  function perScreen(kind: 4 | 5, density: number, s: number): number {
    const keys = 8192;
    let kept = 0;
    for (let key = 0; key < keys; key++)
      kept += featureKeep(density, kind, 0, key, 16 / s);
    const spacing =
      kind === 4 ? featuresLayout.lineSlotSpacing : featuresLayout.polygonCell;
    const slotPx = (spacing * 512 * s) / EXTENT;
    const slots = kind === 4 ? 100 / slotPx : (100 / slotPx) ** 2;
    return (slots * kept) / keys;
  }
  const across = [1, 1.25, 1.5, 1.75, 1.999];

  it("holds up to 25 per 100 px of line and 39 per 100 x 100 px of polygon", () => {
    // The keep threshold's soft edge (featureKeep) costs a slot share of
    // 0.01: up to 0.5 per 100 px of line and 1.6 per 100 x 100 px of polygon.
    for (const s of across) {
      for (const density of [8, 25])
        expect(
          Math.abs(perScreen(4, density, s) - density),
          `s ${s}`,
        ).toBeLessThan(1);
      for (const density of [8, 39])
        expect(
          Math.abs(perScreen(5, density, s) - density),
          `s ${s}`,
        ).toBeLessThan(2);
    }
  });

  it("caps lines at 50 falling to 25, and polygons at 156 falling to 39", () => {
    expect(perScreen(4, 100, 1)).toBeCloseTo(50, 0);
    expect(perScreen(4, 100, 1.999)).toBeCloseTo(25, 0);
    // The polygon cap at an integer zoom is above the maximum density.
    expect(Math.abs(perScreen(5, 100, 1) - 100)).toBeLessThan(2);
    expect(perScreen(5, 100, 1.999)).toBeCloseTo(39, 0);
  });

  it("holds at most 16 per point feature", () => {
    let kept = 0;
    for (let rank = 0; rank < featuresLayout.pointSlots; rank++)
      kept += featureKeep(40, 3, rank, rank, 16);
    expect(kept).toBe(16);
  });
});
