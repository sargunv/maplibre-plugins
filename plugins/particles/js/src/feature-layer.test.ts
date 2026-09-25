// The particle-features JS layer without a GPU: tile parsing as the host
// reads tiles, per-feature values as the host's binders fill them, the
// program variants against the native binding tables, and the layer's JSON.

import { readdirSync, readFileSync } from "node:fs";

import { VectorTile } from "@mapbox/vector-tile";
import {
  attributeLayout,
  DEFAULT_TRANSITION,
  isFeatureValue,
} from "@maplibre-plugins/paint";
import type { FilterSpecification } from "@maplibre/maplibre-gl-style-spec";
import type {
  CustomRenderMethodInput,
  Map as MaplibreMap,
  OverscaledTileID,
} from "maplibre-gl";
import { PbfReader, PbfWriter } from "pbf";
import { describe, expect, it } from "vite-plus/test";

import { fakeGL } from "./fake-gl.ts";
import {
  ParticleFeaturesLayer,
  type ParticleFeaturesLayerJson,
} from "./feature-layer.ts";
import { createFeaturesPaintState, featuresPaintSpec } from "./paint.ts";
import {
  dataDrivenAttributes,
  featureBindings,
  featureMembers,
  featuresVertexSource,
  propertyMacro,
  variantDefines,
  variantMask,
} from "./shaders-features.ts";
import {
  featuresDataDriven,
  featuresPaintNames,
  type PaintName,
  paintSpec,
} from "./spec.ts";
import {
  compileFilter,
  GEOJSON_SOURCE_LAYER,
  layoutTile,
  tileAttributes,
  tileGeometry,
  type TileLayout,
} from "./tiles.ts";

const pluginRoot = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, pluginRoot), "utf8");

// ---------------------------------------------------------------------------
// A minimal Mapbox Vector Tile writer, for tiles with known features.
// ---------------------------------------------------------------------------

interface TestFeature {
  id?: number;
  type: 1 | 2 | 3;
  properties?: Record<string, string | number | boolean>;
  /** Paths in the layer's extent: one per point, line or ring. */
  paths: [number, number][][];
}

interface TestLayer {
  name: string;
  extent?: number;
  features: TestFeature[];
}

const zigzag = (n: number) => (n << 1) ^ (n >> 31);
const command = (id: number, count: number) => (id & 7) | (count << 3);

function geometry(feature: TestFeature): number[] {
  const out: number[] = [];
  let x = 0;
  let y = 0;
  const moveTo = ([px, py]: [number, number]) => {
    out.push(zigzag(px - x), zigzag(py - y));
    x = px;
    y = py;
  };
  if (feature.type === 1) {
    const points = feature.paths.flat();
    out.push(command(1, points.length));
    points.forEach(moveTo);
    return out;
  }
  for (const path of feature.paths) {
    out.push(command(1, 1));
    moveTo(path[0]!);
    out.push(command(2, path.length - 1));
    path.slice(1).forEach(moveTo);
    if (feature.type === 3) out.push(command(7, 1));
  }
  return out;
}

function vectorTile(layers: TestLayer[]): ArrayBuffer {
  const pbf = new PbfWriter();
  for (const layer of layers) {
    pbf.writeMessage(
      3,
      (l: TestLayer, w) => {
        w.writeVarintField(15, 2);
        w.writeStringField(1, l.name);
        const keys: string[] = [];
        const values: (string | number | boolean)[] = [];
        for (const feature of l.features) {
          const tags: number[] = [];
          for (const [key, value] of Object.entries(feature.properties ?? {})) {
            if (!keys.includes(key)) keys.push(key);
            if (!values.includes(value)) values.push(value);
            tags.push(keys.indexOf(key), values.indexOf(value));
          }
          w.writeMessage(
            2,
            (f: TestFeature, fw) => {
              if (f.id !== undefined) fw.writeVarintField(1, f.id);
              fw.writePackedVarint(2, tags);
              fw.writeVarintField(3, f.type);
              fw.writePackedVarint(4, geometry(f));
            },
            feature,
          );
        }
        for (const key of keys) w.writeStringField(3, key);
        for (const value of values) {
          w.writeMessage(
            4,
            (v: string | number | boolean, vw) => {
              if (typeof v === "string") vw.writeStringField(1, v);
              else if (typeof v === "boolean") vw.writeBooleanField(7, v);
              else vw.writeDoubleField(3, v);
            },
            value,
          );
        }
        w.writeVarintField(5, l.extent ?? 4096);
      },
      layer,
    );
  }
  const bytes = pbf.finish();
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

const CANONICAL = { z: 14, x: 2620, y: 6332 };

const poiTile = () =>
  vectorTile([
    {
      name: "poi",
      features: [
        {
          id: 1,
          type: 1,
          properties: { class: "shop", rank: 3 },
          paths: [[[100, 200]]],
        },
        // Owned by the neighbouring tile: no slots, no range.
        {
          id: 2,
          type: 1,
          properties: { class: "cafe", rank: 5 },
          paths: [[[4096, 10]]],
        },
        {
          id: 3,
          type: 1,
          properties: { class: "museum", rank: 20 },
          paths: [[[300, 300]]],
        },
        {
          id: 4,
          type: 1,
          properties: { class: "museum", rank: 1 },
          paths: [[[1000, 1000]]],
        },
      ],
    },
    {
      name: "water",
      features: [
        {
          type: 3,
          properties: { class: "lake" },
          paths: [
            [
              [0, 0],
              [512, 0],
              [512, 512],
              [0, 512],
              [0, 0],
            ],
          ],
        },
        {
          type: 2,
          properties: { class: "river" },
          paths: [
            [
              [100, 1000],
              [900, 1000],
            ],
          ],
        },
      ],
    },
  ]);

describe("tiles", () => {
  it("lays out one source layer's features in tile order, filtered at the tile's zoom", () => {
    const filter = compileFilter([
      "all",
      ["<=", ["get", "rank"], 14],
      [">=", ["zoom"], 15],
    ]);
    const tile = layoutTile(poiTile(), "poi", filter, 15, CANONICAL)!;
    expect(tile.ranges).toEqual([
      { featureIndex: 0, firstVertex: 0, vertexCount: 64 },
      { featureIndex: 3, firstVertex: 64, vertexCount: 64 },
    ]);
    expect([tile.quads, tile.vertexCount]).toEqual([32, 128]);
    // Layer extent 4096 scales to the host's 8192.
    expect(Array.from(tile.vertices.subarray(0, 4))).toEqual([200, 400, 0, 0]);
    expect(Array.from(tile.vertices.subarray(64 * 4, 64 * 4 + 4))).toEqual([
      2000, 2000, 0, 0,
    ]);
    expect(tile.features).toEqual([
      { type: 1, id: 1, properties: { class: "shop", rank: 3 } },
      { type: 1, id: 4, properties: { class: "museum", rank: 1 } },
    ]);
    // Below the filter's zoom nothing passes.
    expect(layoutTile(poiTile(), "poi", filter, 14, CANONICAL)!.quads).toBe(0);
  });

  it("takes points, lines and polygons, and reports a missing layer", () => {
    const tile = layoutTile(poiTile(), "water", null, 14, CANONICAL)!;
    expect(tile.ranges.map((r) => r.featureIndex)).toEqual([0, 1]);
    // The line piece: 1600 units long, 50 slots at its midpoint facing east.
    expect(tile.ranges[1]!.vertexCount).toBe(4 * 50);
    const first = tile.ranges[1]!.firstVertex * 4;
    expect(Array.from(tile.vertices.subarray(first, first + 4))).toEqual([
      1000,
      2000,
      256 * 8192 + 800,
      1,
    ]);
    expect(layoutTile(poiTile(), "roads", null, 14, CANONICAL)).toBeNull();
  });

  it("scales geometry like MapLibre Native: roundf in f32, int16 or nothing", () => {
    const tile = (extent: number, paths: [number, number][][]) => {
      const data = vectorTile([
        { name: "l", extent, features: [{ type: 2, paths }] },
      ]);
      return new VectorTile(new PbfReader(data)).layers.l!.feature(0);
    };
    // Halves round away from zero, and -0 becomes 0.
    expect(
      tileGeometry(
        tile(16384, [
          [
            [-3, 5],
            [-1, 1],
            [0, 3],
          ],
        ]),
      ),
    ).toEqual([
      [
        { x: -2, y: 3 },
        { x: -1, y: 1 },
        { x: 0, y: 2 },
      ],
    ]);
    expect(
      tileGeometry(
        tile(3, [
          [
            [1, 2],
            [-1, 3],
          ],
        ]),
      ),
    ).toEqual([
      [
        { x: 2731, y: 5461 },
        { x: -2731, y: 8192 },
      ],
    ]);
    expect(
      tileGeometry(
        tile(4096, [
          [
            [0, 0],
            [20000, 0],
          ],
        ]),
      ),
    ).toEqual([]);
  });

  it("decodes the nested values maplibre-gl encodes into GeoJSON tiles", () => {
    const data = vectorTile([
      {
        name: GEOJSON_SOURCE_LAYER,
        extent: 8192,
        features: [
          {
            type: 1,
            properties: { tags: `__$json__:{"kind":"fountain"}`, name: "a" },
            paths: [[[10, 10]]],
          },
        ],
      },
    ]);
    const tile = layoutTile(data, GEOJSON_SOURCE_LAYER, null, 14, CANONICAL)!;
    expect(tile.features[0]!.properties).toEqual({
      tags: { kind: "fountain" },
      name: "a",
    });
  });
});

describe("feature values", () => {
  const tile = layoutTile(poiTile(), "poi", null, 15, CANONICAL)!;
  // All four data-driven properties as feature expressions, kept here rather
  // than read from examples/poi-sparkles.json so tuning the preset does not
  // move these expectations.
  const poi: { paint: Record<string, unknown> } = {
    paint: {
      "particle-density": [
        "interpolate",
        ["linear"],
        ["get", "rank"],
        1,
        10,
        14,
        2,
      ],
      "particle-color": [
        "match",
        ["get", "class"],
        "shop",
        "#ffd36b",
        ["restaurant", "cafe", "bar"],
        "#ff9f6e",
        "#9fe3ff",
      ],
      "particle-shape": [
        "match",
        ["get", "class"],
        ["attraction", "museum"],
        "star",
        "spark",
      ],
      "particle-size": [
        "match",
        ["get", "class"],
        ["attraction", "museum"],
        ["literal", [4, 7]],
        ["literal", [2.5, 4.5]],
      ],
    },
  };
  /** A tile's attributes for `paint`, and each bound property's (min, max) at a vertex. */
  const fill = (
    paint: Record<string, unknown>,
    target: Pick<TileLayout, "vertexCount" | "ranges" | "features"> = tile,
  ) => {
    const current = createFeaturesPaintState(DEFAULT_TRANSITION, paint).current(
      15,
      0,
    );
    const layout = attributeLayout(featuresDataDriven, current);
    const values = tileAttributes(target, layout, current, 15);
    const at = (name: (typeof featuresDataDriven)[number], vertex: number) => {
      const offset = vertex * layout.stride + layout.offsets[name]!;
      const width = 2 * (current[name] as { components: number }).components;
      return Array.from(values.subarray(offset, offset + width));
    };
    return { current, layout, values, at };
  };

  it("gives every vertex of a feature that feature's value, as (min, max)", () => {
    const { layout, values, at } = fill(poi.paint);
    // Interleaved in the data-driven order: density, shape, size, color.
    expect(layout.bound).toEqual(featuresDataDriven);
    expect(layout.offsets).toEqual({
      "particle-density": 0,
      "particle-shape": 2,
      "particle-size": 4,
      "particle-color": 8,
    });
    expect(values.length).toBe(16 * tile.vertexCount);
    // #ffd36b for the shop, #9fe3ff for the museum, premultiplied (alpha 1).
    const shop = [1, 0xd3 / 255, 0x6b / 255, 1];
    const other = [0x9f / 255, 0xe3 / 255, 1, 1];
    for (const v of [0, 63])
      expect(at("particle-color", v)).toEqual(
        [...shop, ...shop].map((c) => Math.fround(c)),
      );
    for (const v of [64, 127])
      expect(at("particle-color", v)).toEqual(
        [...other, ...other].map((c) => Math.fround(c)),
      );

    expect(at("particle-size", 0)).toEqual([2.5, 4.5, 2.5, 4.5]);
    expect(at("particle-size", 64)).toEqual([4, 7, 4, 7]);
    // Enums carry their index: star for museums, spark otherwise.
    const shapes = paintSpec["particle-shape"].values as readonly string[];
    expect(at("particle-shape", 0)).toEqual(
      Array(2).fill(shapes.indexOf("spark")),
    );
    expect(at("particle-shape", 64)).toEqual(
      Array(2).fill(shapes.indexOf("star")),
    );
    // rank 3 on the curve from (1, 10) to (14, 2).
    expect(at("particle-density", 0)).toEqual(
      Array(2).fill(Math.fround(10 - 16 / 13)),
    );
  });

  it("evaluates a zoom-and-feature value at the tile's zoom and the next", () => {
    const { current, layout, at } = fill({
      "particle-density": [
        "interpolate",
        ["linear"],
        ["zoom"],
        15,
        ["get", "rank"],
        16,
        ["*", 2, ["get", "rank"]],
      ],
    });
    const density = current["particle-density"];
    if (!isFeatureValue(density)) throw new Error("expected a feature value");
    expect(density.zoomDependent).toBe(true);
    expect(layout.bound).toEqual(["particle-density"]);
    expect(layout.stride).toBe(2);
    // The shop (rank 3), then the museums (ranks 20 and 1).
    expect(at("particle-density", 0)).toEqual([3, 6]);
    expect(at("particle-density", 64)).toEqual([20, 40]);
    expect(at("particle-density", 128)).toEqual([1, 2]);
    expect(density.factor(15, 15.25)).toBe(0.25);
  });

  it("binds only the paint state's data-driven values", () => {
    expect(fill(poi.paint).layout.bound).toEqual(featuresDataDriven);
    const flat = fill({ "particle-color": "#fff" });
    expect(flat.layout.bound).toEqual([]);
    expect(flat.layout.key).toBe("1111");
    expect(flat.values.length).toBe(0);
  });

  it("takes feature expressions only where native declares them, and never feature-state", () => {
    for (const name of featuresPaintNames) {
      const spec = featuresPaintSpec[name];
      const dataDriven = (featuresDataDriven as readonly string[]).includes(
        name,
      );
      expect(spec.expressions === "data-driven", name).toBe(dataDriven);
      if (dataDriven) expect(spec.featureState, name).toBe(false);
    }
    expect(() =>
      createFeaturesPaintState(DEFAULT_TRANSITION, {
        "particle-gravity": ["get", "g"],
      }),
    ).toThrow("expression dependencies are not supported");
    expect(() =>
      createFeaturesPaintState(DEFAULT_TRANSITION, {
        "particle-size": [
          "coalesce",
          ["feature-state", "size"],
          ["literal", [1, 2]],
        ],
      }),
    ).toThrow("expression dependencies are not supported");
    expect(() =>
      createFeaturesPaintState(DEFAULT_TRANSITION, {
        "particle-lifetime": [
          "step",
          ["zoom"],
          ["literal", [1, 2]],
          10,
          ["literal", [3, 4]],
        ],
      }),
    ).toThrow("expression dependencies are not supported");
  });

  it("covers an empty tile", () => {
    const empty = { vertexCount: 0, ranges: [], features: [] };
    expect(fill(poi.paint, empty).values.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Program variants.
// ---------------------------------------------------------------------------

/** The native tables in properties.zig and shaders.zig, read as text. */
function nativeBindings(): {
  name: string;
  field: string;
  attribute: number;
}[] {
  const text = read("native/src/properties.zig");
  const table = text.slice(text.indexOf("pub const feature_bindings"));
  return [
    ...table
      .slice(0, table.indexOf("};"))
      .matchAll(
        /\.name = "([^"]+)", \.field = "([^"]+)", \.attribute = (\d+)/g,
      ),
  ].map(([, name, field, attribute]) => ({
    name: name!,
    field: field!,
    attribute: Number(attribute),
  }));
}

function nativeMembers(): [string, string][] {
  const text = read("native/src/shaders.zig");
  const table = text.slice(text.indexOf("const feature_members"));
  return [
    ...table
      .slice(0, table.indexOf("};"))
      .matchAll(/\.type = "([^"]+)", \.name = "([^"]+)"/g),
  ].map(([, type, name]) => [type!, name!]);
}

/**
 * The attribute declarations a GLSL preprocessor keeps: evaluates #define,
 * #if NAME, #if !NAME, #ifdef, #else and #endif, and fails on anything else.
 */
function activeAttributes(source: string, predefined: string[] = []) {
  const macros = new Map<string, string>(predefined.map((m) => [m, "1"]));
  const stack: boolean[] = [];
  const attributes: [number, string, string][] = [];
  const active = () => stack.every(Boolean);
  for (const line of source.split("\n")) {
    const directive = line.trim().match(/^#\s*(\w+)\s*(.*)$/);
    if (directive) {
      const [, name, rest] = directive as unknown as [string, string, string];
      if (name === "define") {
        if (active()) {
          const [macro, ...value] = rest.split(/\s+/);
          macros.set(macro!, value.join(" "));
        }
      } else if (name === "if") {
        const m = rest.match(/^(!?)(\w+)$/);
        if (!m) throw new Error(`unsupported #if ${rest}`);
        const value = macros.get(m[2]!);
        if (value === undefined) throw new Error(`undefined macro ${m[2]}`);
        const truthy = Number(value) !== 0;
        stack.push(m[1] ? !truthy : truthy);
      } else if (name === "ifdef") stack.push(macros.has(rest.trim()));
      else if (name === "ifndef") stack.push(!macros.has(rest.trim()));
      else if (name === "else") stack.push(!stack.pop()!);
      else if (name === "endif") stack.pop();
      else if (name !== "version") throw new Error(`unsupported #${name}`);
      continue;
    }
    const attribute = line.match(/^layout\(location=(\d+)\) in (\w+) (\w+);$/);
    if (attribute && active())
      attributes.push([Number(attribute[1]), attribute[2]!, attribute[3]!]);
  }
  expect(stack).toEqual([]);
  return attributes;
}

describe("program variants", () => {
  it("bind the properties like the native plugin", () => {
    expect(featureBindings.map((b) => b.name)).toEqual(featuresPaintNames);
    expect(featureBindings).toEqual(nativeBindings());
  });

  it("declare native's uniform block members, less the tile matrix and padding", () => {
    expect(featureMembers.map(([type, name]) => [type, name])).toEqual(
      nativeMembers().filter(([, name]) => name !== "matrix" && name !== "pad"),
    );
  });

  it("put the data-driven properties first, a color's max after its min", () => {
    expect(
      dataDrivenAttributes.map((a) => [a.name, a.location, a.width, a.binding]),
    ).toEqual([
      ["particle-density", 4, 1, 0],
      ["particle-shape", 5, 1, 7],
      ["particle-size", 3, 2, 8],
      ["particle-color", 1, 4, 10],
    ]);
  });

  for (let mask = 0; mask < 16; mask++) {
    const names = featuresDataDriven.filter((_, bit) => mask & (1 << bit));
    it(`declare only a_emit and ${names.join(", ") || "no feature values"}`, () => {
      expect(variantMask(names)).toBe(mask);
      const defines = variantDefines(mask);
      for (const name of featuresPaintNames) {
        const uniform = !(names as readonly string[]).includes(name);
        expect(defines).toContain(
          `#define ${propertyMacro(name)} ${uniform ? 1 : 0}\n`,
        );
      }
      const expected: [number, string, string][] = [[0, "vec4", "a_emit"]];
      for (const attribute of dataDrivenAttributes) {
        if (!(mask & (1 << attribute.bit))) continue;
        const stem = `a_particle_${attribute.name.slice("particle-".length)}`;
        if (attribute.width === 4) {
          expected.push([attribute.location, "vec4", `${stem}_min`]);
          expected.push([attribute.location + 1, "vec4", `${stem}_max`]);
        } else {
          const type = attribute.width === 1 ? "vec2" : "vec4";
          expected.push([attribute.location, type, stem]);
        }
      }
      const source = featuresVertexSource("", "", mask);
      expect(activeAttributes(source).sort((a, b) => a[0] - b[0])).toEqual(
        expected.sort((a, b) => a[0] - b[0]),
      );
      // Globe builds keep the horizon cull.
      expect(featuresVertexSource("", "#define GLOBE", mask)).toContain(
        "o = particleCollapsed();",
      );
      expect(activeAttributes(source, ["GLOBE"])).toHaveLength(expected.length);
    });
  }

  it("fill every lane from the spec defaults of the properties features lacks", () => {
    const source = featuresVertexSource("", "", 0);
    for (const name of Object.keys(paintSpec) as PaintName[]) {
      if ((featuresPaintNames as readonly string[]).includes(name)) continue;
      const macro = `PARTICLE_DEFAULT_${name.toUpperCase().replace(/-/g, "_")}`;
      expect(source).toContain(`#define ${macro} `);
    }
    expect(source).toContain("#define PARTICLE_DEFAULT_PARTICLE_SPACE 1.0\n");
    expect(source).toContain(
      "float packedIdentity = 4194304.0 * 3.0 + 1048576.0 * PARTICLE_DEFAULT_PARTICLE_SPACE + PARTICLE_DEFAULT_PARTICLE_SEED + 65536.0 * clamp(floor(p_shape + 0.5), 0.0, 9.0);",
    );
    expect(source).toContain("    P.colorEnd = p_color;\n");
    expect(source).toContain(
      "ParticleSeed S = particleFeatureSeed(emit, p_density, ptu);",
    );
  });
});

// ---------------------------------------------------------------------------
// The layer's JSON.
// ---------------------------------------------------------------------------

describe("ParticleFeaturesLayer", () => {
  const presets = readdirSync(new URL("examples/", pluginRoot))
    .map((file) => JSON.parse(read(`examples/${file}`)) as { type: string })
    .filter((layer) => layer.type === "particle-features");

  it("has feature presets", () => {
    expect(presets.length).toBeGreaterThan(0);
  });

  for (const preset of presets as ParticleFeaturesLayerJson[]) {
    it(`round-trips ${preset.id}`, () => {
      const json = ParticleFeaturesLayer.fromLayerJson(preset).toLayerJson();
      const { paint, ...rest } = json;
      const { paint: presetPaint, ...presetRest } = preset;
      expect(rest).toEqual(presetRest);
      expect(paint).toMatchObject(presetPaint!);
      expect(Object.keys(paint!)).toEqual(featuresPaintNames);
    });
  }

  it("takes a GeoJSON source without a source layer", () => {
    const layer = ParticleFeaturesLayer.fromLayerJson({
      id: "points",
      type: "particle-features",
      source: "geojson",
    });
    expect(layer.sourceLayer).toBeUndefined();
    expect(layer.toLayerJson()["source-layer"]).toBeUndefined();
  });

  it("rejects what the native plugin rejects", () => {
    const base = { id: "x", source: "s", "source-layer": "l" };
    expect(() =>
      ParticleFeaturesLayer.fromLayerJson({
        ...base,
        type: "particle-emitter",
      } as unknown as ParticleFeaturesLayerJson),
    ).toThrow(/Expected layer type/);
    // The host fails the whole layer on a paint key the type lacks: an
    // emitter-only property, a misspelt one, or either's transition.
    for (const paint of [
      { "particle-opacity": 0.2 },
      { "particle-colour": "#f00" },
      { "particle-drag-transition": { duration: 5 } },
      { "particle-colour-transition": { duration: 5 } },
    ]) {
      expect(
        () =>
          ParticleFeaturesLayer.fromLayerJson({
            ...base,
            type: "particle-features",
            paint,
          } as ParticleFeaturesLayerJson),
        Object.keys(paint)[0],
      ).toThrow(/Unknown paint property/);
    }
    expect(() =>
      ParticleFeaturesLayer.fromLayerJson({
        ...base,
        type: "particle-features",
        paint: { "particle-shape-transition": { duration: 0 } },
      } as ParticleFeaturesLayerJson),
    ).toThrow(/takes no transition/);
    const layer = ParticleFeaturesLayer.fromLayerJson({
      ...base,
      type: "particle-features",
      paint: {
        "particle-density": 4,
        "particle-density-transition": { duration: 0 },
      },
    });
    // Emitter-only properties, and transitions on enums and constants.
    expect(() => layer.setPaintProperty("particle-drag", 1)).toThrow();
    expect(() =>
      layer.setPaintProperty("particle-shape-transition", { duration: 0 }),
    ).toThrow();
    expect(() =>
      layer.setPaintProperty("particle-density", ["get", "rank"]),
    ).not.toThrow();
    expect(() =>
      layer.setPaintProperty("particle-speed", [
        "match",
        ["get", "class"],
        "river",
        ["literal", [1, 2]],
        ["literal", [3, 4]],
      ]),
    ).toThrow();
    expect(() =>
      layer.setFilter(["==", 1] as unknown as FilterSpecification),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Rendering, against a fake GL and map.
// ---------------------------------------------------------------------------

/** What maplibre-gl hands a 2D custom layer's render, with blank matrices. */
const renderArgs = {
  shaderData: { variantName: "mercator", vertexShaderPrelude: "", define: "" },
  getProjectionData: () => ({
    mainMatrix: new Float32Array(16),
    fallbackMatrix: new Float32Array(16),
    tileMercatorCoords: [0, 0, 1, 1],
    clippingPlane: [0, 0, 0, 0],
    projectionTransition: 0,
  }),
} as unknown as CustomRenderMethodInput;

/** A map at zoom 15.5 whose source "src" shows four tiles of poiTile(). */
function fakeMap() {
  const raw = poiTile();
  const shown = [0, 1, 2, 3].map((i) => ({
    key: `15/${i}`,
    wrap: 0,
    overscaledZ: 15,
    canonical: { z: 15, x: 5240 + i, y: 12664 },
  })) as unknown as OverscaledTileID[];
  const state = { coords: shown, removed: false };
  const manager = {
    getVisibleCoordinates: () => state.coords,
    getTileByID: () => ({
      hasData: () => true,
      latestRawTileData: raw,
      latestEncoding: "mvt",
    }),
  };
  const map = {
    painter: {
      transform: {
        zoom: 15.5,
        width: 800,
        height: 600,
        cameraToCenterDistance: 900,
      },
    },
    get style() {
      return { tileManagers: state.removed ? {} : { src: manager } };
    },
    triggerRepaint() {},
    on() {},
    off() {},
  } as unknown as MaplibreMap;
  return { map, state, shown };
}

describe("ParticleFeaturesLayer rendering", () => {
  const setup = () => {
    const fake = fakeGL();
    const { map, state, shown } = fakeMap();
    const layer = new ParticleFeaturesLayer({
      id: "p",
      source: "src",
      sourceLayer: "poi",
    });
    layer.onAdd(map, fake.gl);
    const frames = (n: number) => {
      for (let i = 0; i < n; i++) layer.render(fake.gl, renderArgs);
    };
    return { fake, layer, state, shown, frames };
  };
  // The shared index pattern, and a vertex array and a buffer per tile.
  const INDICES = 1;
  const DRAWN = INDICES + 2 * 4;

  it("leaves depth to maplibre, read-only at its sublayer like native's", () => {
    const { fake, frames } = setup();
    frames(1);
    const { gl, calls } = fake;
    expect(calls.filter((c) => c.name === "drawElements")).toHaveLength(4);
    const depth = calls.filter(
      (c) =>
        c.name.startsWith("depth") ||
        ((c.name === "enable" || c.name === "disable") &&
          c.args[0] === gl.DEPTH_TEST),
    );
    expect(depth).toEqual([]);
  });

  it("keeps no CPU copy of a tile's vertices once they are uploaded", () => {
    const { fake, layer, frames } = setup();
    frames(1);
    const { gl, calls } = fake;
    const uploads = calls.filter(
      (c) => c.name === "bufferData" && c.args[0] === gl.ARRAY_BUFFER,
    );
    // Three points of 16 slots, four vertices of four floats each.
    expect(uploads.map((c) => (c.args[1] as Float32Array).length)).toEqual(
      Array(4).fill(3 * 16 * 16),
    );
    const entries = [...layer["resources"]!.tiles.values()];
    expect(entries).toHaveLength(4);
    for (const entry of entries) {
      expect(entry.layout?.vertexCount).toBe(3 * 16 * 4);
      expect(entry.layout).not.toHaveProperty("vertices");
    }
  });

  it("lets cached tiles go while it draws nothing, after the same grace", () => {
    const { fake, layer, state, shown, frames } = setup();
    frames(10);
    expect(fake.live()).toBe(DRAWN);

    // Hidden: the tiles outlive a brief toggle, then go.
    layer.setLayoutProperty("visibility", "none");
    frames(100);
    expect(fake.live()).toBe(DRAWN);
    frames(100);
    expect(fake.live()).toBe(INDICES);
    layer.setLayoutProperty("visibility", "visible");
    frames(1);
    expect(fake.live()).toBe(DRAWN);

    // Past the layer's maxzoom.
    layer.setZoomRange(0, 15);
    frames(200);
    expect(fake.live()).toBe(INDICES);
    layer.setZoomRange(0, 24);
    frames(1);
    expect(fake.live()).toBe(DRAWN);

    // The source shows no tiles (its companion layer hidden, say).
    state.coords = [];
    frames(200);
    expect(fake.live()).toBe(INDICES);
    state.coords = shown;
    frames(1);
    expect(fake.live()).toBe(DRAWN);

    // A removed source's tiles go at once.
    state.removed = true;
    frames(1);
    expect(fake.live()).toBe(INDICES);
  });

  it("binds data-driven values from one interleaved buffer per tile, refilled only when they change", () => {
    const { fake, layer, frames } = setup();
    const { gl, calls } = fake;
    const paintUploads = () =>
      calls
        .filter(
          (c) =>
            c.name === "bufferData" &&
            c.args[0] === gl.ARRAY_BUFFER &&
            (c.args[1] as Float32Array).length !== 3 * 16 * 16,
        )
        .map((c) => (c.args[1] as Float32Array).length);
    const pointers = () =>
      calls
        // Location 0 is a_emit, in the tile's own buffer.
        .filter((c) => c.name === "vertexAttribPointer" && c.args[0] !== 0)
        .map((c) => [c.args[0], c.args[1], c.args[4], c.args[5]]);
    const vertices = 3 * 16 * 4;

    layer.setPaint({
      "particle-size": [
        "match",
        ["get", "class"],
        "shop",
        ["literal", [1, 2]],
        ["literal", [3, 4]],
      ],
      "particle-color": ["match", ["get", "class"], "shop", "red", "blue"],
    });
    frames(1);
    // Size (2 + 2 floats) then color (4 + 4): 12 floats per vertex.
    expect(paintUploads()).toEqual(Array(4).fill(12 * vertices));
    const locations = Object.fromEntries(
      dataDrivenAttributes.map((a) => [a.name, a.location]),
    );
    const size = locations["particle-size"]!;
    const color = locations["particle-color"]!;
    const perTile = [
      // location, components, stride in bytes, offset in bytes
      [size, 4, 48, 0],
      [color, 4, 48, 16],
      [color + 1, 4, 48, 32],
    ];
    expect(pointers()).toEqual(Array(4).fill(perTile).flat());

    // Nothing changes: nothing is filled again.
    calls.length = 0;
    frames(3);
    expect(paintUploads()).toEqual([]);
    expect(pointers()).toEqual([]);

    // A constant size without a transition unbinds it at once (with one,
    // the host keeps the per-feature values until it ends), and only color
    // stays.
    layer.setPaintProperty("particle-size", [1, 2], { duration: 0 });
    calls.length = 0;
    frames(1);
    expect(paintUploads()).toEqual(Array(4).fill(8 * vertices));
    expect(pointers()).toEqual(
      Array(4)
        .fill([
          [color, 4, 32, 0],
          [color + 1, 4, 32, 16],
        ])
        .flat(),
    );
    expect(
      calls.filter(
        (c) => c.name === "disableVertexAttribArray" && c.args[0] === size,
      ),
    ).toHaveLength(4);

    // Back to uniform values: the paint buffers go.
    layer.setPaintProperty("particle-color", "white", { duration: 0 });
    frames(1);
    expect(fake.live()).toBe(DRAWN);
  });
});
