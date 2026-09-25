// Registry of the plugins the gallery can show. Each entry mounts its JS
// layer on the map and builds its control panel from the shared spec.

import type { Feature } from "geojson";
import type { Map as MaplibreMap } from "maplibre-gl";

import { mountAnimatedIcon } from "./animated-icon.ts";
import { mountLocationIndicator } from "./location-indicator.ts";
import { mountWater } from "./water.ts";
import {
  mountWeatherStations,
  weatherAttribution,
} from "./weather-stations.ts";

export interface PluginView {
  /** Style-layer JSON for the current state, as the native plugin would consume it. */
  layerJson(): unknown;
  onChange(listener: () => void): void;
  hitTest(point: { x: number; y: number }): boolean;
  queryFeature(point: { x: number; y: number }): Feature | null;
}

export interface PluginEntry {
  id: string;
  title: string;
  layerType: string;
  description: string;
  /** The basemap style URL; defaults to the gallery's light style. */
  style?: string;
  /** HTML added to the map's attribution, for data the page brings. */
  attribution?: string;
  camera: {
    /** [lat, lng], the order the native viewer's --center takes. */
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
      "Procedural puck, bearing arrow, accuracy circle and shadow drawn analytically in the fragment shader. Every control below is a paint property the native plugin also accepts.",
    camera: { center: [37.7749, -122.4194], zoom: 13, bearing: 12, pitch: 30 },
    mount: mountLocationIndicator,
  },
  {
    id: "water",
    title: "Water",
    layerType: "water-shore",
    description:
      "Animated shoreline built from the style's own water polygons: a shallow-water tint, breaking crests rolling in, and a bubbling wash along every coast and island. Each control is a paint property the native plugin also accepts.",
    camera: { center: [37.862, -122.44], zoom: 14, bearing: -25, pitch: 50 },
    mount: mountWater,
  },
  {
    id: "animated-icon",
    title: "Animated icon",
    layerType: "animated-icon",
    description:
      "Baked Lottie animations playing at every point of a source: one quad per point, with anti-aliased coverage computed from the animation's curves in the fragment shader. Each control is a paint property the native plugin also accepts.",
    camera: { center: [37.788, -122.4075], zoom: 16, bearing: 0, pitch: 30 },
    mount: mountAnimatedIcon,
  },
  {
    id: "weather-stations",
    title: "Weather stations",
    layerType: "animated-icon",
    description:
      "240 world cities with a synthetic weather snapshot, each playing the Meteocons animation its condition picks from a catalog the page fetches at run time. Speed follows the wind and each icon's phase its id. Click a station for its weather.",
    style: "https://tiles.openfreemap.org/styles/dark",
    attribution: weatherAttribution,
    camera: { center: [12, 28], zoom: 2.6, bearing: 0, pitch: 0 },
    mount: mountWeatherStations,
  },
];
