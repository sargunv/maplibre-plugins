// spec.ts against ../../spec.json, the schema rules both implementations rely
// on, the shader-side @clamp block, the shared shader mirrors, and the
// example layers.

import { readdirSync, readFileSync } from "node:fs";

import { DEFAULT_TRANSITION } from "@maplibre-plugins/paint";
import { describe, expect, it } from "vite-plus/test";

import {
  ParticleEmitterLayer,
  type ParticleEmitterLayerJson,
} from "./emitter-layer.ts";
import emitterFrame from "./generated/emitter.glsl.ts";
import particleCore from "./generated/particle.glsl.ts";
import shapes from "./generated/shape.glsl.ts";
import { createEmitterPaintState, createFeaturesPaintState } from "./paint.ts";
import { emitterLanes, Lane } from "./record.ts";
import {
  EMITTER_TYPE,
  emitterPaintNames,
  FEATURES_TYPE,
  featuresDataDriven,
  featuresLayout,
  featuresPaintNames,
  isEmitterPaintName,
  type PaintName,
  paintNames,
  paintSpec,
} from "./spec.ts";

const pluginRoot = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, pluginRoot), "utf8");

interface SharedProperty {
  type: string;
  default: unknown;
  minimum?: number;
  maximum?: number;
  values?: string[];
  transition?: boolean;
  expressions?: string;
  components?: { name: string; clamp?: [number, number] }[];
}

interface SharedLayerType {
  sourceFree: boolean;
  paint: string[];
  geometry?: string[];
  dataDriven?: string[];
  layout?: Record<string, number>;
}

interface SharedSpec {
  layerTypes: Record<string, SharedLayerType>;
  paint: Record<string, SharedProperty>;
}

const shared = JSON.parse(read("spec.json")) as SharedSpec;
const emitterType = shared.layerTypes[EMITTER_TYPE]!;
const featuresType = shared.layerTypes[FEATURES_TYPE]!;

/** Keys that document a property for the gallery and README; parity ignores them. */
const DOC_KEYS = new Set(["group", "ui", "units", "doc", "components"]);
/** Floats the emitter's packer clamps from the spec bounds instead of the shader. */
const PACKER_CLAMPED = new Set(["particle-opacity", "emitter-vignette"]);

function isSubsequence(list: readonly string[], of: readonly string[]) {
  const indices = list.map((name) => of.indexOf(name));
  return indices.every(
    (index, i) => index >= 0 && (i === 0 || index > indices[i - 1]!),
  );
}

describe("shared spec", () => {
  it("declares the same layer types", () => {
    expect(Object.keys(shared.layerTypes)).toEqual([
      EMITTER_TYPE,
      FEATURES_TYPE,
    ]);
    expect(emitterType.sourceFree).toBe(true);
    expect(featuresType.sourceFree).toBe(false);
    expect(featuresType.geometry).toEqual(["point", "linestring", "polygon"]);
  });

  it("declares the same canonical properties in the same order", () => {
    expect(paintNames).toEqual(Object.keys(shared.paint));
  });

  it("lists the same properties per type, in host definition order", () => {
    expect(emitterPaintNames).toEqual(emitterType.paint);
    expect(featuresPaintNames).toEqual(featuresType.paint);
    expect(featuresDataDriven).toEqual(featuresType.dataDriven);
    expect(featuresLayout).toEqual(featuresType.layout);
  });

  it("declares the same types, defaults, bounds, values, transitions and expressions", () => {
    const mirrored = JSON.parse(JSON.stringify(paintSpec)) as unknown;
    const expected = Object.fromEntries(
      Object.entries(shared.paint).map(([name, property]) => [
        name,
        Object.fromEntries(
          Object.entries(property).filter(([key]) => !DOC_KEYS.has(key)),
        ),
      ]),
    );
    expect(mirrored).toEqual(expected);
  });
});

describe("schema rules", () => {
  it("lists each type's properties as a subsequence of the canonical order", () => {
    for (const type of [emitterType, featuresType]) {
      expect(isSubsequence(type.paint, paintNames)).toBe(true);
    }
    expect(emitterPaintNames).toEqual(
      paintNames.filter((name) => name !== "particle-density"),
    );
  });

  it("uses every canonical property on some type", () => {
    const used = new Set([...emitterType.paint, ...featuresType.paint]);
    expect(paintNames.filter((name) => !used.has(name))).toEqual([]);
  });

  it("defines every property once, in the canonical table", () => {
    // Layer types only list names, so a property both types take has one
    // definition; both paint states read it from the one table.
    const allowed = new Set([
      "sourceFree",
      "doc",
      "paint",
      "geometry",
      "dataDriven",
      "layout",
    ]);
    for (const type of [emitterType, featuresType]) {
      expect(Object.keys(type).filter((key) => !allowed.has(key))).toEqual([]);
      expect(type.paint.every((name) => typeof name === "string")).toBe(true);
    }
    const emitter = createEmitterPaintState(DEFAULT_TRANSITION, {});
    const features = createFeaturesPaintState(DEFAULT_TRANSITION, {});
    const [a, b] = [emitter.evaluate(12, 0), features.evaluate(12, 0)];
    let both = 0;
    for (const name of featuresPaintNames) {
      if (!isEmitterPaintName(name)) continue;
      expect(a[name], name).toEqual(b[name]);
      both++;
    }
    expect(both).toBe(featuresPaintNames.length - 1);
  });

  it("puts bounds only on floats and clamps only on float2 components", () => {
    for (const [name, property] of Object.entries(shared.paint)) {
      const bounded =
        property.minimum !== undefined || property.maximum !== undefined;
      if (bounded) expect(property.type, name).toBe("float");
      if (property.type === "float2") {
        expect(property.components?.length, name).toBe(2);
        for (const { clamp } of property.components!) {
          if (clamp) expect(clamp[0], name).toBeLessThanOrEqual(clamp[1]);
        }
      } else {
        expect(property.components, name).toBeUndefined();
      }
    }
  });

  it("keeps every default inside its bounds and clamps", () => {
    for (const [name, property] of Object.entries(shared.paint)) {
      const value = property.default;
      switch (property.type) {
        case "float":
          expect(typeof value, name).toBe("number");
          expect(value as number, name).toBeGreaterThanOrEqual(
            property.minimum ?? -Infinity,
          );
          expect(value as number, name).toBeLessThanOrEqual(
            property.maximum ?? Infinity,
          );
          break;
        case "float2":
          (value as number[]).forEach((v, i) => {
            const [lo, hi] = property.components![i]!.clamp ?? [
              -Infinity,
              Infinity,
            ];
            expect(v, name).toBeGreaterThanOrEqual(lo);
            expect(v, name).toBeLessThanOrEqual(hi);
          });
          break;
        case "color":
          expect(value, name).toHaveLength(4);
          for (const v of value as number[]) {
            expect(v, name).toBeGreaterThanOrEqual(0);
            expect(v, name).toBeLessThanOrEqual(1);
          }
          break;
        case "enum":
          expect(property.values, name).toContain(value);
          break;
        case "double2":
          expect(value, name).toHaveLength(2);
          break;
        default:
          throw new Error(`${name}: unknown type ${property.type}`);
      }
    }
  });

  it("never lets an enum take a transition", () => {
    for (const [name, property] of Object.entries(shared.paint)) {
      if (property.type === "enum")
        expect(property.transition, name).toBe(false);
    }
  });

  it("knows only camera and constant expressions, and feature ones on the tile type", () => {
    for (const [name, property] of Object.entries(shared.paint)) {
      expect([undefined, "camera", "constant"], name).toContain(
        property.expressions,
      );
    }
    expect(emitterType.dataDriven).toBeUndefined();
    for (const name of featuresType.dataDriven ?? []) {
      expect(featuresType.paint, name).toContain(name);
      expect(shared.paint[name]!.expressions, name).toBeUndefined();
    }
  });
});

type Bound = number | "-";

/** The `// @clamp <name> <lo> <hi> ...` markers of particle.glsl. */
function clampMarkers(): Map<string, Bound[]> {
  const markers = new Map<string, Bound[]>();
  for (const match of particleCore.matchAll(/^\/\/ @clamp (\S+) (.+)$/gm)) {
    const bounds = match[2]!
      .trim()
      .split(/\s+/)
      .map((v): Bound => (v === "-" ? "-" : Number(v)));
    markers.set(match[1]!, bounds);
  }
  return markers;
}

/** The markers spec.json implies: float bounds and float2 component clamps. */
function expectedMarkers(): Map<string, Bound[]> {
  const markers = new Map<string, Bound[]>();
  for (const [name, property] of Object.entries(shared.paint)) {
    let bounds: Bound[] = [];
    if (property.type === "float" && !PACKER_CLAMPED.has(name)) {
      bounds = [property.minimum ?? "-", property.maximum ?? "-"];
    } else if (property.type === "float2") {
      bounds = property.components!.flatMap(
        ({ clamp }): Bound[] => clamp ?? ["-", "-"],
      );
    }
    if (bounds.some((b) => b !== "-")) markers.set(name, bounds);
  }
  return markers;
}

/** Splits a GLSL argument list at its top-level commas. */
function splitArguments(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

/** A literal argument: a number or floatN(...) of numbers. */
function literals(text: string): number[] {
  const vector = /^float\d\((.*)\)$/.exec(text);
  return (vector ? splitArguments(vector[1]!) : [text]).map(Number);
}

const SWIZZLE = { x: 0, y: 1, z: 2, w: 3 } as const;

/**
 * What particleClampParams clamps: "lane.component" -> [lo, hi], read from
 * its `p.<lane>[.<swizzle>] = clamp(...)` and `= max(...)` statements.
 */
function paramsClamps(): Map<string, [number, number]> {
  const start = particleCore.indexOf("ParticleParams particleClampParams(");
  const body = particleCore.slice(start, particleCore.indexOf("\n}", start));
  const clamps = new Map<string, [number, number]>();
  const lanes = (member: string, swizzle: string | undefined) => {
    const lane = Lane[member as keyof typeof Lane];
    expect(lane, member).toBeDefined();
    return (swizzle ?? "xyzw")
      .split("")
      .map((c) => `${lane}.${SWIZZLE[c as keyof typeof SWIZZLE]}`);
  };
  for (const match of body.matchAll(
    /^\s*p\.(\w+)(?:\.([xyzw]+))? = (clamp|max)\(p\.\1(?:\.\2)?, (.+)\);$/gm,
  )) {
    const [, member, swizzle, fn, rest] = match;
    const args = splitArguments(rest!).map(literals);
    const [lo, hi] = fn === "clamp" ? args : [args[0]!, []];
    lanes(member!, swizzle).forEach((key, i) => {
      clamps.set(key, [lo![i] ?? lo![0]!, hi![i] ?? hi![0] ?? Infinity]);
    });
  }
  // The seed part of the identity: seed + 65536 * class.
  const seed =
    /p\.emission\.w = .*clamp\(floor\(p\.emission\.w[^,]*\), (.+)\);$/m.exec(
      body,
    );
  expect(seed).not.toBeNull();
  const [lo, hi] = splitArguments(seed![1]!).map(Number);
  clamps.set(`${Lane.emission}.3`, [lo!, hi!]);
  return clamps;
}

function glslFloat(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : `${value}`;
}

describe("shader clamps", () => {
  const markers = clampMarkers();

  it("mark every bounded float and clamped float2 with the spec's bounds", () => {
    expect(markers).toEqual(expectedMarkers());
  });

  it("clamp each marked emitter lane in particleClampParams with the marker's literals", () => {
    const expected = new Map<string, [number, number]>();
    const elsewhere: string[] = [];
    for (const [name, bounds] of markers) {
      if (
        !isEmitterPaintName(name) ||
        emitterLanes[name].lane === Lane.placement
      ) {
        elsewhere.push(name);
        continue;
      }
      const entry = emitterLanes[name];
      const component = entry.use === "identity" ? 3 : entry.component;
      for (let i = 0; i < bounds.length / 2; i++) {
        const [lo, hi] = [bounds[2 * i]!, bounds[2 * i + 1]!];
        if (lo === "-" && hi === "-") continue;
        expected.set(`${entry.lane}.${component + i}`, [
          lo === "-" ? -Infinity : lo,
          hi === "-" ? Infinity : hi,
        ]);
      }
    }
    expect(paramsClamps()).toEqual(expected);
    expect(elsewhere).toEqual(["particle-density", "particle-scale"]);
  });

  it("clamp particle-density in the feature keep and particle-scale in the emitter frame", () => {
    const [densityLo, densityHi] = markers.get("particle-density") as number[];
    expect(particleCore).toContain(
      `clamp(density, ${glslFloat(densityLo!)}, ${glslFloat(densityHi!)})`,
    );
    const [scaleLo] = markers.get("particle-scale") as number[];
    expect(emitterFrame).toContain(`max(placement.w, ${glslFloat(scaleLo!)})`);
  });
});

describe("shared shaders", () => {
  it("are generated from the files in shaders/", () => {
    expect(particleCore).toBe(read("shaders/particle.glsl"));
    expect(shapes).toBe(read("shaders/shape.glsl"));
    expect(emitterFrame).toBe(read("shaders/emitter.glsl"));
  });
});

interface ExampleLayer {
  id: string;
  type: string;
  source?: string;
  "source-layer"?: string;
  metadata?: Record<string, unknown>;
  paint: Record<string, unknown>;
}

describe("examples", () => {
  const files = readdirSync(new URL("examples/", pluginRoot)).filter((file) =>
    file.endsWith(".json"),
  );

  it("include the default layer", () => {
    expect(files).toContain("layer.json");
  });

  for (const file of files) {
    it(`${file} is a valid layer with preset metadata`, () => {
      const layer = JSON.parse(read(`examples/${file}`)) as ExampleLayer;
      if (file !== "layer.json") expect(`${layer.id}.json`).toBe(file);
      const type = shared.layerTypes[layer.type];
      expect(type, layer.type).toBeDefined();
      if (type!.sourceFree) {
        expect(layer.source).toBeUndefined();
      } else {
        expect(typeof layer.source).toBe("string");
        expect(typeof layer["source-layer"]).toBe("string");
      }

      const metadata = layer.metadata ?? {};
      expect(typeof metadata["maplibre-plugins:title"]).toBe("string");
      const camera = metadata["maplibre-plugins:camera"] as Record<
        string,
        unknown
      >;
      const [lat, lon] = camera.center as number[];
      expect(Math.abs(lat!)).toBeLessThanOrEqual(90);
      expect(typeof lon).toBe("number");
      for (const key of ["zoom", "bearing", "pitch"])
        expect(typeof camera[key], key).toBe("number");
      const before = metadata["maplibre-plugins:before"];
      if (before !== undefined) expect(typeof before).toBe("string");

      // Every property belongs to the type, and the paint state accepts
      // the values as the native host would (bounds, enum values,
      // constant-only and data-driven properties).
      for (const key of Object.keys(layer.paint)) {
        expect(type!.paint, key).toContain(key.replace(/-transition$/, ""));
      }
      const create =
        layer.type === EMITTER_TYPE
          ? createEmitterPaintState
          : createFeaturesPaintState;
      expect(() => create(DEFAULT_TRANSITION, layer.paint)).not.toThrow();
      if (layer.type === EMITTER_TYPE) {
        const json = ParticleEmitterLayer.fromLayerJson(
          layer as ParticleEmitterLayerJson,
        ).toLayerJson();
        expect([json.id, json.type, json.metadata]).toEqual([
          layer.id,
          layer.type,
          layer.metadata,
        ]);
        expect(json.paint).toMatchObject(layer.paint);
      }

      // Literal float2 values stay inside the clamps the shader applies.
      for (const [key, value] of Object.entries(layer.paint)) {
        const property = shared.paint[key as PaintName];
        if (
          property?.type !== "float2" ||
          typeof (value as unknown[])[0] !== "number"
        )
          continue;
        (value as number[]).forEach((v, i) => {
          const [lo, hi] = property.components![i]!.clamp ?? [
            -Infinity,
            Infinity,
          ];
          expect(v, `${key}[${i}]`).toBeGreaterThanOrEqual(lo);
          expect(v, `${key}[${i}]`).toBeLessThanOrEqual(hi);
        });
      }
    });
  }
});
