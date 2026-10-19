// Generates buildings.geojson and buildings.geojson.LICENSE.txt: real
// OpenStreetMap buildings with their roof tagging, for the building plugin's
// demo. The area is Bamberg's old town (the cathedral hill, the old town hall
// and the island town), extended north-west to include mapped roof lines.
// The original box was picked because roof:shape is mapped
// on about half of its buildings, with more gambrel and mansard roofs than
// anywhere else surveyed.
//
//   node generate.mjs            # fetch (or reuse the cache) and write both files
//   node generate.mjs --refresh  # ignore the cache and fetch again
//
// The Overpass query is pinned to SNAPSHOT with [date:], so it returns the
// same data whenever it runs. The raw response is cached in .cache/overpass/
// (gitignored) and only ever parsed as JSON. Given the same response the
// output is byte-identical.
//
// Simple 3D Buildings (https://wiki.openstreetmap.org/wiki/Simple_3D_Buildings):
// a building outline is dropped when it has parts, either as the outline of a
// type=building relation with part members or because a building:part lies
// inside it, so only the parts are drawn there. Parts do not inherit tags from
// their outline. Everything is fetched in a box PAD_M larger than BBOX, and a
// feature is kept when the interior point of its building (its own, or for a
// part the outline it belongs to) lies inside BBOX, so no building loses
// parts at the edge.
//
// Feature ids are numeric for feature-state: a way keeps its OSM id and a
// relation gets RELATION_ID_OFFSET + its id. The "osm" property says which
// ("way/123"). Only the tags in KEPT_TAGS are copied, verbatim. Values a style
// expression cannot parse get normalized properties beside them (see NORMALIZED).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(HERE, ".cache", "overpass");
const OUTPUT = join(HERE, "buildings.geojson");
const NOTICE = join(HERE, "buildings.geojson.LICENSE.txt");

const AREA = "Bamberg: old town";
/** [south, west, north, east]: old town and the roof-line cluster to its north-west. */
const BBOX = [49.88611, 10.874, 49.9003, 10.89337];
const PAD_M = 200;
const SNAPSHOT = "2026-10-01T00:00:00Z";
const RELATION_ID_OFFSET = 1e12;
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const USER_AGENT =
  "maplibre-plugins building demo (https://github.com/sargunv/maplibre-plugins)";

const KEPT_TAGS = [
  "building",
  "building:part",
  "height",
  "min_height",
  "building:levels",
  "building:min_level",
  "roof:shape",
  "roof:lines",
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
];

/** Normalized property -> the tag it comes from and how it is parsed. */
const NORMALIZED = {
  height_m: ["height", parseLength],
  min_height_m: ["min_height", parseLength],
  levels: ["building:levels", parseCount],
  min_level: ["building:min_level", parseCount],
  roof_height_m: ["roof:height", parseLength],
  roof_levels: ["roof:levels", parseCount],
  roof_angle_deg: ["roof:angle", parseAngle],
  roof_direction_deg: ["roof:direction", parseDirection],
  roof_orientation: ["roof:orientation", parseOrientation],
};

// ------------------------------------------------------------------ fetch
function paddedBbox() {
  const [s, w, n, e] = BBOX;
  const dLat = PAD_M / 111320;
  const dLon = PAD_M / (111320 * Math.cos((((s + n) / 2) * Math.PI) / 180));
  return [s - dLat, w - dLon, n + dLat, e + dLon].map((v) => v.toFixed(5));
}

function overpassQuery() {
  return [
    `[out:json][timeout:300][date:"${SNAPSHOT}"][bbox:${paddedBbox().join(",")}];`,
    `(way["building"];way["building:part"];rel["building"];rel["building:part"];rel["type"="building"];way["roof:ridge"="yes"];way["roof:edge"="yes"];node["roof:apex"="yes"];);`,
    `(._;>>;);`,
    `out body qt;`,
  ].join("\n");
}

async function fetchOverpass(query, refresh) {
  const key = createHash("sha256").update(query).digest("hex").slice(0, 16);
  const file = join(CACHE_DIR, `${key}.json`);
  if (!refresh && existsSync(file)) {
    console.error(`using cached ${file}`);
    return parseResponse(readFileSync(file, "utf8"));
  }
  let lastError;
  for (let attempt = 0; attempt < 8; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      console.error(`POST ${url} (attempt ${attempt + 1})`);
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `data=${encodeURIComponent(query)}`,
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = parseResponse(text);
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(file, text);
      return json;
    } catch (error) {
      lastError = error;
      console.error(`  failed: ${error.message}`);
      await new Promise((resolve) =>
        setTimeout(resolve, 5000 * 2 ** Math.min(attempt, 4)),
      );
    }
  }
  throw new Error(`Overpass failed: ${lastError?.message}`);
}

/** The response is untrusted: JSON only, and every field is checked before use. */
function parseResponse(text) {
  const json = JSON.parse(text);
  if (
    typeof json !== "object" ||
    json === null ||
    !Array.isArray(json.elements)
  ) {
    throw new Error("not an Overpass JSON response");
  }
  if (typeof json.remark === "string" && /error/i.test(json.remark)) {
    throw new Error(`Overpass: ${json.remark}`);
  }
  return json;
}

// ------------------------------------------------------------------ elements
const isId = (v) => Number.isSafeInteger(v) && v > 0;

function readTags(raw) {
  const tags = {};
  if (typeof raw !== "object" || raw === null) return tags;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string" && v.length <= 255) tags[k] = v;
  }
  return tags;
}

function indexElements(elements) {
  const nodes = new Map();
  const nodeTags = new Map();
  const ways = new Map();
  const relations = new Map();
  for (const e of elements) {
    if (typeof e !== "object" || e === null || !isId(e.id)) continue;
    if (e.type === "node") {
      const { lat, lon } = e;
      if (
        Number.isFinite(lat) &&
        Number.isFinite(lon) &&
        Math.abs(lat) <= 90 &&
        Math.abs(lon) <= 180
      ) {
        nodes.set(e.id, [lon, lat]);
        nodeTags.set(e.id, readTags(e.tags));
      }
    } else if (
      e.type === "way" &&
      Array.isArray(e.nodes) &&
      e.nodes.every(isId)
    ) {
      ways.set(e.id, { id: e.id, nodes: e.nodes, tags: readTags(e.tags) });
    } else if (e.type === "relation" && Array.isArray(e.members)) {
      const members = e.members
        .filter(
          (m) =>
            (m.type === "way" || m.type === "relation" || m.type === "node") &&
            isId(m.ref),
        )
        .map((m) => ({
          type: m.type,
          ref: m.ref,
          role: typeof m.role === "string" ? m.role : "",
        }));
      relations.set(e.id, { id: e.id, members, tags: readTags(e.tags) });
    }
  }
  return { nodes, nodeTags, ways, relations };
}

const isYes = (v) => v !== undefined && v !== "no";
const isPartTags = (t) => isYes(t["building:part"]);
const isBuildingTags = (t) => isYes(t.building) && !isPartTags(t);
const isUnderground = (t) =>
  t.location === "underground" || t.building === "underground";

// ------------------------------------------------------------------ geometry
/** Local equirectangular meters around the box center, for areas and tests. */
const LAT0 = (BBOX[0] + BBOX[2]) / 2;
const LON0 = (BBOX[1] + BBOX[3]) / 2;
const KX = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const KY = 110574;
const toLocal = ([lon, lat]) => [(lon - LON0) * KX, (lat - LAT0) * KY];

function ringOfNodes(nodeIds, nodes) {
  const ring = [];
  for (const id of nodeIds) {
    const p = nodes.get(id);
    if (!p) return null;
    ring.push(p);
  }
  return ring;
}

/** Joins member ways into closed node-id rings; unclosable chains are dropped. */
function assembleRings(wayNodeLists) {
  const rings = [];
  const open = [];
  for (const list of wayNodeLists) {
    if (list.length < 2) continue;
    if (list[0] === list.at(-1)) rings.push(list.slice());
    else open.push(list.slice());
  }
  while (open.length > 0) {
    let chain = open.shift();
    let grew = true;
    while (chain[0] !== chain.at(-1) && grew) {
      grew = false;
      for (let i = 0; i < open.length; i++) {
        const w = open[i];
        if (w[0] === chain.at(-1)) chain = chain.concat(w.slice(1));
        else if (w.at(-1) === chain.at(-1))
          chain = chain.concat(w.slice(0, -1).reverse());
        else if (w.at(-1) === chain[0]) chain = w.slice(0, -1).concat(chain);
        else if (w[0] === chain[0]) chain = w.slice(1).reverse().concat(chain);
        else continue;
        open.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (chain[0] === chain.at(-1)) rings.push(chain);
  }
  return rings;
}

function signedArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return a / 2;
}

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

/** polygons: [[outer, ...holes], ...] in local meters. */
function pointInPolygons(p, polygons) {
  return polygons.some(
    ([outer, ...holes]) =>
      pointInRing(p, outer) && !holes.some((h) => pointInRing(p, h)),
  );
}

/** A point inside the largest polygon: its centroid if inside, else a scanline midpoint. */
function interiorPoint(polygons) {
  let best = polygons[0];
  for (const p of polygons)
    if (Math.abs(signedArea(p[0])) > Math.abs(signedArea(best[0]))) best = p;
  const outer = best[0];
  let cx = 0;
  let cy = 0;
  let a = 0;
  for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
    const f = outer[j][0] * outer[i][1] - outer[i][0] * outer[j][1];
    cx += (outer[j][0] + outer[i][0]) * f;
    cy += (outer[j][1] + outer[i][1]) * f;
    a += f;
  }
  if (a !== 0) {
    const c = [cx / (3 * a), cy / (3 * a)];
    if (pointInPolygons(c, [best])) return c;
  }
  const ys = outer.map((p) => p[1]);
  const y = a !== 0 ? cy / (3 * a) : (Math.min(...ys) + Math.max(...ys)) / 2;
  const xs = [];
  for (const ring of best) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y) xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
    }
  }
  xs.sort((p, q) => p - q);
  let widest = [outer[0][0], outer[0][1]];
  let width = -1;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (xs[i + 1] - xs[i] > width) {
      width = xs[i + 1] - xs[i];
      widest = [(xs[i] + xs[i + 1]) / 2, y];
    }
  }
  return widest;
}

/**
 * Builds [[outer, ...holes], ...] from node-id rings (lon/lat), outer rings
 * by role when given, else by containment. Returns null when nothing closes.
 */
function buildPolygons(outerRings, innerRings) {
  const outers = outerRings.filter((r) => r.length >= 4);
  const inners = innerRings.filter((r) => r.length >= 4);
  if (outers.length === 0) return null;
  const polygons = outers.map((r) => [r]);
  for (const inner of inners) {
    const probe = toLocal(inner[0]);
    const host = polygons.find(([outer]) =>
      pointInRing(probe, outer.map(toLocal)),
    );
    if (host) host.push(inner);
  }
  return polygons;
}

function wayPolygons(way, nodes) {
  if (way.nodes.length < 4 || way.nodes[0] !== way.nodes.at(-1)) return null;
  const ring = ringOfNodes(way.nodes, nodes);
  return ring ? buildPolygons([ring], []) : null;
}

function multipolygonPolygons(rel, ways, nodes) {
  const byRole = { outer: [], inner: [] };
  for (const m of rel.members) {
    if (m.type !== "way") continue;
    const way = ways.get(m.ref);
    if (!way) continue;
    (m.role === "inner" ? byRole.inner : byRole.outer).push(way.nodes);
  }
  const toCoords = (rings) =>
    rings.map((r) => ringOfNodes(r, nodes)).filter(Boolean);
  return buildPolygons(
    toCoords(assembleRings(byRole.outer)),
    toCoords(assembleRings(byRole.inner)),
  );
}

// ------------------------------------------------------------------ tags
const FEET = 0.3048;

/** "12", "12.5", "12,5", "12 m", "40 ft", "40'", "10'6\"" -> meters, else undefined. */
function parseLength(value) {
  const v = value.split(";")[0].trim().toLowerCase();
  let m = /^(\d+(?:[.,]\d+)?)\s*(m|meters?|metres?)?$/.exec(v);
  if (m) return round(Number(m[1].replace(",", ".")), 2);
  m = /^(\d+(?:[.,]\d+)?)\s*(ft|feet|')$/.exec(v);
  if (m) return round(Number(m[1].replace(",", ".")) * FEET, 2);
  m = /^(\d+)'\s*(\d+(?:\.\d+)?)"$/.exec(v);
  if (m) return round((Number(m[1]) + Number(m[2]) / 12) * FEET, 2);
  return undefined;
}

/** Levels: a non-negative number. */
function parseCount(value) {
  const m = /^(\d+(?:[.,]\d+)?)$/.exec(value.split(";")[0].trim());
  return m ? Number(m[1].replace(",", ".")) : undefined;
}

function parseAngle(value) {
  const m = /^(\d+(?:[.,]\d+)?)\s*(°|deg|degrees?)?$/i.exec(
    value.split(";")[0].trim(),
  );
  if (!m) return undefined;
  const a = Number(m[1].replace(",", "."));
  return a > 0 && a < 90 ? a : undefined;
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

/** Degrees clockwise from north, or a 16-wind compass point -> [0, 360). */
function parseDirection(value) {
  const v = value.split(";")[0].trim();
  const compass = COMPASS.indexOf(v.toUpperCase());
  if (compass >= 0) return compass * 22.5;
  const m = /^(-?\d+(?:[.,]\d+)?)\s*°?$/.exec(v);
  if (!m) return undefined;
  const deg = Number(m[1].replace(",", "."));
  return round(((deg % 360) + 360) % 360, 2);
}

function parseOrientation(value) {
  const v = value.trim().toLowerCase();
  return v === "along" || v === "across" ? v : undefined;
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function properties(osm, kind, tags) {
  const props = { osm, kind };
  for (const key of KEPT_TAGS)
    if (tags[key] !== undefined) props[key] = tags[key];
  for (const [name, [key, parse]] of Object.entries(NORMALIZED)) {
    if (tags[key] === undefined) continue;
    const value = parse(tags[key]);
    if (value !== undefined) props[name] = value;
  }
  return props;
}

/** OSM2World ComplexRoof: edge node, edge way, apex; ridge ways override them. */
function joinRoofLines(props, polygons, nodes, nodeTags, ways) {
  if (
    props["roof:lines"] === "no" ||
    ["flat", "round", "dome", "onion"].includes(props["roof:shape"])
  )
    return;
  const segments = [];
  for (const way of ways.values()) {
    const edge = way.tags["roof:edge"] === "yes";
    if (!edge && way.tags["roof:ridge"] !== "yes") continue;
    for (let i = 1; i < way.nodes.length; i++) {
      const a = nodes.get(way.nodes[i - 1]),
        b = nodes.get(way.nodes[i]);
      if (
        !a ||
        !b ||
        !pointInPolygons([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], polygons)
      )
        continue;
      segments.push({
        a: way.nodes[i - 1],
        b: way.nodes[i],
        edge,
        tags: way.tags,
      });
    }
  }
  const apexes = [...nodeTags]
    .filter(
      ([id, tags]) =>
        tags["roof:apex"] === "yes" && pointInPolygons(nodes.get(id), polygons),
    )
    .map(([id]) => id);
  if (!segments.length && !(props["roof:shape"] === "complex" && apexes.length))
    return;
  const roofHeight =
    props.roof_height_m ??
    (props.roof_levels !== undefined ? 3 * props.roof_levels : 3);
  if (!(roofHeight > 0)) return;
  const heights = new Map();
  const heightOrder = new Map();
  let order = 0;
  const setHeight = (id, height) => {
    heights.set(id, height);
    heightOrder.set(id, order++);
  };
  for (const id of apexes)
    setHeight(
      id,
      parseLength(nodeTags.get(id)["roof:height"] ?? "") ?? roofHeight,
    );
  for (const s of segments.filter((s) => s.edge))
    for (const id of [s.a, s.b]) {
      const tags = nodeTags.get(id) ?? {};
      const height =
        tags["roof:height"] !== undefined
          ? parseLength(tags["roof:height"])
          : s.tags["roof:height"] !== undefined
            ? parseLength(s.tags["roof:height"])
            : tags["roof:apex"] === "yes"
              ? roofHeight
              : undefined;
      if (height !== undefined) setHeight(id, height);
    }
  for (const s of segments.filter((s) => !s.edge))
    for (const id of [s.a, s.b])
      setHeight(
        id,
        s.tags["roof:height"] !== undefined
          ? parseLength(s.tags["roof:height"])
          : roofHeight,
      );
  const ids = [...new Set([...segments.flatMap((s) => [s.a, s.b]), ...apexes])];
  // Coincident copies are listed in OSM2World write order: last wins (ridges after edges).
  const coincident = new Map();
  for (const [i, id] of ids.entries()) {
    const key = nodes.get(id).join(",");
    const group = coincident.get(key) ?? [];
    group.push(i);
    coincident.set(key, group);
  }
  for (const group of coincident.values()) {
    const sorted = group
      .map((i) => ids[i])
      .sort((a, b) => (heightOrder.get(a) ?? -1) - (heightOrder.get(b) ?? -1));
    group.forEach((i, k) => (ids[i] = sorted[k]));
  }
  props.roof_lines = {
    vertices: ids.map((id) => [
      ...nodes.get(id),
      (heights.get(id) ?? 0) / roofHeight,
    ]),
    edges: segments.map((s) => [ids.indexOf(s.a), ids.indexOf(s.b)]),
  };
  props.roof_lines_height_m = roofHeight;
}

// ------------------------------------------------------------------ output
/** RFC 7946 rings: rounded to 1e-7 degrees, deduplicated, outer CCW, holes CW. */
function geometryOf(polygons) {
  const out = [];
  for (const rings of polygons) {
    const polygon = [];
    for (const [i, ring] of rings.entries()) {
      const r = [];
      for (const [lon, lat] of ring) {
        const p = [round(lon, 7), round(lat, 7)];
        const last = r.at(-1);
        if (!last || last[0] !== p[0] || last[1] !== p[1]) r.push(p);
      }
      if (r.length < 4 || r[0][0] !== r.at(-1)[0] || r[0][1] !== r.at(-1)[1]) {
        if (i === 0) break;
        continue;
      }
      const ccw = signedArea(r) > 0; // signedArea is positive for counterclockwise rings
      if (ccw !== (i === 0)) r.reverse();
      polygon.push(r);
    }
    if (polygon.length > 0) out.push(polygon);
  }
  if (out.length === 0) return null;
  return out.length === 1
    ? { type: "Polygon", coordinates: out[0] }
    : { type: "MultiPolygon", coordinates: out };
}

async function main() {
  const refresh = process.argv.includes("--refresh");
  const query = overpassQuery();
  const response = await fetchOverpass(query, refresh);
  const { nodes, nodeTags, ways, relations } = indexElements(response.elements);

  // Every building and part polygon, keyed "way/1" or "relation/1".
  const features = new Map();
  const add = (key, id, tags, polygons) => {
    if (!polygons || isUnderground(tags)) return;
    const kind = isPartTags(tags)
      ? "part"
      : isBuildingTags(tags)
        ? "building"
        : null;
    if (!kind) return;
    features.set(key, {
      key,
      id,
      kind,
      tags,
      polygons,
      local: polygons.map((p) => p.map((r) => r.map(toLocal))),
    });
  };
  // Untagged member ways of a multipolygon are skipped by add(): only the relation is a building.
  for (const way of ways.values())
    add(`way/${way.id}`, way.id, way.tags, wayPolygons(way, nodes));
  for (const rel of relations.values()) {
    if (rel.tags.type === "multipolygon") {
      add(
        `relation/${rel.id}`,
        RELATION_ID_OFFSET + rel.id,
        rel.tags,
        multipolygonPolygons(rel, ways, nodes),
      );
    }
  }

  // Outlines with parts, from type=building relations and from containment.
  const dropped = new Set();
  const partOf = new Map(); // part key -> outline key
  for (const rel of relations.values()) {
    if (rel.tags.type !== "building") continue;
    const outlines = rel.members
      .filter((m) => m.role === "outline")
      .map((m) => `${m.type}/${m.ref}`);
    const parts = rel.members
      .filter((m) => m.role === "part")
      .map((m) => `${m.type}/${m.ref}`);
    for (const part of parts) {
      const f = features.get(part);
      if (f && f.kind !== "part") f.kind = "part"; // a part member counts as a part
      if (outlines[0]) partOf.set(part, outlines[0]);
    }
    if (parts.some((p) => features.has(p)))
      for (const o of outlines) dropped.add(o);
  }
  const outlines = [...features.values()].filter((f) => f.kind === "building");
  for (const part of features.values()) {
    if (part.kind !== "part") continue;
    part.point = interiorPoint(part.local);
    if (partOf.has(part.key)) continue;
    let host = null;
    for (const o of outlines) {
      if (!pointInPolygons(part.point, o.local)) continue;
      if (
        !host ||
        Math.abs(signedArea(o.local[0][0])) <
          Math.abs(signedArea(host.local[0][0]))
      )
        host = o;
    }
    if (host) {
      partOf.set(part.key, host.key);
      dropped.add(host.key);
    }
  }

  // Keep what lies in BBOX, judged by the building's interior point.
  const [s, w, n, e] = BBOX;
  const [x0, y0] = toLocal([w, s]);
  const [x1, y1] = toLocal([e, n]);
  const inBox = ([x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  const anchor = (f) => {
    const host = partOf.has(f.key) ? features.get(partOf.get(f.key)) : null;
    if (host) return (host.point ??= interiorPoint(host.local));
    return (f.point ??= interiorPoint(f.local));
  };
  const kept = [...features.values()]
    .filter((f) => !dropped.has(f.key) && inBox(anchor(f)))
    .sort((a, b) => a.id - b.id);

  const lines = [];
  const stats = {
    building: 0,
    part: 0,
    dropped: dropped.size,
    shapes: {},
    tags: {},
    normalized: {},
  };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let largest = 0;
  for (const f of kept) {
    const geometry = geometryOf(f.polygons);
    if (!geometry) continue;
    const props = properties(f.key, f.kind, f.tags);
    joinRoofLines(props, f.polygons, nodes, nodeTags, ways);
    stats[f.kind]++;
    for (const key of KEPT_TAGS)
      if (props[key] !== undefined)
        stats.tags[key] = (stats.tags[key] ?? 0) + 1;
    for (const key of Object.keys(NORMALIZED))
      if (props[key] !== undefined)
        stats.normalized[key] = (stats.normalized[key] ?? 0) + 1;
    const shape = props["roof:shape"] ?? "(none)";
    stats.shapes[shape] = (stats.shapes[shape] ?? 0) + 1;
    const xs = [];
    const ys = [];
    for (const polygon of f.local)
      for (const [x, y] of polygon[0]) {
        xs.push(x);
        ys.push(y);
      }
    largest = Math.max(
      largest,
      Math.max(...xs) - Math.min(...xs),
      Math.max(...ys) - Math.min(...ys),
    );
    const coords =
      geometry.type === "Polygon"
        ? [geometry.coordinates]
        : geometry.coordinates;
    for (const polygon of coords) {
      for (const [lon, lat] of polygon[0]) {
        minX = Math.min(minX, lon);
        minY = Math.min(minY, lat);
        maxX = Math.max(maxX, lon);
        maxY = Math.max(maxY, lat);
      }
    }
    lines.push(
      JSON.stringify({
        type: "Feature",
        id: f.id,
        geometry,
        properties: props,
      }),
    );
  }

  const header = {
    type: "FeatureCollection",
    bbox: [minX, minY, maxX, maxY],
    area: AREA,
    selection: {
      bbox: [BBOX[1], BBOX[0], BBOX[3], BBOX[2]],
      snapshot: SNAPSHOT,
    },
    attribution:
      "© OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)",
    license: "ODbL-1.0",
  };
  const head = JSON.stringify(header).slice(0, -1);
  writeFileSync(OUTPUT, `${head},"features":[\n${lines.join(",\n")}\n]}\n`);
  writeFileSync(NOTICE, notice());

  stats.shapes = Object.fromEntries(
    Object.entries(stats.shapes).sort(
      (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
    ),
  );
  stats.largestFootprintM = Math.round(largest);
  console.error(JSON.stringify(stats, null, 2));
}

function notice() {
  const [s, w, n, e] = BBOX;
  return `buildings.geojson
=================

Building outlines, building parts and their roof and 3D tags from
OpenStreetMap, for ${AREA} (Germany).

Data (c) OpenStreetMap contributors.
https://www.openstreetmap.org/copyright

The data is made available under the Open Database License (ODbL) 1.0:
https://opendatacommons.org/licenses/odbl/1-0/

Any rights in individual contents of the database are licensed under the
Database Contents License: https://opendatacommons.org/licenses/dbcl/1-0/

Source: the OpenStreetMap database as of ${SNAPSHOT}, fetched from the
Overpass API with [date:"${SNAPSHOT}"].
Selection box (west, south, east, north): ${w}, ${s}, ${e}, ${n}.

This file is a derived database: generate.mjs selects buildings and parts,
drops building outlines that have parts (Simple 3D Buildings), keeps a subset
of their tags and adds normalized copies of some of them. Anything you
publish that uses it must credit "(c) OpenStreetMap contributors" and, if you
distribute the data itself or a derived database, do so under the ODbL.
`;
}

await main();
