import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader, PbfWriter } from "pbf";
import { describe, expect, it } from "vite-plus/test";

import type { VectorFeatureLike, VectorLayerLike } from "./gljs.ts";
import { compileFilter, type ReadOptions, readPointFeatures } from "./tiles.ts";

// A minimal Mapbox Vector Tile encoder, enough to feed readPointFeatures
// the layers maplibre-gl-js's feature index decodes (loadVTLayers).

type Value = string | number;

interface TestFeature {
  id?: number;
  /** 1 point, 2 line, 3 polygon. */
  type: 1 | 2 | 3;
  properties?: Record<string, Value>;
  /** Points of one MoveTo (points) or of a MoveTo then LineTos (lines, polygons). */
  points: Array<[number, number]>;
}

interface TestLayer {
  name: string;
  extent: number;
  features: TestFeature[];
}

const zigzag = (n: number) => (n << 1) ^ (n >> 31);

function geometry(feature: TestFeature): number[] {
  const out: number[] = [];
  let x = 0;
  let y = 0;
  feature.points.forEach(([px, py], i) => {
    if (feature.type === 1 && i === 0)
      out.push((feature.points.length << 3) | 1);
    if (feature.type !== 1 && i === 0) out.push((1 << 3) | 1);
    if (feature.type !== 1 && i === 1)
      out.push(((feature.points.length - 1) << 3) | 2);
    out.push(zigzag(px - x), zigzag(py - y));
    x = px;
    y = py;
  });
  if (feature.type === 3) out.push((1 << 3) | 7);
  return out;
}

function encodeTile(layers: TestLayer[]): Uint8Array {
  const pbf = new PbfWriter();
  for (const layer of layers) {
    pbf.writeMessage(
      3,
      (l: TestLayer, p) => {
        const keys: string[] = [];
        const values: Value[] = [];
        const index = <T>(list: T[], item: T) => {
          const i = list.indexOf(item);
          return i >= 0 ? i : list.push(item) - 1;
        };
        p.writeVarintField(15, 2);
        p.writeStringField(1, l.name);
        for (const feature of l.features) {
          p.writeMessage(
            2,
            (f: TestFeature, fp) => {
              if (f.id !== undefined) fp.writeVarintField(1, f.id);
              const tags = Object.entries(f.properties ?? {}).flatMap(
                ([key, value]) => [index(keys, key), index(values, value)],
              );
              fp.writePackedVarint(2, tags);
              fp.writeVarintField(3, f.type);
              fp.writePackedVarint(4, geometry(f));
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
              else vp.writeSVarintField(6, v);
            },
            value,
          );
        }
        p.writeVarintField(5, l.extent);
      },
      layer,
    );
  }
  return pbf.finish();
}

const tile = { z: 0, x: 0, y: 0 };

/** The layers of an encoded tile, decoded as loadVTLayers does for MVT. */
function layers(data: Uint8Array): Record<string, VectorLayerLike> {
  return new VectorTile(new PbfReader(data)).layers as unknown as Record<
    string,
    VectorLayerLike
  >;
}

function options(overrides: Partial<ReadOptions> = {}): ReadOptions {
  return {
    geojson: false,
    filter: null,
    zoom: 14,
    canonical: tile,
    stateId: (feature) => feature.id,
    ...overrides,
  };
}

const poi: TestLayer = {
  name: "poi",
  extent: 4096,
  features: [
    {
      id: 7,
      type: 1,
      properties: { name: "a", rank: 1 },
      points: [[100, 200]],
    },
    {
      type: 2,
      properties: { rank: 1 },
      points: [
        [0, 0],
        [50, 50],
      ],
    },
    {
      type: 1,
      properties: { name: "b", rank: 5 },
      points: [
        [10, 20],
        [4095, 0],
        [-8, 4100],
      ],
    },
    { type: 1, properties: { name: "c", rank: 20 }, points: [[1, 1]] },
    {
      type: 3,
      properties: { rank: 1 },
      points: [
        [0, 0],
        [9, 0],
        [9, 9],
      ],
    },
  ],
};

describe("readPointFeatures", () => {
  const data = layers(encodeTile([poi]));

  it("returns every point feature scaled to the layout extent", () => {
    const features = readPointFeatures(data.poi, options())!;
    expect(features.map((f) => f.index)).toEqual([0, 2, 3]);
    expect(features[0]!.points).toEqual([{ x: 200, y: 400 }]);
    // A MultiPoint keeps each point, buffered ones too; the layout drops those.
    expect(features[1]!.points).toEqual([
      { x: 20, y: 40 },
      { x: 8190, y: 0 },
      { x: -16, y: 8200 },
    ]);
    expect(features[0]!.evaluation).toEqual({
      type: 1,
      id: 7,
      properties: { name: "a", rank: 1 },
    });
    expect(features[0]!.id).toBe(7);
    expect(features[0]!.stateKey).toBe("7");
    // No id: expressions see none (style-spec's ["id"] tests for the key),
    // and the feature has no state.
    expect("id" in features[1]!.evaluation).toBe(false);
    expect(features[1]!.stateKey).toBeUndefined();
  });

  it("filters like the layer does", () => {
    const filter = compileFilter(["<=", ["get", "rank"], 12]);
    const features = readPointFeatures(data.poi, options({ filter }))!;
    expect(features.map((f) => f.index)).toEqual([0, 2]);
    const zoomed = compileFilter([">=", ["zoom"], 15]);
    expect(readPointFeatures(data.poi, options({ filter: zoomed }))).toEqual(
      [],
    );
    expect(
      readPointFeatures(data.poi, options({ filter: zoomed, zoom: 15 })),
    ).toHaveLength(3);
    const byId = compileFilter(["==", ["id"], 7]);
    expect(
      readPointFeatures(data.poi, options({ filter: byId }))!.map(
        (f) => f.index,
      ),
    ).toEqual([0]);
  });

  it("gives geometry filters the points in layout coordinates", () => {
    const around = (lng: number, lat: number) => [
      [lng - 1, lat - 1],
      [lng + 1, lat - 1],
      [lng + 1, lat + 1],
      [lng - 1, lat + 1],
      [lng - 1, lat - 1],
    ];
    const centered = layers(
      encodeTile([
        {
          name: "poi",
          extent: 4096,
          features: [
            { type: 1, points: [[2048, 2048]] },
            { type: 1, points: [[100, 100]] },
          ],
        },
      ]),
    );
    const filter = compileFilter([
      "within",
      { type: "Polygon", coordinates: [around(0, 0)] },
    ]);
    const features = readPointFeatures(
      centered.poi,
      options({ filter, zoom: 0 }),
    )!;
    expect(features.map((f) => f.index)).toEqual([0]);
  });

  it("rounds like MapLibre Native: halves away from zero", () => {
    const fine = layers(
      encodeTile([
        {
          name: "poi",
          extent: 16384,
          features: [
            {
              type: 1,
              points: [
                [3, 5],
                [-3, -5],
                [1, -1],
              ],
            },
          ],
        },
        {
          name: "tiny",
          extent: 81920,
          features: [{ type: 1, points: [[-3, 3]] }],
        },
      ]),
    );
    const [feature] = readPointFeatures(fine.poi, options())!;
    expect(feature!.points).toEqual([
      { x: 2, y: 3 },
      { x: -2, y: -3 },
      { x: 1, y: -1 },
    ]);
    const [tiny] = readPointFeatures(fine.tiny, options())!;
    expect(tiny!.points).toEqual([{ x: 0, y: 0 }]);
    expect(Object.is(tiny!.points[0]!.x, 0)).toBe(true);
  });

  it("returns null for a tile without the source layer", () => {
    expect(readPointFeatures(data.water, options())).toBeNull();
  });

  it("decodes a GeoJSON source's encoded objects and arrays, and only there", () => {
    const encoded = {
      name: "_geojsonTileLayer",
      extent: 8192,
      features: [
        {
          id: 3,
          type: 1 as const,
          properties: {
            tags: '__$json__:{"kind":"cafe"}',
            sizes: "__$json__:[1,2]",
            broken: "__$json__:{",
            plain: "x",
          },
          points: [[10, 10]] as Array<[number, number]>,
        },
      ],
    };
    const decoded = layers(encodeTile([encoded]))._geojsonTileLayer;
    const [geojson] = readPointFeatures(decoded, options({ geojson: true }))!;
    expect(geojson!.evaluation.properties).toEqual({
      tags: { kind: "cafe" },
      sizes: [1, 2],
      broken: "__$json__:{",
      plain: "x",
    });
    // Filters see the decoded values too, as MapLibre Native's do.
    const filter = compileFilter([
      "==",
      ["get", "kind", ["get", "tags"]],
      "cafe",
    ]);
    expect(
      readPointFeatures(decoded, options({ geojson: true, filter })),
    ).toHaveLength(1);
    const [vector] = readPointFeatures(decoded, options())!;
    expect(vector!.evaluation.properties.tags).toBe(
      '__$json__:{"kind":"cafe"}',
    );
  });

  it("reads MLT features: a NaN id is none, and the shared properties stay untouched", () => {
    // MLTVectorTileFeature: Number(id) is NaN without one, and a layer hands
    // out the same properties object on every read.
    const shared = { name: "__$json__:[1]" };
    const mlt: VectorLayerLike = {
      length: 2,
      feature(i: number): VectorFeatureLike {
        return {
          type: 1,
          id: i === 0 ? Number.NaN : 42,
          properties: shared,
          extent: 4096,
          loadGeometry: () => [[{ x: 10 * (i + 1), y: 20 }]],
        };
      },
    };
    const features = readPointFeatures(mlt, options({ geojson: true }))!;
    expect(features.map((f) => f.id)).toEqual([undefined, 42]);
    expect("id" in features[0]!.evaluation).toBe(false);
    expect(features[1]!.evaluation.id).toBe(42);
    expect(features[0]!.evaluation.properties).toEqual({ name: [1] });
    expect(shared).toEqual({ name: "__$json__:[1]" });
    expect(features[0]!.evaluation.properties).not.toBe(
      features[1]!.evaluation.properties,
    );
  });

  it("keys feature state by the state id gl-js gives (promoteId)", () => {
    const promoted = readPointFeatures(
      data.poi,
      options({
        stateId: (feature: VectorFeatureLike) => feature.properties.name,
      }),
    )!;
    expect(promoted.map((f) => f.stateKey)).toEqual(["a", "b", "c"]);
    expect(promoted.map((f) => f.id)).toEqual(["a", "b", "c"]);
    // Expressions still read the feature's own id, as in maplibre-gl-js.
    expect(promoted[0]!.evaluation.id).toBe(7);
    const numeric = readPointFeatures(
      data.poi,
      options({ stateId: (feature) => feature.properties.rank }),
    )!;
    expect(numeric.map((f) => f.stateKey)).toEqual(["1", "5", "20"]);
  });
});
