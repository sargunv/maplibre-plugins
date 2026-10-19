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

export interface RoofGraph {
  vertices: RoofPoint[];
  edges: number[][];
}

function snap(p: RoofPoint, polygon: Polygon): RoofPoint {
  let nearest = 0.75 ** 2;
  let snapped = p;
  for (const ring of [polygon.outer, ...polygon.holes])
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!,
        b = ring[(i + 1) % ring.length]!;
      const t = Math.max(0, Math.min(1, along(a, b, p)));
      const q = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y), n: p.n };
      const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
      if (d < nearest) {
        nearest = d;
        snapped = q;
      }
    }
  return snapped;
}

function contains(polygon: Polygon, p: Point): boolean {
  const inside = (ring: Point[]) => {
    let result = false;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!,
        b = ring[(i + 1) % ring.length]!;
      if (on(a, b, p)) return true;
      if (
        a.y > p.y !== b.y > p.y &&
        p.x < a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y)
      )
        result = !result;
    }
    return result;
  };
  // Hole boundaries belong to the roof too.
  for (const ring of [polygon.outer, ...polygon.holes])
    for (let i = 0; i < ring.length; i++)
      if (on(ring[i]!, ring[(i + 1) % ring.length]!, p)) return true;
  return inside(polygon.outer) && !polygon.holes.some(inside);
}

/** Validate once, project to the tile, and assign graph vertices to components. */
export function partitionRoofGraph(
  polygons: Polygon[],
  text: string,
  tile: CanonicalTile | undefined,
  extent: number,
): (RoofGraph | null)[] {
  const invalid = () => polygons.map(() => null);
  if (!tile || text.length > 65536) return invalid();
  let data: { vertices: number[][]; edges: number[][] };
  try {
    data = JSON.parse(text);
  } catch {
    return invalid();
  }
  if (
    !data ||
    !Array.isArray(data.vertices) ||
    !Array.isArray(data.edges) ||
    !data.vertices.length ||
    data.vertices.length > 192 ||
    data.edges.length > 576
  )
    return invalid();

  // Containment and snapping use small coordinates, just like triangulation.
  // World coordinates at z16 otherwise lose sub-tile boundary precision.
  const local = polygons.map((polygon) => {
    const origin = polygon.outer[0]!;
    const ring = (points: Point[]) =>
      points.map((p) => ({ x: p.x - origin.x, y: p.y - origin.y }));
    return {
      origin,
      polygon: {
        outer: ring(polygon.outer),
        holes: polygon.holes.map(ring),
        cut: polygon.cut,
      },
    };
  });
  const graphs: RoofGraph[] = polygons.map(() => ({ vertices: [], edges: [] }));
  const owners: number[] = [],
    ids: number[] = [];
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
      return invalid();
    const scale = extent * 2 ** tile.z;
    const sin = Math.sin((v[1]! * Math.PI) / 180);
    const p = {
      x: Math.round((v[0]! / 360 + 0.5) * scale) - tile.x * extent,
      y:
        Math.round(
          (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
        ) -
        tile.y * extent,
      n: v[2]!,
    };
    const owner = local.findIndex(({ polygon, origin }) =>
      contains(
        polygon,
        snap({ x: p.x - origin.x, y: p.y - origin.y, n: p.n }, polygon),
      ),
    );
    if (owner < 0) return invalid();
    owners.push(owner);
    ids.push(graphs[owner]!.vertices.length);
    graphs[owner]!.vertices.push(p);
  }
  const bad = new Set<number>();
  for (const edge of data.edges) {
    if (
      !Array.isArray(edge) ||
      edge.length !== 2 ||
      !edge.every((i) => Number.isInteger(i) && i >= 0 && i < ids.length)
    )
      return invalid();
    const [a, b] = edge as [number, number];
    if (owners[a] !== owners[b]) {
      bad.add(owners[a]!);
      bad.add(owners[b]!);
    } else graphs[owners[a]!]!.edges.push([ids[a]!, ids[b]!]);
  }
  return graphs.map((g, i) => (bad.has(i) || !g.vertices.length ? null : g));
}

/** Ear clipping preserves every cavity boundary vertex (including collinear ones).
 * Each successful pass removes a vertex; an invalid cavity returns immediately. */
function fillCavity(points: RoofPoint[], ring: number[]): number[] | null {
  const result: number[] = [];
  while (ring.length > 2) {
    let clipped = false;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[(i + ring.length - 1) % ring.length]!,
        b = ring[i]!,
        c = ring[(i + 1) % ring.length]!;
      if (cross(points[a]!, points[b]!, points[c]!) <= EPS) continue;
      if (
        ring.some(
          (p) =>
            p !== a &&
            p !== b &&
            p !== c &&
            cross(points[a]!, points[b]!, points[p]!) >= -EPS &&
            cross(points[b]!, points[c]!, points[p]!) >= -EPS &&
            cross(points[c]!, points[a]!, points[p]!) >= -EPS,
        )
      )
        continue;
      result.push(a, b, c);
      ring.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) return null;
  }
  return result;
}

/** Insert vertices, then replace each crossed triangle strip with two cavities. */
export function complexRoof(
  polygon: Polygon,
  data: RoofGraph | null,
  origin: Point,
  run: number,
): ComplexRoof | null {
  if (!data) return null;
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
  for (const v of data.vertices) {
    const p = snap({ x: v.x - origin.x, y: v.y - origin.y, n: v.n }, polygon);
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
      const edges = new Map<string, number[]>();
      for (let t = 0; t < triangles.length; t += 3)
        for (let k = 0; k < 3; k++) {
          const key = edgeKey(triangles[t + k]!, triangles[t + ((k + 1) % 3)]!);
          const pair = edges.get(key) ?? [];
          pair.push(t);
          edges.set(key, pair);
        }
      if (!edges.has(key)) {
        const crossing = (a: number, b: number) =>
          crosses(points[u]!, points[v]!, points[a]!, points[b]!);
        let current = -1;
        for (let t = 0; t < triangles.length; t += 3) {
          const tri = triangles.slice(t, t + 3);
          if (
            tri.includes(u) &&
            tri.some((a, k) => crossing(a, tri[(k + 1) % 3]!))
          ) {
            current = t;
            break;
          }
        }
        if (current < 0) return null;
        const removed = new Set<number>();
        const left = [u],
          right = [u];
        let entry = "";
        // A straight segment visits each triangle at most once. Reject malformed
        // topology instead of revisiting a triangle or using an attempt budget.
        while (true) {
          if (removed.has(current)) return null;
          removed.add(current);
          const tri = triangles.slice(current, current + 3);
          if (tri.includes(v)) break;
          let next = -1;
          for (let k = 0; k < 3; k++) {
            const a = tri[k]!,
              b = tri[(k + 1) % 3]!,
              key = edgeKey(a, b);
            if (key === entry || !crossing(a, b)) continue;
            const pair = edges.get(key)!;
            if (fixed.has(key) || pair.length !== 2) return null;
            for (const id of [a, b]) {
              const side =
                cross(points[u]!, points[v]!, points[id]!) > 0 ? left : right;
              if (side.at(-1) !== id) side.push(id);
            }
            next = pair[0] === current ? pair[1]! : pair[0]!;
            entry = key;
            break;
          }
          if (next < 0) return null;
          current = next;
        }
        left.push(v);
        right.push(v);
        const l = fillCavity(points, left.reverse()),
          r = fillCavity(points, right);
        if (!l || !r) return null;
        triangles = triangles.filter((_, i) => !removed.has(i - (i % 3)));
        triangles.push(...l, ...r);
      }
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
