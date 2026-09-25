import { compile, type PaintPropertySpec } from "@maplibre-plugins/paint";
import { describe, expect, it } from "vite-plus/test";

import locationExample from "../../../plugins/location-indicator/examples/layer.json";
import locationSpec from "../../../plugins/location-indicator/spec.json";
import particlesExample from "../../../plugins/particles/examples/layer.json";
import particlesSpec from "../../../plugins/particles/spec.json";
import waterExample from "../../../plugins/water/examples/layer.json";
import waterSpec from "../../../plugins/water/spec.json";
import { cssColor, nativePaint } from "./layer-json.ts";

type Spec = Record<string, PaintPropertySpec>;

const color: PaintPropertySpec = { type: "color", default: [1, 1, 1, 1] };
const width: PaintPropertySpec = { type: "float", default: 4 };

describe("cssColor", () => {
  it("writes a straight-alpha float color as rgba(), clamped to 0..1", () => {
    expect(cssColor([1, 0.5, 0, 0.25])).toBe("rgba(255, 128, 0, 0.25)");
    expect(cssColor([2, -1, 0, 3])).toBe("rgba(255, 0, 0, 1)");
  });

  it("parses back to the same color, to 8 bits", () => {
    const rgba = [0.62, 0.9, 0.96, 0.55];
    const parsed = compile(color, "color", cssColor(rgba))(0);
    const straight = compile(color, "color", rgba)(0);
    parsed.forEach((c, i) => expect(c).toBeCloseTo(straight[i]!, 2));
  });
});

describe("nativePaint", () => {
  const spec: Spec = { color, width };

  it("leaves out properties at their default unless the example sets them", () => {
    expect(nativePaint({ color: [1, 1, 1, 1], width: 4 }, spec)).toEqual({});
    expect(nativePaint({ color: [1, 1, 1, 1], width: 5 }, spec)).toEqual({
      width: 5,
    });
    expect(
      nativePaint({ color: [1, 1, 1, 1], width: 4 }, spec, { width: 4 }),
    ).toEqual({ width: 4 });
  });

  it("writes colors that are still float arrays as CSS strings", () => {
    expect(nativePaint({ color: [1, 0, 0, 0.5] }, spec)).toEqual({
      color: "rgba(255, 0, 0, 0.5)",
    });
    expect(
      nativePaint({ color: [1, 1, 1, 1] }, spec, { color: [1, 1, 1, 1] }),
    ).toEqual({ color: "rgba(255, 255, 255, 1)" });
    expect(nativePaint({ color: "red" }, spec)).toEqual({ color: "red" });
    const ramp = ["interpolate", ["linear"], ["zoom"], 0, "red", 10, "blue"];
    expect(nativePaint({ color: ramp }, spec)).toEqual({ color: ramp });
  });

  it("passes other keys through", () => {
    expect(
      nativePaint({ "width-transition": { duration: 0 }, extra: 1 }, spec),
    ).toEqual({ "width-transition": { duration: 0 }, extra: 1 });
  });

  // Each layer's toLayerJson lists every property, holding the spec.json
  // default where the example sets none; colors default to float arrays.
  it.each([
    ["location-indicator", locationSpec, locationExample],
    ["water", waterSpec, waterExample],
    ["particles", particlesSpec, particlesExample],
  ])(
    "shows %s's example with only CSS string colors",
    (_, pluginSpec, example) => {
      const paintSpec = (pluginSpec as { paint: Spec }).paint;
      const authored = (example as { paint?: Record<string, unknown> }).paint;
      const layerPaint = {
        ...Object.fromEntries(
          Object.entries(paintSpec).map(([name, p]) => [name, p.default]),
        ),
        ...authored,
      };
      const shown = nativePaint(layerPaint, paintSpec, authored);
      expect(Object.keys(shown).sort()).toEqual(
        Object.keys(authored ?? {}).sort(),
      );
      for (const [name, value] of Object.entries(shown)) {
        if (paintSpec[name]?.type === "color")
          expect(typeof value, name).toBe("string");
      }
    },
  );
});
