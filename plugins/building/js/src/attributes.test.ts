import {
  attributeLayout,
  compileValue,
  type Current,
  fillAttributes,
} from "@maplibre-plugins/paint";
import { describe, expect, it } from "vite-plus/test";

import { colorByte, packAttributes, packedLayout } from "./attributes.ts";
import { BOUND_NAMES, type BoundName } from "./shaders.ts";
import { paintSpec } from "./spec.ts";

/** Every bound property's value: the given expressions, else its default. */
function currentOf(values: Partial<Record<BoundName, unknown>>) {
  return Object.fromEntries(
    BOUND_NAMES.map((name) => {
      const compiled = compileValue(paintSpec[name], name, values[name]);
      return [name, compiled.kind === "feature" ? compiled : compiled.at(16)];
    }),
  ) as Record<BoundName, Current>;
}

describe("colorByte", () => {
  it("truncates like the host's uint8(clamp(c, 0, 1) * 255)", () => {
    expect(colorByte(0)).toBe(0);
    expect(colorByte(1)).toBe(255);
    expect(colorByte(0.5)).toBe(127);
    expect(colorByte(254.9 / 255)).toBe(254);
    expect(colorByte(-1)).toBe(0);
    expect(colorByte(2)).toBe(255);
    expect(colorByte(Number.NaN)).toBe(0);
  });
});

describe("packAttributes", () => {
  const current = currentOf({
    "building-height": ["get", "h"],
    "building-roof-color": [
      "interpolate",
      ["linear"],
      ["zoom"],
      16,
      ["to-color", ["get", "c"]],
      17,
      "#ffffff",
    ],
  });
  const layout = attributeLayout(BOUND_NAMES, current);

  it("gives every bound property 8 bytes at the contract's locations", () => {
    expect(layout.key).toBe("01111011");
    expect(packedLayout(layout)).toEqual({
      stride: 16,
      attributes: [
        { location: 2, kind: "float2", offset: 0 },
        { location: 8, kind: "rgba8", offset: 8 },
        { location: 9, kind: "rgba8", offset: 12 },
      ],
    });
  });

  it("packs numbers as float pairs and colors as min and max bytes", () => {
    const features = [
      { type: 3 as const, properties: { h: 12, c: "rgba(255, 0, 0, 0.5)" } },
      { type: 3 as const, properties: { h: 30, c: "#00ff00" } },
    ];
    const ranges = [
      { featureIndex: 0, firstVertex: 0, vertexCount: 2 },
      { featureIndex: 1, firstVertex: 2, vertexCount: 1 },
    ];
    const floats = new Float32Array(3 * layout.stride);
    fillAttributes(
      floats,
      layout,
      current,
      ranges,
      {
        feature: (i) => features[i],
        stateKey: () => undefined,
        state: () => undefined,
      },
      16,
    );
    const out = new ArrayBuffer(3 * 16);
    packAttributes(floats, layout, out);
    const f32 = new Float32Array(out);
    const u8 = new Uint8Array(out);
    expect([f32[0], f32[1], f32[4], f32[5], f32[8], f32[9]]).toEqual([
      12, 12, 12, 12, 30, 30,
    ]);
    // Premultiplied half-alpha red at zoom 16, white at 17.
    expect([...u8.subarray(8, 16)]).toEqual([
      127, 0, 0, 127, 255, 255, 255, 255,
    ]);
    expect([...u8.subarray(40, 48)]).toEqual([
      0, 255, 0, 255, 255, 255, 255, 255,
    ]);
  });
});
