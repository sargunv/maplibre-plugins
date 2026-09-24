// Shoreline band geometry. This is the maplibre-gl-js twin of
// ../../native/src/layout.zig: the same clipping, joins and strip layout,
// tested against the same fixtures. See that file for the conventions.
//
// For every water polygon ring the layout builds a strip on the water side
// of the shoreline: an outer vertex on the shore and an inner vertex carrying
// a unit extrusion vector, which the vertex shader scales to the band width
// in pixels. Each vertex also carries a 0..1 band distance.

export interface Point {
  x: number;
  y: number;
}

/** Floats per vertex: position(2) extrude(2) dist(1) limit(1). */
export const FLOATS_PER_VERTEX = 6;

/** Vertices per segment stay addressable by 16-bit indices. */
export const MAX_SEGMENT_VERTICES = 65535;
/** Convex corners extend the band by at most this factor of its width. */
export const MITER_LIMIT = 2;
/** Reflex corners fan the band around the point in steps of at most 45°. */
export const FAN_STEP = Math.PI / 4;
/**
 * How far beyond the tile square rings are kept, as a fraction of the
 * extent: wider than any source buffer, so buffered geometry survives.
 */
export const CLIP_MARGIN = 0.5;
/**
 * How far an extrusion looks for the opposite bank, in tile units. Past
 * this the band is unlimited, and the vertex shader clamps it to half the
 * reach so the two banks of a narrow channel meet in the middle instead of
 * overlapping.
 */
export const REACH = 4096;
/** Limit stored for vertices whose extrusion hits nothing within REACH. */
export const UNLIMITED = 1e8;
const GRID_CELLS = 32;

export interface Segment {
  vertexOffset: number;
  indexOffset: number;
  vertexLength: number;
  indexLength: number;
}

/** The vertices one source feature produced. */
export interface Range {
  featureIndex: number;
  firstVertex: number;
  vertexCount: number;
}

interface Pair {
  outer: Point;
  extrude: Point;
  /** The feature edges sharing the outer point; the reach ray ignores them. */
  exclude: [number, number];
}

interface FeatureEdge {
  a: Point;
  b: Point;
}

interface ClippedEdge {
  a: Point;
  b: Point;
  normal: Point;
  direction: Point;
  startsAtVertex: boolean;
  endsAtVertex: boolean;
  /** Index of the ring edge this came from; consecutive kept edges join. */
  ringEdge: number;
  /** Index into the feature's edge list, for the reach cast. */
  edgeId: number;
}

export class ShoreLayout {
  private readonly vertexData: number[] = [];
  private readonly indexData: number[] = [];
  readonly segments: Segment[] = [];
  readonly ranges: Range[] = [];
  private pairs: Pair[] = [];
  private featureEdges: FeatureEdge[] = [];
  /** Uniform grid over the clip square: feature edge ids per cell. */
  private readonly grid: number[][] = Array.from(
    { length: GRID_CELLS * GRID_CELLS },
    () => [],
  );

  constructor(readonly extent: number) {}

  get vertexCount(): number {
    return this.vertexData.length / FLOATS_PER_VERTEX;
  }

  get indexCount(): number {
    return this.indexData.length;
  }

  /** Interleaved vertices as uploaded to the GPU. */
  vertices(): Float32Array {
    return new Float32Array(this.vertexData);
  }

  /** Segment-relative triangle indices. */
  indices(): Uint16Array {
    return new Uint16Array(this.indexData);
  }

  /** One vertex's fields, for tests and debugging. */
  vertex(i: number): {
    x: number;
    y: number;
    extrudeX: number;
    extrudeY: number;
    dist: number;
    limit: number;
  } {
    const o = i * FLOATS_PER_VERTEX;
    return {
      x: this.vertexData[o]!,
      y: this.vertexData[o + 1]!,
      extrudeX: this.vertexData[o + 2]!,
      extrudeY: this.vertexData[o + 3]!,
      dist: this.vertexData[o + 4]!,
      limit: this.vertexData[o + 5]!,
    };
  }

  /**
   * Adds every ring of one polygon feature. Rings may repeat their first
   * point at the end; rings with fewer than three distinct points are
   * skipped.
   */
  addPolygon(rings: readonly (readonly Point[])[], featureIndex: number): void {
    const firstVertex = this.vertexCount;
    // Clean every ring first: the reach cast needs all of the feature's
    // edges before any ring's strip is built.
    const cleaned: Point[][] = [];
    for (const input of rings) {
      const ring: Point[] = [];
      for (const p of input) {
        const last = ring[ring.length - 1];
        if (last && last.x === p.x && last.y === p.y) continue;
        ring.push(p);
      }
      while (
        ring.length > 1 &&
        ring[ring.length - 1]!.x === ring[0]!.x &&
        ring[ring.length - 1]!.y === ring[0]!.y
      )
        ring.pop();
      if (ring.length >= 3) cleaned.push(ring);
    }
    this.featureEdges = [];
    for (const cell of this.grid) cell.length = 0;
    for (const ring of cleaned) {
      for (let i = 0; i < ring.length; i++)
        this.addFeatureEdge(ring[i]!, ring[(i + 1) % ring.length]!);
    }
    let edgeBase = 0;
    for (const ring of cleaned) {
      this.addRing(ring, edgeBase);
      edgeBase += ring.length;
    }
    const vertexCount = this.vertexCount - firstVertex;
    if (vertexCount > 0)
      this.ranges.push({ featureIndex, firstVertex, vertexCount });
  }

  private cellCoordinate(v: number): number {
    const margin = this.extent * CLIP_MARGIN;
    const size = (this.extent + 2 * margin) / GRID_CELLS;
    const c = Math.floor((v + margin) / size);
    return Math.min(Math.max(c, 0), GRID_CELLS - 1);
  }

  private addFeatureEdge(a: Point, b: Point): void {
    const id = this.featureEdges.length;
    this.featureEdges.push({ a, b });
    const x0 = this.cellCoordinate(Math.min(a.x, b.x));
    const x1 = this.cellCoordinate(Math.max(a.x, b.x));
    const y0 = this.cellCoordinate(Math.min(a.y, b.y));
    const y1 = this.cellCoordinate(Math.max(a.y, b.y));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) this.grid[y * GRID_CELLS + x]!.push(id);
  }

  /**
   * Casts a ray from a pair's outer point along its extrusion and returns
   * the extrusion limit in tile units: half the distance to the nearest
   * other edge of the feature, or UNLIMITED.
   */
  private limitFor(pair: Pair): number {
    const len = Math.hypot(pair.extrude.x, pair.extrude.y);
    if (len < 1e-12) return UNLIMITED;
    const d = { x: pair.extrude.x / len, y: pair.extrude.y / len };
    const o = pair.outer;
    let best = REACH;
    const margin = this.extent * CLIP_MARGIN;
    const step = ((this.extent + 2 * margin) / GRID_CELLS) * 0.5;
    let lastCell = -1;
    for (let travelled = 0; travelled <= best; travelled += step) {
      const x = o.x + d.x * travelled;
      const y = o.y + d.y * travelled;
      const cell = this.cellCoordinate(y) * GRID_CELLS + this.cellCoordinate(x);
      if (cell === lastCell) continue;
      lastCell = cell;
      for (const id of this.grid[cell]!) {
        if (id === pair.exclude[0] || id === pair.exclude[1]) continue;
        const edge = this.featureEdges[id]!;
        const hit = rayHit(o, d, edge.a, edge.b);
        if (hit !== null && hit > 1e-6 && hit < best) best = hit;
      }
    }
    if (best >= REACH) return UNLIMITED;
    return best / (2 * len);
  }

  private addRing(ring: readonly Point[], edgeBase: number): void {
    let area = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!;
      const q = ring[(i + 1) % ring.length]!;
      area += p.x * q.y - q.x * p.y;
    }
    if (Math.abs(area) < 1e-9) return;

    // The artificial cuts of a buffered tile are axis-aligned edges on the
    // ring's bounding box, outside the tile square.
    const box: [number, number, number, number] = [
      Infinity,
      Infinity,
      -Infinity,
      -Infinity,
    ];
    for (const p of ring) {
      box[0] = Math.min(box[0], p.x);
      box[1] = Math.min(box[1], p.y);
      box[2] = Math.max(box[2], p.x);
      box[3] = Math.max(box[3], p.y);
    }
    const edges: ClippedEdge[] = [];
    for (let i = 0; i < ring.length; i++) {
      const edge = this.clipEdge(
        ring[i]!,
        ring[(i + 1) % ring.length]!,
        i,
        box,
      );
      if (edge) {
        edge.edgeId = edgeBase + i;
        edges.push(edge);
      }
    }
    if (edges.length === 0) return;

    // Consecutive kept edges join at their shared ring vertex when neither
    // was clipped there. A ring that joins everywhere is a closed loop.
    let start = 0;
    let closed = true;
    for (let i = 0; i < edges.length; i++) {
      const previous = edges[(i + edges.length - 1) % edges.length]!;
      if (!joins(previous, edges[i]!, ring.length)) {
        start = i;
        closed = false;
        break;
      }
    }

    let i = 0;
    while (i < edges.length) {
      const edge = edges[(start + i) % edges.length]!;
      this.pairs = [];
      if (closed) {
        this.appendJoin(
          edges[(start + edges.length - 1) % edges.length]!,
          edge,
        );
      } else {
        this.pairs.push({
          outer: edge.a,
          extrude: edge.normal,
          exclude: [edge.edgeId, edge.edgeId],
        });
      }
      let previous = edge;
      i++;
      for (; i < edges.length; i++) {
        const next = edges[(start + i) % edges.length]!;
        if (!joins(previous, next, ring.length)) break;
        this.appendJoin(previous, next);
        previous = next;
      }
      if (closed) {
        // Every edge joined: close the loop by repeating the first corner,
        // which keeps the strip an open chain.
        this.appendJoin(previous, edge);
      } else {
        this.pairs.push({
          outer: previous.b,
          extrude: previous.normal,
          exclude: [previous.edgeId, previous.edgeId],
        });
      }
      this.emitChain();
    }
  }

  /**
   * Clips one ring edge to the tile square grown by CLIP_MARGIN. Edges lying
   * along a tile or buffer edge are the artificial cuts of a buffered tile,
   * not shoreline, and are dropped.
   */
  private clipEdge(
    p: Point,
    q: Point,
    ringEdge: number,
    box: [number, number, number, number],
  ): ClippedEdge | null {
    const extent = this.extent;
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return null;
    if (
      dx === 0 &&
      ((p.x <= 0 && p.x === box[0]) || (p.x >= extent && p.x === box[2]))
    )
      return null;
    if (
      dy === 0 &&
      ((p.y <= 0 && p.y === box[1]) || (p.y >= extent && p.y === box[3]))
    )
      return null;
    const margin = extent * CLIP_MARGIN;
    let t0 = 0;
    let t1 = 1;
    const bounds: [number, number][] = [
      [-dx, p.x + margin],
      [dx, extent + margin - p.x],
      [-dy, p.y + margin],
      [dy, extent + margin - p.y],
    ];
    for (const [denominator, numerator] of bounds) {
      if (denominator === 0) {
        if (numerator < 0) return null;
        continue;
      }
      const t = numerator / denominator;
      if (denominator < 0) {
        if (t > t1) return null;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return null;
        if (t < t1) t1 = t;
      }
    }
    if (t1 <= t0) return null;
    return {
      a: { x: p.x + dx * t0, y: p.y + dy * t0 },
      b: { x: p.x + dx * t1, y: p.y + dy * t1 },
      normal: { x: -dy / len, y: dx / len },
      direction: { x: dx / len, y: dy / len },
      startsAtVertex: t0 === 0,
      endsAtVertex: t1 === 1,
      ringEdge,
      edgeId: 0,
    };
  }

  /**
   * Appends the pair(s) at the vertex shared by two joined edges: a miter
   * for convex water corners, a fan around reflex ones (where the water
   * wraps around a point of land).
   */
  private appendJoin(previous: ClippedEdge, next: ClippedEdge): void {
    const n0 = previous.normal;
    const n1 = next.normal;
    const outer = next.a;
    const exclude: [number, number] = [previous.edgeId, next.edgeId];
    const cross =
      previous.direction.x * next.direction.y -
      previous.direction.y * next.direction.x;
    const dot = n0.x * n1.x + n0.y * n1.y;
    if (cross > 0 || (cross === 0 && dot >= 0)) {
      const mx = n0.x + n1.x;
      const my = n0.y + n1.y;
      const len2 = mx * mx + my * my;
      let extrude = n0;
      if (len2 > 1e-12) {
        let scale = 2 / len2;
        const miterLen = scale * Math.sqrt(len2);
        if (miterLen > MITER_LIMIT) scale *= MITER_LIMIT / miterLen;
        extrude = { x: mx * scale, y: my * scale };
      }
      this.pairs.push({ outer, extrude, exclude });
      return;
    }
    const angle = -Math.acos(Math.min(Math.max(dot, -1), 1));
    const steps = Math.max(1, Math.ceil(Math.abs(angle) / FAN_STEP - 1e-9));
    for (let step = 0; step <= steps; step++) {
      const a = (angle * step) / steps;
      const c = Math.cos(a);
      const s = Math.sin(a);
      this.pairs.push({
        outer,
        extrude: { x: n0.x * c - n0.y * s, y: n0.x * s + n0.y * c },
        exclude,
      });
    }
  }

  /**
   * Writes the pending pairs as one strip, splitting it across segments
   * when it would overflow 16-bit indices.
   */
  private emitChain(): void {
    const pairs = this.pairs;
    if (pairs.length < 2) return;
    let first = 0;
    while (first + 1 < pairs.length) {
      let segment = this.segments[this.segments.length - 1];
      if (!segment || segment.vertexLength + 4 > MAX_SEGMENT_VERTICES)
        segment = this.startSegment();
      const room = Math.floor(
        (MAX_SEGMENT_VERTICES - segment.vertexLength) / 2,
      );
      let count = pairs.length - first;
      if (count > room) {
        if (room < 2) {
          segment = this.startSegment();
          count = Math.min(count, Math.floor(MAX_SEGMENT_VERTICES / 2));
        } else count = room;
      }
      const base = segment.vertexLength;
      for (let i = first; i < first + count; i++) {
        const pair = pairs[i]!;
        const { outer, extrude } = pair;
        this.vertexData.push(outer.x, outer.y, 0, 0, 0, 0);
        this.vertexData.push(
          outer.x,
          outer.y,
          extrude.x,
          extrude.y,
          1,
          this.limitFor(pair),
        );
      }
      for (let j = 0; j < count - 1; j++) {
        const o = base + j * 2;
        this.indexData.push(o, o + 1, o + 3, o, o + 3, o + 2);
      }
      segment.vertexLength += count * 2;
      segment.indexLength += (count - 1) * 6;
      // The next run re-emits the last pair so the strip stays joined.
      first += count - 1;
    }
  }

  private startSegment(): Segment {
    const segment: Segment = {
      vertexOffset: this.vertexCount,
      indexOffset: this.indexCount,
      vertexLength: 0,
      indexLength: 0,
    };
    this.segments.push(segment);
    return segment;
  }
}

function joins(
  previous: ClippedEdge,
  next: ClippedEdge,
  ringLength: number,
): boolean {
  return (
    previous.endsAtVertex &&
    next.startsAtVertex &&
    (previous.ringEdge + 1) % ringLength === next.ringEdge
  );
}

/** Distance along the ray (o, d) to segment ab, or null when they miss. */
function rayHit(o: Point, d: Point, a: Point, b: Point): number | null {
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const denominator = d.x * ey - d.y * ex;
  if (Math.abs(denominator) < 1e-12) return null;
  const wx = a.x - o.x;
  const wy = a.y - o.y;
  const s = (wx * ey - wy * ex) / denominator;
  const u = (wx * d.y - wy * d.x) / denominator;
  if (s < 0 || u < -1e-9 || u > 1 + 1e-9) return null;
  return s;
}

/** Even-odd point-in-polygon over a feature's rings, in the layout's coordinates. */
export function containsPoint(
  rings: readonly (readonly Point[])[],
  point: Point,
): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i]!;
      const b = ring[j]!;
      const crosses = a.y > point.y !== b.y > point.y;
      if (
        crosses &&
        point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
      )
        inside = !inside;
    }
  }
  return inside;
}
