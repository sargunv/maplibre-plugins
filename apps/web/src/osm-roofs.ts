// The OSM roofs page: 3,091 real OpenStreetMap buildings and building parts
// of Bamberg's old town (plugins/building/examples/osm) drawn by the building
// layer with the Simple 3D Buildings rules of its layer.json, roofs with a
// roof:shape tag in one color and untagged ones in another. Hovering highlights a building through feature-state, and a
// click opens its roof tagging, StreetComplete style: the roof:shape the
// layer drew and every roof and height tag behind it.

import {
  type BuildingFeature,
  BuildingLayer,
  type BuildingLayerJson,
} from "@maplibre-plugins/building";
import {
  type ExpressionSpecification,
  type Map as MaplibreMap,
  type MapMouseEvent,
  Popup,
} from "maplibre-gl";

import buildingsUrl from "../../../plugins/building/examples/osm/buildings.geojson?url";
import noticeUrl from "../../../plugins/building/examples/osm/buildings.geojson.LICENSE.txt?url&no-inline";
import osmJson from "../../../plugins/building/examples/osm/layer.json";
import osmSource from "../../../plugins/building/examples/osm/source.json";
import {
  buildingControls,
  compareRow,
  coreExtrusion,
  firstSymbolLayer,
  lightControls,
  shownJson,
} from "./building.ts";
import { section } from "./controls.ts";
import type { PluginView } from "./plugins.ts";

/** OSM credit for the buildings, added to the map's attribution. */
export const osmAttribution = `Buildings © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors (ODbL, <a href="${noticeUrl}" target="_blank" rel="noopener">notice</a>)`;

const authored = osmJson as BuildingLayerJson;

/** The basemap's own flat buildings, hidden under the 3D ones. */
const BASEMAP_BUILDINGS = ["building", "building-top"];

/** A color that turns to `highlight` while the feature's hover state is set. */
function hovered(color: unknown, highlight: string): ExpressionSpecification {
  return [
    "case",
    ["boolean", ["feature-state", "hover"], false],
    highlight,
    color as ExpressionSpecification,
  ];
}

/** layer.json with a hover highlight on walls and roofs. */
const example: BuildingLayerJson = {
  ...authored,
  paint: {
    ...authored.paint,
    "building-color": hovered(authored.paint?.["building-color"], "#ffe7a3"),
    "building-roof-color": hovered(
      authored.paint?.["building-roof-color"],
      "#f2a900",
    ),
  },
};

/** The tags a roof inspection lists, in StreetComplete's order of interest. */
const ROOF_TAGS = [
  "roof:shape",
  "roof:height",
  "roof:levels",
  "roof:angle",
  "roof:direction",
  "roof:orientation",
  "roof:colour",
  "roof:material",
  "height",
  "min_height",
  "building:levels",
  "building:min_level",
  "building:colour",
  "building:material",
];

/** A tag value as text: OSM tags are strings, normalized ones numbers. */
function text(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function popupContent(feature: BuildingFeature): HTMLElement {
  const properties = (feature.properties ?? {}) as Record<string, unknown>;
  const root = document.createElement("div");
  const title = document.createElement("div");
  title.className = "title";
  const kind =
    properties.kind === "part"
      ? `building:part=${text(properties["building:part"] ?? "yes")}`
      : `building=${text(properties.building ?? "yes")}`;
  title.textContent =
    typeof properties.name === "string" ? properties.name : kind;
  root.append(title);

  const tagged = properties["roof:shape"];
  const drawn = feature.roof.shape;
  const shape = document.createElement("div");
  shape.className = "roof";
  shape.textContent =
    tagged === undefined
      ? `No roof:shape · drawn ${drawn}`
      : tagged === drawn
        ? `Roof: ${drawn}`
        : `Roof: ${text(tagged)} · drawn as ${drawn}`;
  root.append(shape);

  const table = document.createElement("table");
  for (const key of ROOF_TAGS) {
    const value = properties[key];
    if (value === undefined) continue;
    const row = table.insertRow();
    row.insertCell().textContent = key;
    row.insertCell().textContent = text(value);
  }
  if (table.rows.length > 0) root.append(table);

  if (typeof properties.osm === "string") {
    const link = document.createElement("a");
    link.href = `https://www.openstreetmap.org/${properties.osm}`;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = `${properties.osm} on openstreetmap.org`;
    root.append(link);
  }
  return root;
}

export function mountOsmRoofs(
  map: MaplibreMap,
  panel: HTMLElement,
): PluginView {
  for (const id of BASEMAP_BUILDINGS)
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
  map.addSource(example.source, { ...osmSource, data: buildingsUrl } as never);
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
    "Hover a building to highlight it, click it for its roof tags. Light grey roofs have no roof:shape in OSM.";
  view.append(hint);
  buildingControls(panel, layer, changed);
  lightControls(panel, map);

  // Hover highlight: the feature-state the layer's colors read.
  let hoveredId: number | string | null = null;
  const hover = (id: number | string | null) => {
    if (id === hoveredId) return;
    if (hoveredId !== null)
      map.setFeatureState(
        { source: example.source, id: hoveredId },
        { hover: false },
      );
    if (id !== null)
      map.setFeatureState({ source: example.source, id }, { hover: true });
    hoveredId = id;
  };
  map.on("mousemove", (e: MapMouseEvent) => {
    hover(layer.queryFeature(e.point)?.id ?? null);
  });
  map.getCanvas().addEventListener("mouseleave", () => hover(null));
  map.on("click", (e: MapMouseEvent) => {
    const feature = layer.queryFeature(e.point);
    if (!feature) return;
    new Popup({ className: "roof-popup", maxWidth: "300px" })
      .setLngLat(e.lngLat)
      .setDOMContent(popupContent(feature))
      .addTo(map);
  });
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
