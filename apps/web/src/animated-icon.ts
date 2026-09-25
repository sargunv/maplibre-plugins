import {
  AnimatedIconLayer,
  type AnimatedIconLayerJson,
  type PaintName,
  paintNames,
  paintSpecFor,
} from "@maplibre-plugins/animated-icon";
import type { Map as MaplibreMap } from "maplibre-gl";

import exampleLayer from "../../../plugins/animated-icon/examples/layer.json";
import sharedSpec from "../../../plugins/animated-icon/spec.json";
import {
  colorRow,
  isExpression,
  numberRow,
  pairRow,
  section,
  selectRow,
  sliderRange,
} from "./controls.ts";
import type { PluginView } from "./plugins.ts";

type Docs = Record<string, { doc?: string }>;
const docs = (sharedSpec as { paint: Docs }).paint;

/** Slider ranges for unbounded properties; bounded ones use the spec's limits. */
const ranges: Partial<Record<PaintName, [number, number, number]>> = {
  "icon-size": [0, 3, 0.05],
  "icon-offset": [-48, 48, 1],
  "icon-animation-speed": [-4, 4, 0.05],
  "icon-animation-offset": [0, 10, 0.05],
};

/** The section each property's row goes under; the rest go under "Icon". */
const sections: Partial<Record<PaintName, "Placement" | "Playback">> = {
  "icon-offset": "Placement",
  "icon-anchor": "Placement",
  "icon-rotation-alignment": "Placement",
  "icon-pitch-alignment": "Placement",
  "icon-animation-speed": "Playback",
  "icon-animation-offset": "Playback",
  "icon-animation-mode": "Playback",
};

/**
 * Properties that move the playhead: a transition of speed or offset would
 * sweep it through the animation, so they switch at once.
 */
const timing = new Set<PaintName>([
  "icon-animation-speed",
  "icon-animation-offset",
  "icon-animation-mode",
]);

export function mountAnimatedIcon(
  map: MaplibreMap,
  panel: HTMLElement,
): PluginView {
  const example = exampleLayer as AnimatedIconLayerJson;
  const layer = AnimatedIconLayer.fromLayerJson(example);
  // On top of the style, like the native viewer adds it by default.
  map.addLayer(layer);
  // maplibre-gl-js drops custom layers when the WebGL context is lost and
  // reloads the rest of the style once it is restored; add this one back.
  map.on("webglcontextrestored", () => {
    map.once("style.load", () => {
      if (!map.getLayer(layer.id)) map.addLayer(layer);
    });
  });
  const spec = paintSpecFor(layer.catalog);

  const listeners: Array<() => void> = [];
  const changed = () => listeners.forEach((l) => l());
  const set = (
    name: PaintName,
    value: unknown,
    transition?: { duration: number },
  ) => {
    layer.setPaintProperty(
      name,
      value,
      timing.has(name) ? { duration: 0 } : transition,
    );
    changed();
  };

  const parents = {
    Icon: section(panel, "Icon"),
    Placement: section(panel, "Placement"),
    Playback: section(panel, "Playback"),
  };
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent =
    "The example picks each POI's animation and anchor from its class and desynchronizes the icons by feature id; rows reading expr are data-driven until you set a value.";
  parents.Icon.append(hint);
  const setters = new Map<PaintName, (value: unknown) => void>();
  for (const name of paintNames) {
    const property = spec[name];
    const doc = docs[name]?.doc ?? "";
    const parent = parents[sections[name] ?? "Icon"];
    const raw = layer.getPaintProperty(name);
    if (property.type === "enum") {
      const show = selectRow(parent, {
        name,
        doc,
        values: property.values,
        initial: typeof raw === "string" ? raw : property.default,
        // An enum holds its old value for the whole transition, then snaps;
        // switch at once so the dropdown answers immediately.
        onInput: (value) => set(name, value, { duration: 0 }),
      });
      const setter = (value: unknown) => {
        if (typeof value === "string") show(value);
        else if (isExpression(value)) show(null);
      };
      setter(raw);
      setters.set(name, setter);
    } else if (property.type === "color") {
      // The alpha field is the recolor strength: 0 keeps the authored colors.
      const show = colorRow(parent, {
        name,
        doc,
        initial: raw,
        onInput: (rgba) => set(name, rgba),
      });
      setters.set(name, show);
    } else if (property.type === "float2") {
      const pair = (value: unknown): [number, number] | null =>
        Array.isArray(value) && value.length === 2 && !isExpression(value)
          ? [Number(value[0]), Number(value[1])]
          : null;
      const show = pairRow(parent, {
        name,
        doc,
        initial: pair(raw) ?? [0, 0],
        components: ["right", "down"],
        range: ranges[name] ?? [-1, 1, 0.01],
        onInput: (value) => set(name, value),
      });
      const setter = (value: unknown) => {
        const next = pair(value);
        if (next) show(next);
        else if (isExpression(value)) show(null);
      };
      setter(raw);
      setters.set(name, setter);
    } else {
      const show = numberRow(parent, {
        name,
        doc,
        initial: typeof raw === "number" ? raw : Number(property.default),
        range: sliderRange(property, ranges[name]),
        onInput: (value) => set(name, value),
      });
      const setter = (value: unknown) => {
        if (typeof value === "number") show(value);
        else if (isExpression(value)) show(null);
      };
      setter(raw);
      setters.set(name, setter);
    }
  }

  const actions = document.createElement("div");
  actions.className = "actions";
  const presets: Array<[string, Partial<Record<PaintName, unknown>>]> = [
    ["Example", example.paint ?? {}],
    ["Pulse", { "icon-animation": "pulse", "icon-size": 0.8 }],
    [
      "Recolored",
      {
        "icon-animation": "pin",
        "icon-anchor": "bottom",
        "icon-color": [0.17, 0.54, 0.9, 1],
      },
    ],
    [
      "On the ground",
      {
        "icon-animation": "pulse",
        "icon-size": 1.5,
        "icon-rotation-alignment": "map",
        "icon-pitch-alignment": "map",
      },
    ],
    [
      "Ping-pong",
      {
        ...example.paint,
        "icon-animation-mode": "alternate",
        "icon-animation-speed": 0.5,
      },
    ],
    ["In sync", { ...example.paint, "icon-animation-offset": 0 }],
  ];
  if (layer.catalog.animations.some((a) => a.name === "clear-day")) {
    presets.push([
      "Weather",
      { "icon-animation": "clear-day", "icon-size": 1.2, "icon-opacity": 0.9 },
    ]);
  }
  for (const [title, paint] of presets) {
    const button = document.createElement("button");
    button.textContent = title;
    button.addEventListener("click", () => {
      for (const name of paintNames) {
        const value = paint[name] ?? spec[name].default;
        const duration =
          spec[name].type === "enum" || timing.has(name) ? 0 : 600;
        layer.setPaintProperty(name, value, { duration });
        setters.get(name)?.(value);
      }
      changed();
    });
    actions.append(button);
  }
  parents.Icon.append(actions);

  return {
    layerJson: () => layer.toLayerJson(),
    onChange: (listener) => listeners.push(listener),
    hitTest: (point) => layer.hitTest(point),
    queryFeature: (point) => layer.queryFeature(point),
  };
}
