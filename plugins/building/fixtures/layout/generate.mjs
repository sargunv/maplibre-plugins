// Writes the layout fixtures in this directory: building footprints laid
// out with every roof shape, orientation and a few directions by the
// maplibre-gl-js twin (../../js/src/layout.ts). The native twin
// (../../native/src/layout.zig) is tested against the same files. The
// format and the summary formula are documented in ../../js/src/fixture.ts.
//
//   node plugins/building/fixtures/layout/generate.mjs
//   pnpm exec dprint fmt plugins/building/fixtures/layout/*.json
//
// Footprints are in MVT winding (exteriors with positive shoelace area in
// tile coordinates, y down) unless a case says otherwise, at realistic
// sizes for an 8192 extent at zoom 16 (about 13.4 units per meter).

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expectedOutput, layOut } from "../../js/src/fixture.ts";
import { ROOF_SHAPES } from "../../js/src/spec.ts";

const here = dirname(fileURLToPath(import.meta.url));
const EXTENT = 8192;

/** Shapes whose roof follows building-roof-orientation. */
const FRAME_SHAPES = [
  "gabled",
  "hipped",
  "half-hipped",
  "skillion",
  "gambrel",
  "round",
  "double_saltbox",
  "saltbox",
  "mansard",
  "quadruple_saltbox",
  "round_gabled",
];

const DIRECTIONS = [
  ["gabled", 30],
  ["hipped", 350],
  ["skillion", 30],
  ["skillion", 200],
  ["saltbox", 135],
  ["saltbox", 290],
  ["round", 75],
  ["gambrel", 0],
  ["pyramidal", 90],
  ["skillion", 360],
  ["gabled", 45],
];

function rotate(points, degrees, [cx, cy]) {
  const r = (degrees * Math.PI) / 180;
  return points.map(([x, y]) => [
    Math.round(cx + (x - cx) * Math.cos(r) - (y - cy) * Math.sin(r)),
    Math.round(cy + (x - cx) * Math.sin(r) + (y - cy) * Math.cos(r)),
  ]);
}

function polygon(n, radius, [cx, cy]) {
  // Clockwise on a y-down screen, i.e. MVT exterior winding.
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return [
      Math.round(cx + radius * Math.cos(a)),
      Math.round(cy + radius * Math.sin(a)),
    ];
  });
}

const rectangle = [
  [1000, 1000],
  [1300, 1000],
  [1300, 1160],
  [1000, 1160],
];

/** Every shape, along; every frame shape across; the direction cases. */
function matrix(rings, options = {}) {
  const features = [];
  const add = (shape, orientation, direction, label) =>
    features.push({
      index: features.length,
      label,
      rings,
      shape,
      orientation,
      direction,
    });
  if (options.along !== false)
    for (const shape of ROOF_SHAPES) add(shape, "along", -1, `${shape}`);
  if (options.across !== false)
    for (const shape of FRAME_SHAPES)
      add(shape, "across", -1, `${shape} across`);
  if (options.directions !== false)
    for (const [shape, direction] of DIRECTIONS)
      add(shape, "along", direction, `${shape} toward ${direction}°`);
  return features;
}

const fixtures = {
  "rectangle-full": {
    description:
      "A 300 × 160 axis-aligned rectangle with every roof shape, recorded vertex by vertex.",
    features: matrix([rectangle], { across: false, directions: false }),
    full: true,
  },
  rectangle: {
    description:
      "The same rectangle across and with set directions; skillion follows the exact direction, the others turn their frame to the nearest axis (135° is a tie, which picks the shorter side's axis).",
    features: matrix([rectangle], { along: false }),
  },
  rotated: {
    description:
      "The rectangle rotated 30° and rounded to integers, so its bounding rectangle comes from the calipers.",
    features: matrix([rotate(rectangle, 30, [1000, 1000])]),
  },
  square: {
    description:
      "A square: the long and short sides tie, so along takes the first calipers edge.",
    features: matrix([
      [
        [2000, 2000],
        [2200, 2000],
        [2200, 2200],
        [2000, 2200],
      ],
    ]),
  },
  "l-shape": {
    description:
      "An L: frame shapes span its bounding rectangle; radial shapes fall back to flat (the center is outside the kernel).",
    features: matrix([
      [
        [1000, 1000],
        [1160, 1000],
        [1160, 1140],
        [1360, 1140],
        [1360, 1300],
        [1000, 1300],
      ],
    ]),
  },
  "u-shape": {
    description:
      "A U with a notch, a concave footprint whose break lines cross the notch walls.",
    features: matrix(
      [
        [
          [1000, 1000],
          [1100, 1000],
          [1100, 1200],
          [1300, 1200],
          [1300, 1000],
          [1400, 1000],
          [1400, 1300],
          [1000, 1300],
        ],
      ],
      { directions: false },
    ),
  },
  pentagon: {
    description:
      "An irregular convex pentagon: no side is parallel to the frame, and the radial shapes fit.",
    features: matrix(
      [
        [
          [1000, 1000],
          [1280, 1010],
          [1310, 1120],
          [1250, 1190],
          [990, 1170],
        ],
      ],
      { directions: false },
    ),
  },
  circle: {
    description:
      "A 16-gon of radius 150: smooth radial roofs (cone, dome, onion) and the frame shapes on a round footprint.",
    features: matrix([polygon(16, 150, [3000, 3000])], { directions: false }),
  },
  courtyard: {
    description:
      "A footprint with a courtyard: every shape falls back to a flat roof, with walls around the courtyard facing into it.",
    features: matrix(
      [
        [
          [1000, 1000],
          [1400, 1000],
          [1400, 1300],
          [1000, 1300],
        ],
        [
          [1120, 1100],
          [1120, 1200],
          [1280, 1200],
          [1280, 1100],
        ],
      ],
      { across: false, directions: false },
    ),
  },
  clipped: {
    description:
      "Tile-clipped footprints: edges on axis-aligned lines outside [0, extent] get no walls, and footprints crossing the tile's edge get flat roofs. An edge exactly on x = 0 is not a cut.",
    features: [
      ...["gabled", "hipped", "dome", "flat"].map((shape, i) => ({
        index: i,
        label: `${shape} cut at x = -128`,
        rings: [
          [
            [-128, 2000],
            [200, 2000],
            [200, 2200],
            [-128, 2200],
          ],
        ],
        shape,
      })),
      {
        index: 4,
        label: "gabled cut at y = extent + 128 and x = extent + 64",
        rings: [
          [
            [7900, 8000],
            [8256, 8000],
            [8256, 8320],
            [7900, 8320],
          ],
        ],
        shape: "gabled",
      },
      {
        index: 5,
        label: "gabled on x = 0, not a cut",
        rings: [
          [
            [0, 3000],
            [300, 3000],
            [300, 3160],
            [0, 3160],
          ],
        ],
        shape: "gabled",
      },
    ],
  },
  tiles: {
    description:
      "Footprints near the tile's edge. The tile owns [0, extent)²: a footprint only in the buffer is skipped (a neighboring tile draws it), one crossing the edge gets a flat roof whether or not it is cut, and one inside, even touching x = 0, gets its roof.",
    features: [
      ["only in the buffer, east", [8200, 3000, 8300, 3160]],
      ["only in the buffer, north-west", [-120, -100, -20, -10]],
      ["crossing the east edge, not cut", [8100, 3000, 8300, 3160]],
      ["ending on x = extent", [7900, 4000, 8192, 4160]],
      ["starting on x = 0", [0, 4000, 300, 4160]],
      ["starting on y = 0", [3000, 0, 3300, 160]],
      ["ending on y = extent", [3000, 8032, 3300, 8192]],
    ].map(([label, [x0, y0, x1, y1]], index) => ({
      index,
      label,
      rings: [
        [
          [x0, y0],
          [x1, y0],
          [x1, y1],
          [x0, y1],
        ],
      ],
      shape: "gabled",
    })),
  },
  touching: {
    description:
      "Rings touching at a point: a courtyard touching the exterior's corner, two courtyards touching at a corner, and one ring pinched at a vertex. Ears never span the touching point, so courtyards stay open.",
    features: [
      ...["flat", "gabled"].map((shape, i) => ({
        index: i,
        label: `${shape}: courtyard touching the exterior's corner`,
        rings: [
          [
            [1000, 1000],
            [1400, 1000],
            [1400, 1300],
            [1000, 1300],
          ],
          [
            [1000, 1000],
            [1050, 1100],
            [1100, 1050],
          ],
        ],
        shape,
      })),
      {
        index: 2,
        label: "two courtyards touching at a corner",
        rings: [
          [
            [2000, 1000],
            [2400, 1000],
            [2400, 1300],
            [2000, 1300],
          ],
          [
            [2050, 1050],
            [2050, 1150],
            [2150, 1150],
            [2150, 1050],
          ],
          [
            [2150, 1150],
            [2150, 1250],
            [2250, 1250],
            [2250, 1150],
          ],
        ],
        shape: "flat",
      },
      ...["flat", "gabled", "hipped", "pyramidal"].map((shape, i) => ({
        index: 3 + i,
        label: `${shape}: two squares as one ring, pinched at a vertex`,
        rings: [
          [
            [3000, 1000],
            [3100, 1000],
            [3100, 1100],
            [3200, 1100],
            [3200, 1200],
            [3100, 1200],
            [3100, 1100],
            [3000, 1100],
          ],
        ],
        shape,
      })),
    ],
  },
  robust: {
    description:
      "Found by fuzzing: a hip running exactly through a reflex corner, and thin footprints where a break line runs along a triangle edge. Points within 1e-9 (in n) of a break line count as on it, so no crossing is made at a rounding-error place or divides by zero.",
    features: [
      {
        label: "hipped U whose hip passes through the inner corner",
        rings: [
          [
            [963, 2333],
            [1239, 2333],
            [1239, 2038],
            [1177, 2038],
            [1177, 2271],
            [1025, 2271],
            [1025, 2038],
            [963, 2038],
          ],
        ],
        shape: "hipped",
      },
      {
        label: "quadruple_saltbox on a thin L",
        rings: [
          [
            [1235, 5466],
            [1337, 5466],
            [1337, 5461],
            [1240, 5461],
            [1240, 5439],
            [1235, 5439],
          ],
        ],
        shape: "quadruple_saltbox",
      },
      {
        label: "quadruple_saltbox on a thin U",
        rings: [
          [
            [5996, 2628],
            [6020, 2628],
            [6020, 2828],
            [6030, 2828],
            [6030, 2628],
            [6054, 2628],
            [6054, 2852],
            [5996, 2852],
          ],
        ],
        shape: "quadruple_saltbox",
      },
      {
        label: "quadruple_saltbox across toward 200° on an L",
        rings: [
          [
            [1014, 1947],
            [1152, 1947],
            [1152, 2195],
            [1299, 2195],
            [1299, 2333],
            [1014, 2333],
          ],
        ],
        shape: "quadruple_saltbox",
        orientation: "across",
        direction: 200,
      },
    ].map((feature, index) => ({ index, ...feature })),
  },
  degenerate: {
    description:
      "Rings that need cleanup: repeated, closing, collinear and spike points are dropped; a zero-area ring and a tiny triangle produce nothing; a strip thinner than 2 units gets a flat roof; unknown values fall back to flat and along.",
    features: [
      {
        index: 0,
        label: "repeats, collinear points, a spike, closed",
        rings: [
          [
            [1000, 1000],
            [1000, 1000],
            [1150, 1000],
            [1300, 1000],
            [1300, 1080],
            [1400, 1080],
            [1300, 1080],
            [1300, 1160],
            [1150, 1161],
            [1000, 1160],
            [1000, 1000],
          ],
        ],
        shape: "gabled",
      },
      {
        index: 1,
        label: "zero area",
        rings: [
          [
            [1000, 1000],
            [1100, 1000],
            [1200, 1000],
          ],
        ],
        shape: "gabled",
      },
      {
        index: 2,
        label: "tiny triangle",
        rings: [
          [
            [1000, 1000],
            [1001, 1000],
            [1000, 1001],
          ],
        ],
        shape: "hipped",
      },
      {
        index: 3,
        label: "a strip 1 unit wide",
        rings: [
          [
            [1000, 1000],
            [1400, 1000],
            [1400, 1001],
            [1000, 1001],
          ],
        ],
        shape: "gabled",
      },
      {
        index: 4,
        label: "unknown shape and orientation",
        rings: [rectangle],
        shape: "sawtooth",
        orientation: "diagonal",
      },
      {
        index: 5,
        label:
          "one ring in reversed winding: the first ring decides, so an exterior",
        rings: [
          [
            [1000, 1000],
            [1000, 1100],
            [1100, 1100],
            [1100, 1000],
          ],
        ],
        shape: "gabled",
      },
    ],
  },
  multipolygon: {
    description:
      "Reversed winding (the first ring decides which rings are exteriors) and a feature with two buildings, one with a hole.",
    features: [
      {
        index: 0,
        label: "rectangle, reversed winding",
        rings: [[...rectangle].reverse()],
        shape: "hipped",
      },
      {
        index: 1,
        label: "two buildings",
        rings: [
          [
            [2000, 2000],
            [2300, 2000],
            [2300, 2160],
            [2000, 2160],
          ],
          [
            [2400, 2000],
            [2800, 2000],
            [2800, 2300],
            [2400, 2300],
          ],
          [
            [2500, 2100],
            [2500, 2200],
            [2700, 2200],
            [2700, 2100],
          ],
        ],
        shape: "gabled",
      },
    ],
  },
  segments: {
    description:
      "Enough domes on a 32-gon to overflow one 16-bit segment; a mesh that does not fit continues in a new segment.",
    features: [
      {
        index: 0,
        label: "dome on a 32-gon, 160 times",
        rings: [polygon(32, 300, [4000, 4000])],
        shape: "dome",
        repeat: 160,
      },
    ],
  },
};

const round = (value, digits) => Number(value.toPrecision(digits));

function rounded(expected) {
  return {
    ...expected,
    summaries: expected.summaries.map((s) => ({
      vertices: s.vertices,
      triangles: s.triangles,
      sum_pos: s.sum_pos.map((v) => round(v, 12)),
      sum_roof: s.sum_roof.map((v) => round(v, 12)),
      weighted: round(s.weighted, 12),
      moment: s.moment,
    })),
    ...(expected.positions && {
      positions: expected.positions.map((p) => p.map((v) => round(v, 9))),
      roofs: expected.roofs.map((p) => p.map((v) => round(v, 9))),
    }),
  };
}

for (const [name, { description, features, full = false }] of Object.entries(
  fixtures,
)) {
  const layout = layOut(EXTENT, features);
  const fixture = {
    description,
    extent: EXTENT,
    features: features.map(({ label, ...feature }) => ({ label, ...feature })),
    expected: rounded(expectedOutput(layout, full)),
  };
  writeFileSync(join(here, `${name}.json`), `${JSON.stringify(fixture)}\n`);
  console.log(
    `${name}.json: ${features.length} features, ${layout.vertexCount} vertices, ${layout.segments.length} segments`,
  );
}
