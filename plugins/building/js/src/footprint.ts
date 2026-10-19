// Footprint preparation: ring cleanup, MVT ring classification, tile clip
// edges and the minimum-area bounding rectangle that frames a roof. Part of
// the building layout; ../../native/src/footprint.zig is its twin and both
// are tested against ../../fixtures/layout.
//
// Coordinates are tile units (x right, y down). Every comparison that picks
// between near-equal candidates uses a relative tolerance and then the first
// candidate, so the two twins make the same choices despite last-bit
// differences in their floating point.

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Vertices closer than this to the line through their neighbors are
 * dropped, in tile units: it removes collinear points and the jitter that
 * int16 quantization leaves on straight walls.
 */
export const SIMPLIFY_TOLERANCE = 0.5;
/** Rings with a smaller area, in square tile units, are dropped. */
export const MIN_RING_AREA = 1;
/** Relative tolerance of every near-tie decision. */
export const TIE = 1e-9;

/** Twice the signed area: positive for MVT exterior rings. */
export function signedArea2(ring: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    sum += p.x * q.y - q.x * p.y;
  }
  return sum;
}

export function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function same(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

/**
 * The bounding box of every point of the features one tile lays out. A
 * source clips its features to the tile plus a buffer along axis-aligned
 * lines, and nothing reaches beyond them, so the box's sides outside the
 * tile square are the only places a cut can lie.
 */
export interface TileBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** The bounds of a tile's features, each a list of rings. */
export function tileBounds(
  features: Iterable<readonly (readonly Point[])[]>,
): TileBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rings of features) {
    for (const ring of rings) {
      for (const p of ring) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }
  }
  return { minX, minY, maxX, maxY };
}

/** Bounds with no cut lines: no edge lies on an infinite line. */
export const NO_CUTS: TileBounds = tileBounds([]);

/**
 * Whether the ring edge a→b is an artificial cut of a tile-clipped
 * polygon: axis-aligned, outside the tile square (core fill-extrusion's
 * boundary-edge test) and on the side of the tile's bounds that faces away
 * from the tile, where the source's clip line lies. That last condition
 * keeps axis-aligned walls in the buffer from counting as cuts, unless one
 * happens to be the outermost point of the whole tile.
 */
export function isClipEdge(
  a: Point,
  b: Point,
  extent: number,
  bounds: TileBounds,
): boolean {
  return (
    (a.x === b.x &&
      ((a.x < 0 && a.x === bounds.minX) ||
        (a.x > extent && a.x === bounds.maxX))) ||
    (a.y === b.y &&
      ((a.y < 0 && a.y === bounds.minY) ||
        (a.y > extent && a.y === bounds.maxY)))
  );
}

/** Whether any edge of a ring is a cut. */
export function hasClipEdge(
  ring: readonly Point[],
  extent: number,
  bounds: TileBounds,
): boolean {
  for (let i = 0; i < ring.length; i++) {
    if (isClipEdge(ring[i]!, ring[(i + 1) % ring.length]!, extent, bounds))
      return true;
  }
  return false;
}

function onCutLine(p: Point, extent: number, bounds: TileBounds): boolean {
  return (
    (p.x < 0 && p.x === bounds.minX) ||
    (p.x > extent && p.x === bounds.maxX) ||
    (p.y < 0 && p.y === bounds.minY) ||
    (p.y > extent && p.y === bounds.maxY)
  );
}

/**
 * Whether a ring as the source gave it repeats a point on a cut line: where
 * the source clipped away a tip narrower than its grid, both crossings
 * round to that point and the cut edge has no length. One closing point is
 * not a repeat.
 */
export function hasCollapsedCut(
  ring: readonly Point[],
  extent: number,
  bounds: TileBounds,
): boolean {
  let n = ring.length;
  if (n > 1 && same(ring[0]!, ring[n - 1]!)) n--;
  for (let i = 0; i < n; i++) {
    const p = ring[i]!;
    if (same(p, ring[(i + 1) % n]!) && onCutLine(p, extent, bounds))
      return true;
  }
  return false;
}

/**
 * Drops repeated points, the closing point, collinear points and spikes,
 * until no vertex is within SIMPLIFY_TOLERANCE of the line through its
 * neighbors. The endpoints of clip edges are kept unless both of their
 * edges are clip edges, so cuts never merge into real walls. Returns an
 * empty ring when fewer than three points remain.
 */
export function simplifyRing(
  input: readonly Point[],
  extent: number,
  bounds: TileBounds = NO_CUTS,
): Point[] {
  const ring: Point[] = [];
  for (const p of input) {
    const last = ring[ring.length - 1];
    if (last && same(last, p)) continue;
    ring.push({ x: p.x, y: p.y });
  }
  while (ring.length > 1 && same(ring[ring.length - 1]!, ring[0]!)) ring.pop();
  let changed = true;
  while (changed && ring.length >= 3) {
    changed = false;
    let i = 0;
    while (i < ring.length && ring.length >= 3) {
      const n = ring.length;
      const a = ring[(i + n - 1) % n]!;
      const b = ring[i]!;
      const c = ring[(i + 1) % n]!;
      if (removable(a, b, c, extent, bounds)) {
        ring.splice(i, 1);
        changed = true;
      } else i++;
    }
  }
  return ring.length >= 3 ? ring : [];
}

function removable(
  a: Point,
  b: Point,
  c: Point,
  extent: number,
  bounds: TileBounds,
): boolean {
  if (same(a, b) || same(b, c)) return true;
  const clipBefore = isClipEdge(a, b, extent, bounds);
  const clipAfter = isClipEdge(b, c, extent, bounds);
  if (clipBefore !== clipAfter) return false;
  if (clipBefore)
    return isClipEdge(a, c, extent, bounds) && cross(a, b, c) === 0;
  const dx = c.x - a.x;
  const dy = c.y - a.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  // Neighbors (nearly) on top of each other: b is the tip of a spike.
  if (length <= SIMPLIFY_TOLERANCE) return true;
  return Math.abs(cross(a, c, b)) <= SIMPLIFY_TOLERANCE * length;
}

/** One polygon of a feature: an exterior ring and its holes. */
export interface Polygon {
  /** Positive area (MVT exterior winding). */
  outer: Point[];
  /** Negative area each. */
  holes: Point[][];
  /**
   * Whether the source cut this copy of the footprint at a clip line: some
   * ring has a clip edge, or repeats a point on a cut line. An uncut copy
   * is the whole footprint, the same in every tile up to a translation.
   */
  cut: boolean;
}

/**
 * Groups a feature's rings into polygons as core's classifyRings does: the
 * first usable ring's winding marks exteriors, and every ring of the other
 * winding is a hole of the exterior before it. Rings are simplified first
 * and dropped when they degenerate. Exteriors come out with positive area
 * and holes with negative area, whatever the input winding.
 */
export function classifyRings(
  rings: readonly (readonly Point[])[],
  extent: number,
  bounds: TileBounds = NO_CUTS,
): Polygon[] {
  const polygons: Polygon[] = [];
  let exteriorSign = 0;
  for (const input of rings) {
    const ring = simplifyRing(input, extent, bounds);
    if (ring.length < 3) continue;
    const area2 = signedArea2(ring);
    if (Math.abs(area2) < 2 * MIN_RING_AREA) continue;
    const sign = area2 > 0 ? 1 : -1;
    if (exteriorSign === 0) exteriorSign = sign;
    const cut =
      hasClipEdge(ring, extent, bounds) ||
      hasCollapsedCut(input, extent, bounds);
    if (sign === exteriorSign) {
      if (sign < 0) ring.reverse();
      polygons.push({ outer: ring, holes: [], cut });
    } else {
      const polygon = polygons[polygons.length - 1];
      if (!polygon) continue;
      if (sign > 0) ring.reverse();
      polygon.holes.push(ring);
      polygon.cut ||= cut;
    }
  }
  return polygons;
}

/** Andrew's monotone chain; counter-clockwise in a y-up frame. */
export function convexHull(points: readonly Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const hull: Point[] = [];
  for (const p of sorted) {
    while (
      hull.length >= 2 &&
      cross(hull[hull.length - 2]!, hull[hull.length - 1]!, p) <= 0
    )
      hull.pop();
    hull.push(p);
  }
  const lower = hull.length + 1;
  for (let i = sorted.length - 2; i >= 0; i--) {
    const p = sorted[i]!;
    while (
      hull.length >= lower &&
      cross(hull[hull.length - 2]!, hull[hull.length - 1]!, p) <= 0
    )
      hull.pop();
    hull.push(p);
  }
  hull.pop();
  return hull;
}

/** The minimum-area bounding rectangle of a footprint. */
export interface BoundingRectangle {
  center: Point;
  /** Unit vector along the longer side (the first found on a tie). */
  long: Point;
  /** Unit vector along the shorter side, `long` turned a quarter. */
  short: Point;
  /** Half the longer side's length. */
  halfLong: number;
  /** Half the shorter side's length. */
  halfShort: number;
}

/**
 * Rotating calipers over the convex hull: the rectangle has a side along
 * one hull edge, so trying every edge finds the smallest. Null when the
 * points are collinear.
 */
export function minimumAreaRectangle(
  points: readonly Point[],
): BoundingRectangle | null {
  const hull = convexHull(points);
  if (hull.length < 3) return null;
  const origin = hull[0]!;
  let best: {
    ux: number;
    uy: number;
    min: [number, number];
    max: [number, number];
  } | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hull.length]!;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const length = Math.sqrt(ex * ex + ey * ey);
    if (length === 0) continue;
    const ux = ex / length;
    const uy = ey / length;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of hull) {
      const dx = p.x - origin.x;
      const dy = p.y - origin.y;
      const u = dx * ux + dy * uy;
      const v = dy * ux - dx * uy;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < bestArea * (1 - TIE)) {
      bestArea = area;
      best = { ux, uy, min: [minU, minV], max: [maxU, maxV] };
    }
  }
  if (!best || !(bestArea > 0)) return null;
  const { ux, uy } = best;
  // v = (-uy, ux): the edge direction turned a quarter.
  const vx = -uy;
  const vy = ux;
  const midU = (best.min[0] + best.max[0]) / 2;
  const midV = (best.min[1] + best.max[1]) / 2;
  const center = {
    x: origin.x + ux * midU + vx * midV,
    y: origin.y + uy * midU + vy * midV,
  };
  const halfU = (best.max[0] - best.min[0]) / 2;
  const halfV = (best.max[1] - best.min[1]) / 2;
  if (halfV > halfU * (1 + TIE)) {
    return {
      center,
      long: { x: vx, y: vy },
      short: { x: -ux, y: -uy },
      halfLong: halfV,
      halfShort: halfU,
    };
  }
  return {
    center,
    long: { x: ux, y: uy },
    short: { x: vx, y: vy },
    halfLong: halfU,
    halfShort: halfV,
  };
}
