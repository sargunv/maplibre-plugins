// Writes the placement fixtures in this directory: screen corners, hit and
// miss points of icons at MapLibre-style cameras, computed with the
// maplibre-gl-js twin (../../js/src/place.ts). The native twin
// (../../native/src/place.zig) and the plugin's query_feature are tested
// against the same files.
//
//   node plugins/animated-icon/fixtures/place/generate.mjs
//   pnpm exec dprint fmt plugins/animated-icon/fixtures/place/*.json
//
// Cameras follow MapLibre Native's transform (transform_state.cpp) with
// roll 0 and no insets: a 512-pixel world tile, a vertical field of view of
// 2·atan(0.5 / 1.5), so the camera sits 1.5 viewport heights from the
// center, then pitch about the center and the bearing about the view axis.
// Each file's `view.matrix` maps the tile units of one tile to clip space,
// like the tile matrix the host hands query_feature, and `camera` records
// what built it, so a harness can set the same camera on a real map.
//
// Test points lie at least 1 px from every quad edge, and each unprojects to
// the ground within int16 tile units and back within 0.25 px, so the
// native query test (which queries in int16 tile units) sees the same hits.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { corners, hitPoint, hitPolygon, project } from "../../js/src/place.ts";

const EXTENT = 8192;
const TILE_SIZE = 512;
const FOV = 2 * Math.atan(0.5 / 1.5);

// Column-major 4×4 matrices, as gl-matrix.
function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[column * 4 + k];
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

function identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function translation(x, y, z) {
  const m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

function scaling(x, y, z) {
  const m = identity();
  m[0] = x;
  m[5] = y;
  m[10] = z;
  return m;
}

function rotationX(angle) {
  const m = identity();
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  m[5] = c;
  m[6] = s;
  m[9] = -s;
  m[10] = c;
  return m;
}

function rotationZ(angle) {
  const m = identity();
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  m[0] = c;
  m[1] = s;
  m[4] = -s;
  m[5] = c;
  return m;
}

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const m = new Array(16).fill(0);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

/**
 * The view of tile `tile` ([z, x, y]) under a camera centered on
 * `center` (tile units of that tile) at `zoom`, `pitch` and `bearing`
 * (degrees), with a `viewport` of logical pixels. With `aligned`, the
 * projection gets MapLibre Native's pixel-grid alignment
 * (TransformState::getProjMatrix with aligned = true), as the render
 * matrix the plugin's uniform context carries has; queries use the
 * unaligned one.
 */
export function tileView(camera, { aligned = false } = {}) {
  const { viewport, zoom, tile, center, pitch, bearing, pixelRatio } = camera;
  const [width, height] = viewport;
  const [tz, tx, ty] = tile;
  const worldSize = TILE_SIZE * 2 ** zoom;
  const tileScale = worldSize / 2 ** tz;
  const cx = (tx + center[0] / EXTENT) * tileScale;
  const cy = (ty + center[1] / EXTENT) * tileScale;
  const cameraToCenterDistance = (0.5 * height) / Math.tan(FOV / 2);
  const angle = (-bearing * Math.PI) / 180;
  let m = perspective(FOV, width / height, 1, cameraToCenterDistance * 100);
  m = multiply(m, scaling(1, -1, 1));
  m = multiply(m, translation(0, 0, -cameraToCenterDistance));
  m = multiply(m, rotationX((pitch * Math.PI) / 180));
  m = multiply(m, rotationZ(angle));
  m = multiply(m, translation(-cx, -cy, 0));
  if (aligned) {
    const dx = cx - 0.5 * worldSize;
    const dy = cy - 0.5 * worldSize;
    const xShift = (width % 2) / 2;
    const yShift = (height % 2) / 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const dxa = -(dx - Math.trunc(dx)) + cos * xShift + sin * yShift;
    const dya = -(dy - Math.trunc(dy)) + cos * yShift + sin * xShift;
    m = multiply(
      m,
      translation(dxa > 0.5 ? dxa - 1 : dxa, dya > 0.5 ? dya - 1 : dya, 0),
    );
  }
  m = multiply(m, translation(tx * tileScale, ty * tileScale, 0));
  m = multiply(m, scaling(tileScale / EXTENT, tileScale / EXTENT, 1));
  return {
    matrix: m,
    viewport: [width, height],
    pixelRatio,
    cameraToCenterDistance,
    pixelsToTileUnits: EXTENT / tileScale,
    bearing: angle,
  };
}

/** Longitude and latitude of a point in tile units of the camera's tile. */
export function tileLngLat(camera, p) {
  const [tz, tx, ty] = camera.tile;
  const x = (tx + p[0] / EXTENT) / 2 ** tz;
  const y = (ty + p[1] / EXTENT) / 2 ** tz;
  const lng = x * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
  return [lng, lat];
}

/** The ground point (tile units) under a screen point, or null. */
export function unproject(view, p) {
  const m = view.matrix;
  const [width, height] = view.viewport;
  const nx = (2 * p[0]) / width - 1;
  const ny = 1 - (2 * p[1]) / height;
  const a = m[0] - nx * m[3];
  const b = m[4] - nx * m[7];
  const c = m[1] - ny * m[3];
  const d = m[5] - ny * m[7];
  const e = -(m[12] - nx * m[15]);
  const f = -(m[13] - ny * m[15]);
  const det = a * d - b * c;
  if (det === 0) return null;
  const x = (e * d - b * f) / det;
  const y = (a * f - e * c) / det;
  const w = m[3] * x + m[7] * y + m[15];
  return w > 0 ? [x, y] : null;
}

const ANCHORS = [
  "center",
  "left",
  "right",
  "top",
  "bottom",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];
const ALIGNMENTS = ["auto", "map", "viewport"];

// `f7` has the geometry of the frames.mlvc entry the GPU check draws.
const ENTRIES = [
  { name: "f7", box: [0, 0, 32, 32], display_px: 32 },
  { name: "tall", box: [10, 5, 110, 125], display_px: 48 },
  { name: "wide", box: [-20, -10, 60, 30], display_px: 24 },
];

function resolve(properties) {
  const index = ENTRIES.findIndex(
    (e) => e.name === properties["icon-animation"],
  );
  return {
    animation: index + 1,
    size: properties["icon-size"],
    rotate: properties["icon-rotate"],
    opacity: properties["icon-opacity"],
    offset: properties["icon-offset"],
    anchor: ANCHORS.indexOf(properties["icon-anchor"]),
    rotationAlignment: ALIGNMENTS.indexOf(
      properties["icon-rotation-alignment"],
    ),
    pitchAlignment: ALIGNMENTS.indexOf(properties["icon-pitch-alignment"]),
  };
}

function entryFor(properties) {
  const entry =
    ENTRIES.find((e) => e.name === properties["icon-animation"]) ?? ENTRIES[0];
  return { box: entry.box, displayPx: entry.display_px };
}

function segmentDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy;
  const t =
    length2 === 0
      ? 0
      : Math.min(
          Math.max(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2, 0),
          1,
        );
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function edgeDistance(quad, p) {
  const ring = [quad[0], quad[1], quad[3], quad[2]];
  let distance = Infinity;
  for (let i = 0; i < 4; i++)
    distance = Math.min(
      distance,
      segmentDistance(p, ring[i], ring[(i + 1) % 4]),
    );
  return distance;
}

/** Whether a native query at p (int16 tile units) sees p within 0.25 px. */
function queryable(view, p) {
  const ground = unproject(view, p);
  if (ground === null) return false;
  const tile = ground.map(Math.round);
  if (tile.some((v) => v < -32768 || v > 32767)) return false;
  const back = project(view, tile);
  return back !== null && Math.hypot(back[0] - p[0], back[1] - p[1]) < 0.25;
}

function onScreen(view, p) {
  return (
    p[0] >= 0 &&
    p[1] >= 0 &&
    p[0] <= view.viewport[0] &&
    p[1] <= view.viewport[1]
  );
}

const round = (v) => Math.round(v * 1000) / 1000;

/** Hit and miss points around a quad, 1 px or more from its edges. */
function probes(view, quad, anchorScreen) {
  const center = [0, 1, 2, 3].reduce(
    (s, i) => [s[0] + quad[i][0] / 4, s[1] + quad[i][1] / 4],
    [0, 0],
  );
  const hits = [];
  const misses = [];
  const candidates = [center];
  for (const t of [0.35, 0.7]) {
    for (const corner of quad)
      candidates.push([
        center[0] + (corner[0] - center[0]) * t,
        center[1] + (corner[1] - center[1]) * t,
      ]);
  }
  for (const corner of quad) {
    const d = [corner[0] - center[0], corner[1] - center[1]];
    const length = Math.hypot(d[0], d[1]) || 1;
    candidates.push([
      corner[0] + (d[0] / length) * 3,
      corner[1] + (d[1] / length) * 3,
    ]);
    candidates.push([
      corner[0] + (d[0] / length) * 8,
      corner[1] + (d[1] / length) * 8,
    ]);
  }
  const ring = [quad[0], quad[1], quad[3], quad[2]];
  for (let i = 0; i < 4; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % 4];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const out = [mid[0] - center[0], mid[1] - center[1]];
    const length = Math.hypot(out[0], out[1]) || 1;
    candidates.push([
      mid[0] + (out[0] / length) * 2.5,
      mid[1] + (out[1] / length) * 2.5,
    ]);
    candidates.push([
      mid[0] - (out[0] / length) * 2.5,
      mid[1] - (out[1] / length) * 2.5,
    ]);
  }
  if (anchorScreen) candidates.push(anchorScreen);
  for (const raw of candidates) {
    const p = [round(raw[0]), round(raw[1])];
    if (!onScreen(view, p) || !queryable(view, p) || edgeDistance(quad, p) < 1)
      continue;
    (hitPoint(quad, p) ? hits : misses).push(p);
  }
  return { hits, misses };
}

function box(p, half) {
  return [
    [p[0] - half, p[1] - half],
    [p[0] + half, p[1] - half],
    [p[0] + half, p[1] + half],
    [p[0] - half, p[1] + half],
    [p[0] - half, p[1] - half],
  ];
}

function ringProbes(view, quad, hits, misses) {
  const ringHits = [];
  const ringMisses = [];
  // A box around a hit point, and one reaching a hit point from outside.
  if (hits.length > 0) ringHits.push(box(hits[0], 2));
  for (const miss of misses) {
    const near = hits.find(
      (h) => Math.hypot(h[0] - miss[0], h[1] - miss[1]) < 12,
    );
    if (near === undefined) continue;
    const ring = [miss, near, [near[0] + 0.5, near[1] + 0.5], miss].map((p) =>
      p.map(round),
    );
    if (
      ring.every((p) => onScreen(view, p) && queryable(view, p)) &&
      hitPolygon(quad, ring)
    ) {
      ringHits.push(ring);
      break;
    }
  }
  // Boxes around misses that stay 1 px or more from the quad.
  for (const miss of misses) {
    if (edgeDistance(quad, miss) < 2 * Math.SQRT2 + 1.5) continue;
    const ring = box(miss, 1);
    if (!ring.every((p) => onScreen(view, p) && queryable(view, p))) continue;
    if (!hitPolygon(quad, ring)) ringMisses.push(ring);
    if (ringMisses.length === 2) break;
  }
  return { ringHits, ringMisses };
}

function properties(overrides) {
  return {
    "icon-animation": "tall",
    "icon-size": 1,
    "icon-rotate": 0,
    "icon-opacity": 1,
    "icon-offset": [0, 0],
    "icon-anchor": "center",
    "icon-rotation-alignment": "auto",
    "icon-pitch-alignment": "auto",
    ...overrides,
  };
}

function makeCase(view, anchor, overrides) {
  const props = properties(overrides);
  const quad = corners(anchor, resolve(props), entryFor(props), view);
  const anchorScreen = project(view, anchor);
  if (quad === null) {
    const misses =
      anchorScreen &&
      onScreen(view, anchorScreen) &&
      queryable(view, anchorScreen.map(round))
        ? [anchorScreen.map(round)]
        : [];
    return {
      anchor,
      properties: props,
      corners: null,
      hits: [],
      misses,
      ring_hits: [],
      ring_misses: [],
    };
  }
  const { hits, misses } = probes(view, quad, anchorScreen);
  const { ringHits, ringMisses } = ringProbes(view, quad, hits, misses);
  return {
    anchor,
    properties: props,
    corners: quad,
    hits,
    misses,
    ring_hits: ringHits,
    ring_misses: ringMisses,
  };
}

function write(name, description, camera, cases) {
  const view = tileView(camera);
  const file = {
    description,
    camera,
    view: {
      matrix: view.matrix,
      viewport: view.viewport,
      pixel_ratio: view.pixelRatio,
      camera_to_center_distance: view.cameraToCenterDistance,
      pixels_to_tile_units: view.pixelsToTileUnits,
      bearing: view.bearing,
    },
    entries: ENTRIES,
    cases: cases.map(([anchor, overrides]) =>
      makeCase(view, anchor, overrides),
    ),
  };
  for (const c of file.cases) {
    if (c.corners !== null && c.hits.length === 0)
      throw new Error(`${name}: a case has no hit point: ${JSON.stringify(c)}`);
  }
  const directory = dirname(fileURLToPath(import.meta.url));
  writeFileSync(
    join(directory, `${name}.json`),
    `${JSON.stringify(file, null, 2)}\n`,
  );
  console.log(`wrote ${name}.json (${file.cases.length} cases)`);
}

function main() {
  const flat = {
    viewport: [800, 600],
    pixelRatio: 2,
    zoom: 4.5,
    tile: [4, 8, 5],
    center: [4096, 4096],
    pitch: 0,
    bearing: 0,
  };

  // Pitch 0, bearing 0: every icon faces the camera at scale 1, so the
  // corners are the anchor's screen point plus the box offsets.
  const anchors = ANCHORS.map((anchor, i) => [
    [1600 + (i % 3) * 2400, 1800 + Math.floor(i / 3) * 2000],
    { "icon-anchor": anchor },
  ]);
  write(
    "pitch0-bearing0",
    "Pitch 0, bearing 0, zoom 4.5 on tile 4/8/5 centered at (4096, 4096). Hand-verified: case 0 ('tall', box [10, 5, 110, 125], display 48, so 0.4 px per canvas px, anchor center at the screen center (400, 300)) has corners (380, 276), (420, 276), (380, 324), (420, 324); case 1 (bottom anchor, size 2, offset [5, -10]: 0.8 px per canvas px, bottom-center (60, 125) on (400, 300) moved by (10, -20)) has corners (370, 184), (450, 184), (370, 280), (450, 280); case 2 ('f7', box [0, 0, 32, 32], display 32, top-left anchor) has corners (400, 300), (432, 300), (400, 332), (432, 332). Then every icon-anchor, rotate, offset and the collapsed cases: size 0, opacity 0 and an unknown animation.",
    flat,
    [
      [[4096, 4096], {}],
      [
        [4096, 4096],
        { "icon-anchor": "bottom", "icon-size": 2, "icon-offset": [5, -10] },
      ],
      [[4096, 4096], { "icon-animation": "f7", "icon-anchor": "top-left" }],
      ...anchors,
      [[2500, 5000], { "icon-rotate": 30 }],
      [
        [5600, 5200],
        {
          "icon-rotate": 300,
          "icon-offset": [12, 4],
          "icon-anchor": "left",
          "icon-animation": "wide",
          "icon-size": 1.5,
        },
      ],
      [[4096, 4096], { "icon-size": 0 }],
      [[4096, 4096], { "icon-opacity": 0 }],
      [[4096, 4096], { "icon-animation": "unknown" }],
      [[3000, 3000], { "icon-rotation-alignment": "map", "icon-rotate": 45 }],
      [
        [3000, 5200],
        { "icon-pitch-alignment": "map", "icon-anchor": "bottom-right" },
      ],
    ],
  );

  // Every rotation × pitch alignment at each camera, with rotate, offset
  // and a mix of anchors and entries.
  const alignmentCases = (center) => {
    const cases = [];
    let i = 0;
    for (const rotation of ALIGNMENTS) {
      for (const pitch of ALIGNMENTS) {
        const dx = ((i % 3) - 1) * 1300;
        const dy = (Math.floor(i / 3) - 1) * 900;
        cases.push([
          [center[0] + dx, center[1] + dy],
          {
            "icon-animation": ENTRIES[i % 3].name,
            "icon-anchor": ANCHORS[(i * 4) % 9],
            "icon-rotate": (i * 37) % 360,
            "icon-offset": [(i % 4) * 3 - 4, 6 - (i % 5) * 2],
            "icon-size": 1 + (i % 3) * 0.5,
            "icon-rotation-alignment": rotation,
            "icon-pitch-alignment": pitch,
          },
        ]);
        i++;
      }
    }
    return cases;
  };

  for (const pitch of [0, 45, 60, 85]) {
    for (const bearing of [0, 30]) {
      if (pitch === 0 && bearing === 0) continue;
      const steep = pitch === 85;
      // At 85° the ground recedes fast: a closer camera center near the
      // tile's top edge keeps icons in front of the camera, and a point far
      // south of it lies behind the camera.
      const camera = steep
        ? {
            viewport: [800, 600],
            pixelRatio: 2,
            zoom: 4.9,
            tile: [4, 8, 5],
            center: [4096, 200],
            pitch,
            bearing,
          }
        : {
            viewport: [800, 600],
            pixelRatio: 2,
            zoom: 4.5,
            tile: [4, 8, 5],
            center: [4096, 4096],
            pitch,
            bearing,
          };
      const cases = alignmentCases(steep ? [4096, 900] : camera.center);
      if (steep && bearing === 0) {
        cases.push([[4096, 8150], { "icon-pitch-alignment": "viewport" }]);
        cases.push([[4096, 8150], { "icon-pitch-alignment": "map" }]);
      }
      write(
        `pitch${pitch}-bearing${bearing}`,
        `Pitch ${pitch}, bearing ${bearing}, zoom ${camera.zoom} on tile 4/8/5 centered at (${camera.center.join(", ")}): every rotation × pitch alignment with rotate, offset, size and anchors.${steep && bearing === 0 ? " The last two anchors lie behind the camera (corners null)." : ""}`,
        camera,
        cases,
      );
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
