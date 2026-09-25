// Anchor geometry: one quad per point. This is the maplibre-gl-js twin of
// ../../native/src/layout.zig: the same ownership, order and vertex layout,
// checked by the shared fixtures in ../../fixtures/layout. See that file for
// the conventions.
//
// Every point a tile owns becomes four vertices around its anchor, which the
// vertex shader (shaders/place.glsl) spreads over the animation's anchor box
// on screen or on the ground.

export interface Point {
  x: number;
  y: number;
}

/** Floats per vertex: `anchor * 2 + corner`. */
export const FLOATS_PER_VERTEX = 2;
export const VERTICES_PER_ANCHOR = 4;
export const INDICES_PER_ANCHOR = 6;
/**
 * Vertices per segment: the largest multiple of four that 16-bit indices
 * address.
 */
export const MAX_SEGMENT_VERTICES = 65532;
/** Corner of each of an anchor's four vertices, in order. */
export const CORNERS: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
];
/** The quad's two triangles, relative to the anchor's first vertex. */
export const QUAD_INDICES: readonly number[] = [0, 1, 2, 1, 3, 2];

export interface Segment {
  vertexOffset: number;
  indexOffset: number;
  vertexLength: number;
  indexLength: number;
}

/** The vertices of one anchor, for feature queries. */
export interface Range {
  featureIndex: number;
  firstVertex: number;
  vertexCount: number;
}

interface Anchor {
  x: number;
  y: number;
  featureIndex: number;
}

export class IconLayout {
  private readonly anchors: Anchor[] = [];
  private vertexData = new Float32Array(0);
  private indexData = new Uint16Array(0);
  readonly segments: Segment[] = [];
  readonly ranges: Range[] = [];

  constructor(readonly extent: number) {}

  get vertexCount(): number {
    return this.vertexData.length / FLOATS_PER_VERTEX;
  }

  get indexCount(): number {
    return this.indexData.length;
  }

  /** Vertices as uploaded to the GPU: one float2 `a_pos` each. */
  vertices(): Float32Array {
    return this.vertexData;
  }

  /** Segment-relative triangle indices. */
  indices(): Uint16Array {
    return this.indexData;
  }

  /**
   * Adds the points of one feature: a Point, or every point of a
   * MultiPoint. Points outside the tile square are dropped.
   */
  addPoints(points: readonly Point[], featureIndex: number): void {
    for (const p of points) {
      if (p.x < 0 || p.y < 0 || p.x >= this.extent || p.y >= this.extent) {
        continue;
      }
      this.anchors.push({ x: p.x, y: p.y, featureIndex });
    }
  }

  /**
   * Sorts the anchors and builds the vertices, indices, segments and
   * ranges. Call once, after the last addPoints.
   */
  finish(): void {
    // Array sort is stable: equal anchors keep the order they came in.
    const anchors = this.anchors.sort((a, b) => a.y - b.y || a.x - b.x);
    const vertices = new Float32Array(
      anchors.length * VERTICES_PER_ANCHOR * FLOATS_PER_VERTEX,
    );
    const indices = new Uint16Array(anchors.length * INDICES_PER_ANCHOR);
    let segment: Segment | undefined;
    let v = 0;
    let i = 0;
    for (const anchor of anchors) {
      if (
        !segment ||
        segment.vertexLength + VERTICES_PER_ANCHOR > MAX_SEGMENT_VERTICES
      ) {
        segment = {
          vertexOffset: v / FLOATS_PER_VERTEX,
          indexOffset: i,
          vertexLength: 0,
          indexLength: 0,
        };
        this.segments.push(segment);
      }
      const base = segment.vertexLength;
      this.ranges.push({
        featureIndex: anchor.featureIndex,
        firstVertex: v / FLOATS_PER_VERTEX,
        vertexCount: VERTICES_PER_ANCHOR,
      });
      for (const [cx, cy] of CORNERS) {
        vertices[v++] = anchor.x * 2 + cx;
        vertices[v++] = anchor.y * 2 + cy;
      }
      for (const offset of QUAD_INDICES) indices[i++] = base + offset;
      segment.vertexLength += VERTICES_PER_ANCHOR;
      segment.indexLength += INDICES_PER_ANCHOR;
    }
    this.vertexData = vertices;
    this.indexData = indices;
  }
}
