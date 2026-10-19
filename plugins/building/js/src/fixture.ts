// The layout fixture format (../../fixtures/layout/*.json), shared by the
// fixture generator, layout.test.ts and the Zig twin's tests.
//
// Each fixture lays out its features in order into one BuildingLayout, as
// one tile whose bounds cover every feature, and records the output. Every
// feature always gets a summary; small fixtures also record every vertex
// and index. A summary is computed from the float32 vertices and the
// segment-relative indices alone:
//
//   vertices   the feature's vertex count (its range)
//   triangles  triangles whose first vertex is in the range
//   sum_pos    Σ (x, y, run) over the range, in vertex order, in f64
//   sum_roof   Σ (n, kind, gx, gy) likewise
//   weighted   Σ (i + 1) · (x + y + run + n + kind + gx + gy) / vertices,
//              i the vertex's position in the range
//   moment     Σ (t + 1) · (i0 + 2·i1 + 3·i2) over the feature's triangles,
//              t the triangle's position among them and i the vertex
//              positions in the range (orientation-sensitive)
//
// Values compare with |a - b| <= 1e-6 + 1e-6·|b|, loose enough for the
// last-bit differences between the twins' math and tight enough to catch
// any change of logic.

import { BuildingLayout, FLOATS_PER_VERTEX, tileBounds } from "./layout.ts";

export interface FixtureFeature {
  index: number;
  /** Rings of [x, y] tile points. */
  rings: [number, number][][];
  shape: string;
  orientation?: string;
  direction?: number;
  /** Lays the feature out this many times, with consecutive indices. */
  repeat?: number;
  label?: string;
}

export interface Summary {
  vertices: number;
  triangles: number;
  sum_pos: [number, number, number];
  sum_roof: [number, number, number, number];
  weighted: number;
  moment: number;
}

export interface Expected {
  vertex_count: number;
  index_count: number;
  /** [vertex_offset, index_offset, vertex_length, index_length]. */
  segments: [number, number, number, number][];
  /** [feature index, first vertex, vertex count]. */
  ranges: [number, number, number][];
  summaries: Summary[];
  /** Every vertex's (x, y, run), when recorded. */
  positions?: [number, number, number][];
  /** Every vertex's (n, kind, gx, gy), when recorded. */
  roofs?: [number, number, number, number][];
  indices?: number[];
}

export interface Fixture {
  description: string;
  extent: number;
  features: FixtureFeature[];
  expected: Expected;
}

/** Lays out a fixture's features as one tile, whose bounds cover them all. */
export function layOut(
  extent: number,
  features: readonly FixtureFeature[],
): BuildingLayout {
  const all = features.map((feature) =>
    feature.rings.map((ring) => ring.map(([x, y]) => ({ x, y }))),
  );
  const layout = new BuildingLayout(extent, tileBounds(all));
  features.forEach((feature, f) => {
    const rings = all[f]!;
    for (let k = 0; k < (feature.repeat ?? 1); k++) {
      layout.addFeature(rings, feature.index + k, {
        shape: feature.shape,
        orientation: feature.orientation ?? "along",
        direction: feature.direction ?? -1,
      });
    }
  });
  return layout;
}

/** The global vertex numbers of every triangle, in output order. */
export function triangles(layout: BuildingLayout): number[][] {
  const indices = layout.indices();
  const result: number[][] = [];
  for (const segment of layout.segments) {
    for (let t = 0; t < segment.indexLength; t += 3) {
      const o = segment.indexOffset + t;
      result.push([
        segment.vertexOffset + indices[o]!,
        segment.vertexOffset + indices[o + 1]!,
        segment.vertexOffset + indices[o + 2]!,
      ]);
    }
  }
  return result;
}

export function summarize(layout: BuildingLayout): Summary[] {
  const data = layout.vertices();
  const all = triangles(layout);
  return layout.ranges.map((range) => {
    const sumPos: [number, number, number] = [0, 0, 0];
    const sumRoof: [number, number, number, number] = [0, 0, 0, 0];
    let weighted = 0;
    for (let i = 0; i < range.vertexCount; i++) {
      const o = (range.firstVertex + i) * FLOATS_PER_VERTEX;
      let total = 0;
      for (let c = 0; c < FLOATS_PER_VERTEX; c++) {
        const value = data[o + c]!;
        if (c < 3) sumPos[c] = sumPos[c]! + value;
        else sumRoof[c - 3] = sumRoof[c - 3]! + value;
        total += value;
      }
      weighted += (i + 1) * total;
    }
    let count = 0;
    let moment = 0;
    const end = range.firstVertex + range.vertexCount;
    for (const tri of all) {
      if (tri[0]! < range.firstVertex || tri[0]! >= end) continue;
      const [a, b, c] = tri.map((v) => v - range.firstVertex) as [
        number,
        number,
        number,
      ];
      moment += (count + 1) * (a + 2 * b + 3 * c);
      count++;
    }
    return {
      vertices: range.vertexCount,
      triangles: count,
      sum_pos: sumPos,
      sum_roof: sumRoof,
      weighted: weighted / Math.max(range.vertexCount, 1),
      moment,
    };
  });
}

export function expectedOutput(
  layout: BuildingLayout,
  full: boolean,
): Expected {
  const expected: Expected = {
    vertex_count: layout.vertexCount,
    index_count: layout.indexCount,
    segments: layout.segments.map((s) => [
      s.vertexOffset,
      s.indexOffset,
      s.vertexLength,
      s.indexLength,
    ]),
    ranges: layout.ranges.map((r) => [
      r.featureIndex,
      r.firstVertex,
      r.vertexCount,
    ]),
    summaries: summarize(layout),
  };
  if (full) {
    const data = layout.vertices();
    expected.positions = [];
    expected.roofs = [];
    for (let i = 0; i < layout.vertexCount; i++) {
      const o = i * FLOATS_PER_VERTEX;
      expected.positions.push([data[o]!, data[o + 1]!, data[o + 2]!]);
      expected.roofs.push([
        data[o + 3]!,
        data[o + 4]!,
        data[o + 5]!,
        data[o + 6]!,
      ]);
    }
    expected.indices = Array.from(layout.indices());
  }
  return expected;
}

export function close(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= 1e-6 + 1e-6 * Math.abs(expected);
}
