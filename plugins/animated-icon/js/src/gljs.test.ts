import type { Map as MaplibreMap } from "maplibre-gl";
import { describe, expect, it } from "vite-plus/test";

import { GlJsInternalsError, sourceTiles } from "./gljs.ts";

const raw = new ArrayBuffer(8);
const layers = { poi: { length: 0, feature: () => ({}) } };

function mapWith(style: unknown): MaplibreMap {
  return { style } as unknown as MaplibreMap;
}

function manager(overrides: Record<string, unknown> = {}) {
  const tiles: Record<string, unknown> = {
    loaded: {
      latestRawTileData: raw,
      latestFeatureIndex: {
        rawTileData: raw,
        promoteId: "ref",
        loadVTLayers: () => layers,
        getId: (feature: { properties: { ref: string } }) =>
          feature.properties.ref,
      },
    },
    // A GeoJSON tile that lost its features: gl-js clears the feature index
    // but keeps the last raw data.
    emptied: { latestRawTileData: raw, latestFeatureIndex: null },
    loading: {},
  };
  const state = { revision: 3, state: { poi: { 7: { hover: true } } } };
  return {
    getVisibleCoordinates: () => [{ key: "loaded" }],
    getTileByID: (key: string) => tiles[key],
    getState: () => state,
    getSource: () => ({ type: "vector" }),
    ...overrides,
  };
}

describe("sourceTiles", () => {
  it("is null until the style has the source", () => {
    expect(sourceTiles(mapWith(undefined), "points")).toBeNull();
    expect(sourceTiles(mapWith({ tileManagers: {} }), "points")).toBeNull();
  });

  it("reads a source's type, tiles and feature state", () => {
    const tiles = sourceTiles(
      mapWith({ tileManagers: { points: manager() } }),
      "points",
    )!;
    expect(tiles.type).toBe("vector");
    expect(tiles.visibleCoordinates()).toEqual([{ key: "loaded" }]);
    const tile = tiles.tile("loaded")!;
    expect(tile.raw).toBe(raw);
    expect(tile.layers()).toBe(layers);
    const feature = {
      type: 1,
      properties: { ref: "a" },
      extent: 4096,
      loadGeometry: () => [],
    };
    expect(tile.stateId(feature, "poi")).toBe("a");
    expect(tiles.featureState()).toEqual({
      revision: 3,
      state: { poi: { 7: { hover: true } } },
    });
  });

  it("gives no data for an emptied or loading tile", () => {
    const tiles = sourceTiles(
      mapWith({ tileManagers: { points: manager() } }),
      "points",
    )!;
    expect(tiles.tile("emptied")).toBeNull();
    expect(tiles.tile("loading")).toBeNull();
    expect(tiles.tile("missing")).toBeNull();
  });

  it("throws one clear error when an internal moved", () => {
    const expectMoved = (style: unknown, run: (map: MaplibreMap) => void) => {
      expect(() => run(mapWith(style))).toThrow(GlJsInternalsError);
      expect(() => run(mapWith(style))).toThrow(
        /maplibre-gl's internals changed .* supports maplibre-gl >=6.10 <7/,
      );
    };
    expectMoved({ sourceCaches: {} }, (map) => sourceTiles(map, "points"));
    expectMoved(
      { tileManagers: { points: manager({ getState: undefined }) } },
      (map) => sourceTiles(map, "points"),
    );
    expectMoved(
      {
        tileManagers: {
          points: manager({ getState: () => ({ revision: "3" }) }),
        },
      },
      (map) => sourceTiles(map, "points")!.featureState(),
    );
    expectMoved(
      {
        tileManagers: {
          points: manager({
            getTileByID: () => ({
              latestFeatureIndex: { rawTileData: raw, vtLayers: {} },
            }),
          }),
        },
      },
      (map) => sourceTiles(map, "points")!.tile("loaded"),
    );
  });
});
