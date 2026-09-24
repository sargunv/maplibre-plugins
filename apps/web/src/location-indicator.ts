import {
  LocationPuckLayer,
  type LocationPuckLayerJson,
  type PaintName,
  paintNames,
  type PaintPropertySpec,
  paintSpec,
} from "@maplibre-plugins/location-indicator";
import type { Map as MaplibreMap, MapMouseEvent } from "maplibre-gl";

import exampleLayer from "../../../plugins/location-indicator/examples/layer.json";
import sharedSpec from "../../../plugins/location-indicator/spec.json";
import { colorRow, numberRow, section, sliderRange } from "./controls.ts";
import type { PluginView } from "./plugins.ts";

type Docs = Record<string, { doc?: string }>;
const docs = (sharedSpec as { paint: Docs }).paint;

/** Slider ranges for unbounded properties; bounded ones use the spec's limits. */
const ranges: Partial<Record<PaintName, [number, number, number]>> = {
  "tilt-displacement": [0, 60, 1],
  "bearing-radius": [0, 60, 1],
  "accuracy-radius": [0, 2000, 1],
  "accuracy-border-width": [0, 8, 0.5],
  "bearing-accuracy-radius": [0, 200, 1],
  "shadow-radius": [0, 60, 1],
  "puck-radius": [0, 40, 1],
  "puck-border-width": [0, 12, 0.5],
  "pulse-radius": [0, 120, 1],
  "pulse-period": [0.1, 5, 0.1],
};

export function mountLocationIndicator(
  map: MaplibreMap,
  panel: HTMLElement,
): PluginView {
  const layer = LocationPuckLayer.fromLayerJson(
    exampleLayer as LocationPuckLayerJson,
  );
  map.addLayer(layer);

  const listeners: Array<() => void> = [];
  const changed = () => listeners.forEach((l) => l());
  const set = (name: PaintName, value: unknown) => {
    layer.setPaintProperty(name, value);
    changed();
  };

  const numberControls = new Map<PaintName, (value: number) => void>();
  const positionSection = section(panel, "Position");
  const positionInputs = ([0, 1] as const).map((index) => {
    const row = document.createElement("div");
    row.className = "row wide";
    const label = document.createElement("label");
    label.textContent = index === 0 ? "latitude" : "longitude";
    label.title = docs.position?.doc ?? "";
    const input = document.createElement("input");
    input.type = "number";
    input.step = "0.0001";
    row.append(label, input);
    positionSection.append(row);
    input.addEventListener("change", () => {
      const current = layer.getPaintProperty("position") as [number, number];
      const next: [number, number] = [current[0], current[1]];
      next[index] = Number(input.value);
      set("position", next);
    });
    return input;
  });
  const syncPosition = () => {
    const [lat, lon] = layer.getPaintProperty("position") as [number, number];
    positionInputs[0]!.value = lat.toFixed(5);
    positionInputs[1]!.value = lon.toFixed(5);
  };
  syncPosition();

  const actions = document.createElement("div");
  actions.className = "actions";
  positionSection.append(actions);

  const placeButton = document.createElement("button");
  placeButton.textContent = "Move to click";
  let placing = false;
  placeButton.addEventListener("click", () => {
    placing = !placing;
    placeButton.setAttribute("aria-pressed", String(placing));
  });
  map.on("click", (e: MapMouseEvent) => {
    if (!placing) return;
    set("position", [e.lngLat.lat, e.lngLat.lng]);
    syncPosition();
  });
  actions.append(placeButton);

  // A drive simulation: circles the start point, animating position and
  // bearing through ordinary paint transitions, like a location provider would.
  const driveButton = document.createElement("button");
  driveButton.textContent = "Simulate driving";
  let driving: number | null = null;
  driveButton.addEventListener("click", () => {
    if (driving !== null) {
      clearInterval(driving);
      driving = null;
      driveButton.setAttribute("aria-pressed", "false");
      return;
    }
    const [lat0, lon0] = layer.getPaintProperty("position") as [number, number];
    let step = 0;
    const tick = () => {
      step += 1;
      const angle = step * 0.08;
      const radiusDeg = 0.004;
      const lat = lat0 + radiusDeg * Math.sin(angle);
      const lon =
        lon0 + (radiusDeg * Math.cos(angle)) / Math.cos((lat0 * Math.PI) / 180);
      const bearing = ((angle * 180) / Math.PI + 90 + 360) % 360;
      layer.setPaint(
        { position: [lat, lon], bearing, "bearing-visible": 1 },
        { duration: 1000 },
      );
      syncPosition();
      numberControls.get("bearing")?.(bearing);
      numberControls.get("bearing-visible")?.(1);
      changed();
    };
    tick();
    driving = window.setInterval(tick, 1000);
    driveButton.setAttribute("aria-pressed", "true");
  });
  actions.append(driveButton);

  const resetButton = document.createElement("button");
  resetButton.textContent = "Reset";
  resetButton.addEventListener("click", () => {
    const paint = (exampleLayer as LocationPuckLayerJson).paint ?? {};
    for (const name of paintNames) {
      const value = paint[name] ?? paintSpec[name].default;
      layer.setPaintProperty(name, value);
      const spec = paintSpec[name];
      if (spec.type === "float" || spec.type === "rotation")
        numberControls.get(name)?.(value as number);
      if (spec.type === "color") colorControls.get(name)?.(value);
    }
    syncPosition();
    changed();
  });
  actions.append(resetButton);

  const numbersSection = section(panel, "Geometry");
  const colorsSection = section(panel, "Colors");
  const colorControls = new Map<PaintName, (value: unknown) => void>();

  for (const name of paintNames) {
    const spec: PaintPropertySpec = paintSpec[name];
    const doc = docs[name]?.doc ?? "";
    if (spec.type === "float" || spec.type === "rotation") {
      const show = numberRow(numbersSection, {
        name,
        doc,
        initial: Number(layer.getPaintProperty(name)),
        range: sliderRange(spec, ranges[name]),
        onInput: (value) => set(name, value),
      });
      numberControls.set(name, show);
    } else if (spec.type === "color") {
      const show = colorRow(colorsSection, {
        name,
        doc,
        initial: layer.getPaintProperty(name),
        onInput: (rgba) => set(name, rgba),
      });
      colorControls.set(name, show);
    }
  }

  return {
    layerJson: () => layer.toLayerJson(),
    onChange: (listener) => listeners.push(listener),
    hitTest: (point) => layer.hitTest(point),
    queryFeature: (point) => layer.queryFeature(point),
  };
}
