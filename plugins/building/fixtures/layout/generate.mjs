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

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expectedOutput, layOut } from "../../js/src/fixture.ts";
import { ROOF_SHAPES } from "../../js/src/spec.ts";

const here = dirname(fileURLToPath(import.meta.url));
const EXTENT = 8192;

/** Frame shapes, plus skeleton shapes to check that orientation is ignored. */
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
    for (const shape of ROOF_SHAPES.filter((shape) => shape !== "complex"))
      add(shape, "along", -1, `${shape}`);
  if (options.across !== false)
    for (const shape of FRAME_SHAPES)
      add(shape, "across", -1, `${shape} across`);
  if (options.directions !== false)
    for (const [shape, direction] of DIRECTIONS)
      add(shape, "along", direction, `${shape} toward ${direction}°`);
  return features;
}

const fixtures = {
  comb: {
    description:
      "Fuzz seed 2: a comb collapse coincides with the mansard/gambrel slope break. Both bands must retain collinear event vertices so the roof stays closed.",
    features: ["gambrel", "mansard"].flatMap((shape, i) =>
      [
        ["along", -1],
        ["along", 0],
        ["across", -1],
        ["across", 90],
      ].map(([orientation, direction], j) => ({
        index: i * 4 + j,
        label: `${shape} ${orientation} ${direction}`,
        rings: [
          [
            [1877, 4210],
            [1877, 4126],
            [1916, 4126],
            [1916, 4197],
            [1955, 4197],
            [1955, 4126],
            [1994, 4126],
            [1994, 4197],
            [2033, 4197],
            [2033, 4126],
            [2072, 4126],
            [2072, 4197],
            [2111, 4197],
            [2111, 4126],
            [2150, 4126],
            [2150, 4197],
            [2189, 4197],
            [2189, 4126],
            [2228, 4126],
            [2228, 4197],
            [2267, 4197],
            [2267, 4210],
          ],
        ],
        shape,
        orientation,
        direction,
      })),
    ),
  },
  skeleton: {
    description:
      "Straight-skeleton event regressions, including stationary gable ends, simultaneous collapses and touching courtyard boundaries.",
    features: JSON.parse(
      readFileSync(join(here, "../skeleton/cases.json"), "utf8"),
    ).flatMap((entry, i) =>
      ["hipped", "mansard", "gabled", "gambrel"].map((shape, j) => ({
        index: i * 4 + j,
        label: `${entry.name}: ${shape}`,
        rings: entry.rings.map((ring) =>
          ring.map(([x, y]) => [x + 1000, y + 1000]),
        ),
        shape,
        orientation: "along",
        direction: -1,
      })),
    ),
  },
  invalides: {
    description:
      "The three Hotel des Invalides courtyard wings (OSM snapshot 2026-10-01), projected onto the zoom-15 grid. Hipped, mansard, gabled and gambrel roofs must cover the wings and leave all courtyards open.",
    features: JSON.parse(
      readFileSync(join(here, "../skeleton/invalides.geojson"), "utf8"),
    ).features.flatMap((feature, i) => {
      const rings = feature.geometry.coordinates.map((ring) =>
        ring
          .map(([lon, lat]) => [
            Math.round(((lon + 180) / 360) * 2 ** 15 * EXTENT),
            Math.round(
              ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) /
                2) *
                2 ** 15 *
                EXTENT,
            ),
          ])
          .reverse(),
      );
      const minX = Math.min(...rings[0].map((p) => p[0]));
      const minY = Math.min(...rings[0].map((p) => p[1]));
      const local = rings.map((ring) =>
        ring.map(([x, y]) => [x - minX + 1000, y - minY + 1000]),
      );
      return ["hipped", "mansard", "gabled", "gambrel"].map((shape, j) => ({
        index: i * 4 + j,
        label: `${feature.properties.osm} ${shape}`,
        rings: local,
        shape,
      }));
    }),
  },
  profiles: {
    description:
      "Unequal L arms: the 40-unit arm disappears before the global cap time (0.3 of the maximum run). Caps and 15-degree arches share event and band vertices with walls, recorded vertex by vertex.",
    full: true,
    features: [
      "double_saltbox",
      "quadruple_saltbox",
      "round",
      "round_gabled",
    ].map((shape, index) => ({
      index,
      shape,
      rings: [
        [
          [1000, 1000],
          [1040, 1000],
          [1040, 1200],
          [1400, 1200],
          [1400, 1360],
          [1000, 1360],
        ],
      ],
    })),
  },
  "rectangle-full": {
    description:
      "A 300 × 160 axis-aligned rectangle with every roof shape, recorded vertex by vertex.",
    features: matrix([rectangle], { across: false, directions: false }),
    full: true,
  },
  rectangle: {
    description:
      "The same rectangle across and with set directions; skillion follows the exact direction, skeleton shapes ignore directions and the other shapes turn their frame to the nearest axis (135° is a tie, which picks the shorter side's axis).",
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
      "An L: gabled, gambrel, capped and barrel roofs follow its arms; half-hipped and saltbox span the bounding rectangle. Cone, dome and onion sit on circular bases with terraces; pyramidal stays flat (the center is outside the kernel).",
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
  "t-shape": {
    description:
      "A T with three gable ends and two valleys; skeleton arms ignore the frame orientation and direction.",
    features: matrix([
      [
        [1000, 1000],
        [1400, 1000],
        [1400, 1120],
        [1260, 1120],
        [1260, 1320],
        [1140, 1320],
        [1140, 1120],
        [1000, 1120],
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
      "A courtyard: skeleton roofs follow the eaves, frame roofs clip around the hole, cone, dome and onion use inscribed circles with terraces, pyramidal stays flat. Courtyard walls face into it and follow the roof profile.",
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
      "Tile-clipped footprints, laid out as one tile whose features reach x = -128, x = extent + 64 and y = extent + 128: the source's cut lines. A ring edge on one of them, outside the tile, is a cut (so is a point repeated there, where the cut collapsed): it gets no wall, and the copy draws roofless (walls to the eaves and a lid at n = 0, with the piece's own run), or flat when its shape is flat or its courtyard shape is unsupported. Axis-aligned walls elsewhere, an edge on x = 0 and footprints crossing the tile's edge uncut get their whole roofs.",
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
      {
        index: 6,
        label: "skillion down 200°, cut at x = -128",
        rings: [
          [
            [-128, 4000],
            [180, 4000],
            [180, 4240],
            [-128, 4240],
          ],
        ],
        shape: "skillion",
        direction: 200,
      },
      {
        index: 7,
        label: "gabled with a courtyard, cut at x = -128",
        rings: [
          [
            [-128, 4600],
            [300, 4600],
            [300, 4900],
            [-128, 4900],
          ],
          [
            [50, 4700],
            [50, 4800],
            [150, 4800],
            [150, 4700],
          ],
        ],
        shape: "gabled",
      },
      {
        index: 8,
        label: "gabled in the west buffer, axis-aligned but not on a cut line",
        rings: [
          [
            [-100, 2400],
            [-20, 2400],
            [-20, 2560],
            [-100, 2560],
          ],
        ],
        shape: "gabled",
      },
      {
        index: 9,
        label: "hipped crossing the east edge, not cut",
        rings: [
          [
            [8100, 3000],
            [8240, 3000],
            [8240, 3160],
            [8100, 3160],
          ],
        ],
        shape: "hipped",
      },
      {
        index: 10,
        label: "hipped cut at x = -128 in two collinear pieces",
        rings: [
          [
            [-128, 5200],
            [160, 5200],
            [160, 5400],
            [-128, 5400],
            [-128, 5300],
          ],
        ],
        shape: "hipped",
      },
      {
        index: 11,
        label:
          "gabled whose tip beyond x = -128 was clipped away, both crossings rounded to one repeated point",
        rings: [
          [
            [-128, 5700],
            [-128, 5700],
            [-60, 5600],
            [200, 5600],
            [200, 5800],
            [-60, 5800],
          ],
        ],
        shape: "gabled",
      },
    ],
  },
  tiles: {
    description:
      "Footprints near the tile's edge, none of them cut. Every tile draws every copy it has with its whole roof, buffer copies included, as core fill-extrusion draws its buffer copies. Two turned footprints further out keep the tile's bounds beyond the others' walls, so their axis-aligned walls in the buffer are not taken for cuts.",
    features: [
      ["only in the buffer, east", [8200, 3000, 8300, 3160]],
      ["only in the buffer, north-west", [-120, -100, -20, -10]],
      ["crossing the east edge", [8100, 3000, 8300, 3160]],
      ["ending on x = extent", [7900, 4000, 8192, 4160]],
      ["starting on x = 0", [0, 4000, 300, 4160]],
      ["starting on y = 0", [3000, 0, 3300, 160]],
      ["ending on y = extent", [3000, 8032, 3300, 8192]],
    ]
      .map(([label, [x0, y0, x1, y1]], index) => ({
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
      }))
      .concat(
        [
          ["turned, east of the others", [8400, 5000]],
          ["turned, north-west of the others", [-200, -200]],
        ].map(([label, [cx, cy]], i) => ({
          index: 7 + i,
          label,
          rings: [
            [
              [cx - 60, cy],
              [cx, cy - 60],
              [cx + 60, cy],
              [cx, cy + 60],
            ],
          ],
          shape: "gabled",
        })),
      ),
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
      // Keep the reported skeleton failures in the shared closed-mesh suite.
      ...[
        {
          label: "seed 2: collapsed comb face",
          rings: [
            [
              [723, 4889],
              [591, 4754],
              [603, 4742],
              [603, 4742],
              [662, 4802],
              [720, 4861],
              [732, 4850],
              [615, 4730],
              [628, 4718],
              [744, 4838],
              [756, 4826],
              [640, 4706],
              [652, 4694],
              [769, 4814],
              [781, 4802],
              [664, 4682],
              [676, 4671],
              [793, 4790],
              [805, 4778],
              [689, 4659],
              [701, 4647],
              [817, 4766],
              [829, 4755],
              [713, 4635],
              [725, 4623],
              [842, 4743],
              [854, 4731],
              [869, 4747],
            ],
          ],
        },
        {
          label: "seed 3: eight-vertex stationary gable",
          rings: [
            [
              [5936, 6519],
              [6075, 6602],
              [5976, 6770],
              [6085, 6834],
              [6184, 6666],
              [6215, 6684],
              [6279, 6576],
              [6000, 6411],
            ],
          ],
        },
        {
          label: "seed 3: near-coincident wall events",
          rings: [
            [
              [1223, 4367],
              [1077, 4551],
              [1032, 4515],
              [1068, 4469],
              [842, 4289],
              [878, 4244],
              [1104, 4423],
              [1178, 4331],
            ],
          ],
        },
        {
          label: "seed 3: barrel band touches comb event",
          rings: [
            [
              [4331, 4067],
              [4331, 4063],
              [4363, 4063],
              [4363, 4065],
              [4395, 4065],
              [4395, 4063],
              [4427, 4063],
              [4427, 4065],
              [4459, 4065],
              [4459, 4063],
              [4491, 4063],
              [4491, 4065],
              [4523, 4065],
              [4523, 4063],
              [4555, 4063],
              [4555, 4065],
              [4587, 4065],
              [4587, 4063],
              [4619, 4063],
              [4619, 4065],
              [4651, 4065],
              [4651, 4067],
            ],
          ],
        },
      ].flatMap(({ label, rings }) =>
        [
          "gabled",
          "gambrel",
          "double_saltbox",
          "quadruple_saltbox",
          "round",
          "round_gabled",
        ].map((shape) => ({ label: `${label}: ${shape}`, rings, shape })),
      ),
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

// Real ridge/hip graph and small cases that isolate graph recovery and fallbacks.
const tile = { z: 16, x: 34748, y: 22254 };
const scale = EXTENT * 2 ** tile.z;
const project = ([lon, lat]) => {
  const sin = Math.sin((lat * Math.PI) / 180);
  return [
    Math.round((lon / 360 + 0.5) * scale) - tile.x * EXTENT,
    Math.round(
      (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
    ) -
      tile.y * EXTENT,
  ];
};
const geographic = ([x, y, n]) => [
  ((x + tile.x * EXTENT) / scale) * 360 - 180,
  (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + tile.y * EXTENT)) / scale))) *
    180) /
    Math.PI,
  n,
];
const graph = (vertices, edges) =>
  JSON.stringify({ vertices: vertices.map(geographic), edges });
const real = JSON.parse(
  readFileSync(join(here, "../../examples/osm/buildings.geojson"), "utf8"),
).features.find((f) => f.id === 36941229);
const realRings = real.geometry.coordinates.map((r) =>
  r.map(project).reverse(),
);
const ridge = graph(
  [
    [1000, 1080, 1],
    [1300, 1080, 1],
  ],
  [[0, 1]],
);
const cases = [
  {
    label: "Bamberg way/36941229",
    rings: realRings,
    lines: JSON.stringify(real.properties.roof_lines),
  },
  { label: "ridge reaching gable walls", rings: [rectangle], lines: ridge },
  {
    label: "edge apex at mapped relative height",
    rings: [rectangle],
    lines: graph(
      [
        [1000, 1000, 0],
        [1300, 1000, 0],
        [1300, 1160, 0],
        [1000, 1160, 0],
        [1130, 1070, 0.75],
      ],
      [
        [0, 4],
        [1, 4],
        [2, 4],
        [3, 4],
      ],
    ),
  },
  {
    label: "isolated apex",
    rings: [rectangle],
    lines: graph([[1130, 1070, 1]], []),
  },
  { label: "missing lines", rings: [rectangle] },
  { label: "malformed JSON", rings: [rectangle], lines: "{" },
  {
    label: "outside footprint",
    rings: [rectangle],
    lines: graph([[900, 900, 1]], []),
  },
  {
    label: "invalid height",
    rings: [rectangle],
    lines: graph([[1100, 1100, 2]], []),
  },
  {
    label: "crossing without a junction",
    rings: [rectangle],
    lines: graph(
      [
        [1000, 1080, 1],
        [1300, 1080, 1],
        [1150, 1000, 0],
        [1150, 1160, 0],
      ],
      [
        [0, 1],
        [2, 3],
      ],
    ),
  },
];
cases.push({
  label: "courtyard with a closed ridge ring",
  rings: [
    [
      [1000, 1000],
      [1400, 1000],
      [1400, 1400],
      [1000, 1400],
    ],
    [
      [1150, 1150],
      [1150, 1250],
      [1250, 1250],
      [1250, 1150],
    ],
  ],
  lines: graph(
    [
      [1075, 1075, 1],
      [1325, 1075, 1],
      [1325, 1325, 1],
      [1075, 1325, 1],
    ],
    [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 0],
    ],
  ),
});

fixtures["roof-lines"] = {
  description:
    "Explicit roof graphs: OSM Bamberg way/36941229, gables, apex heights, invalid input and whole tile copies. Real data © OpenStreetMap contributors, ODbL; see ../../examples/osm/buildings.geojson.LICENSE.txt.",
  full: true,
  features: cases.flatMap((f, i) =>
    [0, 1, -1].map((offset, k) => ({
      ...f,
      index: i * 3 + k,
      shape: "complex",
      tile: { ...tile, x: tile.x - offset },
      rings: f.rings.map((r) => r.map(([x, y]) => [x + offset * EXTENT, y])),
    })),
  ),
};

// Bounds beyond the copies: these two degenerate points emit no geometry.
fixtures["roof-lines"].features.push({
  index: 99,
  label: "tile bounds",
  shape: "flat",
  rings: [
    [
      [-20000, -20000],
      [30000, 30000],
    ],
  ],
});

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
