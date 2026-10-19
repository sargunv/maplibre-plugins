// Writes prism.json in this directory: hit-test cases for the building
// layer's twins, the maplibre-gl-js layer's ../../js/src/query.ts (which
// computes the expected hits here) and the native plugin's
// ../../native/src/query.zig. Both are tested against the file.
//
//   node plugins/building/fixtures/query/generate.mjs
//   pnpm exec dprint fmt plugins/building/fixtures/query/prism.json
//
// Each case is a footprint (rings in tile units), building-base and
// -height (meters), building-translate (logical pixels) with its anchor,
// the map's bearing (radians, clockwise) and tile units per pixel, a
// column-major tile matrix (tile units and meters to clip space), and a
// grid of ground query points (tile units, z = 0): one string per row, from
// north to south, with "#" where the point hits and "." where it misses.
// The matrices are perspective cameras, so a tall building's walls and roof
// cover ground beyond its footprint, and a translated prism differs from a
// translated query point.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { prismHit, translationInTileUnits } from "../../js/src/query.ts";

const here = dirname(fileURLToPath(import.meta.url));

// --- Matrices ---------------------------------------------------------------

function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return [
    f / aspect,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    0,
    0,
    (far + near) * nf,
    -1,
    0,
    0,
    2 * far * near * nf,
    0,
  ];
}

function lookAt(eye, target, up) {
  const sub = (a, b) => a.map((v, i) => v - b[i]);
  const norm = (a) => a.map((v) => v / Math.hypot(...a));
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
  const z = norm(sub(eye, target));
  const x = norm(cross(up, z));
  const y = cross(z, x);
  return [
    x[0],
    y[0],
    z[0],
    0,
    x[1],
    y[1],
    z[1],
    0,
    x[2],
    y[2],
    z[2],
    0,
    -dot(x, eye),
    -dot(y, eye),
    -dot(z, eye),
    1,
  ];
}

/**
 * A camera looking at (cx, cy) from `distance` tile units away, pitched
 * `pitch` degrees from straight down, seen from the south (+y), with
 * `unitsPerMeter` tile units per meter of height. The tile frame is
 * left-handed (y down, z up), so the camera works in (x, -y, z).
 */
function camera(cx, cy, distance, pitch, unitsPerMeter) {
  const p = (pitch * Math.PI) / 180;
  const flip = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, unitsPerMeter, 0, 0, 0, 0, 1];
  const eye = [cx, -cy - distance * Math.sin(p), distance * Math.cos(p)];
  const view = lookAt(eye, [cx, -cy, 0], pitch === 0 ? [0, 1, 0] : [0, 0, 1]);
  const projection = perspective(
    0.6435011087932844,
    1.5,
    distance / 50,
    distance * 10,
  );
  return multiply(projection, multiply(view, flip));
}

const round = (m) => m.map((v) => Number(v.toPrecision(12)));
const topDown = round(camera(4100, 4100, 3000, 0, 20));
const pitched = round(camera(4100, 4100, 2500, 60, 6));
const pitchedNear = round(camera(4100, 4100, 1200, 55, 6));
// Steep and close: a 20 m top shows between the walls, and 2,250 tile units
// south of the target a 20 m top is behind the camera.
const steepNear = round(camera(4100, 4100, 1200, 30, 6));

// --- Footprints ----------------------------------------------------------------

const square = [
  [
    [4000, 4000],
    [4200, 4000],
    [4200, 4200],
    [4000, 4200],
  ],
];
const courtyard = [
  ...square,
  [
    [4060, 4060],
    [4060, 4140],
    [4140, 4140],
    [4140, 4060],
  ],
];
const ell = [
  [
    [4000, 4000],
    [4100, 4000],
    [4100, 4100],
    [4200, 4100],
    [4200, 4200],
    [4000, 4200],
  ],
];

// --- Cases ---------------------------------------------------------------------

function project(m, x, y, z) {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return {
    x: (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
    y: (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
    w,
  };
}

/** Ground points from (x0, y0) to (x1, y1), `dx` and `dy` apart. */
function grid(x0, y0, x1, y1, dx, dy = dx) {
  return {
    x0,
    y0,
    dx,
    dy,
    columns: Math.floor((x1 - x0) / dx) + 1,
    rows: Math.floor((y1 - y0) / dy) + 1,
  };
}

// Grids start off the 25-unit lattice, so no query point lies exactly on a
// footprint edge, where the twins' last-bit rounding could disagree.
const near = grid(3706.25, 3506.25, 4500, 4500, 25, 50);
// Pitched cameras see a tall building's top far north of its footprint.
const north = grid(3706.25, 1506.25, 4500, 4500, 50, 100);
const cases = [
  {
    name: "top-down",
    matrix: topDown,
    rings: square,
    base: 0,
    height: 20,
    points: near,
  },
  {
    name: "top-down courtyard",
    matrix: topDown,
    rings: courtyard,
    base: 0,
    height: 20,
    points: near,
  },
  {
    name: "pitched tall",
    matrix: pitched,
    rings: square,
    base: 0,
    height: 60,
    points: north,
  },
  {
    name: "pitched raised base",
    matrix: pitched,
    rings: square,
    base: 30,
    height: 60,
    points: north,
  },
  {
    name: "pitched L",
    matrix: pitched,
    rings: ell,
    base: 0,
    height: 40,
    points: north,
  },
  {
    name: "pitched flat",
    matrix: pitched,
    rings: square,
    base: 0,
    height: 0,
    points: north,
  },
  {
    name: "negative heights clamp",
    matrix: pitched,
    rings: square,
    base: -10,
    height: -5,
    points: north,
  },
  {
    name: "translate map",
    matrix: topDown,
    rings: square,
    base: 0,
    height: 20,
    translate: [50, 0],
    pixelsToTileUnits: 4,
    points: near,
  },
  {
    name: "translate viewport, bearing 90",
    matrix: topDown,
    rings: square,
    base: 0,
    height: 20,
    translate: [50, 0],
    viewport: true,
    bearing: Math.PI / 2,
    pixelsToTileUnits: 4,
    points: near,
  },
  {
    name: "translate viewport, bearing 30, pitched tall",
    matrix: pitched,
    rings: square,
    base: 0,
    height: 60,
    translate: [40, -25],
    viewport: true,
    bearing: Math.PI / 6,
    pixelsToTileUnits: 4,
    points: north,
  },
  {
    // Close up and tall: the translated walls cover ground that a translated
    // query point would miss (the case asserts that it does).
    name: "translated prism, not translated query",
    matrix: pitchedNear,
    rings: square,
    base: 0,
    height: 60,
    translate: [0, -60],
    pixelsToTileUnits: 2,
    points: grid(3856.25, 3306.25, 4350, 4200, 12.5, 25),
    distinguishes: true,
  },
  {
    // A second component whose top is behind the camera must not hide the
    // first one's top: the hits are the first square's alone (the generator
    // checks). Some of them only the top covers.
    name: "multipolygon, one top behind the camera",
    matrix: steepNear,
    rings: [
      ...square,
      [
        [4000, 6350],
        [4200, 6350],
        [4200, 6480],
        [4000, 6480],
      ],
    ],
    base: 0,
    height: 20,
    points: grid(3906.25, 3806.25, 4300, 4300, 12.5, 12.5),
    sameAs: square,
  },
  {
    // A first ring the layout drops (under MIN_RING_AREA) and wound the
    // other way must not set the exterior winding: the courtyard stays a
    // hole, so the hits are the courtyard footprint's alone.
    name: "dropped first ring, courtyard",
    matrix: topDown,
    rings: [
      [
        [3000, 3000],
        [3001, 3001],
        [3001, 3000],
      ],
      ...courtyard,
    ],
    base: 0,
    height: 20,
    points: near,
    sameAs: courtyard,
  },
  {
    // A dropped first ring that a query covers: the layout draws nothing
    // there, so it is no top of its own and has no walls.
    name: "dropped first ring under the query",
    matrix: topDown,
    rings: [
      [
        [3806, 3806],
        [3807, 3807],
        [3807, 3806],
      ],
      ...square,
    ],
    base: 0,
    height: 20,
    points: grid(3801.25, 3801.25, 3811.25, 3811.25, 0.5, 0.5),
    sameAs: square,
    hitless: true,
  },
];

const out = cases.map((c) => {
  const translate = c.translate ?? [0, 0];
  const viewport = c.viewport ?? false;
  const bearing = c.bearing ?? 0;
  const pixelsToTileUnits = c.pixelsToTileUnits ?? 1;
  const t = translationInTileUnits(
    translate,
    viewport,
    bearing,
    pixelsToTileUnits,
  );
  const rings = c.rings.map((ring) => ring.map(([x, y]) => ({ x, y })));
  let differs = 0;
  let hits = 0;
  const g = c.points;
  const rows = [];
  for (let r = 0; r < g.rows; r++) {
    let row = "";
    for (let k = 0; k < g.columns; k++) {
      const x = g.x0 + k * g.dx;
      const y = g.y0 + r * g.dy;
      const q = project(c.matrix, x, y, 0);
      if (!(q.w > 0))
        throw new Error(`${c.name}: query point ${x},${y} behind the camera`);
      const hit = prismHit(rings, c.base, c.height, c.matrix, q, t) !== null;
      // What translating the query's ground point would say instead.
      const moved = project(c.matrix, x - t[0], y - t[1], 0);
      if ((prismHit(rings, c.base, c.height, c.matrix, moved) !== null) !== hit)
        differs++;
      if (c.sameAs) {
        const alone = c.sameAs.map((ring) => ring.map(([x, y]) => ({ x, y })));
        if (
          (prismHit(alone, c.base, c.height, c.matrix, q, t) !== null) !==
          hit
        )
          throw new Error(
            `${c.name}: differs from its first polygon alone at ${x},${y}`,
          );
      }
      if (hit) hits++;
      row += hit ? "#" : ".";
    }
    rows.push(row);
  }
  const total = g.rows * g.columns;
  if (hits === 0 && c.height > 0 && !c.hitless)
    throw new Error(`${c.name}: no hits`);
  if (c.distinguishes && differs === 0)
    throw new Error(`${c.name}: does not distinguish a translated prism`);
  console.log(
    `${c.name}: ${hits}/${total} hits${c.distinguishes ? `, ${differs} differ from a translated query` : ""}`,
  );
  return {
    name: c.name,
    matrix: c.matrix,
    rings: c.rings,
    base: c.base,
    height: c.height,
    translate,
    translateAnchor: viewport ? "viewport" : "map",
    bearing,
    pixelsToTileUnits,
    grid: { x0: g.x0, y0: g.y0, dx: g.dx, dy: g.dy },
    hits: rows,
  };
});

writeFileSync(
  join(here, "prism.json"),
  JSON.stringify(
    {
      $comment:
        "Written by generate.mjs from ../../js/src/query.ts; ../../native/src/query.zig is tested against it too. matrix: column-major, tile units and meters to clip space. rings: tile units. base, height: meters. translate: logical pixels, turned by bearing (radians, clockwise, the map's) for a viewport anchor, times pixelsToTileUnits. grid: the ground query points (tile units, z = 0), x0 + column * dx and y0 + row * dy; hits: one string per row, # where the point hits.",
      cases: out,
    },
    null,
    1,
  ) + "\n",
);
