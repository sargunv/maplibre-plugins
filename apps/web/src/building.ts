// The building plugin's shapes page: the 170-building grid of
// plugins/building/examples/shapes (every roof shape on four footprints,
// with orientation, direction and roof-angle variants) drawn by the
// plugin's example layer, with spec-driven controls for its layout and
// paint, the style light, and a core fill-extrusion layer of the same
// heights to compare against. The helpers below are shared with the OSM
// roofs page (osm-roofs.ts).

import {
  BuildingLayer,
  type BuildingLayerJson,
  layoutNames,
  type PaintName,
  paintNames,
  paintSpec,
} from "@maplibre-plugins/building";
import type {
  FillExtrusionLayerSpecification,
  LightSpecification,
  Map as MaplibreMap,
} from "maplibre-gl";

import exampleJson from "../../../plugins/building/examples/layer.json";
import shapesUrl from "../../../plugins/building/examples/shapes/buildings.geojson?url";
import shapesSource from "../../../plugins/building/examples/shapes/source.json";
import sharedSpec from "../../../plugins/building/spec.json";
import {
  numberRow,
  renderSpecControls,
  section,
  selectRow,
  type SpecProperty,
} from "./controls.ts";
import { nativePaint } from "./layer-json.ts";
import type { PluginView } from "./plugins.ts";

const example = exampleJson as BuildingLayerJson;

type Table = Record<string, SpecProperty>;
const spec = sharedSpec as unknown as { layout: Table; paint: Table };

/** Groups and slider ranges the spec leaves to the app. */
const paintUi: Record<string, Partial<SpecProperty>> = {
  "building-height": { group: "Heights", ui: { range: [0, 60, 0.5] } },
  "building-base": { group: "Heights", ui: { range: [0, 40, 0.5] } },
  "building-roof-height": { group: "Heights", ui: { range: [0, 20, 0.5] } },
  "building-roof-angle": { group: "Heights", ui: { range: [0, 89, 1] } },
  "building-color": { group: "Colors" },
  "building-roof-color": { group: "Colors" },
  "building-opacity": { group: "Display" },
  "building-vertical-gradient": { group: "Display" },
  "building-translate": {
    group: "Display",
    components: [
      { name: "right", ui: [-100, 100, 1] },
      { name: "down", ui: [-100, 100, 1] },
    ],
  },
  "building-translate-anchor": { group: "Display" },
};

function withUi(
  table: Table,
  ui: Record<string, Partial<SpecProperty>>,
  group?: string,
): Table {
  return Object.fromEntries(
    Object.entries(table).map(([name, property]) => [
      name,
      { ...property, ...(group && { group }), ...ui[name] } as SpecProperty,
    ]),
  );
}

/** The first symbol layer: 3D layers go under the labels. */
export function firstSymbolLayer(map: MaplibreMap): string | undefined {
  return map.getStyle().layers.find((layer) => layer.type === "symbol")?.id;
}

/**
 * Adds a building layer's spec-driven controls: the layout table under
 * "Roof (layout)" and the paint table by group. Returns a function that
 * re-reads every value.
 */
export function buildingControls(
  panel: HTMLElement,
  layer: BuildingLayer,
  changed: () => void,
): () => void {
  const layoutSync = renderSpecControls(panel, {
    spec: withUi(spec.layout, {}, "Roof (layout)"),
    names: layoutNames,
    get: (name) => layer.getLayoutProperty(name as never),
    set: (name, value) => {
      layer.setLayoutProperty(name, value);
      changed();
    },
  });
  const paintSync = renderSpecControls(panel, {
    spec: withUi(spec.paint, paintUi),
    names: paintNames,
    get: (name) => layer.getPaintProperty(name as PaintName),
    set: (name, value) => {
      layer.setPaintProperty(name, value);
      changed();
    },
  });
  return () => {
    layoutSync();
    paintSync();
  };
}

/**
 * A core fill-extrusion layer drawing the same footprints with the
 * building layer's heights and wall color, for comparison: where the roofs
 * are flat the two should match pixel for pixel.
 */
export function coreExtrusion(
  layer: BuildingLayer,
  id: string,
): FillExtrusionLayerSpecification {
  const json = layer.toLayerJson();
  const paint = json.paint ?? {};
  return {
    id,
    type: "fill-extrusion",
    source: layer.source,
    ...(layer.sourceLayer !== undefined && {
      "source-layer": layer.sourceLayer,
    }),
    layout: { visibility: "none" },
    paint: {
      "fill-extrusion-height": paint["building-height"] as never,
      "fill-extrusion-base": paint["building-base"] as never,
      "fill-extrusion-color": paint["building-color"] as never,
      "fill-extrusion-opacity": paint["building-opacity"] as never,
      "fill-extrusion-vertical-gradient": paint[
        "building-vertical-gradient"
      ] as never,
    },
  };
}

const COMPARE = ["building", "fill-extrusion", "both"] as const;

/**
 * A dropdown that shows the building layer, a core fill-extrusion layer of
 * the same heights, or both sharing the depth buffer.
 */
export function compareRow(
  parent: HTMLElement,
  map: MaplibreMap,
  layer: BuildingLayer,
  coreId: string,
): void {
  selectRow(parent, {
    name: "draw",
    doc: "building: the plugin layer. fill-extrusion: a core layer with the same height, base, wall color and opacity (flat roofs). both: the two share the depth buffer, so the core boxes poke through the roofs.",
    values: COMPARE,
    initial: "building",
    onInput: (value) => {
      const core = value !== "building";
      if (core) {
        // Pick up the building layer's current paint.
        const fresh = coreExtrusion(layer, coreId).paint ?? {};
        for (const [name, v] of Object.entries(fresh))
          map.setPaintProperty(coreId, name as never, v as never);
      }
      map.setLayoutProperty(coreId, "visibility", core ? "visible" : "none");
      layer.setLayoutProperty(
        "visibility",
        value === "fill-extrusion" ? "none" : "visible",
      );
    },
  });
}

interface LightValues {
  anchor: "map" | "viewport";
  position: [number, number, number];
  color: string;
  intensity: number;
}

/** The style spec's light defaults, which a style without `light` gets. */
const LIGHT: LightValues = {
  anchor: "viewport",
  position: [1.15, 210, 30],
  color: "#ffffff",
  intensity: 0.5,
};

/**
 * Controls for the style light, which lights the building layer as it
 * lights core fill-extrusion: anchor, azimuth, polar angle, intensity.
 */
export function lightControls(parent: HTMLElement, map: MaplibreMap): void {
  const light = {
    ...LIGHT,
    position: [...LIGHT.position] as [number, number, number],
  };
  const apply = () => {
    const spec: LightSpecification = {
      ...light,
      position: [...light.position],
    };
    map.setLight(spec);
  };
  const body = section(parent, "Light");
  selectRow(body, {
    name: "anchor",
    doc: "map: the light turns with the map. viewport: it stays fixed to the screen.",
    values: ["viewport", "map"],
    initial: light.anchor,
    onInput: (value) => {
      light.anchor = value as "map" | "viewport";
      apply();
    },
  });
  numberRow(body, {
    name: "azimuth",
    doc: "Where the light comes from, degrees clockwise from north (or from the top of the screen for a viewport anchor).",
    initial: light.position[1],
    range: [0, 360, 1],
    onInput: (value) => {
      light.position[1] = value;
      apply();
    },
  });
  numberRow(body, {
    name: "polar",
    doc: "The light's angle from straight up, in degrees.",
    initial: light.position[2],
    range: [0, 90, 1],
    onInput: (value) => {
      light.position[2] = value;
      apply();
    },
  });
  numberRow(body, {
    name: "intensity",
    doc: "Light intensity: higher brightens lit faces and darkens the rest.",
    initial: light.intensity,
    range: [0, 1, 0.01],
    onInput: (value) => {
      light.intensity = value;
      apply();
    },
  });
}

/** A layer's JSON as the panel shows it: paint as the native plugin loads it. */
export function shownJson(
  layer: BuildingLayer,
  authored: BuildingLayerJson,
): unknown {
  const json = layer.toLayerJson();
  return {
    ...json,
    paint: nativePaint(json.paint ?? {}, paintSpec, authored.paint),
  };
}

export function mountBuilding(
  map: MaplibreMap,
  panel: HTMLElement,
): PluginView {
  map.addSource(example.source, { ...shapesSource, data: shapesUrl } as never);
  const layer = BuildingLayer.fromLayerJson(example);
  const before = firstSymbolLayer(map);
  map.addLayer(layer, before);
  const coreId = `${example.id}-core`;
  map.addLayer(coreExtrusion(layer, coreId), before);

  const listeners: Array<() => void> = [];
  const changed = () => listeners.forEach((l) => l());

  const view = section(panel, "View");
  compareRow(view, map, layer, coreId);
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent =
    "Columns: the 17 roof shapes in spec order. Rows: rectangle along, across and roof:direction 200; the rectangle turned 30° (along, across, direction 75); an L along and across; a 24-gon; roof:angle 35. Click a building for its label.";
  view.append(hint);
  buildingControls(panel, layer, changed);
  lightControls(panel, map);
  // maplibre-gl-js drops custom layers when the WebGL context is lost and
  // reloads the rest of the style once it is restored; add this one back.
  map.on("webglcontextrestored", () => {
    map.once("style.load", () => {
      if (!map.getLayer(layer.id)) map.addLayer(layer, firstSymbolLayer(map));
    });
  });

  return {
    layerJson: () => shownJson(layer, example),
    onChange: (listener) => listeners.push(listener),
    hitTest: (point) => layer.hitTest(point),
    queryFeature: (point) => layer.queryFeature(point),
  };
}
