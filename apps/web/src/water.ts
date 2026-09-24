import {
  type PaintName,
  paintNames,
  paintSpec,
  WaterShoreLayer,
  type WaterShoreLayerJson,
} from "@maplibre-plugins/water";
import type { Map as MaplibreMap } from "maplibre-gl";

import exampleLayer from "../../../plugins/water/examples/layer.json";
import sharedSpec from "../../../plugins/water/spec.json";
import { colorRow, numberRow, section, sliderRange } from "./controls.ts";
import type { PluginView } from "./plugins.ts";

type Docs = Record<string, { doc?: string }>;
const docs = (sharedSpec as { paint: Docs }).paint;

/** Slider ranges for unbounded properties; bounded ones use the spec's limits. */
const ranges: Partial<Record<PaintName, [number, number, number]>> = {
  "shore-width": [0, 160, 1],
};

/**
 * Inserts the layer right above the style's water fills, so it sits under
 * roads, buildings and labels like the native example does.
 */
function beforeIdAboveWater(map: MaplibreMap): string | undefined {
  const layers = map.getStyle().layers;
  let index = -1;
  layers.forEach((layer, i) => {
    if (layer.type === "fill" && layer["source-layer"] === "water") index = i;
  });
  return layers[index + 1]?.id;
}

export function mountWater(map: MaplibreMap, panel: HTMLElement): PluginView {
  const layer = WaterShoreLayer.fromLayerJson(
    exampleLayer as WaterShoreLayerJson,
  );
  map.addLayer(layer, beforeIdAboveWater(map));

  const listeners: Array<() => void> = [];
  const changed = () => listeners.forEach((l) => l());
  const set = (name: PaintName, value: unknown) => {
    layer.setPaintProperty(name, value);
    changed();
  };

  const wavesSection = section(panel, "Waves");
  const colorsSection = section(panel, "Colors");
  const setters = new Map<PaintName, (value: unknown) => void>();
  for (const name of paintNames) {
    const spec = paintSpec[name];
    const doc = docs[name]?.doc ?? "";
    if (spec.type === "float") {
      const raw = layer.getPaintProperty(name);
      const show = numberRow(wavesSection, {
        name,
        doc,
        initial: typeof raw === "number" ? raw : Number(spec.default),
        range: sliderRange(spec, ranges[name]),
        onInput: (value) => set(name, value),
      });
      setters.set(name, (value) => {
        if (typeof value === "number") show(value);
      });
    } else if (spec.type === "color") {
      const show = colorRow(colorsSection, {
        name,
        doc,
        initial: layer.getPaintProperty(name),
        onInput: (rgba) => set(name, rgba),
      });
      setters.set(name, show);
    }
  }

  const actions = document.createElement("div");
  actions.className = "actions";
  const presets: Array<[string, Partial<Record<PaintName, unknown>>]> = [
    ["Example", (exampleLayer as WaterShoreLayerJson).paint ?? {}],
    [
      "Calm",
      {
        "wave-count": 1,
        "wave-speed": 0.12,
        "wave-wobble": 0.2,
        "foam-length": 0.15,
        "wash-strength": 0.5,
      },
    ],
    [
      "Surf",
      {
        "wave-count": 6,
        "wave-speed": 0.6,
        "wave-wobble": 0.8,
        "foam-length": 0.5,
        "wash-strength": 1,
      },
    ],
  ];
  for (const [title, paint] of presets) {
    const button = document.createElement("button");
    button.textContent = title;
    button.addEventListener("click", () => {
      for (const name of paintNames) {
        const value = paint[name] ?? paintSpec[name].default;
        layer.setPaintProperty(name, value, { duration: 600 });
        setters.get(name)?.(value);
      }
      changed();
    });
    actions.append(button);
  }
  wavesSection.append(actions);

  return {
    layerJson: () => layer.toLayerJson(),
    onChange: (listener) => listeners.push(listener),
    hitTest: (point) => layer.hitTest(point),
    queryFeature: (point) => layer.queryFeature(point),
  };
}
