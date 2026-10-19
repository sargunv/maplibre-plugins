// Building geometry: walls and a roof:shape roof for every polygon of a
// tile. This is the maplibre-gl-js twin of ../../native/src/layout.zig:
// the same cleanup, frames, profiles and vertex order, tested against the
// same fixtures (../../fixtures/layout). See ../../README.md for the
// contract the shaders rely on.
//
// Vertex format: 7 float32, interleaved.
//   a_pos  = (x, y, run): tile units; run is the feature's horizontal
//            eave-to-ridge distance, which building-roof-angle turns into a
//            roof height (0 for flat roofs).
//   a_roof = (n, kind, gx, gy):
//     n    relative roof elevation in [0, 1]; z = wallTop + n × roofHeight.
//     kind 0 wall bottom (z = base, n = 0), 1 wall top (n follows the roof
//          along the wall, so gable ends rise), 2 roof, 3 roof underside
//          (an overhang: onion's bulge; its normal points down).
//     gx, gy  walls: outward unit normal in tile coordinates. Roofs: the
//          gradient of n per tile unit; the normal of the roof surface is
//          ±(-roofHeight·gx, -roofHeight·gy, 1) with heights in tile units
//          (+ for kind 2, - for kind 3).
//
// Winding: core fill-extrusion's. The tile frame (x right, y down, z up) is
// left-handed, so in tile coordinates cross(b - a, c - a) of every triangle
// points into the building, and every triangle is counter-clockwise on
// screen seen from outside: front faces for back-face culling with CCW
// front faces. Roof triangles have negative signed area (shoelace) in tile
// coordinates and undersides positive.
//
// Sharing: piecewise-linear roofs share vertices only within one planar
// facet (crisp ridges and hips); curved roofs share them within a smooth
// group with interpolated gradients. Each wall edge is one planar strip,
// split where the roof's break lines cross it.
//
// Tile copies: every tile draws every footprint it has, buffer copies
// included, as core fill-extrusion does. A copy the source did not cut is
// the same footprint in every tile up to a translation, so it is built in
// a frame anchored on the footprint itself (its floored minimum corner):
// every copy computes the same roof, bit for bit for integer coordinates.
// A cut copy cannot know its roof, and draws roofless (see addPolygon).

import {
  classifyRings,
  isClipEdge,
  minimumAreaRectangle,
  NO_CUTS,
  type Point,
  type Polygon,
  type TileBounds,
} from "./footprint.ts";
import {
  directionVector,
  envelope,
  frameFor,
  MIN_HALF_WIDTH,
  type Plane,
  roofModel,
  type RoofModel,
  stripGradient,
} from "./roof.ts";
import { straightSkeleton, type SkeletonPoint } from "./skeleton.ts";
import {
  ROOF_ORIENTATIONS,
  ROOF_SHAPES,
  type RoofOrientation,
  type RoofShape,
} from "./spec.ts";
import { triangulate } from "./triangulate.ts";

export type { Point, TileBounds } from "./footprint.ts";
export { tileBounds } from "./footprint.ts";

/** Floats per vertex: a_pos (x, y, run), a_roof (n, kind, gx, gy). */
export const FLOATS_PER_VERTEX = 7;
/** Byte offsets of the two attributes in a vertex. */
export const POS_OFFSET = 0;
export const ROOF_OFFSET = 12;

export const WALL_BOTTOM = 0;
export const WALL_TOP = 1;
export const ROOF = 2;
export const ROOF_UNDERSIDE = 3;

/** Vertices per segment stay addressable by 16-bit indices. */
export const MAX_SEGMENT_VERTICES = 65535;
/**
 * Radial roofs need their center at least this far, in tile units, inside
 * every edge of the footprint.
 */
export const MIN_KERNEL_DISTANCE = 0.5;
/** Clipped roof pieces with less area (tile units²) are dropped. */
const MIN_PIECE_AREA = 1e-6;
/**
 * Clipped points closer than this, in tile units, merge: where several
 * break lines meet, each facet computes the meeting point from a different
 * pair of lines, a few ulps apart.
 */
export const MERGE_DISTANCE = 1 / 1024;
/**
 * Points where two planes differ by no more than this (in n) lie on their
 * break line. Without it, rounding puts points on a line on alternating
 * sides of it, which makes crossings at the wrong place, or none at all
 * (a division by zero) when the line runs along a triangle edge.
 */
export const ON_LINE = 1e-9;

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

/** The evaluated layout properties of one feature. */
export interface LayoutValues {
  /** building-roof-shape; unknown values draw flat roofs. */
  shape?: string;
  /** building-roof-orientation; unknown values mean along. */
  orientation?: string;
  /** building-roof-direction in degrees; negative means unset. */
  direction?: number;
}

/** One vertex's fields, for tests and debugging. */
export interface Vertex {
  x: number;
  y: number;
  run: number;
  n: number;
  kind: number;
  gx: number;
  gy: number;
}

/** A group of vertices and triangles emitted together. */
class Mesh {
  readonly data: number[] = [];
  readonly triangles: number[] = [];
  private readonly keys = new Map<string, number>();

  get size(): number {
    return this.data.length / FLOATS_PER_VERTEX;
  }

  add(v: Vertex): number {
    this.data.push(v.x, v.y, v.run, v.n, v.kind, v.gx, v.gy);
    return this.size - 1;
  }

  /** Adds a vertex once per key. */
  shared(key: string, make: () => Vertex): number {
    const found = this.keys.get(key);
    if (found !== undefined) return found;
    const index = this.add(make());
    this.keys.set(key, index);
    return index;
  }

  triangle(a: number, b: number, c: number): void {
    this.triangles.push(a, b, c);
  }
}

interface ClipVertex {
  x: number;
  y: number;
  /** Bits of the original triangle edges the vertex lies on. */
  mask: number;
}

export class BuildingLayout {
  private readonly vertexData: number[] = [];
  private readonly indexData: number[] = [];
  readonly segments: Segment[] = [];
  readonly ranges: Range[] = [];
  readonly extent: number;
  /** The bounds of every feature of the tile, which locate its cut lines. */
  readonly bounds: TileBounds;
  /** Where the polygon being built has its frame, in tile units. */
  private origin: Point = { x: 0, y: 0 };

  /**
   * `bounds` covers every point of every feature the tile lays out
   * (`tileBounds`); without it nothing counts as cut.
   */
  constructor(extent: number, bounds: TileBounds = NO_CUTS) {
    this.extent = extent;
    this.bounds = bounds;
  }

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

  vertex(i: number): Vertex {
    return this.exactVertex(i, Math.fround);
  }

  /** A vertex before it is narrowed to float32, for tests. */
  exactVertex(i: number, f: (x: number) => number = (x) => x): Vertex {
    const o = i * FLOATS_PER_VERTEX;
    const d = this.vertexData;
    return {
      x: f(d[o]!),
      y: f(d[o + 1]!),
      run: f(d[o + 2]!),
      n: f(d[o + 3]!),
      kind: d[o + 4]!,
      gx: f(d[o + 5]!),
      gy: f(d[o + 6]!),
    };
  }

  /**
   * Adds one polygon feature: its rings in tile coordinates (MVT order and
   * winding: each exterior followed by its holes) and its evaluated layout
   * properties. Each exterior with its holes is one building.
   */
  addFeature(
    rings: readonly (readonly Point[])[],
    featureIndex: number,
    values: LayoutValues = {},
  ): void {
    const firstVertex = this.vertexCount;
    const shape: RoofShape = (ROOF_SHAPES as readonly string[]).includes(
      values.shape ?? "",
    )
      ? (values.shape as RoofShape)
      : "flat";
    const orientation: RoofOrientation = (
      ROOF_ORIENTATIONS as readonly string[]
    ).includes(values.orientation ?? "")
      ? (values.orientation as RoofOrientation)
      : "along";
    const direction = directionVector(values.direction ?? -1);
    for (const polygon of classifyRings(rings, this.extent, this.bounds))
      this.addPolygon(polygon, shape, orientation, direction);
    const vertexCount = this.vertexCount - firstVertex;
    if (vertexCount > 0)
      this.ranges.push({ featureIndex, firstVertex, vertexCount });
  }

  /**
   * Builds one polygon in its own frame. Every copy is drawn, in every tile
   * that has it. An uncut copy gets its whole roof. A cut copy is roofless:
   * walls up to the eaves and a lid there, which the real roof of an uncut
   * copy in another tile covers wherever both are drawn (it is never below
   * the eaves). Flat shapes and courtyards stay flat, as their whole
   * footprint is. Walls on cut edges are skipped, as maplibre-gl-js's
   * fill-extrusion does.
   */
  private addPolygon(
    polygon: Polygon,
    shape: RoofShape,
    orientation: RoofOrientation,
    direction: Point | null,
  ): void {
    const rings = [polygon.outer, ...polygon.holes];
    const walls = rings.map((ring) =>
      ring.map(
        (a, i) =>
          !isClipEdge(
            a,
            ring[(i + 1) % ring.length]!,
            this.extent,
            this.bounds,
          ),
      ),
    );
    let minX = Infinity;
    let minY = Infinity;
    for (const p of polygon.outer) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
    }
    const origin = { x: Math.floor(minX), y: Math.floor(minY) };
    const local = (ring: Point[]): Point[] =>
      ring.map((p) => ({ x: p.x - origin.x, y: p.y - origin.y }));
    const footprint: Polygon = {
      outer: local(polygon.outer),
      holes: polygon.holes.map(local),
      cut: polygon.cut,
    };
    this.origin = origin;
    const model = footprint.cut
      ? cutModel(footprint, shape, orientation, direction)
      : modelFor(footprint, shape, orientation, direction);
    if (model.type === "radial" && !radialFits(footprint.outer, model.center))
      return this.build(footprint, { type: "flat" }, walls);
    this.build(footprint, model, walls);
  }

  /** `walls[r][i]`: whether edge i of ring r (outer, then holes) gets a wall. */
  private build(
    polygon: Polygon,
    model: RoofModel,
    walls: readonly (readonly boolean[])[],
  ): void {
    const run = model.type === "flat" ? 0 : model.run;
    [polygon.outer, ...polygon.holes].forEach((ring, r) =>
      this.addWalls(ring, walls[r]!, model, run),
    );
    switch (model.type) {
      case "flat":
        return this.addFlatRoof(polygon, 1, 0);
      case "roofless":
        return this.addFlatRoof(polygon, 0, run);
      case "planes":
        return this.addPlaneRoof(polygon.outer, model);
      case "radial":
        return this.addRadialRoof(polygon.outer, model);
      case "skeleton":
        return this.addSkeletonRoof(model);
    }
  }

  private addSkeletonRoof(
    model: Extract<RoofModel, { type: "skeleton" }>,
  ): void {
    for (const face of model.faces) {
      const bands = model.mansard ? [0, 1] : [0];
      for (const band of bands) {
        const points = model.mansard
          ? clipSkeletonFace(face.points, model.run / 3, band === 0)
          : face.points;
        if (points.length < 3) continue;
        const slope = model.mansard ? (band === 0 ? 2 : 0.5) : 1;
        const intercept = model.mansard && band === 1 ? 0.5 : 0;
        const mesh = new Mesh();
        // A center fan preserves collinear event vertices shared with adjacent
        // faces. Triangles need no extra center, which can collapse in float32.
        const center = { x: 0, y: 0, time: 0 };
        for (const p of points) {
          center.x += p.x / points.length;
          center.y += p.y / points.length;
          center.time += p.time / points.length;
        }
        for (const p of [center, ...points])
          mesh.add({
            x: p.x,
            y: p.y,
            run: model.run,
            n: Math.max(
              0,
              Math.min(1, (slope * p.time) / model.run + intercept),
            ),
            kind: ROOF,
            gx: (slope * face.normal.x) / model.run,
            gy: (slope * face.normal.y) / model.run,
          });
        if (points.length === 3) {
          if (
            triangleArea2(f32(points[0]!), f32(points[1]!), f32(points[2]!)) > 0
          )
            mesh.triangle(1, 2, 3);
        } else
          for (let i = 0; i < points.length; i++) {
            const a = center;
            const b = points[i]!;
            const c = points[(i + 1) % points.length]!;
            if (triangleArea2(f32(a), f32(b), f32(c)) > 0)
              mesh.triangle(0, i + 1, ((i + 1) % points.length) + 1);
          }
        this.emit(mesh);
      }
    }
  }

  // ---- Walls ---------------------------------------------------------------

  private addWalls(
    ring: readonly Point[],
    walls: readonly boolean[],
    model: RoofModel,
    run: number,
  ): void {
    for (let i = 0; i < ring.length; i++) {
      if (!walls[i]) continue;
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.sqrt(dx * dx + dy * dy);
      // Outward: the left of the edge for positive-area exteriors, and into
      // the courtyard for negative-area holes.
      const gx = dy / length;
      const gy = -dx / length;
      const stops = this.wallStops(a, b, model);
      const mesh = new Mesh();
      for (const p of stops) {
        mesh.add({ x: p.x, y: p.y, run, n: 0, kind: WALL_BOTTOM, gx, gy });
        mesh.add({ x: p.x, y: p.y, run, n: p.n, kind: WALL_TOP, gx, gy });
      }
      for (let k = 0; k + 1 < stops.length; k++) {
        const o = 2 * k;
        mesh.triangle(o, o + 2, o + 1);
        mesh.triangle(o + 1, o + 2, o + 3);
      }
      this.emit(mesh);
    }
  }

  /**
   * Points along a wall top where its slope changes, with n: the ends and
   * every crossing of a break line between two facets of the roof.
   */
  private wallStops(
    a: Point,
    b: Point,
    model: RoofModel,
  ): { x: number; y: number; n: number }[] {
    if (model.type !== "planes") {
      const n = model.type === "flat" ? 1 : 0;
      return [
        { x: a.x, y: a.y, n },
        { x: b.x, y: b.y, n },
      ];
    }
    const planes = model.planes;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length2 = dx * dx + dy * dy;
    const cuts: { t: number; p: Point }[] = [];
    for (let k = 0; k < planes.length; k++) {
      for (let j = k + 1; j < planes.length; j++) {
        const line = difference(planes[k]!, planes[j]!);
        if (side(evaluate(line, a)) * side(evaluate(line, b)) >= 0) continue;
        // A real break: both planes are the roof there.
        const p = crossing(a, b, line);
        const n = rawEnvelope(planes, p);
        if (
          Math.abs(evaluate(planes[k]!, p) - n) > 1e-9 ||
          Math.abs(evaluate(planes[j]!, p) - n) > 1e-9
        )
          continue;
        cuts.push({ t: ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2, p });
      }
    }
    // A stable sort, so equal crossings keep their pair order.
    cuts.sort((p, q) => p.t - q.t);
    const stops = [{ x: a.x, y: a.y, n: envelope(planes, a.x, a.y) }];
    for (const { p } of cuts) {
      const last = stops[stops.length - 1]!;
      if (near(p, last) || near(p, b)) continue;
      stops.push({ x: p.x, y: p.y, n: envelope(planes, p.x, p.y) });
    }
    stops.push({ x: b.x, y: b.y, n: envelope(planes, b.x, b.y) });
    return stops;
  }

  // ---- Roofs ---------------------------------------------------------------

  /** A triangulation at one n: 1 for flat roofs, 0 for roofless lids. */
  private addFlatRoof(polygon: Polygon, n: number, run: number): void {
    const { points, triangles } = triangulate(polygon.outer, polygon.holes);
    const mesh = new Mesh();
    for (let t = 0; t < triangles.length; t += 3) {
      const ids = [triangles[t]!, triangles[t + 1]!, triangles[t + 2]!].map(
        (i) => {
          const p = points[i]!;
          return mesh.shared(`${p.x},${p.y}`, () => ({
            x: p.x,
            y: p.y,
            run,
            n,
            kind: ROOF,
            gx: 0,
            gy: 0,
          }));
        },
      );
      mesh.triangle(ids[0]!, ids[1]!, ids[2]!);
    }
    this.emit(mesh);
  }

  /**
   * A frame shape: every footprint triangle is clipped to every facet, so
   * each output triangle is planar. Crossings on a triangle edge are
   * computed from the edge's original endpoints, so the triangles on both
   * sides of an edge, and the wall below a footprint edge, get the same
   * points.
   */
  private addPlaneRoof(
    outer: readonly Point[],
    model: Extract<RoofModel, { type: "planes" }>,
  ): void {
    const { points, triangles } = triangulate(outer);
    const { planes, strips, run, frame } = model;
    // Facets that share vertices: one per plane, or one per strip group.
    const groups: number[][] = [];
    if (strips) {
      for (let k = 0; k < planes.length; k++) {
        const g = strips.groups[k]!;
        (groups[g] ??= []).push(k);
      }
    } else {
      for (let k = 0; k < planes.length; k++) groups.push([k]);
    }
    for (const group of groups) {
      const mesh = new Mesh();
      for (const k of group) {
        const plane = planes[k]!;
        for (let t = 0; t < triangles.length; t += 3) {
          const corners = [
            points[triangles[t]!]!,
            points[triangles[t + 1]!]!,
            points[triangles[t + 2]!]!,
          ] as const;
          const piece = clipToFacet(corners, planes, k);
          if (piece.length < 3 || area2(piece) <= 2 * MIN_PIECE_AREA) continue;
          const ids = piece.map((p) =>
            mesh.shared(`${p.x},${p.y}`, () => {
              let gx = plane.gx;
              let gy = plane.gy;
              if (strips) {
                const v =
                  (p.x - frame.center.x) * frame.v.x +
                  (p.y - frame.center.y) * frame.v.y;
                const slope = stripGradient(strips, k, v);
                gx = slope * frame.v.x;
                gy = slope * frame.v.y;
              }
              return {
                x: p.x,
                y: p.y,
                run,
                n: envelope(planes, p.x, p.y),
                kind: ROOF,
                gx,
                gy,
              };
            }),
          );
          for (let i = 1; i + 1 < piece.length; i++) {
            // Skip slivers that would vanish or flip in float32, judged in
            // the footprint's frame so that every copy keeps the same
            // triangles. (At its tile position, a sliver thinner than
            // float32's rounding there may still flip: it is culled, a
            // crack under a thousandth of a tile unit.)
            if (
              triangleArea2(
                f32(piece[0]!),
                f32(piece[i]!),
                f32(piece[i + 1]!),
              ) <= 0
            )
              continue;
            mesh.triangle(ids[0]!, ids[i]!, ids[i + 1]!);
          }
        }
      }
      this.emit(mesh);
    }
  }

  /**
   * A radial shape: rings of the footprint scaled toward the center by
   * each profile step. Every band × edge quad is planar (n is linear in the
   * scale, and the scale is linear across each edge's sector).
   */
  private addRadialRoof(
    outer: readonly Point[],
    model: Extract<RoofModel, { type: "radial" }>,
  ): void {
    const { steps, center, run } = model;
    const count = outer.length;
    // Gradient of the sector scale ρ (0 at the center, 1 on edge i).
    const sector: Point[] = [];
    for (let i = 0; i < count; i++) {
      const a = outer[i]!;
      const b = outer[(i + 1) % count]!;
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const c = ex * (center.y - a.y) - ey * (center.x - a.x);
      sector.push({ x: ey / c, y: -ex / c });
    }
    const bands = steps.length - 1;
    const slope = (k: number): number =>
      (steps[k + 1]![0] - steps[k]![0]) / (steps[k + 1]![1] - steps[k]![1]);
    const kindOf = (k: number): number =>
      slope(k) <= 0 ? ROOF : ROOF_UNDERSIDE;
    const point = (k: number, i: number): Point => {
      const r = steps[k]![1];
      const q = outer[i % count]!;
      if (r === 1) return q;
      if (r === 0) return center;
      return {
        x: center.x + r * (q.x - center.x),
        y: center.y + r * (q.y - center.y),
      };
    };

    if (!model.smooth) {
      // One planar face per band and edge.
      for (let k = 0; k < bands; k++) {
        const s = slope(k);
        for (let i = 0; i < count; i++) {
          const g = sector[i]!;
          const mesh = new Mesh();
          const corner = (kk: number, ii: number): number => {
            const p = point(kk, ii);
            return mesh.add({
              x: p.x,
              y: p.y,
              run,
              n: steps[kk]![0],
              kind: kindOf(k),
              gx: s * g.x,
              gy: s * g.y,
            });
          };
          this.radialFace(mesh, steps, k, i, corner);
          this.emit(mesh);
        }
      }
      return;
    }

    // Smooth groups: runs of bands facing the same way.
    let start = 0;
    while (start < bands) {
      let end = start;
      while (end + 1 < bands && kindOf(end + 1) === kindOf(start)) end++;
      const kind = kindOf(start);
      const mesh = new Mesh();
      const ringSlope = (k: number): number => {
        const before = k - 1 >= start;
        const after = k <= end;
        if (before && after) return (slope(k - 1) + slope(k)) / 2;
        return before ? slope(k - 1) : slope(k);
      };
      const gradient = (k: number, i: number): Point => {
        const s = ringSlope(k);
        const g0 = sector[(i + count - 1) % count]!;
        const g1 = sector[i % count]!;
        return { x: (s * (g0.x + g1.x)) / 2, y: (s * (g0.y + g1.y)) / 2 };
      };
      for (let k = start; k <= end; k++) {
        for (let i = 0; i < count; i++) {
          const corner = (
            kk: number,
            ii: number,
            apexOf?: [number, number],
          ): number => {
            if (steps[kk]![1] === 0) {
              if (apexOf && model.pointed) {
                // A pointed top: each face gets its own apex, with the mean
                // gradient of its base.
                const g0 = gradient(apexOf[0], apexOf[1]);
                const g1 = gradient(apexOf[0], apexOf[1] + 1);
                return mesh.add({
                  x: center.x,
                  y: center.y,
                  run,
                  n: steps[kk]![0],
                  kind,
                  gx: (g0.x + g1.x) / 2,
                  gy: (g0.y + g1.y) / 2,
                });
              }
              return mesh.shared("apex", () => ({
                x: center.x,
                y: center.y,
                run,
                n: steps[kk]![0],
                kind,
                gx: 0,
                gy: 0,
              }));
            }
            const wrapped = ii % count;
            return mesh.shared(`${kk},${wrapped}`, () => {
              const p = point(kk, wrapped);
              const g = gradient(kk, wrapped);
              return {
                x: p.x,
                y: p.y,
                run,
                n: steps[kk]![0],
                kind,
                gx: g.x,
                gy: g.y,
              };
            });
          };
          this.radialFace(mesh, steps, k, i, corner);
        }
      }
      this.emit(mesh);
      start = end + 1;
    }
  }

  /** The triangles of band k across edge i, from ring k inward to ring k + 1. */
  private radialFace(
    mesh: Mesh,
    steps: readonly (readonly [number, number])[],
    k: number,
    i: number,
    corner: (k: number, i: number, apexOf?: [number, number]) => number,
  ): void {
    const a = corner(k, i);
    const b = corner(k, i + 1);
    if (steps[k + 1]![1] === 0) {
      mesh.triangle(a, b, corner(k + 1, i, [k, i]));
      return;
    }
    const c = corner(k + 1, i + 1);
    const d = corner(k + 1, i);
    mesh.triangle(a, b, c);
    mesh.triangle(a, c, d);
  }

  // ---- Output --------------------------------------------------------------

  /**
   * Appends a mesh's triangles, in order, to the current segment, starting
   * a new one whenever the next triangle's new vertices would not fit.
   * Vertices are written on first use, so a mesh may straddle segments.
   */
  private emit(mesh: Mesh): void {
    const map = new Int32Array(mesh.size).fill(-1);
    let segment = this.segments[this.segments.length - 1];
    for (let t = 0; t < mesh.triangles.length; t += 3) {
      const tri = [
        mesh.triangles[t]!,
        mesh.triangles[t + 1]!,
        mesh.triangles[t + 2]!,
      ];
      let fresh = 0;
      for (let k = 0; k < 3; k++) {
        if (map[tri[k]!]! < 0 && tri.indexOf(tri[k]!) === k) fresh++;
      }
      if (!segment || segment.vertexLength + fresh > MAX_SEGMENT_VERTICES) {
        segment = {
          vertexOffset: this.vertexCount,
          indexOffset: this.indexCount,
          vertexLength: 0,
          indexLength: 0,
        };
        this.segments.push(segment);
        map.fill(-1);
      }
      for (const v of tri) {
        if (map[v]! < 0) {
          map[v] = segment.vertexLength++;
          const o = v * FLOATS_PER_VERTEX;
          // From the footprint's frame back to tile units.
          this.vertexData.push(
            mesh.data[o]! + this.origin.x,
            mesh.data[o + 1]! + this.origin.y,
          );
          for (let f = 2; f < FLOATS_PER_VERTEX; f++)
            this.vertexData.push(mesh.data[o + f]!);
        }
      }
      // Meshes are built facing out by cross(b - a, c - a) in tile
      // coordinates; the output swaps b and c into core's winding.
      this.indexData.push(map[tri[0]!]!, map[tri[2]!]!, map[tri[1]!]!);
      segment.indexLength += 3;
    }
  }
}

/** The roof model of an uncut footprint, or flat for one a shape cannot take. */
function modelFor(
  polygon: Polygon,
  shape: RoofShape,
  orientation: RoofOrientation,
  direction: Point | null,
): RoofModel {
  if (shape === "flat" || shape === "many") return { type: "flat" };
  const rect = minimumAreaRectangle(polygon.outer);
  if (!rect || rect.halfShort < MIN_HALF_WIDTH) return { type: "flat" };
  if (shape === "hipped" || shape === "mansard") {
    const skeleton = straightSkeleton(polygon);
    return skeleton && skeleton.run >= MIN_HALF_WIDTH
      ? { type: "skeleton", mansard: shape === "mansard", ...skeleton }
      : { type: "flat" };
  }
  if (polygon.holes.length > 0) return { type: "flat" };
  const frame = frameFor(rect, orientation, direction);
  return roofModel(shape, rect, frame, polygon.outer, direction);
}

/**
 * The model of a cut copy: flat where the whole footprint is flat too (a
 * flat shape, or an unsupported courtyard shape), else
 * roofless, with the run the piece would have if it were whole. Its eaves
 * sit exactly at the real roof's with building-roof-height; with
 * building-roof-angle the run is an estimate.
 */
function cutModel(
  polygon: Polygon,
  shape: RoofShape,
  orientation: RoofOrientation,
  direction: Point | null,
): RoofModel {
  if (
    shape === "flat" ||
    shape === "many" ||
    (polygon.holes.length > 0 && shape !== "hipped" && shape !== "mansard")
  )
    return { type: "flat" };
  const rect = minimumAreaRectangle(polygon.outer);
  if (!rect) return { type: "roofless", run: 0 };
  const frame = frameFor(rect, orientation, direction);
  const model = roofModel(shape, rect, frame, polygon.outer, direction);
  return {
    type: "roofless",
    run: model.type === "flat" ? rect.halfShort : model.run,
  };
}

function clipSkeletonFace(
  points: readonly SkeletonPoint[],
  time: number,
  below: boolean,
): SkeletonPoint[] {
  const result: SkeletonPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const insideA = below ? a.time <= time : a.time >= time;
    const insideB = below ? b.time <= time : b.time >= time;
    if (insideA) result.push(a);
    if (insideA !== insideB) {
      const t = (time - a.time) / (b.time - a.time);
      result.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y), time });
    }
  }
  return result;
}

/** Whether every edge of a positive-area ring is visible from the center. */
function radialFits(outer: readonly Point[], center: Point): boolean {
  for (let i = 0; i < outer.length; i++) {
    const a = outer[i]!;
    const b = outer[(i + 1) % outer.length]!;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const c = ex * (center.y - a.y) - ey * (center.x - a.x);
    if (!(c > MIN_KERNEL_DISTANCE * Math.sqrt(ex * ex + ey * ey))) return false;
  }
  return true;
}

function near(p: Point, q: Point): boolean {
  return (
    Math.abs(p.x - q.x) <= MERGE_DISTANCE &&
    Math.abs(p.y - q.y) <= MERGE_DISTANCE
  );
}

function evaluate(plane: Plane, p: Point): number {
  return plane.gx * p.x + plane.gy * p.y + plane.c;
}

function difference(p: Plane, q: Plane): Plane {
  return { gx: p.gx - q.gx, gy: p.gy - q.gy, c: p.c - q.c };
}

function rawEnvelope(planes: readonly Plane[], p: Point): number {
  let n = Infinity;
  for (const plane of planes) n = Math.min(n, evaluate(plane, p));
  return n;
}

/**
 * Where segment ab crosses the line f = 0, computed from the
 * lexicographically smaller endpoint so it does not depend on direction.
 */
function crossing(a: Point, b: Point, line: Plane): Point {
  if (b.x < a.x || (b.x === a.x && b.y < a.y)) [a, b] = [b, a];
  const fa = evaluate(line, a);
  const fb = evaluate(line, b);
  if (fa === 0) return a;
  if (fb === 0) return b;
  const t = fa / (fa - fb);
  return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
}

/**
 * Sutherland–Hodgman clip of a triangle to the facet of plane k: the
 * region where it is no higher than every other plane. Vertices remember
 * which triangle edges they lie on, so crossings on an edge use its
 * original endpoints.
 */
function clipToFacet(
  corners: readonly [Point, Point, Point],
  planes: readonly Plane[],
  k: number,
): ClipVertex[] {
  let polygon: ClipVertex[] = [
    { x: corners[0].x, y: corners[0].y, mask: 0b101 },
    { x: corners[1].x, y: corners[1].y, mask: 0b011 },
    { x: corners[2].x, y: corners[2].y, mask: 0b110 },
  ];
  for (let j = 0; j < planes.length && polygon.length > 0; j++) {
    if (j === k) continue;
    const line = difference(planes[k]!, planes[j]!);
    if (line.gx === 0 && line.gy === 0) {
      // Parallel planes: k is never lower, or the same plane, which the
      // first of the two owns.
      if (line.c > 0 || (line.c === 0 && j < k)) return [];
      continue;
    }
    const out: ClipVertex[] = [];
    for (let i = 0; i < polygon.length; i++) {
      const p = polygon[i]!;
      const q = polygon[(i + 1) % polygon.length]!;
      const sp = side(evaluate(line, p));
      const sq = side(evaluate(line, q));
      if (sp <= 0) out.push(p);
      if (sp * sq < 0) {
        // On a triangle edge, cross the edge itself, so the triangle on
        // its other side and the wall below it get the same point.
        const common = p.mask & q.mask;
        const e = common === 0b001 ? 0 : common === 0b010 ? 1 : 2;
        const a = corners[e]!;
        const b = corners[(e + 1) % 3]!;
        const c =
          common !== 0 && side(evaluate(line, a)) * side(evaluate(line, b)) < 0
            ? crossing(a, b, line)
            : crossing(p, q, line);
        out.push({ x: c.x, y: c.y, mask: common });
      }
    }
    polygon = out;
  }
  // Merge repeated and nearly repeated points (a line through a vertex,
  // or several lines meeting).
  const result: ClipVertex[] = [];
  for (const p of polygon) {
    const last = result[result.length - 1];
    if (last && near(last, p)) continue;
    result.push(p);
  }
  while (result.length > 1 && near(result[0]!, result[result.length - 1]!))
    result.pop();
  return result;
}

/** -1, 0 or 1: which side of a break line a plane difference puts a point. */
function side(f: number): number {
  return f > ON_LINE ? 1 : f < -ON_LINE ? -1 : 0;
}

function area2(polygon: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i]!;
    const q = polygon[(i + 1) % polygon.length]!;
    sum += p.x * q.y - q.x * p.y;
  }
  return sum;
}

function f32(p: Point): Point {
  return { x: Math.fround(p.x), y: Math.fround(p.y) };
}

function triangleArea2(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
