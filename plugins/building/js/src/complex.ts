// Explicit roof lines; ../../native/src/complex.zig is the twin.
import type { CanonicalTile } from "@maplibre-plugins/paint";

import { cross, type Point, type Polygon } from "./footprint.ts";
import { triangulate } from "./triangulate.ts";

export interface RoofPoint extends Point {
  x: number;
  y: number;
  n: number;
}
export interface ComplexRoof {
  points: RoofPoint[];
  triangles: number[];
  run: number;
}
const EPS = 1e-7;

function along(a: Point, b: Point, p: Point): number {
  return (
    ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) /
    ((b.x - a.x) ** 2 + (b.y - a.y) ** 2)
  );
}
function on(a: Point, b: Point, p: Point): boolean {
  const t = along(a, b, p);
  return t >= -EPS && t <= 1 + EPS && Math.abs(cross(a, b, p)) < EPS;
}
function crosses(a: Point, b: Point, c: Point, d: Point): boolean {
  return (
    cross(a, b, c) * cross(a, b, d) < -EPS &&
    cross(c, d, a) * cross(c, d, b) < -EPS
  );
}

/** Insert vertices, then flip crossed diagonals to recover the mapped constraints. */
export function complexRoof(
  polygon: Polygon,
  text: string,
  tile: CanonicalTile | undefined,
  extent: number,
  origin: Point,
  run: number,
): ComplexRoof | null {
  if (!tile || text.length > 65536) return null;
  let data: { vertices: number[][]; edges: number[][] };
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !data ||
    !Array.isArray(data.vertices) ||
    !Array.isArray(data.edges) ||
    !data.vertices.length ||
    data.vertices.length > 192 ||
    data.edges.length > 576
  )
    return null;
  if (
    polygon.outer.length +
      polygon.holes.reduce((n, ring) => n + ring.length, 0) >
      192 ||
    run < 1
  )
    return null;
  const base = triangulate(polygon.outer, polygon.holes);
  const points: RoofPoint[] = base.points.map((p) => ({ ...p, n: 0 }));
  let triangles = base.triangles;
  const ids: number[] = [];
  const rings = [polygon.outer, ...polygon.holes];
  for (const v of data.vertices) {
    if (
      !Array.isArray(v) ||
      v.length !== 3 ||
      !v.every(Number.isFinite) ||
      Math.abs(v[0]!) > 180 ||
      Math.abs(v[1]!) > 85.051129 ||
      v[2]! < 0 ||
      v[2]! > 1
    )
      return null;
    const scale = extent * 2 ** tile.z;
    const sin = Math.sin((v[1]! * Math.PI) / 180);
    const p: RoofPoint = {
      x: Math.round((v[0]! / 360 + 0.5) * scale) - tile.x * extent - origin.x,
      y:
        Math.round(
          (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
        ) -
        tile.y * extent -
        origin.y,
      n: v[2]!,
    };
    // Cleanup removes nearly collinear eave nodes; snap them back to the boundary.
    let nearest = 0.75 ** 2;
    let snapped: Point = p;
    for (const ring of rings)
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!,
          b = ring[(i + 1) % ring.length]!;
        const t = Math.max(0, Math.min(1, along(a, b, p)));
        const q = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
        const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
        if (d < nearest) {
          nearest = d;
          snapped = q;
        }
      }
    p.x = snapped.x;
    p.y = snapped.y;
    const found = points.findIndex(
      (q) => Math.abs(p.x - q.x) < EPS && Math.abs(p.y - q.y) < EPS,
    );
    if (found >= 0) {
      points[found]!.n = p.n;
      ids.push(found);
      continue;
    }
    if (points.length >= 192) return null;
    const id = points.length;
    const next: number[] = [];
    let inserted = false;
    for (let i = 0; i < triangles.length; i += 3) {
      const tri = triangles.slice(i, i + 3);
      const sides = tri.map((a, k) =>
        cross(points[a]!, points[tri[(k + 1) % 3]!]!, p),
      );
      if (sides.some((s) => s < -EPS)) {
        next.push(...tri);
        continue;
      }
      inserted = true;
      for (let k = 0; k < 3; k++)
        if (sides[k]! > EPS) next.push(tri[k]!, tri[(k + 1) % 3]!, id);
    }
    if (!inserted) return null;
    triangles = next;
    points.push(p);
    ids.push(id);
  }
  const edgeKey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  const fixed = new Set<string>();
  const tri = (a: number, b: number, c: number): number[] =>
    cross(points[a]!, points[b]!, points[c]!) > 0 ? [a, b, c] : [b, a, c];
  for (const edge of data.edges) {
    if (
      !Array.isArray(edge) ||
      edge.length !== 2 ||
      !edge.every((i) => Number.isInteger(i) && i >= 0 && i < ids.length)
    )
      return null;
    const a = ids[edge[0]!]!,
      b = ids[edge[1]!]!;
    if (a === b) continue;
    const stops = points
      .map((p, i) => ({ i, t: along(points[a]!, points[b]!, p) }))
      .filter((s) => on(points[a]!, points[b]!, points[s.i]!))
      .sort((p, q) => p.t - q.t || p.i - q.i);
    for (let s = 1; s < stops.length; s++) {
      const u = stops[s - 1]!.i,
        v = stops[s]!.i,
        key = edgeKey(u, v);
      let recovered = false;
      for (
        let attempt = 0;
        attempt < points.length * points.length;
        attempt++
      ) {
        const edges = new Map<
          string,
          { a: number; b: number; t: number; c: number }[]
        >();
        for (let t = 0; t < triangles.length; t += 3)
          for (let k = 0; k < 3; k++) {
            const a = triangles[t + k]!,
              b = triangles[t + ((k + 1) % 3)]!,
              c = triangles[t + ((k + 2) % 3)]!;
            const key = edgeKey(a, b);
            const pair = edges.get(key) ?? [];
            pair.push({ a, b, t, c });
            edges.set(key, pair);
          }
        if (edges.has(key)) {
          recovered = true;
          break;
        }
        let flipped = false;
        for (const [k, pair] of edges) {
          if (pair.length !== 2 || fixed.has(k)) continue;
          const [e, f] = pair as [(typeof pair)[number], (typeof pair)[number]];
          if (
            !crosses(points[u]!, points[v]!, points[e.a]!, points[e.b]!) ||
            !crosses(points[e.a]!, points[e.b]!, points[e.c]!, points[f.c]!)
          )
            continue;
          if (
            attempt % 2 === 0 &&
            crosses(points[u]!, points[v]!, points[e.c]!, points[f.c]!)
          )
            continue;
          triangles.splice(e.t, 3, ...tri(e.c, f.c, e.a));
          triangles.splice(f.t, 3, ...tri(f.c, e.c, e.b));
          flipped = true;
          break;
        }
        if (!flipped && attempt % 2 === 1) return null;
      }
      if (!recovered) return null;
      fixed.add(key);
    }
  }
  return { points, triangles, run };
}

export function complexStops(
  a: Point,
  b: Point,
  model: ComplexRoof,
): RoofPoint[] {
  return model.points
    .filter((p) => on(a, b, p))
    .sort((p, q) => along(a, b, p) - along(a, b, q));
}
