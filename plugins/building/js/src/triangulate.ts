// Ear-clipping triangulation of a footprint with holes. Part of the building
// layout; ../../native/src/triangulate.zig is its twin. It is deliberately
// simpler than earcut (no z-order hash, no local-intersection cures) so the
// twins stay line-for-line portable and produce identical triangles: holes
// are bridged into the outer ring (Eberly's "Triangulation by Ear
// Clipping", §3), then ears are clipped in ring order. Where rings touch at
// a point (and at bridge ends) the polygon visits a point more than once:
// zero-width spikes are dropped as they appear, and an ear is rejected when
// another visit of one of its corners has an edge running into it. Input
// that is not a simple polygon still terminates: when a full pass finds no
// ear, a degenerate vertex is dropped or, failing that, the first convex
// vertex is clipped anyway.

import { cross, type Point } from "./footprint.ts";

export interface Triangulation {
  /** The outer ring's points followed by each hole's. */
  points: Point[];
  /** Index triples into `points`, each with positive signed area. */
  triangles: number[];
}

/**
 * Triangulates an outer ring of positive area with holes of negative area
 * (as classifyRings returns them).
 */
export function triangulate(
  outer: readonly Point[],
  holes: readonly (readonly Point[])[] = [],
): Triangulation {
  const points: Point[] = [...outer];
  // The polygon as a sequence of point indices; bridges repeat points.
  let polygon: number[] = outer.map((_, i) => i);
  const holeStarts: { start: number; length: number; right: number }[] = [];
  for (const hole of holes) {
    const start = points.length;
    let right = 0;
    for (let i = 0; i < hole.length; i++) {
      const p = hole[i]!;
      const r = hole[right]!;
      if (p.x > r.x || (p.x === r.x && p.y < r.y)) right = i;
      points.push(p);
    }
    holeStarts.push({ start, length: hole.length, right });
  }
  // Rightmost holes first, so each bridge sees the holes already merged.
  const order = holeStarts
    .map((_, i) => i)
    .sort((a, b) => {
      const pa = points[holeStarts[a]!.start + holeStarts[a]!.right]!;
      const pb = points[holeStarts[b]!.start + holeStarts[b]!.right]!;
      return pb.x - pa.x || pa.y - pb.y || a - b;
    });
  for (const h of order) {
    const hole = holeStarts[h]!;
    const m = hole.start + hole.right;
    const at = findBridge(points, polygon, m);
    if (at < 0) continue;
    const loop: number[] = [];
    for (let k = 0; k <= hole.length; k++)
      loop.push(hole.start + ((hole.right + k) % hole.length));
    polygon = [
      ...polygon.slice(0, at + 1),
      ...loop,
      polygon[at]!,
      ...polygon.slice(at + 1),
    ];
  }
  return { points, triangles: clipEars(points, polygon) };
}

/**
 * Finds where to bridge the hole vertex m into the polygon: the position
 * of a polygon vertex that m sees, found by casting a ray toward +x.
 * Returns -1 when the ray hits nothing (a hole outside its exterior).
 */
function findBridge(
  points: readonly Point[],
  polygon: number[],
  m: number,
): number {
  const mp = points[m]!;
  let hitX = Infinity;
  let candidate = -1;
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    const a = points[polygon[i]!]!;
    const b = points[polygon[(i + 1) % n]!]!;
    if (a.y === b.y) continue;
    if (mp.y < Math.min(a.y, b.y) || mp.y > Math.max(a.y, b.y)) continue;
    const x = a.x + ((mp.y - a.y) * (b.x - a.x)) / (b.y - a.y);
    if (x < mp.x || x >= hitX) continue;
    hitX = x;
    if (x === a.x && mp.y === a.y) candidate = i;
    else if (x === b.x && mp.y === b.y) candidate = (i + 1) % n;
    else candidate = a.x >= b.x ? i : (i + 1) % n;
  }
  if (candidate < 0) return -1;
  const p = points[polygon[candidate]!]!;
  const hit = { x: hitX, y: mp.y };
  if (!(p.x === hit.x && p.y === hit.y)) {
    // A reflex vertex inside the triangle (m, hit, p) may block the view of
    // p; the one closest in angle to the ray is visible instead.
    let bestTan = Infinity;
    let bestDistance = Infinity;
    for (let i = 0; i < n; i++) {
      const r = points[polygon[i]!]!;
      if (i === candidate || (r.x === p.x && r.y === p.y)) continue;
      if (convexAt(points, polygon, i)) continue;
      if (!pointInTriangle(mp, hit, p, r)) continue;
      const dx = r.x - mp.x;
      if (dx <= 0) continue;
      const tan = Math.abs(r.y - mp.y) / dx;
      const distance = dx * dx + (r.y - mp.y) * (r.y - mp.y);
      if (tan < bestTan || (tan === bestTan && distance < bestDistance)) {
        bestTan = tan;
        bestDistance = distance;
        candidate = i;
      }
    }
  }
  // A bridged point appears more than once; pick the copy whose interior
  // wedge contains the bridge.
  const chosen = points[polygon[candidate]!]!;
  for (let k = 0; k < n; k++) {
    const i = (candidate + k) % n;
    const r = points[polygon[i]!]!;
    if (r.x !== chosen.x || r.y !== chosen.y) continue;
    const before = points[polygon[(i + n - 1) % n]!]!;
    const after = points[polygon[(i + 1) % n]!]!;
    if (wedgeContains(before, r, after, mp)) return i;
  }
  return candidate;
}

function convexAt(
  points: readonly Point[],
  polygon: number[],
  i: number,
): boolean {
  const n = polygon.length;
  return (
    cross(
      points[polygon[(i + n - 1) % n]!]!,
      points[polygon[i]!]!,
      points[polygon[(i + 1) % n]!]!,
    ) > 0
  );
}

/** Whether m lies in the interior wedge at p of a positive-area ring. */
function wedgeContains(a: Point, p: Point, c: Point, m: Point): boolean {
  const left = cross(a, p, m) >= 0;
  const right = cross(p, c, m) >= 0;
  return cross(a, p, c) > 0 ? left && right : left || right;
}

/**
 * Whether the direction from v to p lies strictly inside the angle from
 * v→u counter-clockwise (positive cross) to v→w, an angle under 180°.
 */
function inAngle(v: Point, u: Point, w: Point, p: Point): boolean {
  return cross(v, u, p) > 0 && cross(v, p, w) > 0;
}

/** Inclusive point-in-triangle test for either winding. */
function pointInTriangle(a: Point, b: Point, c: Point, p: Point): boolean {
  const d1 = cross(a, b, p);
  const d2 = cross(b, c, p);
  const d3 = cross(c, a, p);
  const negative = d1 < 0 || d2 < 0 || d3 < 0;
  const positive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(negative && positive);
}

function clipEars(
  points: readonly Point[],
  polygon: readonly number[],
): number[] {
  const triangles: number[] = [];
  const n = polygon.length;
  if (n < 3) return triangles;
  const prev = polygon.map((_, i) => (i + n - 1) % n);
  const next = polygon.map((_, i) => (i + 1) % n);
  const at = (i: number): Point => points[polygon[i]!]!;
  const area = (i: number): number => cross(at(prev[i]!), at(i), at(next[i]!));
  const remove = (i: number): void => {
    next[prev[i]!] = next[i]!;
    prev[next[i]!] = prev[i]!;
  };
  const isEar = (i: number): boolean => {
    const a = at(prev[i]!);
    const b = at(i);
    const c = at(next[i]!);
    if (cross(a, b, c) <= 0) return false;
    for (let j = next[next[i]!]!; j !== prev[i]!; j = next[j]!) {
      const p = at(j);
      // Another copy of a corner (a bridge end, or rings touching at a
      // point) blocks the ear when the boundary leaves it into the ear.
      const corner =
        p.x === a.x && p.y === a.y
          ? 0
          : p.x === b.x && p.y === b.y
            ? 1
            : p.x === c.x && p.y === c.y
              ? 2
              : -1;
      if (corner >= 0) {
        const [u, w] = corner === 0 ? [b, c] : corner === 1 ? [c, a] : [a, b];
        if (inAngle(p, u, w, at(prev[j]!)) || inAngle(p, u, w, at(next[j]!)))
          return false;
        continue;
      }
      if (area(j) <= 0 && pointInTriangle(a, b, c, p)) return false;
    }
    return true;
  };
  const isSpike = (i: number): boolean => {
    const a = at(prev[i]!);
    const b = at(i);
    const c = at(next[i]!);
    return (
      cross(a, b, c) === 0 &&
      (a.x - b.x) * (c.x - b.x) + (a.y - b.y) * (c.y - b.y) >= 0
    );
  };
  const emit = (i: number): void => {
    triangles.push(polygon[prev[i]!]!, polygon[i]!, polygon[next[i]!]!);
  };
  let remaining = n;
  let i = 0;
  let stall = 0;
  while (remaining > 3) {
    if (isSpike(i)) {
      // A repeated point, or a zero-width spike where rings touch: it
      // encloses nothing, and leaving it would let an ear span the pinch.
      remove(i);
      remaining--;
      i = next[i]!;
      stall = 0;
      continue;
    }
    if (isEar(i)) {
      emit(i);
      remove(i);
      remaining--;
      i = next[i]!;
      stall = 0;
      continue;
    }
    i = next[i]!;
    if (++stall < remaining) continue;
    // A full pass without an ear: drop a degenerate vertex, else force the
    // first convex one.
    stall = 0;
    let fixed = -1;
    for (let k = 0, j = i; k < remaining; k++, j = next[j]!) {
      if (area(j) === 0) {
        fixed = j;
        break;
      }
    }
    if (fixed >= 0) {
      remove(fixed);
      remaining--;
      i = next[fixed]!;
      continue;
    }
    for (let k = 0, j = i; k < remaining; k++, j = next[j]!) {
      if (area(j) > 0) {
        fixed = j;
        break;
      }
    }
    if (fixed < 0) return triangles;
    emit(fixed);
    remove(fixed);
    remaining--;
    i = next[fixed]!;
  }
  if (area(i) > 0) emit(i);
  return triangles;
}
