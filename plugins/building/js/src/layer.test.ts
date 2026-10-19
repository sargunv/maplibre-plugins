import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { CustomRenderMethodInput, Map as MaplibreMap } from "maplibre-gl";
import { describe, expect, it } from "vite-plus/test";

import type { VectorFeatureLike, VectorLayerLike } from "./gljs.ts";
import { BuildingLayer, type BuildingLayerJson } from "./layer.ts";
import { DRAWABLE_BINDING, DRAWABLE_UBO_BYTES } from "./shaders.ts";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const example = JSON.parse(
  readFileSync(join(pluginRoot, "examples", "layer.json"), "utf8"),
) as BuildingLayerJson;

// ---------------------------------------------------------------------------
// Test doubles: a WebGL2 context that records its calls, decoded tiles, and
// the slice of a maplibre-gl map the layer touches.
// ---------------------------------------------------------------------------

interface Call {
  name: string;
  args: unknown[];
}

function fakeGl(): { gl: WebGL2RenderingContext; calls: Call[] } {
  const calls: Call[] = [];
  let next = 1;
  const answers: Record<string, (...args: unknown[]) => unknown> = {
    isContextLost: () => false,
    getParameter: (name) =>
      name === "UNIFORM_BUFFER_OFFSET_ALIGNMENT" ? 256 : null,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getUniformBlockIndex: () => 0,
    getUniformLocation: (_, name) => ({ id: next++, name }),
  };
  const values: Record<string, unknown> = { INVALID_INDEX: -1 };
  const gl = new Proxy(
    {},
    {
      get(_, prop) {
        if (typeof prop !== "string") return undefined;
        if (prop in values) return values[prop];
        if (/^[A-Z0-9_]+$/.test(prop)) return prop;
        return (...args: unknown[]) => {
          calls.push({ name: prop, args });
          const answer = answers[prop];
          return answer ? answer(...args) : { id: next++ };
        };
      },
    },
  );
  return { gl: gl as WebGL2RenderingContext, calls };
}

type Ring = { x: number; y: number }[];

const rect = (x: number, y: number, w: number, h: number): Ring[] => [
  [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
    { x, y },
  ],
];

interface TestFeature {
  id?: number;
  properties: Record<string, unknown>;
  rings: Ring[];
}

function layerOf(features: TestFeature[]): VectorLayerLike {
  return {
    length: features.length,
    feature: (i): VectorFeatureLike => {
      const f = features[i]!;
      return {
        type: 3,
        ...(f.id !== undefined && { id: f.id }),
        properties: f.properties,
        extent: 8192,
        loadGeometry: () => f.rings,
      };
    },
  };
}

const COORD = {
  key: "16/0/0",
  wrap: 0,
  overscaledZ: 16,
  canonical: { z: 16, x: 0, y: 0 },
};

/** Tile units to clip space looking straight down; w = 1 - z / 1000. */
const MATRIX = [
  2 / 8192,
  0,
  0,
  0,
  0,
  -2 / 8192,
  0,
  0,
  0,
  0,
  -1e-2,
  -1e-3,
  -1,
  1,
  0.5,
  1,
];

function fakeMap(features: TestFeature[]) {
  const state = {
    revision: 0,
    state: {} as Record<string, Record<string, Record<string, unknown>>>,
  };
  const raw = new ArrayBuffer(8);
  const layers: { id: string }[] = [];
  let stencil = 0;
  let repaints = 0;
  const manager = {
    getVisibleCoordinates: () => [COORD],
    getTileByID: () => ({
      latestFeatureIndex: {
        rawTileData: raw,
        loadVTLayers: () => ({ _geojsonTileLayer: layerOf(features) }),
        getId: (feature: VectorFeatureLike) => feature.id,
      },
    }),
    getState: () => state,
    getSource: () => ({ type: "geojson" }),
  };
  const map = {
    getZoom: () => 16,
    getBearing: () => 0,
    getCanvas: () => ({ clientWidth: 800, clientHeight: 800 }),
    triggerRepaint: () => repaints++,
    getSource: () => ({}),
    getLayer: (id: string) => layers.find((l) => l.id === id),
    addLayer: (layer: { id: string }) => layers.push(layer),
    removeLayer: (id: string) =>
      layers.splice(
        layers.findIndex((l) => l.id === id),
        1,
      ),
    setLayoutProperty: () => {},
    setLayerZoomRange: () => {},
    on: () => map,
    off: () => map,
    style: { tileManagers: { "building-shapes": manager } },
    painter: {
      stencilModeFor3D: () => ({ ref: ++stencil }),
    },
  };
  return {
    map: map as unknown as MaplibreMap,
    layers,
    state,
    repaints: () => repaints,
  };
}

const args = {
  shaderData: {
    variantName: "mercator",
    vertexShaderPrelude: "",
    define: "",
  },
  getProjectionData: () => ({
    mainMatrix: MATRIX,
    fallbackMatrix: MATRIX,
    tileMercatorCoords: [0, 0, 1, 1],
    clippingPlane: [0, 0, 0, 0],
    projectionTransition: 0,
  }),
} as unknown as CustomRenderMethodInput;

const features: TestFeature[] = [
  {
    id: 1,
    properties: { "roof:shape": "gabled", height: 12, "roof:height": 4 },
    rings: rect(1000, 1000, 600, 400),
  },
  {
    id: 2,
    properties: { "roof:shape": "flat", height: 30 },
    rings: rect(3000, 3000, 400, 400),
  },
];

function setup(json: BuildingLayerJson = example) {
  const fake = fakeMap(features);
  const { gl, calls } = fakeGl();
  const layer = BuildingLayer.fromLayerJson(json);
  layer.onAdd(fake.map, gl);
  return { layer, gl, calls, ...fake };
}

const names = (calls: Call[]) => calls.map((c) => c.name);

describe("BuildingLayer", () => {
  it("round-trips the example layer JSON", () => {
    const json = BuildingLayer.fromLayerJson(example).toLayerJson();
    expect(json.layout).toEqual(example.layout);
    expect(json.paint).toEqual(example.paint);
    expect(json.source).toBe(example.source);
  });

  it("adds a hidden helper layer that keeps the source's tiles loaded", () => {
    const { layers } = setup();
    expect(layers.map((l) => l.id)).toEqual([`${example.id}-tiles`]);
  });

  it("adopts its own helper layer but leaves a style layer of that id alone", () => {
    const fake = fakeMap(features);
    const own = `${example.id}-tiles`;
    fake.layers.push({ id: own });
    const layer = BuildingLayer.fromLayerJson(example);
    layer.onAdd(fake.map, fakeGl().gl);
    expect(fake.layers.map((l) => l.id)).toEqual([own, `${own}-2`]);
    layer.onRemove(fake.map);
    expect(fake.layers.map((l) => l.id)).toEqual([own]);

    // A style restored after context loss keeps the marked helper.
    const restored = fakeMap(features);
    const first = BuildingLayer.fromLayerJson(example);
    first.onAdd(restored.map, fakeGl().gl);
    const again = BuildingLayer.fromLayerJson(example);
    again.onAdd(restored.map, fakeGl().gl);
    expect(restored.layers.map((l) => l.id)).toEqual([own]);
  });

  it("draws opaque buildings in one pass with core fill-extrusion's state", () => {
    const { layer, gl, calls } = setup();
    layer.render(gl, args);
    const draws = calls.filter((c) => c.name === "drawElements");
    expect(draws.length).toBeGreaterThan(0);
    expect(names(calls)).not.toContain("stencilFunc");
    expect(calls).toContainEqual({ name: "depthFunc", args: ["LEQUAL"] });
    expect(calls).toContainEqual({ name: "cullFace", args: ["BACK"] });
    expect(calls).toContainEqual({ name: "frontFace", args: ["CCW"] });
    expect(calls).toContainEqual({
      name: "blendFunc",
      args: ["ONE", "ONE_MINUS_SRC_ALPHA"],
    });
    const range = calls.find((c) => c.name === "bindBufferRange")!;
    expect(range.args[1]).toBe(DRAWABLE_BINDING);
    expect(range.args[4]).toBe(DRAWABLE_UBO_BYTES);
    // The example binds roof color (two RGBA8 attributes) and the heights.
    const pointers = calls.filter((c) => c.name === "vertexAttribPointer");
    expect(
      pointers.some(
        (c) =>
          c.args[0] === 8 &&
          c.args[2] === "UNSIGNED_BYTE" &&
          c.args[3] === true,
      ),
    ).toBe(true);
    expect(pointers.some((c) => c.args[0] === 6)).toBe(false);
  });

  it("draws translucent buildings into depth first, then once per pixel", () => {
    const { layer, gl, calls } = setup();
    layer.setPaintProperty("building-opacity", 0.5, { duration: 0 });
    layer.render(gl, args);
    const order = names(calls);
    const draws = order.filter((n) => n === "drawElements").length;
    const masked = order.indexOf("colorMask");
    expect(calls[masked]!.args).toEqual([false, false, false, false]);
    const stencil = order.indexOf("stencilFunc");
    expect(stencil).toBeGreaterThan(masked);
    expect(calls[stencil]!.args).toEqual(["NOTEQUAL", 1, 0xff]);
    expect(calls).toContainEqual({
      name: "stencilOp",
      args: ["KEEP", "KEEP", "REPLACE"],
    });
    // Both passes draw every segment.
    const before = order
      .slice(0, stencil)
      .filter((n) => n === "drawElements").length;
    expect(before * 2).toBe(draws);
  });

  it("draws nothing at opacity 0", () => {
    const { layer, gl, calls } = setup();
    layer.setPaintProperty("building-opacity", 0, { duration: 0 });
    layer.render(gl, args);
    expect(names(calls)).not.toContain("drawElements");
  });

  it("lays every tile out again when a roof property changes", () => {
    const { layer, gl, calls } = setup();
    layer.render(gl, args);
    const uploads = () =>
      calls.filter(
        (c) => c.name === "bufferData" && c.args[0] === "ELEMENT_ARRAY_BUFFER",
      ).length;
    expect(uploads()).toBe(1);
    layer.setLayoutProperty("building-roof-shape", "hipped");
    layer.render(gl, args);
    expect(uploads()).toBe(2);
    expect(layer.getLayoutProperty("building-roof-shape")).toBe("hipped");
    expect(() =>
      layer.setLayoutProperty("building-roof-shape", "spire"),
    ).toThrow();
    expect(() => layer.setLayoutProperty("building-height", 1)).toThrow(
      /Unknown/,
    );
  });

  it("queries the projected prism, nearest first, with the roof it drew", () => {
    const { layer, gl } = setup();
    layer.render(gl, args);
    // Screen pixels of tile points under MATRIX on an 800 px canvas.
    const pixel = (x: number, y: number) => ({
      x: (x / 8192) * 800,
      y: (y / 8192) * 800,
    });
    const hit = layer.queryFeature(pixel(1300, 1200));
    expect(hit?.id).toBe(1);
    expect(hit?.properties?.["roof:shape"]).toBe("gabled");
    expect(hit?.roof.shape).toBe("gabled");
    expect(hit?.geometry.type).toBe("Polygon");
    expect(layer.queryFeature(pixel(3200, 3200))?.id).toBe(2);
    expect(layer.hitTest(pixel(5000, 5000))).toBe(false);
  });

  it("refills state-dependent attributes when feature-state changes", () => {
    const json: BuildingLayerJson = {
      ...example,
      paint: {
        ...example.paint,
        "building-color": [
          "case",
          ["boolean", ["feature-state", "hover"], false],
          "#ff0000",
          "#e4dccf",
        ],
      },
    };
    const { layer, gl, calls, state } = setup(json);
    layer.render(gl, args);
    const subData = () =>
      calls.filter(
        (c) => c.name === "bufferSubData" && c.args[0] === "ARRAY_BUFFER",
      ).length;
    expect(subData()).toBe(0);
    state.state = { _geojsonTileLayer: { "2": { hover: true } } };
    state.revision++;
    layer.render(gl, args);
    expect(subData()).toBe(1);
  });
});
