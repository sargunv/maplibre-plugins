// The particle-emitter JS layer without a GPU: the JSON and paint it accepts
// against the native plugin's, and the GL state it draws with.

import type { CustomRenderMethodInput, Map as MaplibreMap } from "maplibre-gl";
import { describe, expect, it } from "vite-plus/test";

import {
  ParticleEmitterLayer,
  type ParticleEmitterLayerJson,
} from "./emitter-layer.ts";
import { fakeGL } from "./fake-gl.ts";
import type { EmitterPaintInput } from "./paint.ts";

describe("ParticleEmitterLayer", () => {
  it("rejects what the native plugin rejects", () => {
    expect(() =>
      ParticleEmitterLayer.fromLayerJson({
        id: "x",
        type: "particle-features",
      } as unknown as ParticleEmitterLayerJson),
    ).toThrow(/Expected layer type/);
    // The host fails the whole layer on a paint key the type lacks: a
    // features-only property, a misspelt one, or either's transition.
    for (const paint of [
      { "particle-density": 5 },
      { "particle-colour": "#f00" },
      { "particle-density-transition": { duration: 5 } },
    ] as Record<string, unknown>[]) {
      expect(
        () =>
          ParticleEmitterLayer.fromLayerJson({
            id: "x",
            type: "particle-emitter",
            paint: paint as EmitterPaintInput,
          }),
        Object.keys(paint)[0],
      ).toThrow(/Unknown paint property/);
      expect(
        () =>
          new ParticleEmitterLayer({
            id: "x",
            paint: paint as EmitterPaintInput,
          }),
        Object.keys(paint)[0],
      ).toThrow(/Unknown paint property/);
    }
    expect(() =>
      ParticleEmitterLayer.fromLayerJson({
        id: "x",
        type: "particle-emitter",
        paint: { "particle-seed-transition": { duration: 0 } },
      } as ParticleEmitterLayerJson),
    ).toThrow(/takes no transition/);
    const layer = ParticleEmitterLayer.fromLayerJson({
      id: "x",
      type: "particle-emitter",
      paint: {
        "particle-opacity": 0.5,
        "particle-opacity-transition": { duration: 0 },
      },
    });
    expect(layer.toLayerJson().paint).toMatchObject({
      "particle-opacity": 0.5,
      "particle-opacity-transition": { duration: 0 },
    });
    expect(() => layer.setPaintProperty("particle-density", 5)).toThrow(
      /Unknown paint property/,
    );
    expect(() =>
      layer.setPaintProperty("particle-color", ["get", "color"]),
    ).toThrow();
  });

  it("leaves depth to maplibre, read-only at its sublayer like native's", () => {
    const { gl, calls } = fakeGL();
    const map = {
      painter: {
        transform: {
          zoom: 16,
          center: { lat: 37.77, lng: -122.42 },
          width: 800,
          height: 600,
          cameraToCenterDistance: 900,
          pixelsPerMeter: 3,
          pitchInRadians: 0.5,
          getCameraLngLat: () => ({ lat: 37.76, lng: -122.42 }),
          getCameraAltitude: () => 800,
        },
      },
      triggerRepaint() {},
      on() {},
      off() {},
    } as unknown as MaplibreMap;
    const args = {
      shaderData: {
        variantName: "mercator",
        vertexShaderPrelude: "",
        define: "",
      },
      getProjectionData: () => ({
        mainMatrix: new Float32Array(16),
        fallbackMatrix: new Float32Array(16),
        tileMercatorCoords: [0, 0, 1, 1],
        clippingPlane: [0, 0, 0, 0],
        projectionTransition: 0,
      }),
    } as unknown as CustomRenderMethodInput;
    const layer = new ParticleEmitterLayer({
      id: "p",
      paint: { "emitter-position": [37.77, -122.42] },
    });
    layer.onAdd(map, gl);
    layer.render(gl, args);
    expect(calls.some((c) => c.name === "drawElements")).toBe(true);
    const depth = calls.filter(
      (c) =>
        c.name.startsWith("depth") ||
        ((c.name === "enable" || c.name === "disable") &&
          c.args[0] === gl.DEPTH_TEST),
    );
    expect(depth).toEqual([]);
  });
});
