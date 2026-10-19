// Checks buildings.geojson and layer.json:
//
//   node check.mjs
//
// buildings.geojson: a FeatureCollection of Polygon and MultiPolygon
// features with unique non-negative integer ids, closed RFC 7946 rings
// (outer counterclockwise, holes clockwise) and only the properties
// generate.mjs writes. source.json: valid GeoJSON source options. layer.json: a "building" layer whose layout and paint
// keys are all in ../../spec.json. When the building JS package's
// dependencies are installed, every expression is also parsed with the
// MapLibre style spec and evaluated on every feature, and the results must
// be in range: the roof shapes it draws are printed with the tag stats.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(join(HERE, "../../spec.json"), "utf8"));
const layer = JSON.parse(readFileSync(join(HERE, "layer.json"), "utf8"));
const collection = JSON.parse(
  readFileSync(join(HERE, "buildings.geojson"), "utf8"),
);

const errors = [];
const fail = (message) => errors.push(message);

// ------------------------------------------------------------------ GeoJSON
const PROPERTIES = new Set([
  "osm",
  "kind",
  "building",
  "building:part",
  "height",
  "min_height",
  "building:levels",
  "building:min_level",
  "roof:shape",
  "roof:lines",
  "roof_lines",
  "roof_lines_height_m",
  "roof:height",
  "roof:angle",
  "roof:levels",
  "roof:direction",
  "roof:orientation",
  "roof:colour",
  "building:colour",
  "roof:material",
  "building:material",
  "name",
  "height_m",
  "min_height_m",
  "levels",
  "min_level",
  "roof_height_m",
  "roof_levels",
  "roof_angle_deg",
  "roof_direction_deg",
  "roof_orientation",
]);

function ringArea(ring) {
  let a = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return a / 2;
}

function checkPolygon(rings, where) {
  if (!Array.isArray(rings) || rings.length === 0)
    return fail(`${where}: no rings`);
  rings.forEach((ring, i) => {
    if (!Array.isArray(ring) || ring.length < 4)
      return fail(`${where}: ring ${i} has < 4 positions`);
    for (const p of ring) {
      if (
        !Array.isArray(p) ||
        p.length !== 2 ||
        !Number.isFinite(p[0]) ||
        !Number.isFinite(p[1]) ||
        Math.abs(p[0]) > 180 ||
        Math.abs(p[1]) > 90
      )
        return fail(`${where}: bad position ${JSON.stringify(p)}`);
    }
    const [a, b] = [ring[0], ring.at(-1)];
    if (a[0] !== b[0] || a[1] !== b[1])
      fail(`${where}: ring ${i} is not closed`);
    const area = ringArea(ring);
    if (area === 0) fail(`${where}: ring ${i} has no area`);
    else if (area > 0 !== (i === 0))
      fail(`${where}: ring ${i} winds the wrong way`);
  });
}

if (
  collection.type !== "FeatureCollection" ||
  !Array.isArray(collection.features)
) {
  fail("buildings.geojson is not a FeatureCollection");
}
const ids = new Set();
const counts = { building: 0, part: 0, Polygon: 0, MultiPolygon: 0, holes: 0 };
const tags = {};
for (const f of collection.features ?? []) {
  const where = `feature ${f.id} (${f.properties?.osm})`;
  if (f.type !== "Feature") fail(`${where}: not a Feature`);
  if (!Number.isSafeInteger(f.id) || f.id < 0)
    fail(`${where}: id is not a non-negative integer`);
  if (ids.has(f.id)) fail(`${where}: duplicate id`);
  ids.add(f.id);
  const g = f.geometry;
  if (g?.type === "Polygon") checkPolygon(g.coordinates, where);
  else if (g?.type === "MultiPolygon")
    g.coordinates.forEach((p, i) => checkPolygon(p, `${where} polygon ${i}`));
  else fail(`${where}: geometry ${g?.type}`);
  counts[g?.type] = (counts[g?.type] ?? 0) + 1;
  const polygons =
    g?.type === "Polygon" ? [g.coordinates] : (g?.coordinates ?? []);
  counts.holes += polygons.reduce((n, p) => n + p.length - 1, 0);
  const p = f.properties ?? {};
  if (p.kind !== "building" && p.kind !== "part")
    fail(`${where}: kind ${p.kind}`);
  else counts[p.kind]++;
  if (!/^(way|relation)\/\d+$/.test(p.osm)) fail(`${where}: osm ${p.osm}`);
  for (const [key, value] of Object.entries(p)) {
    if (!PROPERTIES.has(key)) fail(`${where}: unexpected property ${key}`);
    tags[key] = (tags[key] ?? 0) + 1;
  }
}

// ------------------------------------------------------------------ layer.json
const layerKeys = { ...spec.layout };
if (layer.type !== spec.layerType)
  fail(`layer.json type ${layer.type}, expected ${spec.layerType}`);
for (const key of Object.keys(layer)) {
  if (
    ![
      "id",
      "type",
      "source",
      "source-layer",
      "filter",
      "minzoom",
      "maxzoom",
      "layout",
      "paint",
      "metadata",
    ].includes(key)
  ) {
    fail(`layer.json: unexpected key ${key}`);
  }
}
for (const [table, keys] of [
  ["layout", layerKeys],
  ["paint", spec.paint],
]) {
  for (const key of Object.keys(layer[table] ?? {})) {
    if (key === "visibility" && table === "layout") continue;
    const base = key.endsWith("-transition")
      ? key.slice(0, -"-transition".length)
      : key;
    if (!keys[base])
      fail(`layer.json ${table}: ${key} is not in spec.json ${table}`);
    else if (
      base !== key &&
      (table === "layout" || keys[base].transition === false)
    ) {
      fail(`layer.json ${table}: ${key} takes no transition`);
    }
  }
}

// ------------------------------------------------------------------ expressions
let styleSpec = null;
try {
  const require = createRequire(join(HERE, "../../js/package.json"));
  styleSpec = await import(
    pathToFileURL(require.resolve("@maplibre/maplibre-gl-style-spec")).href
  );
} catch {
  console.log(
    "expressions: skipped, @maplibre/maplibre-gl-style-spec is not installed (pnpm install)",
  );
}

/** A style-spec property spec for a spec.json entry. */
function styleSpecOf(entry) {
  const type = {
    float: "number",
    float2: "array",
    color: "color",
    enum: "enum",
    boolean: "boolean",
    string: "string",
  }[entry.type];
  const dataDriven = entry.expressions === "data-driven";
  return {
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
  };
}

const results = {};
if (styleSpec) {
  for (const [table, keys] of [
    ["layout", spec.layout],
    ["paint", spec.paint],
  ]) {
    for (const [key, value] of Object.entries(layer[table] ?? {})) {
      const entry = keys[key];
      if (!entry) continue;
      const parsed = styleSpec.expression.createPropertyExpression(
        value,
        `${table}.${key}`,
        styleSpecOf(entry),
      );
      if (parsed.result !== "success") {
        fail(
          `layer.json ${key}: ${parsed.value.map((e) => `${e.key} ${e.message}`).join("; ")}`,
        );
        continue;
      }
      const out = (results[key] = {
        values: {},
        min: Infinity,
        max: -Infinity,
      });
      for (const f of collection.features) {
        const feature = { type: 3, id: f.id, properties: f.properties };
        let v;
        try {
          v = parsed.value.evaluateWithoutErrorHandling(
            { zoom: 17 },
            feature,
            {},
          );
        } catch (error) {
          fail(`layer.json ${key} on ${f.properties.osm}: ${error.message}`);
          continue;
        }
        if (typeof v === "number") {
          out.min = Math.min(out.min, v);
          out.max = Math.max(out.max, v);
          if (entry.minimum !== undefined && v < entry.minimum)
            fail(`${key} on ${f.properties.osm}: ${v} < ${entry.minimum}`);
          if (entry.maximum !== undefined && v > entry.maximum)
            fail(`${key} on ${f.properties.osm}: ${v} > ${entry.maximum}`);
        } else if (typeof v === "string") {
          out.values[v] = (out.values[v] ?? 0) + 1;
          if (entry.type === "enum" && !entry.values.includes(v))
            fail(`${key} on ${f.properties.osm}: ${v}`);
        }
      }
    }
  }
  // Base below height on every feature, as the plugin expects.
  const base = styleSpec.expression.createPropertyExpression(
    layer.paint["building-base"],
    "paint.building-base",
    styleSpecOf(spec.paint["building-base"]),
  );
  const height = styleSpec.expression.createPropertyExpression(
    layer.paint["building-height"],
    "paint.building-height",
    styleSpecOf(spec.paint["building-height"]),
  );
  const inverted = [];
  for (const f of collection.features) {
    const feature = { type: 3, id: f.id, properties: f.properties };
    if (
      base.value.evaluate({ zoom: 17 }, feature) >=
      height.value.evaluate({ zoom: 17 }, feature)
    ) {
      inverted.push(f.properties.osm);
    }
  }
  results["base >= height"] = inverted;

  // source.json, with the data added, is a valid GeoJSON source.
  const source = JSON.parse(readFileSync(join(HERE, "source.json"), "utf8"));
  const style = {
    version: 8,
    sources: {
      buildings: {
        ...source,
        data: { type: "FeatureCollection", features: [] },
      },
    },
    layers: [],
  };
  for (const e of styleSpec.validateStyleMin(style))
    fail(`source.json: ${e.message}`);
}

// ------------------------------------------------------------------ report
const sorted = (o) =>
  Object.fromEntries(
    Object.entries(o).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)),
  );
console.log(
  `features: ${collection.features?.length} (${counts.building} buildings, ${counts.part} parts; ${counts.Polygon} Polygon, ${counts.MultiPolygon} MultiPolygon, ${counts.holes} holes)`,
);
console.log("properties:", JSON.stringify(sorted(tags)));
for (const [key, r] of Object.entries(results)) {
  if (Array.isArray(r))
    console.log(`${key}: ${r.length} features ${r.slice(0, 10).join(" ")}`);
  else if (Object.keys(r.values).length > 0)
    console.log(
      `${key}:`,
      key === "building-roof-lines"
        ? `${Object.keys(r.values).length} distinct strings`
        : JSON.stringify(sorted(r.values)),
    );
  else if (r.max >= r.min) console.log(`${key}: ${r.min} .. ${r.max}`);
}
if (errors.length > 0) {
  console.error(
    `${errors.length} error(s):\n  ${errors.slice(0, 50).join("\n  ")}`,
  );
  process.exit(1);
}
console.log("ok");
