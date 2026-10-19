// Generates buildings.geojson: a synthetic grid of buildings showing every
// roof shape of the building layer on seven footprints, with the orientation,
// direction and roof-angle variants. It stands in Letenské sady, Prague, an
// empty stretch of park about 500 m north of the OSM example (../osm).
//
//   node generate.mjs          # write buildings.geojson and check it
//   node generate.mjs --check  # check that the file is current, write nothing
//
// Columns (west to east) are the 17 roof shapes of ../../spec.json in order.
// Rows (north to south) are the variants in VARIANTS. Every building sits in
// the middle of a cell one third of a zoom-18 tile wide and high in Web
// Mercator, so every tile edge at zoom 18 and below runs between buildings:
// no footprint crosses a tile edge at any zoom up to 18, and each building
// gets its own roof whatever the GeoJSON source's maxzoom (see ../../README.md,
// "Fallbacks"). The script checks that, then lays every feature out in its
// zoom-15 tile with the TypeScript layout and checks that it gets the roof
// it is meant to: its shape's, or flat where the README says it falls back.
// Finally it parses ../layer.json with the MapLibre style spec, evaluates it
// on every feature (the layout values must be the ones the feature was made
// for, the paint values in range) and validates source.json.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { BuildingLayout, ROOF } from "../../js/src/layout.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(HERE, "buildings.geojson");
const spec = JSON.parse(readFileSync(join(HERE, "../../spec.json"), "utf8"));
const SHAPES = spec.layout["building-roof-shape"].values;

/** The north-west corner of the grid, rounded down to a zoom-18 tile. */
const NORTH_WEST = { lon: 14.4116, lat: 50.0985 };
const TILE_ZOOM = 18;
/** Grid cells per zoom-18 tile, along each axis. */
const CELLS_PER_TILE = 3;
const EARTH_RADIUS = 6378137;
const EXTENT = 8192;

/** Wall height below the roof, meters. */
const WALL = 7;
/** roof:height of each shape, meters (0: flat). */
const ROOF_HEIGHT = {
  flat: 0,
  gabled: 5,
  hipped: 5,
  "half-hipped": 5,
  pyramidal: 6,
  skillion: 3,
  gambrel: 6,
  round: 5,
  double_saltbox: 4,
  saltbox: 5,
  mansard: 5,
  dome: 6,
  quadruple_saltbox: 4,
  round_gabled: 6,
  onion: 9,
  cone: 8,
  many: 0,
};
/**
 * The run of each shape in half-widths of the bounding rectangle (README,
 * "run"), to size the roof-angle row's buildings so their roofs fit.
 */
const RUN = {
  flat: 0,
  many: 0,
  skillion: 2,
  saltbox: 1.4,
  double_saltbox: 0.3,
  quadruple_saltbox: 0.3,
};
const ROOF_ANGLE = 35;
const PYRAMIDAL = new Set(["pyramidal"]);

// Footprints in meters, x east and y north, counterclockwise, centered in
// the cell: an 18 m x 11 m rectangle (its long side east-west), the same
// rectangle turned 30° counterclockwise, an L of 8 m wide arms in an
// 18 m x 14 m box, and a 24-gon of radius 8 m.
const RECTANGLE = [
  [-9, -5.5],
  [9, -5.5],
  [9, 5.5],
  [-9, 5.5],
];
const ROTATED = RECTANGLE.map(([x, y]) => {
  const a = (30 * Math.PI) / 180;
  return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
});
const L_SHAPE = [
  [-9, -7],
  [9, -7],
  [9, 1],
  [-1, 1],
  [-1, 7],
  [-9, 7],
];
const ROUND = Array.from({ length: 24 }, (_, i) => {
  const a = (i / 24) * 2 * Math.PI;
  return [8 * Math.cos(a), 8 * Math.sin(a)];
});

/**
 * The rows, north to south. `flat` lists the shapes the layout is expected
 * to draw flat on that footprint (README, "Fallbacks"): pyramids whose
 * center is outside the L's kernel.
 */
const VARIANTS = [
  { variant: "along", footprint: "rectangle", ring: RECTANGLE },
  {
    variant: "across",
    footprint: "rectangle",
    ring: RECTANGLE,
    orientation: "across",
  },
  {
    variant: "direction 200",
    footprint: "rectangle",
    ring: RECTANGLE,
    direction: 200,
  },
  { variant: "along", footprint: "rotated", ring: ROTATED },
  {
    variant: "across",
    footprint: "rotated",
    ring: ROTATED,
    orientation: "across",
  },
  {
    variant: "direction 75",
    footprint: "rotated",
    ring: ROTATED,
    direction: 75,
  },
  { variant: "along", footprint: "L", ring: L_SHAPE, flat: PYRAMIDAL },
  {
    variant: "across",
    footprint: "L",
    ring: L_SHAPE,
    orientation: "across",
    flat: PYRAMIDAL,
  },
  { variant: "along", footprint: "round", ring: ROUND },
  {
    variant: `angle ${ROOF_ANGLE}`,
    footprint: "rectangle",
    ring: RECTANGLE,
    angle: ROOF_ANGLE,
  },
  {
    variant: "along",
    footprint: "T",
    ring: [
      [-9, 7],
      [9, 7],
      [9, 1],
      [3, 1],
      [3, -7],
      [-3, -7],
      [-3, 1],
      [-9, 1],
    ].reverse(),
    flat: PYRAMIDAL,
  },
  {
    variant: "along",
    footprint: "U",
    ring: [
      [-9, -7],
      [9, -7],
      [9, 7],
      [3, 7],
      [3, -1],
      [-3, -1],
      [-3, 7],
      [-9, 7],
    ],
    flat: PYRAMIDAL,
  },
  {
    variant: "along",
    footprint: "courtyard",
    ring: RECTANGLE,
    holes: [
      [
        [-4, -2],
        [-4, 2],
        [4, 2],
        [4, -2],
      ],
    ],
    flat: PYRAMIDAL,
  },
];

// ------------------------------------------------------------- projection
const worldX = (lon) => (lon + 180) / 360;
const worldY = (lat) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
const lonOf = (x) => x * 360 - 180;
const latOf = (y) =>
  (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
/** Meters per world unit (the whole Mercator square is 1) at a latitude. */
const metersPerWorld = (lat) =>
  2 * Math.PI * EARTH_RADIUS * Math.cos((lat * Math.PI) / 180);
const round7 = (v) => Math.round(v * 1e7) / 1e7;

// ------------------------------------------------------------------ build
const tiles = 2 ** TILE_ZOOM;
const cell = 1 / (tiles * CELLS_PER_TILE);
const x0 = Math.floor(worldX(NORTH_WEST.lon) * tiles) / tiles;
const y0 = Math.floor(worldY(NORTH_WEST.lat) * tiles) / tiles;

const features = [];
VARIANTS.forEach((row, r) => {
  SHAPES.forEach((shape, c) => {
    const cx = x0 + (c + 0.5) * cell;
    const cy = y0 + (r + 0.5) * cell;
    const scale = metersPerWorld(latOf(cy));
    const rings = [row.ring, ...(row.holes ?? [])].map((points) => {
      const ring = points.map(([x, y]) => [
        round7(lonOf(cx + x / scale)),
        round7(latOf(cy - y / scale)),
      ]);
      ring.push(ring[0]);
      return ring;
    });
    const roofHeight = ROOF_HEIGHT[shape];
    const properties = {
      label: `${shape}, ${row.footprint}, ${row.variant}`,
      footprint: row.footprint,
      variant: row.variant,
      "roof:shape": shape,
    };
    if (row.orientation) properties["roof:orientation"] = row.orientation;
    if (row.direction !== undefined)
      properties["roof:direction"] = row.direction;
    if (row.angle !== undefined) {
      const run = (RUN[shape] ?? 1) * 5.5;
      const rise = Math.tan((row.angle * Math.PI) / 180) * run;
      properties.height = Math.ceil((WALL + rise) * 10) / 10;
      properties["roof:angle"] = row.angle;
    } else {
      properties.height = WALL + roofHeight + (roofHeight === 0 ? 2 : 0);
      if (roofHeight > 0) properties["roof:height"] = roofHeight;
    }
    features.push({
      type: "Feature",
      id: r * SHAPES.length + c + 1,
      properties,
      geometry: { type: "Polygon", coordinates: rings },
    });
  });
});

const text =
  '{"type":"FeatureCollection","features":[\n' +
  features.map((f) => JSON.stringify(f)).join(",\n") +
  "\n]}\n";

// ----------------------------------------------------------------- checks
const errors = [];
const ids = new Set();
for (const f of features) {
  if (ids.has(f.id)) errors.push(`duplicate id ${f.id}`);
  ids.add(f.id);
  const ring = f.geometry.coordinates[0];
  let area = 0;
  for (let i = 0; i + 1 < ring.length; i++)
    area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  if (!(area > 0)) errors.push(`${f.id}: exterior is not counterclockwise`);
  // No footprint crosses a tile edge at any zoom up to 18.
  for (let z = 0; z <= TILE_ZOOM; z++) {
    const n = 2 ** z;
    const tx = new Set(ring.map(([lon]) => Math.floor(worldX(lon) * n)));
    const ty = new Set(ring.map(([, lat]) => Math.floor(worldY(lat) * n)));
    if (tx.size > 1 || ty.size > 1)
      errors.push(
        `${f.id} (${f.properties.label}) crosses a zoom-${z} tile edge`,
      );
  }
}

// Every feature gets its roof when laid out in its zoom-15 tile.
for (const f of features) {
  const z = 15;
  const n = 2 ** z;
  const ring = f.geometry.coordinates[0].slice(0, -1);
  const tx = Math.floor(worldX(ring[0][0]) * n);
  const ty = Math.floor(worldY(ring[0][1]) * n);
  // Tile coordinates: y down, so the ring turns clockwise on screen with a
  // positive area, as MVT and geojson-vt deliver exteriors.
  const points = f.geometry.coordinates.map((r) =>
    r.slice(0, -1).map(([lon, lat]) => ({
      x: Math.round((worldX(lon) * n - tx) * EXTENT),
      y: Math.round((worldY(lat) * n - ty) * EXTENT),
    })),
  );
  const p = f.properties;
  const layout = new BuildingLayout(EXTENT);
  layout.addFeature(points, 0, {
    shape: p["roof:shape"],
    orientation: p["roof:orientation"],
    direction: p["roof:direction"],
  });
  let sloped = false;
  for (let i = 0; i < layout.vertexCount; i++) {
    const v = layout.vertex(i);
    if (v.kind >= ROOF && v.n < 1) sloped = true;
  }
  const row = VARIANTS[Math.floor((f.id - 1) / SHAPES.length)];
  const flat =
    p["roof:shape"] === "flat" ||
    p["roof:shape"] === "many" ||
    (row.flat?.has(p["roof:shape"]) ?? false);
  if (sloped === flat)
    errors.push(
      `${f.id} (${p.label}): expected a ${flat ? "flat" : "sloped"} roof`,
    );
}

// ../layer.json on every feature, and source.json.
const require = createRequire(join(HERE, "../../js/package.json"));
const styleSpec = await import(
  pathToFileURL(require.resolve("@maplibre/maplibre-gl-style-spec")).href
);
const layer = JSON.parse(readFileSync(join(HERE, "../layer.json"), "utf8"));
if (layer.type !== spec.layerType)
  errors.push(`layer.json: type ${layer.type}`);
const STYLE_TYPES = {
  float: "number",
  float2: "array",
  color: "color",
  enum: "enum",
  boolean: "boolean",
};
const expected = {
  "building-roof-shape": (p) => p["roof:shape"],
  "building-roof-orientation": (p) => p["roof:orientation"] ?? "along",
  "building-roof-direction": (p) => p["roof:direction"] ?? -1,
  "building-height": (p) => p.height,
  "building-roof-height": (p) => p["roof:height"] ?? 0,
  "building-roof-angle": (p) => p["roof:angle"] ?? 0,
};
for (const table of ["layout", "paint"]) {
  for (const [key, value] of Object.entries(layer[table] ?? {})) {
    const entry = spec[table][key];
    if (!entry) {
      errors.push(`layer.json ${table}: ${key} is not in spec.json`);
      continue;
    }
    const type = STYLE_TYPES[entry.type];
    const dataDriven = entry.expressions === "data-driven";
    // A constant array is a literal, not an expression.
    const literal =
      type === "array" && !styleSpec.expression.isExpression(value)
        ? ["literal", value]
        : value;
    const parsed = styleSpec.expression.createPropertyExpression(
      literal,
      `${table}.${key}`,
      {
        type,
        ...(type === "enum"
          ? { values: Object.fromEntries(entry.values.map((v) => [v, {}])) }
          : {}),
        ...(type === "array" ? { value: "number", length: 2 } : {}),
        default: entry.default,
        "property-type": dataDriven ? "data-driven" : "data-constant",
        expression: {
          interpolated: type === "number" || type === "color",
          parameters: dataDriven ? ["zoom", "feature"] : ["zoom"],
        },
      },
    );
    if (parsed.result !== "success") {
      errors.push(
        `layer.json ${key}: ${parsed.value.map((e) => e.message).join("; ")}`,
      );
      continue;
    }
    for (const f of features) {
      const v = parsed.value.evaluateWithoutErrorHandling(
        { zoom: 17 },
        { type: 3, id: f.id, properties: f.properties },
        {},
      );
      const want = expected[key]?.(f.properties);
      if (want !== undefined && v !== want)
        errors.push(`layer.json ${key} on ${f.id}: ${v}, expected ${want}`);
      if (typeof v === "number") {
        if (entry.minimum !== undefined && v < entry.minimum)
          errors.push(`${key} on ${f.id}: ${v} < ${entry.minimum}`);
        if (entry.maximum !== undefined && v > entry.maximum)
          errors.push(`${key} on ${f.id}: ${v} > ${entry.maximum}`);
      }
    }
  }
}
const source = JSON.parse(readFileSync(join(HERE, "source.json"), "utf8"));
for (const e of styleSpec.validateStyleMin({
  version: 8,
  sources: {
    [layer.source]: {
      ...source,
      data: { type: "FeatureCollection", features: [] },
    },
  },
  layers: [],
}))
  errors.push(`source.json: ${e.message}`);

if (errors.length > 0) {
  for (const e of errors) console.error(e);
  process.exit(1);
}

if (process.argv.includes("--check")) {
  const current = readFileSync(OUTPUT, "utf8");
  if (current !== text) {
    console.error(`stale: ${OUTPUT}; run node generate.mjs`);
    process.exit(1);
  }
  console.log(`${OUTPUT}: current, ${features.length} buildings, checks pass`);
} else {
  writeFileSync(OUTPUT, text);
  const corner = (x, y) => `${round7(latOf(y))} N, ${round7(lonOf(x))} E`;
  console.log(
    `wrote ${OUTPUT}: ${features.length} buildings, ${SHAPES.length} x ${VARIANTS.length} cells of ` +
      `${(cell * metersPerWorld(latOf(y0))).toFixed(1)} m, from ${corner(x0, y0)} ` +
      `to ${corner(x0 + SHAPES.length * cell, y0 + VARIANTS.length * cell)}`,
  );
}
