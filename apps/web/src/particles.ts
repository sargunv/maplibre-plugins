// The particle plugin's view: every example in plugins/particles/examples as
// a preset button, the selected preset's layer on the map at the preset's
// camera, and spec-driven controls for its layer type. `?preset=<file>`
// picks the preset (default `layer`, the snow the native viewer opens), and
// `?t=<seconds>` freezes the particle clock so frames repeat exactly.

import { supportsTransitions } from "@maplibre-plugins/paint";
import {
  EMITTER_TYPE,
  type EmitterPaintName,
  emitterPaintNames,
  FEATURES_TYPE,
  type FeaturesPaintName,
  featuresPaintNames,
  isPaintName,
  ParticleEmitterLayer,
  type ParticleEmitterLayerJson,
  ParticleFeaturesLayer,
  type ParticleFeaturesLayerJson,
  paintSpec,
} from "@maplibre-plugins/particles";
import type { Map as MaplibreMap, MapMouseEvent } from "maplibre-gl";

import sharedSpec from "../../../plugins/particles/spec.json";
import { renderSpecControls, section, type SpecProperty } from "./controls.ts";
import { nativePaint } from "./layer-json.ts";
import type { PluginEntry, PluginView } from "./plugins.ts";
import { viewerCommand } from "./viewer-command.ts";

type LayerJson = ParticleEmitterLayerJson | ParticleFeaturesLayerJson;
type ParticleLayer = ParticleEmitterLayer | ParticleFeaturesLayer;
type Camera = PluginEntry["camera"];

interface Metadata {
  "maplibre-plugins:title"?: string;
  "maplibre-plugins:camera"?: Camera;
  "maplibre-plugins:before"?: string;
}

interface Preset {
  /** The example's file name without `.json`: the `?preset=` value. */
  file: string;
  json: LayerJson;
  title: string;
  camera: Camera | undefined;
  /** The style layer to insert before, as the native viewer's `--before`. */
  before: string | undefined;
}

const docs = (sharedSpec as unknown as { paint: Record<string, SpecProperty> })
  .paint;

const examples = import.meta.glob<LayerJson>(
  "../../../plugins/particles/examples/*.json",
  { eager: true, import: "default" },
);

/** Button order: weather, the fire family, bursts, ambient, then features. Other files follow by name. */
const ORDER = [
  "layer",
  "rain",
  "fire",
  "smoke",
  "sparks",
  "fountain",
  "fireworks",
  "fireflies",
  "pollen",
  "bubbles",
  "poi-sparkles",
  "park-fireflies",
  "waterway-flow",
  "water-bubbles",
];

const rank = (file: string) => {
  const index = ORDER.indexOf(file);
  return index < 0 ? ORDER.length : index;
};

const presets: Preset[] = Object.entries(examples)
  .map(([path, json]) => {
    const file = path.slice(path.lastIndexOf("/") + 1, -".json".length);
    const metadata = (json.metadata ?? {}) as Metadata;
    return {
      file,
      json,
      title: metadata["maplibre-plugins:title"] ?? json.id,
      camera: metadata["maplibre-plugins:camera"],
      before: metadata["maplibre-plugins:before"],
    };
  })
  .sort((a, b) => rank(a.file) - rank(b.file) || a.file.localeCompare(b.file));

const params = new URLSearchParams(location.search);
const initialPreset =
  presets.find((p) => p.file === params.get("preset")) ??
  presets.find((p) => p.file === "layer") ??
  presets[0]!;
const frozenTime = parseTime(params.get("t"));

/**
 * Where the gallery opens the map: the requested preset's camera, so the
 * first frame is already the preset's view (a URL hash still wins).
 */
export const particlesCamera: Camera = initialPreset.camera ?? {
  center: [37.7695, -122.476],
  zoom: 14,
  bearing: -20,
  pitch: 50,
};

export function mountParticles(
  map: MaplibreMap,
  panel: HTMLElement,
): PluginView {
  // Past a vector source's maxzoom maplibre-gl splits tiles by default, while
  // MapLibre Native overscales them. particle-features lays particles out
  // per tile, so match native, as the plugin README asks. maplibre-gl reads
  // this map field on every tile update.
  map._zoomLevelsToOverscale = undefined;
  panel.classList.add("wide");

  const listeners: Array<() => void> = [];
  const changed = () => listeners.forEach((l) => l());
  const clock = frozenTime === undefined ? undefined : () => frozenTime;

  const presetSection = section(panel, "Presets");
  presetSection.classList.add("presets");
  const buttons = new Map<string, HTMLButtonElement>();
  for (const [type, heading] of [
    [EMITTER_TYPE, "Emitters"],
    [FEATURES_TYPE, "Features"],
  ] as const) {
    const group = presets.filter((p) => p.json.type === type);
    if (group.length === 0) continue;
    const label = document.createElement("h3");
    label.textContent = heading;
    const row = document.createElement("div");
    row.className = "actions";
    for (const preset of group) {
      const button = document.createElement("button");
      button.textContent = preset.title;
      button.title = `${preset.json.type} · examples/${preset.file}.json`;
      button.addEventListener("click", () => select(preset, true));
      buttons.set(preset.file, button);
      row.append(button);
    }
    presetSection.append(label, row);
  }
  const about = document.createElement("p");
  about.className = "hint";
  const command = document.createElement("code");
  command.className = "command";
  command.title = "Opens this preset in the native viewer";
  const actions = document.createElement("div");
  actions.className = "actions";
  presetSection.append(about, command, actions);

  const placeButton = document.createElement("button");
  placeButton.textContent = "Move emitter to click";
  let placing = false;
  const setPlacing = (on: boolean) => {
    placing = on;
    placeButton.setAttribute("aria-pressed", String(on));
  };
  placeButton.addEventListener("click", () => setPlacing(!placing));
  actions.append(placeButton);

  const controls = document.createElement("div");
  controls.className = "spec-controls";
  panel.append(controls);

  let current: { preset: Preset; layer: ParticleLayer } | null = null;
  let refreshControls = () => {};

  const syncActions = () => {
    const layer = current?.layer;
    const isEmitter = layer instanceof ParticleEmitterLayer;
    placeButton.hidden = !isEmitter;
    // Weather ignores emitter-position.
    placeButton.disabled =
      !isEmitter || layer.getPaintProperty("emitter-kind") === "weather";
    if (placeButton.disabled) setPlacing(false);
  };

  const set = (layer: ParticleLayer, name: string, value: unknown) => {
    // The host eases even the properties that take no transition (enums,
    // lifetimes, bursts, seed) over the style's default one; from a control
    // apply those at once, so a dropdown or a lifetime answers immediately.
    const instant = isPaintName(name) && !supportsTransitions(paintSpec[name]);
    layer.setPaintProperty(name, value, instant ? { duration: 0 } : undefined);
    syncActions();
    changed();
  };

  function select(preset: Preset, jump: boolean): void {
    // Build the new layer first: a preset the layer rejects throws before the
    // current one is touched.
    const layer = createLayer(preset.json, clock);
    if (current) map.removeLayer(current.layer.id);
    map.addLayer(layer, beforeId(map, preset.before));
    current = { preset, layer };
    if (jump && preset.camera) map.jumpTo(cameraOptions(preset.camera));

    for (const [file, button] of buttons)
      button.setAttribute("aria-pressed", String(file === preset.file));
    about.textContent =
      `${preset.json.type} · examples/${preset.file}.json` +
      (frozenTime === undefined ? "" : ` · clock frozen at ${frozenTime} s`);
    command.textContent = viewerCommand("particles", {
      layer: `../../plugins/particles/examples/${preset.file}.json`,
      camera: preset.camera,
      before: preset.before,
    });
    syncActions();

    controls.replaceChildren();
    refreshControls = renderSpecControls(controls, {
      spec: docs,
      names:
        preset.json.type === EMITTER_TYPE
          ? emitterPaintNames
          : featuresPaintNames,
      get: (name) => paintValue(layer, name),
      set: (name, value) => set(layer, name, value),
    });

    const url = new URL(location.href);
    url.searchParams.set("preset", preset.file);
    history.replaceState(history.state, "", url);
    changed();
  }

  map.on("click", (e: MapMouseEvent) => {
    if (!placing || !(current?.layer instanceof ParticleEmitterLayer)) return;
    set(current.layer, "emitter-position", [
      round(e.lngLat.lat, 6),
      round(e.lngLat.lng, 6),
    ]);
    refreshControls();
  });

  // maplibre-gl drops custom layers when the WebGL context is lost and
  // reloads the rest of the style once it is restored; add this one back.
  map.on("webglcontextrestored", () => {
    map.once("style.load", () => {
      if (current && !map.getLayer(current.layer.id))
        map.addLayer(current.layer, beforeId(map, current.preset.before));
    });
  });

  select(initialPreset, false);

  return {
    layerJson: () => (current ? layerJson(current.preset, current.layer) : {}),
    onChange: (listener) => listeners.push(listener),
    hitTest: () => false,
    queryFeature: () => null,
  };
}

function createLayer(
  json: LayerJson,
  clock: (() => number) | undefined,
): ParticleLayer {
  // The layer keeps the paint values it is given; hand it a copy so edits
  // never reach the shared example module.
  const copy = structuredClone(json);
  const options = clock ? { clock } : {};
  return copy.type === EMITTER_TYPE
    ? ParticleEmitterLayer.fromLayerJson(copy, options)
    : ParticleFeaturesLayer.fromLayerJson(copy, options);
}

function paintValue(layer: ParticleLayer, name: string): unknown {
  return layer instanceof ParticleEmitterLayer
    ? layer.getPaintProperty(name as EmitterPaintName)
    : layer.getPaintProperty(name as FeaturesPaintName);
}

/**
 * The layer as the native viewer takes it: the preset's JSON with the live
 * paint. Properties the preset leaves out are left out while they hold their
 * default, so the result reads like the example file.
 */
function layerJson(preset: Preset, layer: ParticleLayer): LayerJson {
  const json = layer.toLayerJson();
  const paint = nativePaint(json.paint ?? {}, paintSpec, preset.json.paint);
  return { ...json, paint } as LayerJson;
}

function beforeId(map: MaplibreMap, before: string | undefined) {
  return before !== undefined && map.getLayer(before) ? before : undefined;
}

function cameraOptions(camera: Camera) {
  return {
    center: [camera.center[1], camera.center[0]] as [number, number],
    zoom: camera.zoom,
    bearing: camera.bearing,
    pitch: camera.pitch,
  };
}

function parseTime(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds : undefined;
}

function round(value: number, places: number): number {
  return Number(value.toFixed(places));
}
