// The gallery: one maplibre-gl-js map with a panel of spec-driven controls
// for the JS implementation of each plugin. `mise run web` serves it with
// live reload, so edits to a plugin show up as you type.

import {
  Map as MaplibreMap,
  type MapMouseEvent,
  NavigationControl,
  setWorkerUrl,
} from "maplibre-gl";

import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

import { plugins } from "./plugins.ts";

// maplibre-gl resolves its worker next to its own bundle at runtime, which a
// bundled build cannot satisfy; let Vite bundle the worker (it imports a
// sibling chunk) and hand maplibre the resulting URL.
setWorkerUrl(workerUrl);

const STYLE_URL = "https://tiles.openfreemap.org/styles/bright";

const params = new URLSearchParams(location.search);
const pluginId = params.get("plugin") ?? plugins[0]!.id;
const plugin = plugins.find((p) => p.id === pluginId) ?? plugins[0]!;

const map = new MaplibreMap({
  container: "map",
  style: STYLE_URL,
  center: [plugin.camera.center[1], plugin.camera.center[0]],
  zoom: plugin.camera.zoom,
  bearing: plugin.camera.bearing,
  pitch: plugin.camera.pitch,
  hash: true,
  attributionControl: { compact: true },
});
map.addControl(new NavigationControl({ visualizePitch: true }));
map.on("error", (e) => console.error("map error:", e.error));
// Handy for poking at the map from the devtools console or a browser script.
Object.assign(window, { map });

const panel = document.getElementById("panel")!;
panel.innerHTML = "";

const heading = document.createElement("h1");
heading.textContent = plugin.title;
const layerType = document.createElement("small");
layerType.textContent = plugin.layerType;
heading.append(layerType);
panel.append(heading);

const hint = document.createElement("p");
hint.className = "hint";
hint.textContent = plugin.description;
panel.append(hint);

if (plugins.length > 1) {
  const section = document.createElement("section");
  const picker = document.createElement("div");
  picker.className = "actions";
  for (const other of plugins) {
    const button = document.createElement("button");
    button.textContent = other.title;
    button.setAttribute("aria-pressed", String(other.id === plugin.id));
    button.addEventListener("click", () => {
      const next = new URL(location.href);
      next.searchParams.set("plugin", other.id);
      next.hash = "";
      location.href = next.toString();
    });
    picker.append(button);
  }
  section.append(picker);
  panel.append(section);
}

map.on("load", () => {
  const view = plugin.mount(map, panel);
  const status = document.createElement("div");
  status.id = "status";
  panel.append(status);
  const json = document.createElement("pre");
  json.id = "json";
  panel.append(json);
  const refresh = () => {
    json.textContent = JSON.stringify(view.layerJson(), null, 2);
  };
  refresh();
  view.onChange(refresh);

  map.on("mousemove", (e: MapMouseEvent) => {
    const hit = view.hitTest(e.point);
    map.getCanvas().style.cursor = hit ? "pointer" : "";
    status.textContent = `${e.lngLat.lat.toFixed(5)}, ${e.lngLat.lng.toFixed(5)} · zoom ${map.getZoom().toFixed(2)}${hit ? " · over indicator" : ""}`;
  });
  map.on("click", (e: MapMouseEvent) => {
    const feature = view.queryFeature(e.point);
    if (feature) {
      status.textContent = `clicked feature: ${JSON.stringify(feature.geometry.coordinates)}`;
    }
  });
});
