// The weather-stations page: 240 synthetic stations from
// plugins/animated-icon/examples/weather, drawn by one animated-icon layer
// with an app-supplied catalog (catalog/weather.mlvc, fetched at run time)
// and a label layer under the same filter. The native viewer's `weather`
// task loads the same layer, stations and catalog.

import {
  type AnimatedIconFeature,
  AnimatedIconLayer,
  type AnimatedIconLayerJson,
  clockSeconds,
  loadCatalog,
  type PaintInput,
  paintSpecFor,
} from "@maplibre-plugins/animated-icon";
import {
  type ExpressionSpecification,
  type FilterSpecification,
  type LayerSpecification,
  type Map as MaplibreMap,
  type MapMouseEvent,
  Popup,
} from "maplibre-gl";

import catalogUrl from "../../../plugins/animated-icon/catalog/weather.mlvc?url";
// Never inlined: a small file would become a data: URL, which browsers
// refuse to open from a link.
import noticeUrl from "../../../plugins/animated-icon/catalog/weather.mlvc.LICENSE.txt?url&no-inline";
import labelsJson from "../../../plugins/animated-icon/examples/weather/labels.layer.json";
import layerJson from "../../../plugins/animated-icon/examples/weather/layer.json";
import playOnceJson from "../../../plugins/animated-icon/examples/weather/play-once.layer.json";
import stationsUrl from "../../../plugins/animated-icon/examples/weather/stations.geojson?url";
import { numberRow, section, selectRow } from "./controls.ts";
import { nativePaint } from "./layer-json.ts";
import type { PluginView } from "./plugins.ts";

/** Credits for the icons, places and weather, added to the map's attribution. */
export const weatherAttribution = `Icons: Meteocons by Bas Milius (MIT, <a href="${noticeUrl}" target="_blank" rel="noopener">notice</a>) · Places: Natural Earth · Weather: synthetic`;

const SOURCE = "stations";

const stationsLayer = layerJson as AnimatedIconLayerJson;
const playOnceLayer = playOnceJson as AnimatedIconLayerJson;
const labelsLayer = labelsJson as LayerSpecification;
/** layer.json's filter: fewer, more prominent stations at low zoom. */
const density = stationsLayer.filter as ExpressionSpecification;

/** The fixture's conditions, in the order the chips show them. */
const conditions = [
  ["clear", "Clear"],
  ["partly-cloudy", "Partly cloudy"],
  ["overcast", "Overcast"],
  ["fog", "Fog"],
  ["drizzle", "Drizzle"],
  ["rain", "Rain"],
  ["sleet", "Sleet"],
  ["snow", "Snow"],
  ["thunderstorm", "Thunderstorm"],
  ["wind", "Wind"],
] as const;
type Condition = (typeof conditions)[number][0];
const conditionLabels = new Map<string, string>(conditions);

const playbackModes = [
  "desynced",
  "in sync",
  "on hover, once",
  "paused",
] as const;
type Playback = (typeof playbackModes)[number];

const playbackHints: Record<Playback, string> = {
  desynced:
    "Each icon's phase comes from its station id and its speed from the wind, as in layer.json.",
  "in sync": "Every icon plays from the same start at the same speed.",
  "on hover, once":
    "play-once.layer.json: icons rest on their first frame; hovering a station plays it once and holds its last frame, and a click replays it.",
  paused: "Every icon holds the frame it shows.",
};

/** The paint properties a playback mode sets; undefined resets one. */
const playbackKeys = [
  "icon-animation-mode",
  "icon-animation-speed",
  "icon-animation-offset",
  "icon-animation-speed-transition",
] as const;

function playbackOf(paint: PaintInput = {}): PaintInput {
  return Object.fromEntries(
    playbackKeys.map((key) => [key, paint[key]]),
  ) as PaintInput;
}

/**
 * The paint of a playback mode. Pausing freezes each icon where it is: speed
 * 0 holds the frame at the offset, so the offset becomes the playhead the
 * previous mode had at the current clock.
 */
function playbackPaint(mode: Playback, previous: PaintInput): PaintInput {
  switch (mode) {
    case "desynced":
      return playbackOf(stationsLayer.paint);
    case "in sync":
      return {
        ...playbackOf(stationsLayer.paint),
        "icon-animation-speed": 1,
        "icon-animation-offset": 0,
      };
    case "on hover, once":
      return playbackOf(playOnceLayer.paint);
    case "paused": {
      const clock = clockSeconds();
      const speed = previous["icon-animation-speed"] ?? 1;
      const offset = previous["icon-animation-offset"] ?? 0;
      return {
        ...previous,
        "icon-animation-speed": 0,
        "icon-animation-offset":
          typeof speed === "number" && typeof offset === "number"
            ? clock * speed + offset
            : ["+", ["*", clock, speed], offset],
      };
    }
  }
}

/** layer.json's icon-size with the outputs of its zoom curve scaled. */
function scaledSize(scale: number): unknown {
  const size = stationsLayer.paint?.["icon-size"];
  const round = (value: number) => Math.round(value * scale * 1000) / 1000;
  if (typeof size === "number") return round(size);
  if (!Array.isArray(size) || size[0] !== "interpolate") return size;
  // ["interpolate", curve, input, stop, output, stop, output, ...]
  return size.map((value: unknown, i) =>
    i >= 4 && i % 2 === 0 && typeof value === "number" ? round(value) : value,
  );
}

/**
 * The station a hover or click plays: the smallest id among the hits,
 * numbers before strings, the same pick as the native viewer's
 * --play-once.
 */
function pickStation(
  features: readonly AnimatedIconFeature[],
): number | string | null {
  let best: number | string | null = null;
  for (const { id } of features) {
    if (id === undefined) continue;
    if (
      best === null ||
      (typeof id === "number"
        ? typeof best === "string" || id < best
        : typeof best === "string" && id < best)
    ) {
      best = id;
    }
  }
  return best;
}

const COMPASS = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
];

/** The 16-point compass name of a direction in degrees. */
function compass(degrees: number): string {
  return COMPASS[((Math.round(degrees / 22.5) % 16) + 16) % 16]!;
}

/** A station's properties, as stations.geojson and its README list them. */
interface Station {
  name: string;
  country: string;
  condition: Condition;
  is_day: boolean;
  temperature: number;
  wind_speed: number;
  wind_direction: number;
  cloud_cover: number;
  precipitation: number;
}

function popupContent(station: Station): HTMLElement {
  const root = document.createElement("div");
  const line = (className: string, text: string) => {
    const el = document.createElement("div");
    el.className = className;
    el.textContent = text;
    root.append(el);
    return el;
  };
  const title = line("title", station.name);
  const country = document.createElement("small");
  country.textContent = station.country;
  title.append(" ", country);
  const condition = conditionLabels.get(station.condition) ?? station.condition;
  line("condition", `${condition} · ${station.is_day ? "day" : "night"}`);
  line("temperature", `${station.temperature} °C`);
  line(
    "detail",
    `Wind ${station.wind_speed} km/h from ${compass(station.wind_direction)}`,
  );
  line(
    "detail",
    `Cloud ${station.cloud_cover} % · precipitation ${station.precipitation} mm/h`,
  );
  return root;
}

/** "2026-01-15T15:00:00Z" as "2026-01-15 15:00 UTC". */
function formatSnapshot(iso: unknown): string {
  return typeof iso === "string"
    ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
    : "unknown time";
}

export function mountWeatherStations(
  map: MaplibreMap,
  panel: HTMLElement,
): PluginView {
  map.addSource(SOURCE, { type: "geojson", data: stationsUrl });
  map.addLayer(labelsLayer);

  let layer: AnimatedIconLayer | null = null;
  const listeners: Array<() => void> = [];
  const changed = () => listeners.forEach((l) => l());

  // What the controls chose; applied to the layer once it exists.
  const enabled = new Set<string>(conditions.map(([c]) => c));
  let playback: Playback = "desynced";
  let playbackPaintNow = playbackOf(stationsLayer.paint);
  let sizeScale = 1;

  const filter = (): FilterSpecification =>
    enabled.size === conditions.length
      ? density
      : [
          "all",
          density,
          [
            "in",
            ["get", "condition"],
            [
              "literal",
              conditions.map(([c]): string => c).filter((c) => enabled.has(c)),
            ],
          ],
        ];
  const applyFilter = () => {
    layer?.setFilter(filter());
    map.setFilter(labelsLayer.id, filter());
    changed();
  };

  // Stations: the snapshot line and one chip per condition.
  const stations = section(panel, "Stations");
  const status = document.createElement("p");
  status.className = "hint";
  status.textContent = "Loading stations…";
  stations.append(status);
  const chips = document.createElement("div");
  chips.className = "chips";
  const counts = new Map<Condition, HTMLElement>();
  for (const [condition, label] of conditions) {
    const chip = document.createElement("button");
    chip.setAttribute("aria-pressed", "true");
    chip.dataset.condition = condition;
    const count = document.createElement("span");
    count.className = "count";
    chip.append(label, count);
    counts.set(condition, count);
    chip.addEventListener("click", () => {
      if (enabled.has(condition)) enabled.delete(condition);
      else enabled.add(condition);
      chip.setAttribute("aria-pressed", String(enabled.has(condition)));
      applyFilter();
    });
    chips.append(chip);
  }
  stations.append(chips);
  // The same file the source loads; the browser serves it from its cache.
  fetch(stationsUrl)
    .then((response) => response.json())
    .then(
      (data: {
        snapshot?: unknown;
        features: Array<{ properties: { condition: unknown } }>;
      }) => {
        status.textContent = `${data.features.length} stations · synthetic snapshot ${formatSnapshot(data.snapshot)}`;
        for (const [condition, count] of counts) {
          const n = data.features.filter(
            (f) => f.properties.condition === condition,
          ).length;
          count.textContent = String(n);
        }
      },
    )
    .catch((error: unknown) => {
      status.textContent = `The stations did not load: ${String(error)}`;
    });

  // Playback: switches apply with no transition, so a speed change never
  // sweeps the playhead through the animations.
  const playbackSection = section(panel, "Playback");
  const playbackHint = document.createElement("p");
  playbackHint.className = "hint";
  let hovered: number | string | null = null;
  selectRow(playbackSection, {
    name: "playback",
    doc: "How the icons play: each switch sets icon-animation-mode, -speed and -offset at once.",
    values: playbackModes,
    initial: playback,
    onInput: (value) => {
      const mode = value as Playback;
      playbackPaintNow = playbackPaint(mode, playbackPaintNow);
      playback = mode;
      playbackHint.textContent = playbackHints[mode];
      if (mode === "on hover, once") {
        // Every station rests until hovered, including ones played before.
        map.removeFeatureState({ source: SOURCE });
        hovered = null;
      }
      layer?.setPaint(playbackPaintNow, { duration: 0, delay: 0 });
      changed();
    },
  });
  playbackHint.textContent = playbackHints[playback];
  playbackSection.append(playbackHint);

  // Display: icon size and the labels.
  const display = section(panel, "Display");
  numberRow(display, {
    name: "icon size ×",
    doc: "Scales the outputs of layer.json's icon-size zoom curve.",
    initial: sizeScale,
    range: [0.25, 3, 0.05],
    onInput: (value) => {
      sizeScale = value;
      layer?.setPaintProperty("icon-size", scaledSize(sizeScale), {
        duration: 0,
      });
      changed();
    },
  });
  const labelsRow = document.createElement("div");
  labelsRow.className = "row wide";
  const labelsLabel = document.createElement("label");
  labelsLabel.textContent = "labels";
  labelsLabel.title = "Each station's name and temperature (gallery only).";
  labelsLabel.htmlFor = "weather-labels";
  const labelsToggle = document.createElement("input");
  labelsToggle.type = "checkbox";
  labelsToggle.id = "weather-labels";
  labelsToggle.checked = true;
  labelsToggle.addEventListener("change", () => {
    map.setLayoutProperty(
      labelsLayer.id,
      "visibility",
      labelsToggle.checked ? "visible" : "none",
    );
  });
  labelsRow.append(labelsLabel, labelsToggle);
  display.append(labelsRow);

  const addLayer = (icons: AnimatedIconLayer) => {
    // Under the labels, so each name stays readable.
    map.addLayer(
      icons,
      map.getLayer(labelsLayer.id) ? labelsLayer.id : undefined,
    );
  };
  loadCatalog(catalogUrl)
    .then((catalog) => {
      const icons = AnimatedIconLayer.fromLayerJson(stationsLayer, { catalog });
      if (enabled.size !== conditions.length) icons.setFilter(filter());
      if (playback !== "desynced")
        icons.setPaint(playbackPaintNow, { duration: 0, delay: 0 });
      if (sizeScale !== 1)
        icons.setPaintProperty("icon-size", scaledSize(sizeScale), {
          duration: 0,
        });
      addLayer(icons);
      layer = icons;
      changed();
    })
    .catch((error: unknown) => {
      console.error(error);
      const problem = document.createElement("p");
      problem.className = "hint";
      problem.setAttribute("role", "alert");
      problem.textContent = `The weather catalog did not load: ${String(error)}`;
      status.before(problem);
    });
  // maplibre-gl-js drops custom layers when the WebGL context is lost and
  // reloads the rest of the style once it is restored; add this one back.
  map.on("webglcontextrestored", () => {
    map.once("style.load", () => {
      if (layer && !map.getLayer(layer.id)) addLayer(layer);
    });
  });

  // Hover play-once: a newly hovered station starts at the plugin clock's
  // current time, which play-once.layer.json's offset subtracts. Leaving
  // every station only forgets the last one.
  const play = (id: number | string) => {
    map.setFeatureState({ source: SOURCE, id }, { start: clockSeconds() });
  };
  map.on("mousemove", (e: MapMouseEvent) => {
    if (!layer || playback !== "on hover, once") return;
    const id = pickStation(layer.queryFeatures(e.point));
    if (id !== null && id !== hovered) play(id);
    hovered = id;
  });
  map.on("click", (e: MapMouseEvent) => {
    if (!layer) return;
    if (playback === "on hover, once") {
      // A replay, and the way to play a station without a pointer.
      const id = pickStation(layer.queryFeatures(e.point));
      if (id !== null) play(id);
      hovered = id;
    }
    const feature = layer.queryFeature(e.point);
    if (!feature) return;
    new Popup({ className: "weather-popup", offset: 16, maxWidth: "260px" })
      .setLngLat(feature.geometry.coordinates as [number, number])
      .setDOMContent(popupContent(feature.properties as Station))
      .addTo(map);
  });

  return {
    layerJson: () => {
      if (!layer) return null;
      const json = layer.toLayerJson();
      return {
        ...json,
        paint: nativePaint(
          json.paint ?? {},
          paintSpecFor(layer.catalog),
          stationsLayer.paint,
        ),
      };
    },
    onChange: (listener) => listeners.push(listener),
    hitTest: (point) => layer?.hitTest(point) ?? false,
    queryFeature: (point) => layer?.queryFeature(point) ?? null,
  };
}
