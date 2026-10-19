import { describe, expect, it } from "vite-plus/test";

import type { VectorFeatureLike, VectorLayerLike } from "./gljs.ts";
import { LayoutEvaluator } from "./paint.ts";
import { compileFilter, layoutTile } from "./tiles.ts";

const square = (x: number, y: number, size = 400) => [
  [
    { x, y },
    { x: x + size, y },
    { x: x + size, y: y + size },
    { x, y: y + size },
    { x, y },
  ],
];

function layerOf(
  features: Array<
    Partial<VectorFeatureLike> & { rings: { x: number; y: number }[][] }
  >,
): VectorLayerLike {
  return {
    length: features.length,
    feature: (i) => {
      const { rings, ...rest } = features[i]!;
      return {
        type: 3,
        properties: {},
        extent: 4096,
        loadGeometry: () => rings,
        ...rest,
      };
    },
  };
}

const options = (
  layout: LayoutEvaluator,
  filter = compileFilter(undefined),
) => ({
  geojson: true,
  filter,
  zoom: 16,
  canonical: { z: 16, x: 0, y: 0 },
  layout,
  stateId: (feature: VectorFeatureLike) => feature.id,
});

describe("LayoutEvaluator", () => {
  const evaluator = new LayoutEvaluator({
    "building-roof-shape": ["get", "roof:shape"],
    "building-roof-orientation": ["get", "o"],
    "building-roof-direction": ["get", "d"],
  });
  const at = (properties: Record<string, unknown>) =>
    evaluator.evaluate(16, { type: 3, properties });

  it("evaluates each feature's values", () => {
    expect(at({ "roof:shape": "hipped", o: "across", d: 90 })).toEqual({
      shape: "hipped",
      orientation: "across",
      direction: 90,
      lines: "",
    });
  });

  it("gives the default for null, wrong types and values outside an enum", () => {
    expect(at({})).toEqual({
      shape: "flat",
      orientation: "along",
      direction: -1,
      lines: "",
    });
    expect(at({ "roof:shape": "pitched", o: 3, d: "north" })).toEqual({
      shape: "flat",
      orientation: "along",
      direction: -1,
      lines: "",
    });
  });

  it("serializes roof graphs and rejects state-dependent strings", () => {
    const value = { vertices: [[10, 50, 1]], edges: [] };
    const evaluator = new LayoutEvaluator({
      "building-roof-lines": ["to-string", ["get", "roof_lines"]],
    });
    expect(
      JSON.parse(
        evaluator.evaluate(16, { type: 3, properties: { roof_lines: value } })
          .lines,
      ),
    ).toEqual(value);
    expect(
      () =>
        new LayoutEvaluator({
          "building-roof-lines": ["to-string", ["feature-state", "roof_lines"]],
        }),
    ).toThrow();
    expect(() => new LayoutEvaluator({ "building-roof-lines": 42 })).toThrow();
  });

  it("rejects feature-state, bad constants and unknown keys", () => {
    expect(
      () =>
        new LayoutEvaluator({
          "building-roof-shape": ["feature-state", "shape"],
        }),
    ).toThrow(/not supported/);
    expect(
      () => new LayoutEvaluator({ "building-roof-shape": "spire" }),
    ).toThrow();
    expect(
      () => new LayoutEvaluator({ "building-roof-direction": 400 }),
    ).toThrow();
    expect(() => new LayoutEvaluator({ "building-height": 3 })).toThrow(
      /Unknown layout/,
    );
    expect(new LayoutEvaluator({ visibility: "none" }).toJson()).toEqual({
      "building-roof-shape": "flat",
      "building-roof-orientation": "along",
      "building-roof-direction": -1,
      "building-roof-lines": "",
    });
  });
});

describe("layoutTile", () => {
  it("lays out each polygon with its layout values, scaled to the extent", () => {
    const layout = new LayoutEvaluator({
      "building-roof-shape": ["get", "shape"],
    });
    const tile = layoutTile(
      layerOf([
        { id: 7, rings: square(1000, 1000), properties: { shape: "gabled" } },
        { type: 1, rings: [[{ x: 10, y: 10 }]] },
        { rings: square(2000, 2000), properties: { shape: "nope" } },
      ]),
      options(layout),
    );
    expect(tile.features.map((f) => f.index)).toEqual([0, 2]);
    expect(tile.features[0]!.layout.shape).toBe("gabled");
    expect(tile.features[0]!.rings[0]![1]).toEqual({ x: 2800, y: 2000 });
    expect(tile.features[0]!.stateKey).toBe("7");
    expect(tile.features[1]!.layout.shape).toBe("flat");
    expect(tile.features[1]!.stateKey).toBeUndefined();
    expect(tile.layout.ranges.map((r) => r.featureIndex)).toEqual([0, 1]);
    expect(tile.vertices.length).toBe(tile.layout.vertexCount * 7);
  });

  it("filters features and draws buffer copies, cut at the tile's bounds", () => {
    const layout = new LayoutEvaluator({ "building-roof-shape": "gabled" });
    const tile = layoutTile(
      layerOf([
        { rings: square(1000, 1000), properties: { keep: true } },
        { rings: square(1500, 1000), properties: { keep: false } },
        // Only in the buffer, whole.
        { rings: square(-600, 100, 200), properties: { keep: true } },
        // Reaching the westmost point of the drawn features: cut there.
        { rings: square(-700, 900, 200), properties: { keep: true } },
        // Filtered out, so its points do not move the tile's bounds.
        { rings: square(-800, 1500, 200), properties: { keep: false } },
      ]),
      options(layout, compileFilter(["get", "keep"])),
    );
    expect(tile.features.map((f) => f.index)).toEqual([0, 2, 3]);
    expect(tile.layout.bounds.minX).toBe(-1400);
    const roofN = (feature: number): number[] => {
      const range = tile.layout.ranges[feature]!;
      const ns: number[] = [];
      for (let i = 0; i < range.vertexCount; i++) {
        const v = tile.layout.vertex(range.firstVertex + i);
        if (v.kind >= 2) ns.push(v.n);
      }
      return ns;
    };
    expect(Math.max(...roofN(1))).toBe(1);
    expect(Math.max(...roofN(2))).toBe(0);
  });

  it("gives layout expressions the feature's geometry and tile, for distance", () => {
    const tile = { z: 16, x: 34_000, y: 22_000 };
    // A point inside the first building (layout units 800 to 1600 of 8192).
    const f = 1200 / 8192;
    const lon = ((tile.x + f) / 2 ** tile.z) * 360 - 180;
    const lat =
      (Math.atan(Math.sinh(Math.PI * (1 - (2 * (tile.y + f)) / 2 ** tile.z))) *
        180) /
      Math.PI;
    const near = [
      "<",
      ["distance", { type: "Point", coordinates: [lon, lat] }],
      1,
    ];
    const layout = new LayoutEvaluator({
      "building-roof-shape": ["case", near, "gabled", "flat"],
    });
    const out = layoutTile(
      layerOf([
        { id: 1, rings: square(400, 400) },
        { id: 2, rings: square(3000, 400) },
      ]),
      { ...options(layout), canonical: tile },
    );
    expect(out.features.map((f) => f.layout.shape)).toEqual(["gabled", "flat"]);
  });

  it("decodes a GeoJSON source's encoded properties", () => {
    const tile = layoutTile(
      layerOf([
        {
          rings: square(1000, 1000),
          properties: { tags: '__$json__:{"a":1}' },
        },
      ]),
      options(new LayoutEvaluator()),
    );
    expect(tile.features[0]!.evaluation.properties).toEqual({ tags: { a: 1 } });
  });
});
