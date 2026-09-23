// Registry of the plugins the gallery can show. Each entry mounts its JS
// layer on the map and builds its control panel from the shared spec.

import type { Feature, Point } from "geojson";
import type { Map as MaplibreMap } from "maplibre-gl";

import { mountLocationIndicator } from "./location-indicator.ts";

export interface PluginView {
  /** Style-layer JSON for the current state, as the native plugin would consume it. */
  layerJson(): unknown;
  onChange(listener: () => void): void;
  hitTest(point: { x: number; y: number }): boolean;
  queryFeature(point: { x: number; y: number }): Feature<Point> | null;
}

export interface PluginEntry {
  id: string;
  title: string;
  layerType: string;
  description: string;
  camera: {
    center: [number, number];
    zoom: number;
    bearing: number;
    pitch: number;
  };
  mount(map: MaplibreMap, panel: HTMLElement): PluginView;
}

export const plugins: PluginEntry[] = [
  {
    id: "location-indicator",
    title: "Location indicator",
    layerType: "location-puck",
    description:
      "Procedural puck, bearing arrow, accuracy circle, shadow and pulse drawn analytically in the fragment shader. Every control below is a paint property the native plugin also accepts.",
    camera: { center: [37.7749, -122.4194], zoom: 13, bearing: 12, pitch: 30 },
    mount: mountLocationIndicator,
  },
];
