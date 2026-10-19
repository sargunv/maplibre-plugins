// The 3D hit test (../../README.md, "Hit testing"): a building is hit when
// the query point intersects its prism from base to height, moved by
// building-translate and projected with the tile matrix. This is
// maplibre-gl-js's FillExtrusionStyleLayer.queryIntersectsFeature for a point
// query, in clip space instead of pixels (the same test, scaled), with its
// getIntersectionDistance to order hits nearest first, except that the
// translation moves the prism, as it is drawn, rather than the query's
// ground point, which misses the translated walls of tall buildings in a
// perspective view by up to a few pixels. The roof's own shape
// is not tested: the prism's top is the footprint at building-height, the
// roof's highest point, so a hit on the sky above a gable's slope counts, as
// does a hit inside the box, and an onion's bulge beyond the footprint does
// not.

import { type Point, signedArea2 } from "./footprint.ts";

/** A projected point: x and y in normalized device coordinates, z its depth. */
export interface Projected {
  x: number;
  y: number;
  z: number;
}

/** A column-major 4×4 matrix, as gl-js hands them out. */
export type Matrix = ArrayLike<number>;

function project(m: Matrix, x: number, y: number, z: number): Projected | null {
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  if (!(w > 0)) return null;
  return {
    x: (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w,
    y: (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w,
    z: (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!) / w,
  };
}

/** Each ring projected at one height, or null when a vertex is behind the camera. */
function projectRings(
  rings: readonly (readonly Point[])[],
  z: number,
  m: Matrix,
  translate: readonly [number, number],
): (Projected | null)[][] {
  const [tx, ty] = translate;
  return rings.map((ring) =>
    ring.map((p) => project(m, p.x + tx, p.y + ty, z)),
  );
}

/**
 * A feature's rings grouped into polygons, as classifyRings groups them: the
 * first ring with an area sets the exterior winding, and every exterior
 * starts a polygon that the holes after it join. Returns ring indices.
 */
export function polygonRings(rings: readonly (readonly Point[])[]): number[][] {
  const polygons: number[][] = [];
  let exteriorSign = 0;
  for (let i = 0; i < rings.length; i++) {
    const area2 = signedArea2(rings[i]!);
    if (area2 === 0) continue;
    const sign = area2 > 0 ? 1 : -1;
    if (exteriorSign === 0) exteriorSign = sign;
    if (sign === exteriorSign) polygons.push([i]);
    else polygons[polygons.length - 1]?.push(i);
  }
  return polygons;
}

/** Even-odd point in polygon over every ring; false when a ring has a hidden vertex. */
function insideRings(
  rings: readonly (readonly (Projected | null)[])[],
  q: { x: number; y: number },
): boolean {
  let inside = false;
  for (const ring of rings) {
    if (ring.some((p) => p === null)) return false;
    const points = ring as Projected[];
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[i]!;
      const b = points[j]!;
      if (
        a.y > q.y !== b.y > q.y &&
        q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x
      )
        inside = !inside;
    }
  }
  return inside;
}

/**
 * maplibre-gl-js's getIntersectionDistance for a point: the depth where the
 * point meets the plane of the face's first non-degenerate triangle.
 */
export function intersectionDistance(
  q: { x: number; y: number },
  face: readonly Projected[],
): number {
  let i = 0;
  const a = face[i++];
  if (!a) return Infinity;
  let b: Projected | undefined;
  while (!b || (a.x === b.x && a.y === b.y)) {
    b = face[i++];
    if (!b) return Infinity;
  }
  for (; i < face.length; i++) {
    const c = face[i]!;
    const ab = { x: b.x - a.x, y: b.y - a.y };
    const ac = { x: c.x - a.x, y: c.y - a.y };
    const ap = { x: q.x - a.x, y: q.y - a.y };
    const dotABAB = ab.x * ab.x + ab.y * ab.y;
    const dotABAC = ab.x * ac.x + ab.y * ac.y;
    const dotACAC = ac.x * ac.x + ac.y * ac.y;
    const dotAPAB = ap.x * ab.x + ap.y * ab.y;
    const dotAPAC = ap.x * ac.x + ap.y * ac.y;
    const denom = dotABAB * dotACAC - dotABAC * dotABAC;
    const v = (dotACAC * dotAPAB - dotABAC * dotAPAC) / denom;
    const w = (dotABAB * dotAPAC - dotABAC * dotAPAB) / denom;
    const u = 1 - v - w;
    const distance = a.z * u + b.z * v + c.z * w;
    if (Number.isFinite(distance)) return distance;
  }
  return Infinity;
}

/**
 * Whether a query point (normalized device coordinates) hits the prism of a
 * footprint (rings in tile units) from `base` to `height` (meters, clamped
 * at 0, the height at least the base), moved by `translate` (tile units), under `matrix` (tile units and
 * meters to clip space, untranslated). Returns the
 * depth of the nearest face it hits, or null. Like maplibre-gl-js it tests
 * each polygon's top (holes included) and every wall quad
 * [topA, topB, baseB, baseA]; a face with a vertex behind the camera is
 * never hit.
 */
export function prismHit(
  rings: readonly (readonly Point[])[],
  base: number,
  height: number,
  matrix: Matrix,
  q: { x: number; y: number },
  translate: readonly [number, number] = [0, 0],
): number | null {
  const b = Math.max(base, 0);
  // A base above the height collapses the building to its base, as the
  // shader draws it.
  const h = Math.max(height, b);
  const bottom = projectRings(rings, b, matrix, translate);
  const top = projectRings(rings, h, matrix, translate);
  let closest = Infinity;
  // Each polygon's top on its own: one with a vertex behind the camera
  // must not hide the others.
  for (const polygon of polygonRings(rings)) {
    const tops = polygon.map((i) => top[i]!);
    if (!insideRings(tops, q)) continue;
    // Every ring of a top lies in one plane, but one can be degenerate
    // (the layout drops it), so take the first with a depth.
    for (const ring of tops) {
      const distance = intersectionDistance(q, ring as Projected[]);
      if (distance !== Infinity) {
        closest = Math.min(closest, distance);
        break;
      }
    }
  }
  for (let r = 0; r < top.length; r++) {
    const ringTop = top[r]!;
    const ringBase = bottom[r]!;
    const n = ringTop.length;
    for (let i = 0; i < n; i++) {
      // gl-js's rings repeat their first point; ours do not, so close them.
      const j = (i + 1) % n;
      const face = [ringTop[i], ringTop[j], ringBase[j], ringBase[i]];
      if (face.some((p) => p === null)) continue;
      const quad = face as Projected[];
      if (!insideRings([quad], q)) continue;
      closest = Math.min(closest, intersectionDistance(q, quad));
    }
  }
  // gl-js reports no hit when every hit face's distance is infinite.
  return closest === Infinity ? null : closest;
}

/**
 * building-translate in tile units: `translate` (logical pixels, [right,
 * down]) times tile units per pixel, turned by the map's bearing (radians,
 * clockwise) for a viewport anchor, as maplibre-gl-js's translatePosMatrix
 * and MapLibre Native's FeatureIndex::translateQueryGeometry turn it.
 */
export function translationInTileUnits(
  translate: readonly [number, number],
  viewport: boolean,
  bearing: number,
  pixelsToTileUnits: number,
): [number, number] {
  // In the native twin's order of operations: scale, then turn.
  const x = translate[0] * pixelsToTileUnits;
  const y = translate[1] * pixelsToTileUnits;
  if (!viewport || (x === 0 && y === 0)) return [x, y];
  const c = Math.cos(bearing);
  const s = Math.sin(bearing);
  return [x * c - y * s, x * s + y * c];
}
