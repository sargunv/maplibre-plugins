import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { VectorTile } from "@mapbox/vector-tile";
import type { CustomRenderMethodInput, Map as MaplibreMap } from "maplibre-gl";
import { PbfReader, PbfWriter } from "pbf";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { Catalog } from "./catalog.ts";
import { setClockOverride } from "./clock.ts";
import { sphereAt } from "./globe.ts";
import {
  type AnimatedIconFeature,
  AnimatedIconLayer,
  type AnimatedIconLayerJson,
  demoCatalog,
} from "./layer.ts";
import { MAX_SEGMENT_VERTICES } from "./layout.ts";
import { CATALOG_BINDING, DRAWABLE_BINDING } from "./shaders.ts";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const example = JSON.parse(
  readFileSync(join(pluginRoot, "examples", "layer.json"), "utf8"),
) as AnimatedIconLayerJson;

const demo = demoCatalog();
const [firstAnimation] = demo.animations;
if (!firstAnimation) throw new Error("the demo catalog has no animations");

// ---------------------------------------------------------------------------
// Test doubles: vector tiles of points, a WebGL2 context that records its
// calls, and the slice of a maplibre-gl map (and its tile managers) the
// layer touches.
// ---------------------------------------------------------------------------

type Value = string | number | boolean;

interface TestFeature {
  id?: number;
  properties?: Record<string, Value>;
  /** One point, or several for a MultiPoint. */
  points: ReadonlyArray<readonly [number, number]>;
}

const zigzag = (n: number) => (n << 1) ^ (n >> 31);

/** A one-layer vector tile of point features. */
function pointTile(
  layer: string,
  features: readonly TestFeature[],
  extent = 8192,
): ArrayBuffer {
  const pbf = new PbfWriter();
  pbf.writeMessage(
    3,
    (_: unknown, p) => {
      const keys: string[] = [];
      const values: Value[] = [];
      const index = <T>(list: T[], item: T) => {
        const i = list.indexOf(item);
        return i >= 0 ? i : list.push(item) - 1;
      };
      p.writeVarintField(15, 2);
      p.writeStringField(1, layer);
      for (const feature of features) {
        p.writeMessage(
          2,
          (f: TestFeature, fp) => {
            if (f.id !== undefined) fp.writeVarintField(1, f.id);
            const tags = Object.entries(f.properties ?? {}).flatMap(
              ([key, value]) => [index(keys, key), index(values, value)],
            );
            if (tags.length > 0) fp.writePackedVarint(2, tags);
            fp.writeVarintField(3, 1);
            const geometry = [(f.points.length << 3) | 1];
            let x = 0;
            let y = 0;
            for (const [px, py] of f.points) {
              geometry.push(zigzag(px - x), zigzag(py - y));
              x = px;
              y = py;
            }
            fp.writePackedVarint(4, geometry);
          },
          feature,
        );
      }
      for (const key of keys) p.writeStringField(3, key);
      for (const value of values) {
        p.writeMessage(
          4,
          (v: Value, vp) => {
            if (typeof v === "string") vp.writeStringField(1, v);
            else if (typeof v === "boolean") vp.writeBooleanField(7, v);
            else if (Number.isInteger(v)) vp.writeSVarintField(6, v);
            else vp.writeDoubleField(3, v);
          },
          value,
        );
      }
      p.writeVarintField(5, extent);
    },
    null,
  );
  const bytes = pbf.finish();
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/**
 * A catalog of empty one-frame animations with the given boxes, enough for
 * placement and queries.
 */
function boxCatalog(
  entries: ReadonlyArray<{ name: string; box: number[]; displayPx: number }>,
): Catalog {
  const n = entries.length;
  const names = entries.map((e) => e.name).join("");
  const namesOffset = 64 + 64 * n;
  const texelsOffset = Math.ceil((namesOffset + names.length) / 16) * 16;
  const bytes = new Uint8Array(texelsOffset + 16 * n);
  const view = new DataView(bytes.buffer);
  const ascii = new TextEncoder();
  bytes.set(ascii.encode("MLVCAT\0\0"));
  const header = [2, n, 1024, 1, n, 0, 64, namesOffset, names.length];
  header.forEach((v, i) => view.setUint32(8 + 4 * i, v, true));
  view.setUint32(44, texelsOffset, true);
  let nameOffset = 0;
  entries.forEach((entry, i) => {
    const at = 64 + 64 * i;
    entry.box.forEach((v, k) => view.setFloat32(at + 4 * k, v, true));
    view.setFloat32(at + 16, entry.displayPx, true);
    view.setFloat32(at + 20, 1, true);
    view.setUint32(at + 24, 1, true);
    view.setUint32(at + 28, i, true);
    view.setUint32(at + 32, nameOffset, true);
    view.setUint32(at + 36, entry.name.length, true);
    view.setFloat32(at + 40, 128, true);
    view.setFloat32(at + 44, 128, true);
    nameOffset += entry.name.length;
  });
  bytes.set(ascii.encode(names), namesOffset);
  return Catalog.parse(bytes);
}

interface Call {
  name: string;
  args: unknown[];
  result: unknown;
}

/** A buffer upload, with the buffer bound to its target at the time. */
interface Write {
  name: "bufferData" | "bufferSubData";
  target: string;
  buffer: unknown;
  args: unknown[];
}

interface FakeGl {
  gl: WebGL2RenderingContext;
  calls: Call[];
  writes: Write[];
}

/**
 * A WebGL2 context that records every call. Constants read as their own
 * names, created objects are fresh `{ id }` records, compiles succeed, and
 * buffer uploads are copied and attributed to the bound buffer.
 */
function fakeGl(): FakeGl {
  const calls: Call[] = [];
  const writes: Write[] = [];
  const bound: Record<string, unknown> = {};
  let next = 1;
  const copy = (value: unknown) =>
    ArrayBuffer.isView(value) ? (value as Float32Array).slice() : value;
  const upload =
    (name: Write["name"]) =>
    (target: unknown, ...rest: unknown[]) => {
      writes.push({
        name,
        target: target as string,
        buffer: bound[target as string],
        args: rest.map(copy),
      });
    };
  const answers: Record<string, (...args: unknown[]) => unknown> = {
    isContextLost: () => false,
    getParameter: () => null,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getUniformBlockIndex: (_, name) =>
      name === "IconCatalogUBO" ? 0 : name === "IconDrawableUBO" ? 1 : -1,
    getUniformLocation: (_, name) => ({ id: next++, name }),
    bindBuffer: (target, buffer) => {
      bound[target as string] = buffer;
    },
    bindBufferBase: (target, _, buffer) => {
      bound[target as string] = buffer;
    },
    bufferData: upload("bufferData"),
    bufferSubData: upload("bufferSubData"),
  };
  const values: Record<string, unknown> = {
    drawingBufferWidth: 1600,
    drawingBufferHeight: 1200,
    INVALID_INDEX: -1,
  };
  const gl = new Proxy(
    {},
    {
      get(_, prop) {
        if (typeof prop !== "string") return undefined;
        if (prop in values) return values[prop];
        if (/^[A-Z0-9_]+$/.test(prop)) return prop;
        return (...args: unknown[]) => {
          const answer = answers[prop];
          const result = answer ? answer(...args) : { id: next++ };
          calls.push({
            name: prop,
            args: prop.startsWith("uniform") ? args.map(copy) : args,
            result,
          });
          return result;
        };
      },
    },
  );
  return { gl: gl as WebGL2RenderingContext, calls, writes };
}

interface FakeLayer {
  id: string;
  type: string;
  source?: string;
  "source-layer"?: string;
  filter?: unknown;
  layout?: { visibility?: string };
  minzoom?: number;
  maxzoom?: number;
}

interface Coord {
  key: string;
  wrap: number;
  overscaledZ: number;
  canonical: { z: number; x: number; y: number };
}

interface FakeFeatureIndex {
  rawTileData: ArrayBuffer;
  loadVTLayers(): unknown;
  getId(feature: {
    id?: unknown;
    properties: Record<string, unknown>;
  }): unknown;
}

interface FakeTile {
  latestFeatureIndex?: FakeFeatureIndex | null;
}

interface FakeState {
  revision: number;
  state: Record<string, Record<string, Record<string, unknown>>>;
}

interface FakeSource {
  type: string;
  coords: Coord[];
  tiles: Map<string, FakeTile>;
  state: FakeState;
}

/** A loaded tile whose feature index decodes `raw` as MVT, like gl-js does. */
function loadedTile(raw: ArrayBuffer, promoteId?: string): FakeTile {
  return {
    latestFeatureIndex: {
      rawTileData: raw,
      loadVTLayers: () => new VectorTile(new PbfReader(raw)).layers,
      getId: (feature) =>
        promoteId === undefined ? feature.id : feature.properties[promoteId],
    },
  };
}

const COORD: Coord = {
  key: "14/10/20",
  wrap: 0,
  overscaledZ: 14,
  canonical: { z: 14, x: 10, y: 20 },
};

function source(
  tiles: Record<string, FakeTile> = {},
  type = "vector",
  coords?: Coord[],
): FakeSource {
  return {
    type,
    coords: coords ?? (Object.keys(tiles).length > 0 ? [COORD] : []),
    tiles: new Map(Object.entries(tiles)),
    state: { revision: 0, state: {} },
  };
}

interface FakeMap {
  map: MaplibreMap;
  layers: FakeLayer[];
  sources: Map<string, FakeSource>;
  repaints(): number;
  setBearing(bearing: number): void;
  setZoom(zoom: number): void;
  /** Calls the listeners of a map event. */
  fire(type: string): void;
}

function fakeMap(
  options: {
    layers?: FakeLayer[];
    tile?: ArrayBuffer;
    zoom?: number;
    bearing?: number;
    /** Sources by id; `points` with `tile` (or nothing) by default. */
    sources?: Record<string, FakeSource>;
  } = {},
): FakeMap {
  const layers = [...(options.layers ?? [])];
  const sources = new Map(
    Object.entries(
      options.sources ?? {
        points: source(
          options.tile ? { [COORD.key]: loadedTile(options.tile) } : {},
        ),
      },
    ),
  );
  const listeners = new Map<string, Set<() => void>>();
  let repaints = 0;
  let bearing = options.bearing ?? 0;
  let zoom = options.zoom ?? 14;
  const managers = new Proxy(
    {},
    {
      get(_, id) {
        const found = sources.get(id as string);
        if (!found) return undefined;
        return {
          getVisibleCoordinates: () => found.coords,
          getTileByID: (key: string) => found.tiles.get(key),
          getState: () => found.state,
          getSource: () => ({ type: found.type }),
        };
      },
    },
  );
  const map = {
    getZoom: () => zoom,
    getBearing: () => bearing,
    getCanvas: () => ({ clientWidth: 800, clientHeight: 600 }),
    triggerRepaint: () => repaints++,
    getSource: (id: string) => (sources.has(id) ? {} : undefined),
    getLayersOrder: () => layers.map((l) => l.id),
    getLayer: (id: string) => layers.find((l) => l.id === id),
    setLayoutProperty: (id: string, name: string, value: string) => {
      const layer = layers.find((l) => l.id === id);
      if (layer) layer.layout = { ...layer.layout, [name]: value };
    },
    setLayerZoomRange: (id: string, minzoom: number, maxzoom: number) => {
      const layer = layers.find((l) => l.id === id);
      if (layer) Object.assign(layer, { minzoom, maxzoom });
    },
    addLayer: (layer: FakeLayer, before?: string) => {
      const index = before ? layers.findIndex((l) => l.id === before) : -1;
      layers.splice(index < 0 ? layers.length : index, 0, layer);
    },
    removeLayer: (id: string) => {
      layers.splice(
        layers.findIndex((l) => l.id === id),
        1,
      );
    },
    on: (type: string, listener: () => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
      return map;
    },
    off: (type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener);
      return map;
    },
    style: { tileManagers: managers },
  };
  return {
    map: map as unknown as MaplibreMap,
    layers,
    sources,
    repaints: () => repaints,
    setBearing: (b) => (bearing = b),
    setZoom: (z) => (zoom = z),
    fire: (type) => listeners.get(type)?.forEach((listener) => listener()),
  };
}

const FOV = 0.6435011087932844;

/** The globe half of gl-js's projection data, for renderArgs. */
interface GlobeArgs {
  transition: number;
  mainMatrix?: ArrayLike<number>;
  clippingPlane?: [number, number, number, number];
}

/**
 * Render arguments shaped like gl-js's: in mercator, mainMatrix and
 * fallbackMatrix are both the tile matrix. With `globe`, mainMatrix is the
 * unit-sphere view-projection matrix gl-js hands out while the globe draws
 * (by default one that puts every point behind the camera, w = -1),
 * fallbackMatrix the tile matrix, and projectionTransition blends them.
 */
function renderArgs(
  options: {
    fov?: number;
    variantName?: string;
    matrix?: (canonical: Coord["canonical"]) => ArrayLike<number>;
    globe?: GlobeArgs;
  } = {},
): CustomRenderMethodInput {
  const behind = new Float32Array(16);
  behind[15] = -1;
  const globe = options.globe;
  return {
    fov: options.fov ?? FOV,
    shaderData: {
      variantName: options.variantName ?? (globe ? "globe" : "mercator"),
      vertexShaderPrelude: "// prelude",
      define: "",
    },
    getProjectionData: (params: {
      tileID: { canonical: Coord["canonical"] };
    }) => {
      const { x, y, z } = params.tileID.canonical;
      const tile = Float32Array.from(
        options.matrix?.(params.tileID.canonical) ?? new Float32Array(16),
      );
      return {
        mainMatrix: globe
          ? Float32Array.from(globe.mainMatrix ?? behind)
          : tile,
        fallbackMatrix: tile,
        tileMercatorCoords: [
          x / 2 ** z,
          y / 2 ** z,
          1 / 2 ** z / 8192,
          1 / 2 ** z / 8192,
        ],
        clippingPlane: globe?.clippingPlane ?? [0, 0, 0, 1],
        projectionTransition: globe?.transition ?? 0,
      };
    },
  } as unknown as CustomRenderMethodInput;
}

const named = (calls: Call[], name: string) =>
  calls.filter((c) => c.name === name);

function pointsLayer(
  paint: AnimatedIconLayerJson["paint"],
  id = "icons",
  catalog?: Catalog,
): AnimatedIconLayer {
  return AnimatedIconLayer.fromLayerJson(
    {
      id,
      type: "animated-icon",
      source: "points",
      "source-layer": "poi",
      paint,
    },
    catalog ? { catalog } : {},
  );
}

/** Adds a layer to a fake map the way map.addLayer would. */
function addTo(fake: FakeMap, layer: AnimatedIconLayer): void {
  fake.layers.push({ id: layer.id, type: "custom" });
  layer.onAdd(fake.map, fakeGl().gl);
}

/** Removes a layer from a fake map the way map.removeLayer would. */
function removeFrom(fake: FakeMap, layer: AnimatedIconLayer): void {
  layer.onRemove(fake.map);
  fake.layers.splice(
    fake.layers.findIndex((l) => l.id === layer.id),
    1,
  );
}

function setUp(
  paint: AnimatedIconLayerJson["paint"],
  options: Parameters<typeof fakeMap>[0] & { catalog?: Catalog } = {},
) {
  const fake = fakeMap({
    layers: [{ id: "base", type: "circle", source: "points" }],
    ...options,
  });
  const gl = fakeGl();
  const layer = pointsLayer(paint, "icons", options.catalog);
  layer.onAdd(fake.map, gl.gl);
  return { fake, ...gl, layer };
}

/** The writes to the buffer that `first` wrote to. */
function writesTo(writes: Write[], first: Write | undefined): Write[] {
  return writes.filter((w) => first && w.buffer === first.buffer);
}

/**
 * The first paint-attribute upload of `floats` floats: the layer uploads
 * positions as STATIC_DRAW and paint attributes, which refill, as
 * DYNAMIC_DRAW.
 */
function arrayUpload(writes: Write[], floats: number): Write | undefined {
  return writes.find(
    (w) =>
      w.target === "ARRAY_BUFFER" &&
      w.name === "bufferData" &&
      w.args[1] === "DYNAMIC_DRAW" &&
      (w.args[0] as Float32Array).length === floats,
  );
}

afterEach(() => {
  setClockOverride(null);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe("layer JSON", () => {
  it("round-trips the example layer", () => {
    const layer = AnimatedIconLayer.fromLayerJson(example);
    const json = layer.toLayerJson();
    expect(json.id).toBe(example.id);
    expect(json.source).toBe(example.source);
    expect(json["source-layer"]).toBe(example["source-layer"]);
    expect(json.filter).toEqual(example.filter);
    for (const [name, value] of Object.entries(example.paint ?? {}))
      expect(json.paint?.[name as keyof typeof json.paint]).toEqual(value);
    expect(json.paint?.["icon-opacity"]).toBe(1);
    expect(json.paint?.["icon-animation-mode"]).toBe("loop");
  });

  it("leaves out the source layer of a GeoJSON source", () => {
    const layer = AnimatedIconLayer.fromLayerJson({
      id: "icons",
      type: "animated-icon",
      source: "points",
    });
    expect(layer.sourceLayer).toBeUndefined();
    expect("source-layer" in layer.toLayerJson()).toBe(false);
  });

  it("rejects other layer types and a missing source", () => {
    expect(() =>
      AnimatedIconLayer.fromLayerJson({
        ...example,
        type: "circle",
      } as unknown as AnimatedIconLayerJson),
    ).toThrow(/Expected layer type animated-icon/);
    expect(() =>
      AnimatedIconLayer.fromLayerJson({ ...example, source: "" }),
    ).toThrow(/need a source/);
  });

  it("keeps zoom range, visibility and a replaced filter", () => {
    const layer = AnimatedIconLayer.fromLayerJson({
      ...example,
      minzoom: 12,
      maxzoom: 20,
      layout: { visibility: "none" },
    });
    layer.setFilter(["==", ["get", "class"], "cafe"]);
    const json = layer.toLayerJson();
    expect(json.minzoom).toBe(12);
    expect(json.maxzoom).toBe(20);
    expect(json.layout).toEqual({ visibility: "none" });
    expect(json.filter).toEqual(["==", ["get", "class"], "cafe"]);
  });

  it("takes an app catalog and a default transition", () => {
    const catalog = boxCatalog([
      { name: "rain", box: [0, 0, 10, 10], displayPx: 20 },
    ]);
    const layer = AnimatedIconLayer.fromLayerJson(
      {
        id: "weather",
        type: "animated-icon",
        source: "stations",
        paint: { "icon-animation": "rain" },
      },
      { catalog, transition: { duration: 0 } },
    );
    expect(layer.catalog).toBe(catalog);
    expect(() => layer.setPaintProperty("icon-animation", "pin")).toThrow();
    expect(new AnimatedIconLayer({ id: "a", source: "b" }).catalog).toBe(demo);
  });
});

describe("paint properties", () => {
  it("accepts the catalog's animation names and rejects others", () => {
    const layer = pointsLayer({});
    for (const name of demo.enumValues())
      layer.setPaintProperty("icon-animation", name);
    expect(layer.getPaintProperty("icon-animation")).toBe(
      demo.enumValues().at(-1),
    );
    expect(() => layer.setPaintProperty("icon-animation", "nope")).toThrow();
    expect(() => layer.setPaintProperty("icon-anchor", "middle")).toThrow();
    expect(() => layer.setPaintProperty("icon-bogus", 1)).toThrow();
  });

  it("takes transitions for numbers only, like the native descriptors", () => {
    const layer = pointsLayer({});
    layer.setPaintProperty("icon-size-transition", { duration: 50 });
    layer.setPaintProperty("icon-animation-speed-transition", { duration: 0 });
    expect(() =>
      layer.setPaintProperty("icon-anchor-transition", { duration: 50 }),
    ).toThrow();
    expect(layer.toLayerJson().paint?.["icon-size-transition"]).toEqual({
      duration: 50,
    });
    // MapLibre Native drops a layer whose JSON has one.
    expect(() =>
      AnimatedIconLayer.fromLayerJson({
        ...example,
        paint: {
          "icon-animation": "pin",
          "icon-animation-transition": { duration: 0 },
        },
      }),
    ).toThrow(/takes no transition/);
  });

  it("rejects constants outside the spec's bounds, like the native host", () => {
    expect(() =>
      AnimatedIconLayer.fromLayerJson({
        ...example,
        paint: { "icon-opacity": 1.5 },
      }),
    ).toThrow(/outside/);
    const layer = pointsLayer({});
    expect(() => layer.setPaintProperty("icon-size", -1)).toThrow(/outside/);
    expect(layer.getPaintProperty("icon-size")).toBe(1);
    expect(() => layer.setPaintProperty("icon-animation-speed", 5)).toThrow(
      /outside/,
    );
  });

  it("takes data expressions everywhere except the alignments", () => {
    const layer = pointsLayer({});
    layer.setPaintProperty("icon-animation", ["get", "icon"]);
    layer.setPaintProperty("icon-animation-offset", [
      "-",
      0,
      ["number", ["feature-state", "start"], 8192],
    ]);
    expect(() =>
      layer.setPaintProperty("icon-rotation-alignment", ["get", "a"]),
    ).toThrow(/expression dependencies are not supported/);
  });
});

describe("helper layer", () => {
  it("is added under the layer and removed with it", () => {
    const fake = fakeMap();
    const layer = pointsLayer({ "icon-animation": firstAnimation.name });
    addTo(fake, layer);
    expect(fake.layers.map((l) => l.id)).toEqual(["icons-tiles", "icons"]);
    expect(fake.layers[0]).toMatchObject({
      type: "circle",
      source: "points",
      "source-layer": "poi",
      filter: false,
      layout: { visibility: "visible" },
      paint: { "circle-radius": 0, "circle-opacity": 0 },
    });
    expect(fake.layers[0]?.minzoom).toBeUndefined();
    removeFrom(fake, layer);
    expect(fake.layers.map((l) => l.id)).toEqual([]);
  });

  it("is adopted from a style restored after context loss", () => {
    const fake = fakeMap({
      layers: [
        { id: "icons-tiles", type: "circle", source: "points" },
        { id: "icons", type: "custom" },
      ],
    });
    const layer = pointsLayer({ "icon-animation": firstAnimation.name });
    layer.onAdd(fake.map, fakeGl().gl);
    expect(fake.layers.map((l) => l.id)).toEqual(["icons-tiles", "icons"]);
    layer.onRemove(fake.map);
    expect(fake.layers.map((l) => l.id)).toEqual(["icons"]);
  });

  it("is added even when a built-in layer reads the source", () => {
    // That layer may be hidden, zoom-limited or removed later.
    const fake = fakeMap({
      layers: [{ id: "poi-dots", type: "circle", source: "points" }],
    });
    addTo(fake, pointsLayer({ "icon-animation": firstAnimation.name }));
    expect(fake.layers.map((l) => l.id)).toEqual([
      "poi-dots",
      "icons-tiles",
      "icons",
    ]);
  });

  it("belongs to one layer, so removing another keeps it", () => {
    const fake = fakeMap();
    const pulses = pointsLayer({ "icon-animation": "pulse" }, "pulses");
    const pins = pointsLayer({ "icon-animation": "pin" }, "pins");
    addTo(fake, pulses);
    addTo(fake, pins);
    removeFrom(fake, pulses);
    expect(fake.layers.map((l) => l.id)).toEqual(["pins-tiles", "pins"]);
  });

  it("follows the layer's visibility and zoom range", () => {
    const fake = fakeMap();
    const layer = AnimatedIconLayer.fromLayerJson({
      id: "icons",
      type: "animated-icon",
      source: "points",
      minzoom: 12,
      layout: { visibility: "none" },
    });
    addTo(fake, layer);
    const helper = () => fake.layers.find((l) => l.id === "icons-tiles");
    expect(helper()).toMatchObject({
      minzoom: 12,
      layout: { visibility: "none" },
    });
    expect(helper()?.["source-layer"]).toBeUndefined();
    layer.setLayoutProperty("visibility", "visible");
    layer.setZoomRange(10, 18);
    expect(helper()).toMatchObject({
      minzoom: 10,
      maxzoom: 18,
      layout: { visibility: "visible" },
    });
  });

  it("is added once a source added after the layer exists", () => {
    const fake = fakeMap({ sources: {} });
    const layer = pointsLayer({ "icon-animation": firstAnimation.name });
    addTo(fake, layer);
    expect(fake.layers.map((l) => l.id)).toEqual(["icons"]);
    fake.fire("sourcedata");
    expect(fake.layers.map((l) => l.id)).toEqual(["icons"]);
    fake.sources.set("points", source());
    fake.fire("sourcedata");
    fake.fire("sourcedata");
    expect(fake.layers.map((l) => l.id)).toEqual(["icons-tiles", "icons"]);
    removeFrom(fake, layer);
    fake.fire("sourcedata");
    expect(fake.layers.map((l) => l.id)).toEqual([]);
  });
});

describe("render", () => {
  const tile = pointTile("poi", [
    { id: 1, properties: { size: 2 }, points: [[100, 200]] },
    { id: 2, properties: { size: 3 }, points: [[300, 50]] },
    // In the buffer: the neighbouring tile owns it.
    { id: 3, points: [[-10, 40]] },
  ]);

  it("uploads the catalog texture once, as exact RGBA32F texels on unit 0", () => {
    const { gl, calls, layer } = setUp(
      { "icon-animation": firstAnimation.name },
      { tile },
    );
    layer.render(gl, renderArgs());
    layer.render(gl, renderArgs());
    const uploads = named(calls, "texImage2D");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.args.slice(0, 8)).toEqual([
      "TEXTURE_2D",
      0,
      "RGBA32F",
      demo.textureWidth,
      demo.textureHeight,
      0,
      "RGBA",
      "FLOAT",
    ]);
    expect(uploads[0]!.args[8]).toBe(demo.texture);
    const stores = named(calls, "pixelStorei").map((c) => c.args);
    expect(stores).toEqual(
      expect.arrayContaining([
        ["UNPACK_FLIP_Y_WEBGL", false],
        ["UNPACK_PREMULTIPLY_ALPHA_WEBGL", false],
        ["UNPACK_ALIGNMENT", 4],
        ["UNPACK_ROW_LENGTH", 0],
        ["UNPACK_SKIP_ROWS", 0],
        ["UNPACK_SKIP_PIXELS", 0],
      ]),
    );
    expect(named(calls, "bindBuffer").map((c) => c.args)).toContainEqual([
      "PIXEL_UNPACK_BUFFER",
      null,
    ]);
    expect(named(calls, "texParameteri").map((c) => c.args)).toEqual([
      ["TEXTURE_2D", "TEXTURE_MIN_FILTER", "NEAREST"],
      ["TEXTURE_2D", "TEXTURE_MAG_FILTER", "NEAREST"],
      ["TEXTURE_2D", "TEXTURE_WRAP_S", "CLAMP_TO_EDGE"],
      ["TEXTURE_2D", "TEXTURE_WRAP_T", "CLAMP_TO_EDGE"],
    ]);
    // Bound on unit 0 on every render; the sampler reads unit 0.
    const texture = named(calls, "createTexture")[0]!.result;
    const binds = named(calls, "bindTexture").filter(
      (c) => c.args[1] === texture,
    );
    expect(binds).toHaveLength(3);
    expect(
      named(calls, "activeTexture").every((c) => c.args[0] === "TEXTURE0"),
    ).toBe(true);
    const sampler = named(calls, "getUniformLocation").find(
      (c) => c.args[1] === "u_art",
    )!.result;
    expect(named(calls, "uniform1i").map((c) => c.args)).toEqual([
      [sampler, 0],
    ]);
  });

  it("binds IconCatalogUBO at 3 and IconDrawableUBO at 4 with the native layouts", () => {
    setClockOverride(12.5);
    const { fake, gl, calls, writes, layer } = setUp(
      {
        "icon-animation": firstAnimation.name,
        "icon-size": [
          "interpolate",
          ["linear"],
          ["zoom"],
          14,
          ["get", "size"],
          15,
          4,
        ],
        "icon-rotate": 30,
        "icon-color": "rgba(255, 0, 0, 0.5)",
        "icon-offset": [4, -2],
        "icon-anchor": "bottom",
        "icon-pitch-alignment": "map",
        "icon-animation-speed": -2,
        "icon-animation-offset": 0.25,
        "icon-animation-mode": "once",
      },
      { tile, zoom: 14.25 },
    );
    fake.setBearing(90);
    const matrix = Array.from({ length: 16 }, (_, i) => i + 0.5);
    layer.render(gl, renderArgs({ matrix: () => matrix }));

    expect(
      named(calls, "uniformBlockBinding").map((c) => c.args.slice(1)),
    ).toEqual([
      [0, CATALOG_BINDING],
      [1, DRAWABLE_BINDING],
    ]);
    const bases = named(calls, "bindBufferBase").map((c) => c.args);
    expect(bases.map((b) => b.slice(0, 2))).toEqual([
      ["UNIFORM_BUFFER", 3],
      ["UNIFORM_BUFFER", 4],
    ]);
    const [catalogBuffer, drawableBuffer] = bases.map((b) => b[2]);

    // The catalog block: the clock, then each entry's header.
    const header = new Float32Array(demo.headerBlockFloats);
    demo.writeHeaderBlock(12.5, header);
    const catalogWrites = writes.filter((w) => w.buffer === catalogBuffer);
    expect(catalogWrites.map((w) => w.name)).toEqual(["bufferData"]);
    expect(catalogWrites[0]!.args[0]).toEqual(header);

    // The drawable block: std140 IconDrawableUBO, once per tile.
    const drawableWrites = writes.filter(
      (w) => w.buffer === drawableBuffer && w.name === "bufferSubData",
    );
    expect(drawableWrites).toHaveLength(1);
    const block = drawableWrites[0]!.args[1] as Float32Array;
    expect(block).toHaveLength(52);
    expect(Array.from(block.subarray(0, 16))).toEqual(matrix);
    const cameraToCenter = 300 / Math.tan(FOV / 2);
    expect(Array.from(block.subarray(16, 24))).toEqual(
      [
        2 / 800,
        -2 / 600,
        8192 / (512 * 2 ** 0.25),
        cameraToCenter,
        2,
        -Math.PI / 2,
        0,
        0,
      ].map(Math.fround),
    );
    // icon_color (premultiplied) and icon_offset, then the scalars in
    // IconDrawableUBO order; the bound icon-size field stays 0.
    expect(Array.from(block.subarray(24, 40))).toEqual(
      [0.5, 0, 0, 0.5, 4, -2, 1, 0, 30, 1, 4, 0, 1, -2, 0.25, 2].map(
        Math.fround,
      ),
    );
    // interpolation0.y: icon-size's factor from the tile's zoom 14 to 15.
    expect(Array.from(block.subarray(40, 52))).toEqual([
      0, 0.25, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);

    // The clock uploads alone, and only when it moves.
    layer.render(gl, renderArgs());
    expect(writes.filter((w) => w.buffer === catalogBuffer)).toHaveLength(1);
    setClockOverride(13);
    layer.render(gl, renderArgs());
    const clockWrite = writes.filter((w) => w.buffer === catalogBuffer)[1]!;
    expect(clockWrite.name).toBe("bufferSubData");
    expect(clockWrite.args.slice(0, 1)).toEqual([0]);
    expect(clockWrite.args.slice(2)).toEqual([0, 4]);
    expect((clockWrite.args[1] as Float32Array)[0]).toBe(13);
    expect(named(calls, "bindBufferBase")).toHaveLength(6);
  });

  it("fills per-vertex paint attributes and re-bases every pointer per segment", () => {
    const anchors = MAX_SEGMENT_VERTICES / 4 + 1;
    const points: Array<[number, number]> = [];
    for (let i = 0; i < anchors; i++)
      points.push([i % 128, Math.floor(i / 128)]);
    const { gl, calls, writes, layer } = setUp(
      {
        "icon-animation": firstAnimation.name,
        "icon-size": ["get", "size"],
        "icon-color": ["get", "color"],
      },
      {
        tile: pointTile("poi", [
          { properties: { size: 1.5, color: "rgba(0, 0, 255, 0.5)" }, points },
        ]),
      },
    );
    layer.render(gl, renderArgs());

    // icon-size [min, max], then icon-color min and max: 10 floats a vertex.
    const paint = arrayUpload(writes, anchors * 4 * 10)!
      .args[0] as Float32Array;
    expect(Array.from(paint.subarray(0, 10))).toEqual([
      1.5, 1.5, 0, 0, 0.5, 0.5, 0, 0, 0.5, 0.5,
    ]);
    expect(Array.from(paint.subarray(paint.length - 10))).toEqual(
      Array.from(paint.subarray(0, 10)),
    );
    const enabled = named(calls, "enableVertexAttribArray").map(
      (c) => c.args[0],
    );
    expect(enabled).toEqual([0, 2, 5, 6]);
    expect(
      named(calls, "disableVertexAttribArray").map((c) => c.args[0]),
    ).toEqual([1, 3, 4, 7, 8, 9, 10, 11, 12, 13]);
    const second = MAX_SEGMENT_VERTICES;
    expect(named(calls, "vertexAttribPointer").map((c) => c.args)).toEqual([
      [0, 2, "FLOAT", false, 8, 0],
      [2, 2, "FLOAT", false, 40, 0],
      [5, 4, "FLOAT", false, 40, 8],
      [6, 4, "FLOAT", false, 40, 24],
      [0, 2, "FLOAT", false, 8, second * 8],
      [2, 2, "FLOAT", false, 40, second * 40],
      [5, 4, "FLOAT", false, 40, second * 40 + 8],
      [6, 4, "FLOAT", false, 40, second * 40 + 24],
    ]);
    const firstIndices = (MAX_SEGMENT_VERTICES / 4) * 6;
    expect(named(calls, "drawElements").map((c) => c.args)).toEqual([
      ["TRIANGLES", firstIndices, "UNSIGNED_SHORT", 0],
      ["TRIANGLES", 6, "UNSIGNED_SHORT", firstIndices * 2],
    ]);
  });

  it("compiles one program per projection variant and attribute layout", () => {
    const { gl, calls, layer } = setUp(
      { "icon-animation": firstAnimation.name },
      { tile },
    );
    const vertexSources = () =>
      named(calls, "shaderSource")
        .map((c) => c.args[1] as string)
        .filter((s) => s.includes("iconPlace("));
    layer.render(gl, renderArgs());
    layer.render(gl, renderArgs());
    expect(named(calls, "createProgram")).toHaveLength(1);
    expect(vertexSources()[0]).toContain(
      "#define MLN_PLUGIN_PROPERTY_ICON_SIZE_IS_UNIFORM 1\n",
    );
    layer.setPaintProperty("icon-size", ["get", "size"]);
    layer.render(gl, renderArgs());
    expect(named(calls, "createProgram")).toHaveLength(2);
    expect(vertexSources()[1]).toContain(
      "#define MLN_PLUGIN_PROPERTY_ICON_SIZE_IS_UNIFORM 0\n",
    );
    layer.setPaintProperty("icon-size", 2, { duration: 0 });
    layer.render(gl, renderArgs());
    expect(named(calls, "createProgram")).toHaveLength(2);
    layer.render(gl, renderArgs({ variantName: "globe" }));
    expect(named(calls, "createProgram")).toHaveLength(3);
  });

  it("keeps a visible tile without anchors cached", () => {
    const { gl, layer } = setUp(
      { "icon-animation": firstAnimation.name },
      { tile: pointTile("poi", [{ points: [[-10, 40]] }]) },
    );
    const cached = () =>
      (
        layer as unknown as {
          resources: { tiles: Map<string, unknown> } | null;
        }
      ).resources?.tiles.get(COORD.key);
    layer.render(gl, renderArgs());
    const entry = cached();
    expect(entry).toBeDefined();
    // Eviction runs every 30 frames and drops entries unused for 120.
    for (let i = 0; i < 600; i++) layer.render(gl, renderArgs());
    expect(cached()).toBe(entry);
  });

  it("lays out again when the raw tile changes, empties, or the filter changes", () => {
    const { fake, gl, calls, writes, layer } = setUp(
      { "icon-animation": firstAnimation.name },
      { tile },
    );
    const positions = () =>
      writes.filter(
        (w) => w.name === "bufferData" && w.target === "ARRAY_BUFFER",
      );
    const draws = () => named(calls, "drawElements").length;
    layer.render(gl, renderArgs());
    layer.render(gl, renderArgs());
    expect(positions()).toHaveLength(1);
    expect(draws()).toBe(2);
    const points = fake.sources.get("points")!.tiles.get(COORD.key)!;

    // setData or a reload: a new raw tile, even with the same content.
    points.latestFeatureIndex = loadedTile(
      pointTile("poi", [{ points: [[5, 5]] }]),
    ).latestFeatureIndex!;
    layer.render(gl, renderArgs());
    expect(positions()).toHaveLength(2);
    expect(Array.from(positions()[1]!.args[0] as Float32Array)).toEqual([
      10, 10, 11, 10, 10, 11, 11, 11,
    ]);
    expect(named(calls, "deleteVertexArray")).toHaveLength(1);
    expect(draws()).toBe(3);

    // A GeoJSON tile that lost its features keeps its old raw data but no
    // feature index; its icons must go.
    points.latestFeatureIndex = null;
    layer.render(gl, renderArgs());
    expect(draws()).toBe(3);
    expect(named(calls, "deleteVertexArray")).toHaveLength(2);

    points.latestFeatureIndex = loadedTile(tile).latestFeatureIndex!;
    layer.render(gl, renderArgs());
    expect(draws()).toBe(4);
    layer.setFilter(["==", ["id"], 2]);
    layer.render(gl, renderArgs());
    expect(Array.from(positions().at(-1)!.args[0] as Float32Array)).toEqual([
      600, 100, 601, 100, 600, 101, 601, 101,
    ]);
  });

  it("refills only the features whose state changed, and everything for a new state object", () => {
    const stated = pointTile("poi", [
      { id: 1, properties: { size: 1 }, points: [[10, 100]] },
      { id: 2, properties: { size: 2 }, points: [[10, 200]] },
      { id: 3, properties: { size: 3 }, points: [[10, 300]] },
    ]);
    const { fake, gl, writes, layer } = setUp(
      {
        "icon-animation": firstAnimation.name,
        "icon-size": ["get", "size"],
        "icon-opacity": ["number", ["feature-state", "o"], 0.5],
      },
      { tile: stated },
    );
    const points = fake.sources.get("points")!;
    const vertex = (size: number, opacity: number) => [
      size,
      size,
      opacity,
      opacity,
    ];
    const expected = (o2: number) =>
      [
        ...Array<number[]>(4).fill(vertex(1, 0.5)),
        ...Array<number[]>(4).fill(vertex(2, o2)),
        ...Array<number[]>(4).fill(vertex(3, 0.5)),
      ].flat();
    layer.render(gl, renderArgs());
    const full = arrayUpload(writes, 48)!;
    expect(Array.from(full.args[0] as Float32Array)).toEqual(expected(0.5));
    const paintWrites = () => writesTo(writes, full);

    // A revision with feature 2's state: only its vertices, state-dependent
    // values only.
    points.state.state = { poi: { 2: { o: 1 } } };
    points.state.revision = 1;
    layer.render(gl, renderArgs());
    expect(paintWrites().map((w) => w.name)).toEqual([
      "bufferData",
      "bufferSubData",
    ]);
    const partial = paintWrites()[1]!.args;
    expect(partial.slice(0, 1)).toEqual([4 * 4 * 4]);
    expect(partial.slice(2)).toEqual([16, 16]);
    expect(Array.from(partial[1] as Float32Array)).toEqual(expected(1));

    // Nothing changes without a new revision.
    layer.render(gl, renderArgs());
    expect(paintWrites()).toHaveLength(2);

    // A removed state refills the feature that had one.
    points.state.state = { poi: { 2: {} } };
    points.state.revision = 2;
    layer.render(gl, renderArgs());
    expect(paintWrites()).toHaveLength(3);
    expect(Array.from(paintWrites()[2]!.args[1] as Float32Array)).toEqual(
      expected(0.5),
    );

    // State of features in other tiles costs nothing here.
    points.state.state = { poi: { 9: { o: 1 } } };
    points.state.revision = 3;
    layer.render(gl, renderArgs());
    expect(paintWrites()).toHaveLength(3);

    // The source was re-added: a new state object restarts its revision.
    points.state = { revision: 0, state: { poi: { 3: { o: 0.75 } } } };
    layer.render(gl, renderArgs());
    const refill = paintWrites()[3]!;
    expect(refill.name).toBe("bufferData");
    expect(Array.from((refill.args[0] as Float32Array).subarray(44))).toEqual(
      vertex(3, 0.75).map(Math.fround),
    );
  });

  it("refills everything when a paint value changes what it binds", () => {
    const { gl, writes, layer } = setUp(
      { "icon-animation": firstAnimation.name, "icon-size": ["get", "size"] },
      { tile },
    );
    layer.render(gl, renderArgs());
    const first = arrayUpload(writes, 8 * 2)!;
    expect(Array.from(first.args[0] as Float32Array)).toEqual([
      3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2,
    ]);
    layer.setPaintProperty("icon-size", ["*", 2, ["get", "size"]]);
    layer.render(gl, renderArgs());
    const second = writesTo(writes, first).at(-1)!;
    expect(second.name).toBe("bufferData");
    expect((second.args[0] as Float32Array)[0]).toBe(6);
  });

  it("reads MLT tiles through the feature index's layers", () => {
    // What MLTVectorTile gives: a NaN id without one, shared properties.
    const shared = { size: 2 };
    const mltLayer = {
      length: 2,
      feature: (i: number) => ({
        type: 1,
        id: i === 0 ? Number.NaN : 7,
        properties: shared,
        extent: 4096,
        loadGeometry: () => [[{ x: 10 + 100 * i, y: 20 }]],
      }),
    };
    const points = source({
      [COORD.key]: {
        latestFeatureIndex: {
          rawTileData: new ArrayBuffer(4),
          loadVTLayers: () => ({ poi: mltLayer }),
          getId: (feature) => feature.id,
        },
      },
    });
    points.state.state = { poi: { 7: { big: true } } };
    const { gl, calls, writes, layer } = setUp(
      {
        "icon-animation": firstAnimation.name,
        "icon-size": [
          "case",
          ["boolean", ["feature-state", "big"], false],
          ["*", 2, ["get", "size"]],
          ["get", "size"],
        ],
      },
      { sources: { points } },
    );
    layer.render(gl, renderArgs());
    expect(named(calls, "drawElements").map((c) => c.args[1])).toEqual([12]);
    expect(
      Array.from(arrayUpload(writes, 16)!.args[0] as Float32Array),
    ).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 4, 4, 4, 4, 4, 4, 4, 4]);
    expect(shared).toEqual({ size: 2 });
  });

  it("decodes a GeoJSON source's encoded values, and keys state by promoted ids", () => {
    const encoded = pointTile("_geojsonTileLayer", [
      {
        id: 1,
        properties: { info: '__$json__:{"size":2.5}', ref: "a" },
        points: [[10, 10]],
      },
    ]);
    const paint = {
      "icon-animation": firstAnimation.name,
      "icon-size": ["number", ["get", "size", ["get", "info"]], 1],
      "icon-opacity": ["number", ["feature-state", "o"], 1],
    };
    const geojson = source(
      { [COORD.key]: loadedTile(encoded, "ref") },
      "geojson",
    );
    geojson.state.state = { _geojsonTileLayer: { a: { o: 0.25 } } };
    const fake = fakeMap({ sources: { points: geojson } });
    const gl = fakeGl();
    const layer = AnimatedIconLayer.fromLayerJson({
      id: "icons",
      type: "animated-icon",
      source: "points",
      paint,
    });
    layer.onAdd(fake.map, gl.gl);
    layer.render(gl.gl, renderArgs());
    expect(
      Array.from(arrayUpload(gl.writes, 16)!.args[0] as Float32Array).slice(
        0,
        4,
      ),
    ).toEqual([2.5, 2.5, 0.25, 0.25]);

    // A vector source keeps the string, as MapLibre Native would see it.
    const vector = source({
      [COORD.key]: loadedTile(
        pointTile("poi", [
          {
            properties: { info: '__$json__:{"size":2.5}' },
            points: [[10, 10]],
          },
        ]),
      ),
    });
    const other = setUp(paint, { sources: { points: vector } });
    other.layer.render(other.gl, renderArgs());
    expect(
      Array.from(arrayUpload(other.writes, 16)!.args[0] as Float32Array).slice(
        0,
        4,
      ),
    ).toEqual([1, 1, 1, 1]);
  });

  it("draws nothing for a uniform none, zero size or zero opacity", () => {
    for (const paint of [
      {},
      { "icon-animation": firstAnimation.name, "icon-size": 0 },
      { "icon-animation": firstAnimation.name, "icon-opacity": 0 },
    ]) {
      const { gl, calls, layer } = setUp(paint, { tile });
      layer.render(gl, renderArgs());
      expect(named(calls, "drawElements")).toHaveLength(0);
      expect(named(calls, "bindBufferBase")).toHaveLength(0);
    }
    // Data-driven values collapse per icon in the shader instead.
    const { gl, calls, layer } = setUp(
      { "icon-animation": ["get", "icon"], "icon-size": ["get", "size"] },
      { tile },
    );
    layer.render(gl, renderArgs());
    expect(named(calls, "drawElements")).toHaveLength(1);
  });

  it("keeps repainting while an animation plays or a transition runs", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(10_000);
    const playing = setUp({ "icon-animation": firstAnimation.name }, { tile });
    playing.layer.render(playing.gl, renderArgs());
    expect(playing.fake.repaints()).toBe(1);

    const still = setUp({}, { tile });
    still.layer.render(still.gl, renderArgs());
    expect(still.fake.repaints()).toBe(0);
    for (const paint of [
      { "icon-animation": firstAnimation.name, "icon-size": 0 },
      { "icon-animation": firstAnimation.name, "icon-animation-speed": 0 },
    ]) {
      const stopped = setUp(paint, { tile });
      stopped.layer.render(stopped.gl, renderArgs());
      expect(stopped.fake.repaints()).toBe(0);
    }
    const perFeature = setUp({ "icon-animation": ["get", "icon"] }, { tile });
    perFeature.layer.render(perFeature.gl, renderArgs());
    expect(perFeature.fake.repaints()).toBe(1);

    still.layer.setPaintProperty("icon-size", 2);
    const afterSet = still.fake.repaints();
    still.layer.render(still.gl, renderArgs());
    expect(still.fake.repaints()).toBe(afterSet + 1);
    now.mockReturnValue(20_000);
    still.layer.render(still.gl, renderArgs());
    expect(still.fake.repaints()).toBe(afterSet + 1);
  });

  it("uploads everything again on a new context after a loss", () => {
    const { fake, gl, calls, layer } = setUp(
      { "icon-animation": firstAnimation.name },
      { tile },
    );
    layer.render(gl, renderArgs());
    fake.fire("webglcontextlost");
    layer.render(gl, renderArgs());
    expect(named(calls, "drawElements")).toHaveLength(1);
    fake.fire("webglcontextrestored");
    const restored = fakeGl();
    layer.render(restored.gl, renderArgs());
    expect(named(restored.calls, "texImage2D")).toHaveLength(1);
    expect(named(restored.calls, "createProgram")).toHaveLength(1);
    expect(named(restored.calls, "drawElements")).toHaveLength(1);
  });

  it("reports moved maplibre-gl internals once", () => {
    const fake = fakeMap({ tile });
    (fake.map as unknown as { style: object }).style = { sourceCaches: {} };
    const gl = fakeGl();
    const layer = pointsLayer({ "icon-animation": firstAnimation.name });
    layer.onAdd(fake.map, gl.gl);
    expect(() => layer.render(gl.gl, renderArgs())).toThrow(
      /maplibre-gl's internals changed/,
    );
    expect(() => layer.render(gl.gl, renderArgs())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Queries: the same boxes as the native query_feature, checked against the
// shared placement fixtures and the host's property rules.
// ---------------------------------------------------------------------------

interface PlaceFixture {
  view: {
    matrix: number[];
    viewport: [number, number];
    pixel_ratio: number;
    camera_to_center_distance: number;
    pixels_to_tile_units: number;
    bearing: number;
  };
  camera: { zoom: number; tile: [number, number, number]; bearing: number };
  entries: { name: string; box: number[]; display_px: number }[];
  cases: {
    anchor: [number, number];
    properties: Record<string, unknown>;
    corners: unknown;
    hits: [number, number][];
    misses: [number, number][];
  }[];
}

const placeDir = join(pluginRoot, "fixtures", "place");
const placeFixtures = readdirSync(placeDir)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map(
    (name) =>
      [
        name,
        JSON.parse(readFileSync(join(placeDir, name), "utf8")) as PlaceFixture,
      ] as const,
  );

/**
 * A map and render arguments that give the layer exactly a place fixture's
 * view: its tile matrix, viewport, pixel ratio, camera distance, zoom and
 * bearing.
 */
function fixtureCamera(fixture: PlaceFixture, sourceType = "geojson") {
  const [z, x, y] = fixture.camera.tile;
  const coord: Coord = {
    key: `${z}/${x}/${y}`,
    wrap: 0,
    overscaledZ: z,
    canonical: { z, x, y },
  };
  const [width, height] = fixture.view.viewport;
  expect(width * fixture.view.pixel_ratio).toBe(1600);
  expect([width, height]).toEqual([800, 600]);
  const fov =
    2 * Math.atan((0.5 * height) / fixture.view.camera_to_center_distance);
  const args = renderArgs({ fov, matrix: () => fixture.view.matrix });
  return { coord, args, sourceType };
}

function ids(features: AnimatedIconFeature[]): unknown[] {
  return features.map((f) => f.id);
}

describe("queryFeatures", () => {
  for (const [name, fixture] of placeFixtures) {
    it(`hits and misses like ${name}`, () => {
      const catalog = boxCatalog(
        fixture.entries.map((e) => ({
          name: e.name,
          box: e.box,
          displayPx: e.display_px,
        })),
      );
      const { coord, args } = fixtureCamera(fixture);
      // One layer per alignment pair, which are camera-only; every other
      // value is data-driven, read from the feature, with enum names as
      // the host passes them to query_feature. GeoJSON tiles carry the
      // offsets as encoded arrays.
      const groups = new Map<string, number[]>();
      fixture.cases.forEach((c, i) => {
        const key = `${String(c.properties["icon-rotation-alignment"])}/${String(c.properties["icon-pitch-alignment"])}`;
        groups.set(key, [...(groups.get(key) ?? []), i]);
      });
      let checked = 0;
      for (const [key, members] of groups) {
        const [rotation, pitch] = key.split("/");
        const features: TestFeature[] = members.map((i) => {
          const p = fixture.cases[i]!.properties;
          return {
            id: i + 1,
            properties: {
              animation: p["icon-animation"] as string,
              size: p["icon-size"] as number,
              rotate: p["icon-rotate"] as number,
              opacity: p["icon-opacity"] as number,
              offset: `__$json__:${JSON.stringify(p["icon-offset"])}`,
              anchor: p["icon-anchor"] as string,
            },
            points: [fixture.cases[i]!.anchor],
          };
        });
        const points = source(
          { [coord.key]: loadedTile(pointTile("_geojsonTileLayer", features)) },
          "geojson",
          [coord],
        );
        const fake = fakeMap({
          sources: { points },
          zoom: fixture.camera.zoom,
          bearing: fixture.camera.bearing,
        });
        const gl = fakeGl();
        const layer = AnimatedIconLayer.fromLayerJson(
          {
            id: "icons",
            type: "animated-icon",
            source: "points",
            paint: {
              "icon-animation": ["get", "animation"],
              "icon-size": ["get", "size"],
              "icon-rotate": ["get", "rotate"],
              "icon-opacity": ["get", "opacity"],
              "icon-offset": ["get", "offset"],
              "icon-anchor": ["get", "anchor"],
              "icon-rotation-alignment": rotation,
              "icon-pitch-alignment": pitch,
            },
          },
          { catalog },
        );
        layer.onAdd(fake.map, gl.gl);
        layer.render(gl.gl, args);
        for (const i of members) {
          const c = fixture.cases[i]!;
          for (const [px, py] of c.hits) {
            expect(
              ids(layer.queryFeatures({ x: px, y: py })),
              `case ${i} hit`,
            ).toContain(i + 1);
            checked++;
          }
          for (const [px, py] of c.misses) {
            expect(
              ids(layer.queryFeatures({ x: px, y: py })),
              `case ${i} miss`,
            ).not.toContain(i + 1);
            checked++;
          }
        }
      }
      expect(checked).toBeGreaterThan(0);
    });
  }

  const fixture = placeFixtures.find(
    ([name]) => name === "pitch0-bearing0.json",
  )![1];
  const catalog = boxCatalog([
    { name: "square", box: [0, 0, 32, 32], displayPx: 32 },
  ]);

  /** A layer over one tile 4/8/5 of the pitch-0 fixture camera (zoom 4.5). */
  function queryLayer(
    paint: AnimatedIconLayerJson["paint"],
    features: TestFeature[],
    options: {
      type?: string;
      coords?: Coord[];
      tiles?: Record<string, ArrayBuffer>;
      globe?: GlobeArgs;
    } = {},
  ) {
    const { coord, args } = fixtureCamera(fixture);
    const tiles = options.tiles ?? {
      [coord.key]: pointTile(
        options.type === "vector" ? "poi" : "_geojsonTileLayer",
        features,
      ),
    };
    const points = source(
      Object.fromEntries(
        Object.entries(tiles).map(([key, raw]) => [key, loadedTile(raw)]),
      ),
      options.type ?? "geojson",
      options.coords ?? [coord],
    );
    const fake = fakeMap({ sources: { points }, zoom: fixture.camera.zoom });
    const gl = fakeGl();
    const layer = AnimatedIconLayer.fromLayerJson(
      {
        id: "icons",
        type: "animated-icon",
        source: "points",
        ...(options.type === "vector" && { "source-layer": "poi" }),
        paint: { "icon-animation": "square", ...paint },
      },
      { catalog },
    );
    layer.onAdd(fake.map, gl.gl);
    // Tile 4/8/5's matrix, and a descendant's: its units are shorter by
    // `scale` and start at `origin` in 4/8/5's units.
    const matrix = (canonical: Coord["canonical"]) => {
      const m = fixture.view.matrix;
      const scale = 2 ** (4 - canonical.z);
      const origin = [
        (canonical.x * scale - 8) * 8192,
        (canonical.y * scale - 5) * 8192,
      ] as const;
      return m.map((v, i) =>
        i < 8
          ? v * scale
          : i >= 12
            ? m[i - 12]! * origin[0] + m[i - 8]! * origin[1] + v
            : v,
      );
    };
    layer.render(
      gl.gl,
      renderArgs({ fov: args.fov, matrix, globe: options.globe }),
    );
    return { layer, points, fake, gl };
  }

  // The fixture camera looks at tile point (4096, 4096) from above: screen
  // (400, 300), at 2^0.5 screen pixels per 1/16 tile unit... in short, a
  // 32-pixel square at size 1.
  const center = { x: 400, y: 300 };

  it("places a camera value at the render zoom, like the host's evaluated properties", () => {
    // Zoom 4.5 gives size 2 (±32 px); the tile's own zoom 4 would give 1.
    const { layer } = queryLayer(
      { "icon-size": ["interpolate", ["linear"], ["zoom"], 4, 1, 5, 3] },
      [{ id: 1, points: [[4096, 4096]] }],
    );
    expect(ids(layer.queryFeatures({ x: center.x + 24, y: center.y }))).toEqual(
      [1],
    );
    expect(layer.hitTest({ x: center.x + 34, y: center.y })).toBe(false);
  });

  describe("on the globe", () => {
    const features: TestFeature[] = [
      { id: 2, points: [[4096, 4100]] },
      { id: 1, points: [[4096, 4096]] },
      { id: 3, points: [[100, 100]] },
    ];
    const right = (dx: number) => ({ x: center.x + dx, y: center.y });

    it("reads the tile matrix, not the sphere's, until the globe blends in", () => {
      // At transition 0 gl-js draws with the tile matrix alone; mainMatrix
      // (here one that hides everything) plays no part.
      const mercator = queryLayer({}, features).layer;
      const globe = queryLayer({}, features, {
        globe: { transition: 0 },
      }).layer;
      for (const point of [center, right(24)]) {
        expect(ids(globe.queryFeatures(point))).toEqual(
          ids(mercator.queryFeatures(point)),
        );
      }
      expect(ids(globe.queryFeatures(center))).toEqual([2, 1]);
      expect(globe.hitTest(right(34))).toBe(false);
    });

    // tile 4/8/5, where the fixture camera looks at (4096, 4096).
    const mercator = [8 / 16, 5 / 16, 1 / 16 / 8192, 1 / 16 / 8192] as const;
    const anchor = sphereAt(mercator, 4096, 4096);
    const w = fixture.view.camera_to_center_distance;
    /**
     * A sphere matrix that puts the anchor `dx` logical pixels right of
     * where the tile matrix puts it, at the same w.
     */
    const sphere = (dx: number) => {
      const m = new Float64Array(16);
      m[0] = m[5] = w;
      m[12] = w * (dx / 400 - anchor[0]);
      m[13] = -w * anchor[1];
      m[15] = w;
      return m;
    };

    it("places icons where projectTile draws them", () => {
      const { layer } = queryLayer({}, [{ id: 1, points: [[4096, 4096]] }], {
        globe: { transition: 1, mainMatrix: sphere(200) },
      });
      expect(ids(layer.queryFeatures(right(200)))).toEqual([1]);
      expect(layer.hitTest(right(200 + 12))).toBe(true);
      expect(layer.hitTest(center)).toBe(false);
      // Halfway through the transition, halfway between the two.
      const blended = queryLayer({}, [{ id: 1, points: [[4096, 4096]] }], {
        globe: { transition: 0.5, mainMatrix: sphere(200) },
      }).layer;
      expect(blended.hitTest(right(100))).toBe(true);
      expect(blended.hitTest(center)).toBe(false);
      expect(blended.hitTest(right(200))).toBe(false);
    });

    it("finds nothing on the far side of the globe", () => {
      const { layer } = queryLayer({}, [{ id: 1, points: [[4096, 4096]] }], {
        globe: {
          transition: 1,
          mainMatrix: sphere(0),
          clippingPlane: [-anchor[0], -anchor[1], -anchor[2], 0],
        },
      });
      expect(layer.hitTest(center)).toBe(false);
    });
  });

  it("evaluates a data-driven value at the tile's own zoom, like the host", () => {
    // Drawn at zoom 4.5 with size 2, but hit tested at zoom 4 with size 1.
    const { layer } = queryLayer(
      {
        "icon-size": [
          "interpolate",
          ["linear"],
          ["zoom"],
          4,
          ["get", "a"],
          5,
          ["get", "b"],
        ],
      },
      [{ id: 1, properties: { a: 1, b: 3 }, points: [[4096, 4096]] }],
    );
    expect(layer.hitTest({ x: center.x + 10, y: center.y })).toBe(true);
    expect(layer.hitTest({ x: center.x + 24, y: center.y })).toBe(false);
  });

  it("reads feature state for a query", () => {
    const { layer, points } = queryLayer(
      { "icon-size": ["number", ["feature-state", "size"], 1] },
      [{ id: 5, points: [[4096, 4096]] }],
    );
    expect(layer.hitTest({ x: center.x + 24, y: center.y })).toBe(false);
    points.state.state = { _geojsonTileLayer: { 5: { size: 2 } } };
    expect(layer.hitTest({ x: center.x + 24, y: center.y })).toBe(true);
  });

  it("returns every icon under the point, topmost first, once per feature", () => {
    const { layer } = queryLayer({}, [
      // Drawn later (lower on the map), so on top.
      { id: 2, properties: { name: "b" }, points: [[4096, 4100]] },
      { id: 1, properties: { name: "a" }, points: [[4096, 4096]] },
      // A MultiPoint with two anchors under the point counts once.
      {
        id: 3,
        points: [
          [4090, 4090],
          [4092, 4092],
        ],
      },
      // Features without an id count per feature.
      { points: [[4094, 4094]] },
      { points: [[4094, 4094]] },
      // Far away.
      { id: 4, points: [[100, 100]] },
    ]);
    const hits = layer.queryFeatures(center);
    expect(ids(hits)).toEqual([2, 1, undefined, undefined, 3]);
    expect(layer.queryFeature(center)?.id).toBe(2);
    expect(hits[0]).toEqual({
      type: "Feature",
      id: 2,
      properties: { name: "b" },
      geometry: {
        type: "Point",
        coordinates: [
          ((8 * 8192 + 4096) / (8192 * 16)) * 360 - 180,
          (360 / Math.PI) *
            Math.atan(
              Math.exp((1 - (2 * (5 * 8192 + 4100)) / (8192 * 16)) * Math.PI),
            ) -
            90,
        ],
      },
      source: "points",
      layer: { id: "icons" },
    });
    expect("id" in hits[2]!).toBe(false);
    expect(layer.queryFeatures({ x: 10, y: 10 })).toEqual([]);
  });

  it("tests only the anchors the tile owns", () => {
    // Tile x -4 lies in the tile's buffer: the western neighbour draws and
    // answers for it. Both anchors land near screen x 38.
    const { layer } = queryLayer({}, [
      { id: 1, points: [[-4, 4096]] },
      { id: 2, points: [[4, 4096]] },
    ]);
    const x = 400 + (0 - 4096) / (8192 / (512 * 2 ** 0.5));
    expect(ids(layer.queryFeatures({ x, y: center.y }))).toEqual([2]);
  });

  it("dedupes a feature that a parent and a child tile both draw", () => {
    const parent = {
      key: "4/8/5",
      wrap: 0,
      overscaledZ: 4,
      canonical: { z: 4, x: 8, y: 5 },
    };
    const child = {
      key: "5/17/11",
      wrap: 0,
      overscaledZ: 5,
      canonical: { z: 5, x: 17, y: 11 },
    };
    const { layer } = queryLayer({}, [], {
      type: "vector",
      coords: [parent, child],
      tiles: {
        [parent.key]: pointTile("poi", [
          { id: 9, properties: { tile: "parent" }, points: [[4096, 4096]] },
        ]),
        // The same place in the child's units: (4096 - 4096) * 2.
        [child.key]: pointTile("poi", [
          { id: 9, properties: { tile: "child" }, points: [[0, 0]] },
        ]),
      },
    });
    const hits = layer.queryFeatures(center);
    expect(ids(hits)).toEqual([9]);
    // The tile drawn last wins, with its source layer.
    expect(hits[0]!.properties).toEqual({ tile: "child" });
    expect(hits[0]!.sourceLayer).toBe("poi");
  });

  it("finds nothing before the first render or after removal", () => {
    const layer = pointsLayer({ "icon-animation": firstAnimation.name });
    expect(layer.queryFeatures(center)).toEqual([]);
    const { layer: drawn, fake } = queryLayer({}, [
      { id: 1, points: [[4096, 4096]] },
    ]);
    expect(drawn.hitTest(center)).toBe(true);
    drawn.onRemove(fake.map);
    expect(drawn.hitTest(center)).toBe(false);
  });
});
