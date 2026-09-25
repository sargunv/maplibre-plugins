// particle-features tile layout: the particle slots each feature of a tile
// gets and where each is anchored, as `a_emit` vertices. This is the
// maplibre-gl-js twin of ../../native/src/layout.zig, tested against the same
// fixtures (../../fixtures/layout-{points,lines,polygons}.json); see that file
// for the rules. Every float step is written out the same way (rounding is
// floor(x + 0.5), products in one order) so both produce the same bytes.
//
// - Points: every point the tile owns (0 <= x, y < extent) gets 16 slots.
// - Lines: every segment is clipped to the tile square (Liang–Barsky), and
//   the tile that owns the clipped piece's midpoint keeps the piece. Slots are
//   one per 32 tile units along each path: a piece gets the ones its length
//   carries the path's running count past, so a densely sampled line gets no
//   more than a straight one and a piece may get none. They are anchored at
//   the piece's midpoint with its half length and compass direction, so their
//   particles stay on the piece.
// - Polygons: a 128-unit lattice over the tile with one jittered candidate
//   per cell; each candidate inside the polygon (even-odd over every ring, so
//   holes work) gets one slot.
//
// A tile keeps at most 16383 slots (one segment of 16-bit indices). Past that
// every kind keeps its share: points keep their lowest ranks, the ones
// particle-density draws first, and line and polygon slots an even stride
// (FeatureLayout.finish).

import { pcg3d, u01 } from "./hash.ts";
import { EXTENT, featuresLayout } from "./spec.ts";

/**
 * The a_emit packing (native properties.emit). Every component is an exact
 * f32 integer or quarter:
 * - x, y: the anchor in tile units, a multiple of 1 / ANCHOR_STEPS;
 * - z: lines: angle step * LINE_LENGTH_STEPS + half length (tile units), else 0;
 * - w: slot * SLOT_STRIDE + corner * CORNER_STRIDE + kind.
 */
export const Emit = {
  kindPoint: 0,
  kindLine: 1,
  kindPolygon: 2,
  cornerStride: 4,
  slotStride: 16,
  anchorSteps: 4,
  lineLengthSteps: 8192,
  lineAngleSteps: 1024,
} as const;

/** Floats per vertex: a_emit's four. */
export const FLOATS_PER_VERTEX = 4;
/** Slots of one line piece at most (a full-tile diagonal needs 362). */
export const MAX_LINE_SLOTS = 1023;

export type Kind = "point" | "line" | "polygon";

/** A tile point in integer tile units, as the host hands them to layout. */
export interface Point {
  x: number;
  y: number;
}

/** The vertices one feature kept, for per-feature (data-driven) values. */
export interface Range {
  featureIndex: number;
  firstVertex: number;
  vertexCount: number;
}

/** Slots that share one anchor: a point's 16, a line piece's, a polygon cell's one. */
interface Group {
  x: number;
  y: number;
  z: number;
  kind: number;
  slots: number;
}

/** A feature that produced groups: its own run up to `groupEnd`. */
interface LaidOutFeature {
  index: number;
  groupEnd: number;
}

/** A non-horizontal polygon edge in quarter tile units, from its lower end: y0 < y1. */
export interface Edge {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Rounds halves up, written out as in every twin (Zig's @round rounds them away from zero). */
function round(x: number): number {
  return Math.floor(x + 0.5);
}

/** floor(n / d) for non-negative integers whose products stay below 2^53. */
function divide(n: number, d: number): number {
  let q = Math.floor(n / d);
  while (q * d > n) q--;
  while ((q + 1) * d <= n) q++;
  return q;
}

/** Snaps a tile coordinate to the anchor grid (1/4 tile unit). */
function quarter(x: number): number {
  return round(Emit.anchorSteps * x) / Emit.anchorSteps;
}

/** A candidate's offset from its cell center in quarter tile units, in [-128, 128]. */
function jitter(h: number): number {
  const offset = (u01(h) - 0.5) * (featuresLayout.polygonCell / 2);
  return round(Emit.anchorSteps * offset);
}

/**
 * Even-odd test of (x, y) in quarter units: counts the edges a ray to +x
 * crosses, each edge spanning y0 <= y < y1 so a vertex on the ray counts
 * once. The crossing test is multiplied out, so it is exact in doubles. A
 * point exactly on an edge is inside only where the polygon extends to its
 * +x side (or +y side on a horizontal edge), so polygons sharing an edge
 * never both claim it.
 */
export function inside(edges: readonly Edge[], x: number, y: number): boolean {
  let odd = false;
  for (const edge of edges) {
    if (y < edge.y0 || y >= edge.y1) continue;
    if (
      (x - edge.x0) * (edge.y1 - edge.y0) <
      (y - edge.y0) * (edge.x1 - edge.x0)
    )
      odd = !odd;
  }
  return odd;
}

export class FeatureLayout {
  /** Slots of every group, before the cap. */
  slotCount = 0;
  /** Point groups, each of featuresLayout.pointSlots slots. */
  pointCount = 0;
  /** finish() output: four a_emit vertices per kept slot, grouped by feature. */
  vertices = new Float32Array(0);
  /** finish() output: one range per feature that kept any slot. */
  ranges: Range[] = [];

  private readonly groups: Group[] = [];
  private readonly features: LaidOutFeature[] = [];

  /**
   * `maxSlots` is the most slots the tile keeps (spec
   * layout.maxParticlesPerTile); the fixtures lower it to test the thinning.
   */
  constructor(
    readonly extent: number = EXTENT,
    readonly maxSlots: number = featuresLayout.maxParticlesPerTile,
  ) {}

  /** Kept slots (quads) after finish(). */
  get quads(): number {
    return this.vertices.length / (4 * FLOATS_PER_VERTEX);
  }

  /**
   * Lays out one feature: its points (one per path, or several in one), line
   * paths, or polygon rings. Features must come in the order their slots
   * should be kept in.
   */
  add(
    kind: Kind,
    featureIndex: number,
    paths: readonly (readonly Point[])[],
  ): void {
    const start = this.groups.length;
    if (kind === "point") {
      for (const path of paths) for (const p of path) this.addPoint(p);
    } else if (kind === "line") {
      for (const path of paths) {
        // The kept length of the path so far.
        let run = 0;
        for (let i = 0; i + 1 < path.length; i++)
          run = this.addSegment(path[i]!, path[i + 1]!, run);
      }
    } else {
      this.addPolygon(paths);
    }
    if (this.groups.length > start)
      this.features.push({ index: featureIndex, groupEnd: this.groups.length });
  }

  private addGroup(group: Group): void {
    this.groups.push(group);
    this.slotCount += group.slots;
  }

  private owns(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.extent && y < this.extent;
  }

  private addPoint(p: Point): void {
    if (!this.owns(p.x, p.y)) return;
    this.addGroup({
      x: p.x,
      y: p.y,
      z: 0,
      kind: Emit.kindPoint,
      slots: featuresLayout.pointSlots,
    });
    this.pointCount++;
  }

  /**
   * One line segment: clipped to [0, extent]², kept when at least one tile
   * unit long and its midpoint is this tile's. `run` is the kept length of
   * its path before it; returns the kept length after it.
   */
  private addSegment(a: Point, b: Point, run: number): number {
    const e = this.extent;
    const ax = a.x;
    const ay = a.y;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    // Liang–Barsky: p·t <= q for each side of the square.
    let t0 = 0;
    let t1 = 1;
    const sides = [
      [-dx, ax],
      [dx, e - ax],
      [-dy, ay],
      [dy, e - ay],
    ] as const;
    for (const [p, q] of sides) {
      if (p === 0) {
        if (q < 0) return run;
        continue;
      }
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
    if (t0 > t1) return run;
    const x0 = ax + t0 * dx;
    const y0 = ay + t0 * dy;
    const x1 = ax + t1 * dx;
    const y1 = ay + t1 * dy;
    const length = Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));
    if (length < 1) return run;
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2;
    if (!this.owns(mx, my)) return run;
    // Compass direction (clockwise from north, y down) in 1024 steps.
    const steps = Emit.lineAngleSteps;
    const theta = Math.atan2(dx, -dy);
    const direction =
      ((round((theta / (2 * Math.PI)) * steps) % steps) + steps) % steps;
    const halfLength = round(length / 2);
    // One slot per spacing along the path: the ones this piece's length
    // carries the path's count past.
    const spacing = featuresLayout.lineSlotSpacing;
    const after = run + length;
    const slots = Math.min(
      round(after / spacing) - round(run / spacing),
      MAX_LINE_SLOTS,
    );
    if (slots > 0)
      this.addGroup({
        x: quarter(mx),
        y: quarter(my),
        z: direction * Emit.lineLengthSteps + halfLength,
        kind: Emit.kindLine,
        slots,
      });
    return after;
  }

  /**
   * Every lattice cell of the tile that the polygon's bounding box touches
   * tests its jittered candidate; rows collect the edges their candidates can
   * cross first.
   */
  private addPolygon(rings: readonly (readonly Point[])[]): void {
    const q = Emit.anchorSteps;
    const edges: Edge[] = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i]!;
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
        // Rings close back to their first point; horizontal edges (including
        // a repeated closing point) never cross a scanline.
        const next = ring[(i + 1) % ring.length]!;
        if (p.y === next.y) continue;
        const [lo, hi] = p.y < next.y ? [p, next] : [next, p];
        edges.push({ x0: q * lo.x, y0: q * lo.y, x1: q * hi.x, y1: q * hi.y });
      }
    }
    const extent = this.extent;
    const cell = featuresLayout.polygonCell;
    const cells = Math.floor(extent / cell);
    if (edges.length === 0 || cells === 0) return;
    if (maxX < 0 || maxY < 0 || minX >= extent || minY >= extent) return;
    const clampCell = (x: number) =>
      Math.min(Math.max(Math.floor(x / cell), 0), cells - 1);
    const a0 = clampCell(minX);
    const a1 = clampCell(maxX);
    const b0 = clampCell(minY);
    const b1 = clampCell(maxY);
    // Candidates sit at most a quarter cell from their cell's center.
    const reach = q * (cell / 4);
    const band: Edge[] = [];
    for (let b = b0; b <= b1; b++) {
      const centerY = q * (cell * b + cell / 2);
      band.length = 0;
      for (const edge of edges) {
        if (edge.y0 <= centerY + reach && edge.y1 > centerY - reach)
          band.push(edge);
      }
      if (band.length === 0) continue;
      for (let a = a0; a <= a1; a++) {
        const h = pcg3d(a, b, 0x51);
        const x = q * (cell * a + cell / 2) + jitter(h[0]);
        const y = centerY + jitter(h[1]);
        if (!inside(band, x, y)) continue;
        this.addGroup({
          x: x / q,
          y: y / q,
          z: 0,
          kind: Emit.kindPolygon,
          slots: 1,
        });
      }
    }
  }

  /**
   * Writes four vertices per kept slot, feature by feature, and one range per
   * feature that kept any. Past `maxSlots` of T slots, each kind keeps its
   * share: the Tp point slots Bp = floor(max·Tp/T), and the To line and
   * polygon slots Bo = max - Bp. Exactly max are kept.
   * - The shader draws a point's slots in rank order up to particle-density,
   *   so points keep their lowest ranks: with Bp = k·P + rem over P points,
   *   every point keeps ranks below k, and point p (in feature and group
   *   order) also keeps rank k iff floor((p+1)·rem/P) > floor(p·rem/P).
   * - Line and polygon slots each draw a random share, so they keep an even
   *   stride: the o-th (in the same order) is kept iff
   *   floor((o+1)·Bo/To) > floor(o·Bo/To).
   */
  finish(): void {
    const total = this.slotCount;
    const cap = this.maxSlots;
    const kept = Math.min(total, cap);
    const points = this.pointCount;
    const pointTotal = featuresLayout.pointSlots * points;
    const otherTotal = total - pointTotal;
    const pointBudget =
      total > cap ? divide(cap * pointTotal, total) : pointTotal;
    const otherBudget = total > cap ? cap - pointBudget : otherTotal;
    const ranks = points > 0 ? divide(pointBudget, points) : 0;
    const extra = pointBudget - ranks * points;
    const vertices = new Float32Array(4 * FLOATS_PER_VERTEX * kept);
    const ranges: Range[] = [];
    let p = 0;
    let o = 0;
    let v = 0;
    let start = 0;
    const addSlot = (group: Group, slot: number) => {
      const code = slot * Emit.slotStride + group.kind;
      for (let corner = 0; corner < 4; corner++, v++) {
        const at = v * FLOATS_PER_VERTEX;
        vertices[at] = group.x;
        vertices[at + 1] = group.y;
        vertices[at + 2] = group.z;
        vertices[at + 3] = code + corner * Emit.cornerStride;
      }
    };
    for (const feature of this.features) {
      const first = v;
      for (let g = start; g < feature.groupEnd; g++) {
        const group = this.groups[g]!;
        if (group.kind === Emit.kindPoint) {
          const keep =
            ranks +
            (divide((p + 1) * extra, points) > divide(p * extra, points)
              ? 1
              : 0);
          p++;
          for (let slot = 0; slot < keep; slot++) addSlot(group, slot);
        } else {
          for (let slot = 0; slot < group.slots; slot++, o++) {
            if (
              divide((o + 1) * otherBudget, otherTotal) >
              divide(o * otherBudget, otherTotal)
            )
              addSlot(group, slot);
          }
        }
      }
      start = feature.groupEnd;
      if (v > first)
        ranges.push({
          featureIndex: feature.index,
          firstVertex: first,
          vertexCount: v - first,
        });
    }
    if (v !== 4 * kept)
      throw new Error(`particle layout kept ${v / 4} slots, expected ${kept}`);
    this.vertices = vertices;
    this.ranges = ranges;
  }
}

/** FNV-1a (32-bit) over a vertex stream as the host receives it: little-endian f32s. */
export function digest(vertices: Float32Array): number {
  const bytes = new DataView(new ArrayBuffer(4));
  let hash = 0x811c9dc5;
  for (const value of vertices) {
    bytes.setFloat32(0, value, true);
    for (let i = 0; i < 4; i++) {
      hash ^= bytes.getUint8(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash;
}
