// Renders every roof shape on a few footprints into an isometric SVG contact
// sheet, straight from the layout's vertex data, as a visual check of the
// shapes, the winding (faces are back-face culled) and the normals (faces
// are shaded from the vertex gradients the shaders will use).
//
//   node plugins/building/js/scripts/contact-sheet.ts [out.svg]
//
// Writes /tmp/building-contact-sheet.svg by default, and a PNG beside it on
// macOS (through Quick Look's qlmanage).

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  BuildingLayout,
  type LayoutValues,
  ROOF_UNDERSIDE,
  WALL_BOTTOM,
  WALL_TOP,
} from "../src/layout.ts";
import { ROOF_SHAPES } from "../src/spec.ts";

type P = [number, number];

/** Tile units per meter at zoom 16 with an 8192 extent. */
const UNITS_PER_METER = 8192 / 611.5;
const HEIGHT = 9;
const ROOF_HEIGHT = 5;

function rotated(points: P[], degrees: number): P[] {
  const r = (degrees * Math.PI) / 180;
  const [cx, cy] = [1000, 1000];
  return points.map(([x, y]) => [
    Math.round(cx + (x - cx) * Math.cos(r) - (y - cy) * Math.sin(r)),
    Math.round(cy + (x - cx) * Math.sin(r) + (y - cy) * Math.cos(r)),
  ]);
}

function circle(n: number, radius: number): P[] {
  return Array.from({ length: n }, (_, i): P => {
    const a = (2 * Math.PI * i) / n;
    return [
      Math.round(1000 + radius * Math.cos(a)),
      Math.round(1000 + radius * Math.sin(a)),
    ];
  });
}

const rectangle: P[] = [
  [880, 940],
  [1120, 940],
  [1120, 1060],
  [880, 1060],
];

const footprints: { label: string; rings: P[][]; values?: LayoutValues }[] = [
  { label: "rectangle", rings: [rectangle] },
  { label: "across", rings: [rectangle], values: { orientation: "across" } },
  {
    label: "direction 200°",
    rings: [rotated(rectangle, 25)],
    values: { direction: 200 },
  },
  {
    label: "L-shape",
    rings: [
      [
        [880, 900],
        [1000, 900],
        [1000, 1000],
        [1120, 1000],
        [1120, 1100],
        [880, 1100],
      ],
    ],
  },
  { label: "16-gon", rings: [circle(16, 100)] },
];

const CELL_W = 230;
const CELL_H = 190;
const LABEL_W = 130;
const HEADER_H = 30;

function render(rings: P[][], values: LayoutValues): string {
  const layout = new BuildingLayout(8192);
  layout.addFeature(
    rings.map((ring) => ring.map(([x, y]) => ({ x, y }))),
    0,
    values,
  );
  const indices = layout.indices();
  const H = HEIGHT * UNITS_PER_METER;
  const R = Math.min(ROOF_HEIGHT, HEIGHT) * UNITS_PER_METER;
  const wallTop = H - R;
  const world = (
    i: number,
  ): { p: [number, number, number]; v: ReturnType<typeof layout.vertex> } => {
    const v = layout.vertex(i);
    const z = v.kind === WALL_BOTTOM ? 0 : wallTop + v.n * R;
    return { p: [v.x - 1000, v.y - 1000, z], v };
  };
  const light = normalize([0.35, 0.8, 0.9]);
  const view: [number, number, number] = [1, 1, 1];
  const faces: { depth: number; path: string; fill: string }[] = [];
  for (const segment of layout.segments) {
    for (let t = 0; t < segment.indexLength; t += 3) {
      const ids = [0, 1, 2].map(
        (k) => segment.vertexOffset + indices[segment.indexOffset + t + k]!,
      );
      const [a, b, c] = ids.map(world) as [
        ReturnType<typeof world>,
        ReturnType<typeof world>,
        ReturnType<typeof world>,
      ];
      // Core's winding: cross(c - a, b - a) points out in tile coordinates.
      const normal = crossProduct(sub(c.p, a.p), sub(b.p, a.p));
      if (dot(normal, view) <= 0) continue;
      // Shade from the vertex data, as a shader would.
      let shade = 0;
      for (const { v } of [a, b, c]) {
        let n: [number, number, number];
        if (v.kind === WALL_BOTTOM || v.kind === WALL_TOP) n = [v.gx, v.gy, 0];
        else {
          n = normalize([-R * v.gx, -R * v.gy, 1]);
          if (v.kind === ROOF_UNDERSIDE) n = [-n[0], -n[1], -n[2]];
        }
        shade += Math.max(0, dot(normalize(n), light)) / 3;
      }
      const wall = a.v.kind <= WALL_TOP;
      const base = wall ? [222, 214, 204] : [196, 74, 64];
      const k = 0.35 + 0.65 * shade;
      const fill = `rgb(${base.map((x) => Math.round(x * k)).join(",")})`;
      const pts = [a, b, c].map(({ p }) => project(p));
      faces.push({
        depth:
          (a.p[0] +
            b.p[0] +
            c.p[0] +
            a.p[1] +
            b.p[1] +
            c.p[1] +
            a.p[2] +
            b.p[2] +
            c.p[2]) /
          3,
        path: `M${pts.map((q) => q.map((x) => x.toFixed(1)).join(",")).join("L")}Z`,
        fill,
      });
    }
  }
  faces.sort((p, q) => p.depth - q.depth);
  return faces
    .map(
      (f) =>
        `<path d="${f.path}" fill="${f.fill}" stroke="${f.fill}" stroke-width="0.4"/>`,
    )
    .join("");
}

const SCALE = 0.55;
function project([x, y, z]: [number, number, number]): [number, number] {
  return [(x - y) * 0.866 * SCALE, ((x + y) * 0.5 - z) * SCALE];
}

function sub(a: number[], b: number[]): [number, number, number] {
  return [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
}
function crossProduct(a: number[], b: number[]): [number, number, number] {
  return [
    a[1]! * b[2]! - a[2]! * b[1]!,
    a[2]! * b[0]! - a[0]! * b[2]!,
    a[0]! * b[1]! - a[1]! * b[0]!,
  ];
}
function dot(a: number[], b: number[]): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}
function normalize(a: number[]): [number, number, number] {
  const l = Math.hypot(a[0]!, a[1]!, a[2]!) || 1;
  return [a[0]! / l, a[1]! / l, a[2]! / l];
}

// Shapes in two columns of blocks, each block a label and one cell per
// footprint, on a square canvas (Quick Look crops thumbnails to a square).
const BLOCK_W = LABEL_W + CELL_W * footprints.length;
const COLUMNS = 2;
const ROWS = Math.ceil(ROOF_SHAPES.length / COLUMNS);
const width = Math.max(BLOCK_W * COLUMNS, HEADER_H + CELL_H * ROWS);
const height = width;
const parts: string[] = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Helvetica, Arial, sans-serif" font-size="13">`,
  `<rect width="${width}" height="${height}" fill="#f7f5f0"/>`,
];
for (let block = 0; block < COLUMNS; block++) {
  footprints.forEach((f, column) => {
    parts.push(
      `<text x="${BLOCK_W * block + LABEL_W + CELL_W * column + CELL_W / 2}" y="20" text-anchor="middle" fill="#333">${f.label}</text>`,
    );
  });
}
ROOF_SHAPES.forEach((shape, index) => {
  const x0 = BLOCK_W * Math.floor(index / ROWS);
  const y = HEADER_H + CELL_H * (index % ROWS);
  parts.push(
    `<text x="${x0 + 10}" y="${y + CELL_H / 2}" fill="#333">${shape}</text>`,
    `<line x1="${x0}" x2="${x0 + BLOCK_W}" y1="${y}" y2="${y}" stroke="#ddd"/>`,
  );
  footprints.forEach((f, column) => {
    const cx = x0 + LABEL_W + CELL_W * column + CELL_W / 2;
    const cy = y + CELL_H / 2 + 30;
    parts.push(
      `<g transform="translate(${cx},${cy})">${render(f.rings, { ...f.values, shape })}</g>`,
    );
  });
});
parts.push("</svg>");

const out = process.argv[2] ?? "/tmp/building-contact-sheet.svg";
writeFileSync(out, parts.join("\n"));
console.log(`wrote ${out}`);
if (process.platform === "darwin") {
  try {
    execFileSync(
      "qlmanage",
      ["-t", "-s", String(width), "-o", dirname(out), out],
      {
        stdio: "ignore",
      },
    );
    console.log(`wrote ${join(dirname(out), `${basename(out)}.png`)}`);
  } catch {
    console.log("qlmanage failed; no PNG");
  }
}
