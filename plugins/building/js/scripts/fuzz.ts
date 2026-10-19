// Lays out random footprints with every roof shape, orientation and a
// random direction, and checks the invariants the shaders rely on: n in
// [0, 1], finite values, unit wall normals, outward walls, roofs facing up,
// planar triangles for piecewise-linear shapes and a closed surface. Each
// footprint is also laid out as a copy moved by ±extent, which must build
// the same geometry, and cut along an axis-aligned line as a source clips
// it, which must draw roofless and keep the invariants. It also
// triangulates random courtyards that touch each other and the exterior at
// points, and checks that the triangles cover exactly the footprint. A
// tool for hunting robustness bugs; the fixtures and unit tests are the
// regression suite.
//
//   node plugins/building/js/scripts/fuzz.ts [seed] [iterations]
//
// Prints each failing case (rings and layout values, ready to paste into a
// fixture) and exits with status 1 when any case fails. Cracks narrower than
// 0.05 tile units and float32 rounding of n are tolerated.

import { triangles } from "../src/fixture.ts";
import {
  classifyRings,
  isClipEdge,
  type Point,
  signedArea2,
  tileBounds,
} from "../src/footprint.ts";
import {
  BuildingLayout,
  type LayoutValues,
  MAX_SEGMENT_VERTICES,
  ROOF,
  type Vertex,
  WALL_BOTTOM,
  WALL_TOP,
} from "../src/layout.ts";
import { ROOF_SHAPES } from "../src/spec.ts";
import { triangulate } from "../src/triangulate.ts";

type P = [number, number];

const EXTENT = 8192;
const SMOOTH = new Set(["round", "round_gabled", "cone", "dome", "onion"]);
const DIRECTIONS = [0, 30, 45, 90, 135, 180, 200, 225, 270, 315, 360];
/** Open edges shorter than this, in tile units, are rounding cracks. */
const CRACK = 0.05;

const isWall = (v: Vertex): boolean =>
  v.kind === WALL_BOTTOM || v.kind === WALL_TOP;

/** Every invariant the layout breaks, as messages. */
function problems(layout: BuildingLayout, shape: string): string[] {
  const out = new Set<string>();
  const vertices = Array.from({ length: layout.vertexCount }, (_, i) =>
    layout.vertex(i),
  );
  for (const s of layout.segments)
    if (s.vertexLength > MAX_SEGMENT_VERTICES) out.add("segment too long");
  for (const v of vertices) {
    if (![v.x, v.y, v.run, v.n, v.gx, v.gy].every(Number.isFinite))
      out.add("non-finite vertex");
    else if (!(v.n >= 0 && v.n <= 1)) out.add(`n out of range: ${v.n}`);
    if (isWall(v) && Math.abs(Math.hypot(v.gx, v.gy) - 1) > 1e-5)
      out.add("wall normal not unit");
  }
  // Coarse keys: facets meeting at a point compute it a few ulps apart.
  const key = (v: Vertex): string =>
    `${Math.round(v.x * 10)},${Math.round(v.y * 10)},${Math.round(v.n * 300)}`;
  const edges = new Map<string, number>();
  const ends = new Map<string, [Vertex, Vertex]>();
  const addEdge = (a: Vertex, b: Vertex): void => {
    if (key(a) === key(b)) return;
    const forward = `${key(a)}>${key(b)}`;
    const backward = `${key(b)}>${key(a)}`;
    const reverse = edges.get(backward) ?? 0;
    if (reverse > 0) edges.set(backward, reverse - 1);
    else {
      edges.set(forward, (edges.get(forward) ?? 0) + 1);
      ends.set(forward, [a, b]);
    }
  };
  for (const tri of triangles(layout)) {
    const [a, b, c] = tri.map((i) => vertices[i]!) as [Vertex, Vertex, Vertex];
    if (isWall(a)) {
      const z = (v: Vertex): number => (v.kind === WALL_BOTTOM ? 0 : 1 + v.n);
      const u = [b.x - a.x, b.y - a.y, z(b) - z(a)] as const;
      const w = [c.x - a.x, c.y - a.y, z(c) - z(a)] as const;
      const nx = u[1] * w[2] - u[2] * w[1];
      const ny = u[2] * w[0] - u[0] * w[2];
      if (nx * a.gx + ny * a.gy >= 0) out.add("wall faces inward");
      const tops = [a, b, c].filter((v) => v.kind === WALL_TOP);
      if (tops.length === 2) {
        const i = [a, b, c].findIndex((v) => v.kind !== WALL_TOP);
        const [p, q] = (
          [
            [b, c],
            [c, a],
            [a, b],
          ] as const
        )[i]!;
        addEdge(p, q);
      }
      continue;
    }
    const area2 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    // The layout skips slivers that flip in float32 in the footprint's own
    // frame, so every copy keeps the same triangles; at the tile position
    // one thinner than float32's rounding may still flip.
    const longest = Math.max(
      Math.hypot(b.x - a.x, b.y - a.y),
      Math.hypot(c.x - b.x, c.y - b.y),
      Math.hypot(a.x - c.x, a.y - c.y),
    );
    const sliver = Math.abs(area2) <= 2 ** -9 * longest;
    if (a.kind === ROOF && !(area2 < 0) && !sliver)
      out.add("roof triangle faces down");
    if (!SMOOTH.has(shape)) {
      for (const v of [b, c]) {
        const predicted = a.n + a.gx * (v.x - a.x) + a.gy * (v.y - a.y);
        // float32 positions near x = 8192 are 0.0005 units apart.
        if (Math.abs(predicted - v.n) > 2e-4 + 2e-3 * Math.hypot(a.gx, a.gy))
          out.add("triangle not planar");
      }
    }
    addEdge(a, b);
    addEdge(b, c);
    addEdge(c, a);
  }
  for (const [edge, count] of edges) {
    if (count === 0) continue;
    const [a, b] = ends.get(edge)!;
    const onCut = isClipEdge(a, b, layout.extent, layout.bounds);
    if ((!onCut || isWall(a)) && Math.hypot(a.x - b.x, a.y - b.y) > CRACK)
      out.add(`open edge (${a.x}, ${a.y}) → (${b.x}, ${b.y})`);
  }
  return [...out];
}

/** mulberry32. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A star-shaped polygon around a random center. */
function star(r: () => number): P[] {
  const count = 3 + Math.floor(r() * 12);
  const cx = 500 + r() * 7000;
  const cy = 500 + r() * 7000;
  const radius = 2 + r() * 400;
  return Array.from({ length: count }, () => r() * 2 * Math.PI)
    .sort((a, b) => a - b)
    .map((a): P => {
      const d = radius * (0.3 + 0.7 * r());
      return [
        Math.round(cx + d * Math.cos(a)),
        Math.round(cy + d * Math.sin(a)),
      ];
    });
}

/** An L, U, T or comb with arms from 1 unit thick. */
function orthogonal(r: () => number): P[] {
  const x = 500 + Math.floor(r() * 6000);
  const y = 500 + Math.floor(r() * 6000);
  const w = 3 + Math.floor(r() * 400);
  const h = 3 + Math.floor(r() * 400);
  const t = 1 + Math.floor(r() * Math.max(1, Math.min(w, h) / 2));
  switch (Math.floor(r() * 4)) {
    case 0:
      return [
        [x, y],
        [x + t, y],
        [x + t, y + h - t],
        [x + w, y + h - t],
        [x + w, y + h],
        [x, y + h],
      ];
    case 1:
      return [
        [x, y],
        [x + t, y],
        [x + t, y + h - t],
        [x + w - t, y + h - t],
        [x + w - t, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ];
    case 2: {
      const m = Math.round(x + w / 2);
      return [
        [x, y],
        [x + w, y],
        [x + w, y + t],
        [m + t, y + t],
        [m + t, y + h],
        [m, y + h],
        [m, y + t],
        [x, y + t],
      ];
    }
    default: {
      const teeth = 2 + Math.floor(r() * 5);
      const tooth = Math.max(1, Math.floor(w / (2 * teeth)));
      const points: P[] = [[x, y + h]];
      for (let i = 0; i < teeth; i++) {
        points.push([x + 2 * i * tooth, y], [x + (2 * i + 1) * tooth, y]);
        points.push([x + (2 * i + 1) * tooth, y + h - t]);
        points.push([x + (2 * i + 2) * tooth, y + h - t]);
      }
      points.push([x + 2 * teeth * tooth, y + h]);
      return points;
    }
  }
}

function rotate(points: P[], degrees: number): P[] {
  const a = (degrees * Math.PI) / 180;
  const [cx, cy] = points[0]!;
  return points.map(([x, y]) => [
    Math.round(cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a)),
    Math.round(cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a)),
  ]);
}

function orient(a: P, b: P, c: P): number {
  return Math.sign(
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
  );
}

function onSegment(a: P, b: P, p: P): boolean {
  return (
    orient(a, b, p) === 0 &&
    Math.min(a[0], b[0]) <= p[0] &&
    p[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= p[1] &&
    p[1] <= Math.max(a[1], b[1])
  );
}

/** Whether a ring is simple: rounding can make random rings cross. */
function simple(ring: P[]): boolean {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = ring[j]!;
      const d = ring[(j + 1) % n]!;
      if (
        orient(a, b, c) * orient(a, b, d) < 0 &&
        orient(c, d, a) * orient(c, d, b) < 0
      )
        return false;
      if (
        onSegment(a, b, c) ||
        onSegment(a, b, d) ||
        onSegment(c, d, a) ||
        onSegment(c, d, b)
      )
        return false;
    }
  }
  return true;
}

const toPoints = (ring: P[]): Point[] => ring.map(([x, y]) => ({ x, y }));

/** Differences between a layout and a copy laid out `d` tile units away. */
function copyProblems(
  base: BuildingLayout,
  copy: BuildingLayout,
  [dx, dy]: P,
): string[] {
  if (
    copy.vertexCount !== base.vertexCount ||
    copy.indexCount !== base.indexCount
  )
    return ["copy has other vertices"];
  const a = base.indices();
  const b = copy.indices();
  for (let i = 0; i < a.length; i++)
    if (a[i] !== b[i]) return ["copy has other triangles"];
  for (let i = 0; i < base.vertexCount; i++) {
    const p = base.exactVertex(i);
    const q = copy.exactVertex(i);
    if (Math.abs(q.x - dx - p.x) > 1e-9 || Math.abs(q.y - dy - p.y) > 1e-9)
      return ["copy moved differently"];
    if (
      q.run !== p.run ||
      q.n !== p.n ||
      q.kind !== p.kind ||
      q.gx !== p.gx ||
      q.gy !== p.gy
    )
      return ["copy has another roof"];
  }
  return [];
}

/**
 * The ring cut to x >= c, as a source clips it (crossings rounded to the
 * tile's integer grid, the ring closed), then moved so the cut lies at
 * x = -256: a buffer edge.
 */
function cutRing(ring: P[], c: number): P[] {
  const out: P[] = [];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    if (p[0] >= c) out.push(p);
    if (p[0] >= c !== q[0] >= c) {
      const t = (c - p[0]) / (q[0] - p[0]);
      out.push([c, Math.round(p[1] + t * (q[1] - p[1]))]);
    }
  }
  if (out.length > 0) out.push(out[0]!);
  return out.map(([x, y]) => [x - c - 256, y]);
}

/** `rc` places copies and cuts, so a seed's footprints do not depend on them. */
function fuzzLayouts(
  r: () => number,
  rc: () => number,
  iterations: number,
): string[] {
  const failures: string[] = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    let ring = r() < 0.5 ? star(r) : orthogonal(r);
    if (r() < 0.5) ring = rotate(ring, r() * 360);
    if (r() < 0.3) ring.reverse();
    if (r() < 0.2) {
      // A repeated point and a (nearly) collinear one.
      const i = Math.floor(r() * ring.length);
      const p = ring[i]!;
      const q = ring[(i + 1) % ring.length]!;
      ring.splice(i + 1, 0, [
        Math.round((p[0] + q[0]) / 2),
        Math.round((p[1] + q[1]) / 2),
      ]);
      ring.splice(i, 0, p);
    }
    const distinct = ring.filter((p, i) => {
      const q = ring[(i + 1) % ring.length]!;
      return p[0] !== q[0] || p[1] !== q[1];
    });
    if (!simple(distinct)) continue;
    for (const shape of ROOF_SHAPES)
      for (const orientation of ["along", "across"])
        for (const direction of [
          -1,
          DIRECTIONS[Math.floor(r() * DIRECTIONS.length)]!,
        ]) {
          const values: LayoutValues = { shape, orientation, direction };
          const layout = new BuildingLayout(EXTENT);
          let found: string[];
          try {
            layout.addFeature([toPoints(ring)], 0, values);
            found = problems(layout, shape);
            // A whole copy in a neighboring tile's buffer.
            const d: P = [
              EXTENT * (Math.floor(rc() * 3) - 1),
              EXTENT * (Math.floor(rc() * 3) - 1),
            ];
            const copy = new BuildingLayout(EXTENT);
            copy.addFeature(
              [toPoints(ring.map(([x, y]) => [x + d[0], y + d[1]]))],
              0,
              values,
            );
            found.push(...copyProblems(layout, copy, d));
            // A copy the source cut, alone in its tile.
            const xs = ring.map((p) => p[0]);
            const lo = Math.min(...xs);
            const hi = Math.max(...xs);
            const c = Math.round(lo + (0.2 + 0.6 * rc()) * (hi - lo));
            // A line through the westmost point only touches the footprint:
            // the source keeps it whole.
            if (c > lo) {
              const cut = cutRing(ring, c);
              const rings = [toPoints(cut)];
              const piece = new BuildingLayout(EXTENT, tileBounds([rings]));
              piece.addFeature(rings, 0, values);
              found.push(...problems(piece, shape).map((m) => `cut: ${m}`));
              if (shape !== "flat" && shape !== "many")
                for (let i = 0; i < piece.vertexCount; i++)
                  if (piece.vertex(i).n !== 0) {
                    found.push(`cut: not roofless ${JSON.stringify([cut])}`);
                    break;
                  }
            }
          } catch (error) {
            found = [`threw ${String(error)}`];
          }
          if (found.length > 0)
            failures.push(
              `${JSON.stringify(values)} ${JSON.stringify([ring])}\n  ${found.slice(0, 3).join("\n  ")}`,
            );
        }
  }
  return failures;
}

/**
 * Courtyards as diamonds on a grid, touching each other and the exterior
 * at points. Only configurations whose touch graph has no cycle are valid
 * (a cycle encloses a piece of the floor), so only those are tried.
 */
function fuzzTouchingCourtyards(r: () => number, iterations: number): string[] {
  const failures: string[] = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    const nx = 1 + Math.floor(r() * 6);
    const ny = 1 + Math.floor(r() * 6);
    const s = 20 * (1 + Math.floor(r() * 3));
    const [x0, y0] = [1000, 1000];
    const rings: P[][] = [
      [
        [x0, y0],
        [x0 + nx * s, y0],
        [x0 + nx * s, y0 + ny * s],
        [x0, y0 + ny * s],
      ],
    ];
    const parent = new Map<number, number>([[-1, -1]]);
    const find = (k: number): number => {
      while (parent.get(k) !== k) k = parent.get(k)!;
      return k;
    };
    let courtyards = 0;
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < ny; j++) {
        if (r() < 0.5) continue;
        const edges =
          Number(i === 0) +
          Number(j === 0) +
          Number(i === nx - 1) +
          Number(j === ny - 1);
        if (edges > 1) continue;
        const touches = edges === 1 ? [-1] : [];
        for (const [di, dj] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ] as const) {
          const other = (i + di) * 100 + (j + dj);
          if (parent.has(other)) touches.push(other);
        }
        const roots = touches.map(find);
        if (new Set(roots).size !== roots.length) continue;
        const id = i * 100 + j;
        parent.set(id, id);
        for (const root of roots) parent.set(root, id);
        const [cx, cy, h] = [x0 + i * s + s / 2, y0 + j * s + s / 2, s / 2];
        rings.push([
          [cx, cy - h],
          [cx - h, cy],
          [cx, cy + h],
          [cx + h, cy],
        ]);
        courtyards++;
      }
    const [polygon] = classifyRings(rings.map(toPoints), EXTENT);
    const { points, triangles: indices } = triangulate(
      polygon!.outer,
      polygon!.holes,
    );
    let area2 = 0;
    let flipped = 0;
    for (let t = 0; t < indices.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => points[indices[t + k]!]!) as [
        Point,
        Point,
        Point,
      ];
      const twice = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (twice <= 0) flipped++;
      area2 += twice;
    }
    let expected = signedArea2(polygon!.outer);
    for (const hole of polygon!.holes) expected += signedArea2(hole);
    if (flipped > 0 || area2 !== expected)
      failures.push(
        `${courtyards} courtyards: triangles cover ${area2 / 2}, footprint ${expected / 2}\n  ${JSON.stringify(rings)}`,
      );
  }
  return failures;
}

const seed = Number(process.argv[2] ?? 1);
const iterations = Number(process.argv[3] ?? 300);
const r = random(seed);
const layouts = fuzzLayouts(r, random(seed ^ 0x9e3779b9), iterations);
const courtyards = fuzzTouchingCourtyards(r, 10 * iterations);
for (const failure of [...layouts, ...courtyards].slice(0, 20))
  console.log(failure);
console.log(
  `seed ${seed}: ${layouts.length} failing layouts, ${courtyards.length} of ${10 * iterations} courtyard triangulations failing`,
);
process.exitCode = layouts.length + courtyards.length > 0 ? 1 : 0;
