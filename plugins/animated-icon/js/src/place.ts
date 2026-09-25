// Icon placement on the screen, for hit testing. This is the maplibre-gl-js
// twin of ../../native/src/place.zig, and both are CPU twins of iconPlace()
// in ../../shaders/place.glsl: the same anchor box, anchor point, offset,
// rotation, perspective ratio and alignments, in double precision and
// without the shader's one-device-pixel pad, which only widens the quad for
// anti-aliasing. The shared fixtures in ../../fixtures/place check both.
//
// Screen coordinates are logical pixels with y down: a clip position maps to
// x = (ndc.x + 1) / 2 · width and y = (1 − ndc.y) / 2 · height.

export type Vec2 = readonly [number, number];
/** The box corners (0,0), (1,0), (0,1), (1,1) on the screen, in that order. */
export type Quad = readonly [Vec2, Vec2, Vec2, Vec2];

/** Paint values of one feature, enums as indices in spec.json's order. */
export interface Resolved {
  /** icon-animation's entry index; 0 is none. */
  readonly animation: number;
  readonly size: number;
  /** Degrees clockwise. */
  readonly rotate: number;
  readonly opacity: number;
  /** Logical pixels right and down, scaled by size. */
  readonly offset: Vec2;
  readonly anchor: number;
  readonly rotationAlignment: number;
  readonly pitchAlignment: number;
}

/** The catalog entry of the animation. */
export interface Entry {
  /** Anchor box x0, y0, x1, y1 in canvas pixels. */
  readonly box: readonly [number, number, number, number];
  /** Logical pixels of the box's longer side at size 1. */
  readonly displayPx: number;
}

export interface View {
  /** Tile units to clip space, column-major: the query's tile matrix. */
  readonly matrix: ArrayLike<number>;
  /**
   * Tile units to clip space in place of `matrix`, for a projection no
   * matrix expresses: maplibre-gl-js's globe (globe.ts). A point it hides
   * has w <= 0. The native twin has no such projection.
   */
  readonly project?: (x: number, y: number) => Clip;
  /** Logical pixels. */
  readonly viewport: Vec2;
  /** Unused by corners(); harnesses use it for the device-pixel scale. */
  readonly pixelRatio: number;
  readonly cameraToCenterDistance: number;
  readonly pixelsToTileUnits: number;
  /** Radians, as the host keeps it: the camera bearing negated. */
  readonly bearing: number;
}

/** A clip-space position (x, y, z, w). */
export type Clip = readonly [number, number, number, number];

function clip(view: View, x: number, y: number): Clip {
  if (view.project) return view.project(x, y);
  const m = view.matrix;
  return [
    m[0]! * x + m[4]! * y + m[12]!,
    m[1]! * x + m[5]! * y + m[13]!,
    m[2]! * x + m[6]! * y + m[14]!,
    m[3]! * x + m[7]! * y + m[15]!,
  ];
}

function toScreen(view: View, c: Clip): Vec2 | null {
  if (!(c[3] > 0)) return null;
  const [width, height] = view.viewport;
  return [((c[0] / c[3] + 1) / 2) * width, ((1 - c[1] / c[3]) / 2) * height];
}

/** Tile units to screen pixels, or null behind the camera. */
export function project(view: View, p: Vec2): Vec2 | null {
  return toScreen(view, clip(view, p[0], p[1]));
}

/**
 * The fraction of the anchor box that icon-anchor puts on the anchor, by
 * enum index: center, left, right, top, bottom, top-left, top-right,
 * bottom-left, bottom-right.
 */
function anchorFraction(anchor: number): Vec2 {
  const x =
    anchor === 1 || anchor === 5 || anchor === 7
      ? 0
      : anchor === 2 || anchor === 6 || anchor === 8
        ? 1
        : 0.5;
  const y =
    anchor === 3 || anchor === 5 || anchor === 6
      ? 0
      : anchor === 4 || anchor === 7 || anchor === 8
        ? 1
        : 0.5;
  return [x, y];
}

/** Turns v clockwise on a y-down plane by the angle with cosine and sine cs. */
function turn(v: Vec2, cos: number, sin: number): Vec2 {
  return [v[0] * cos - v[1] * sin, v[0] * sin + v[1] * cos];
}

const CORNERS: readonly Vec2[] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
];

/**
 * The screen corners of the icon's anchor box for an anchor in tile units,
 * or null when the icon collapses (none, size or opacity not positive) or a
 * corner is behind the camera.
 */
export function corners(
  anchor: Vec2,
  resolved: Resolved,
  entry: Entry,
  view: View,
): Quad | null {
  const size = resolved.size;
  if (resolved.animation <= 0 || !(size > 0) || !(resolved.opacity > 0)) {
    return null;
  }
  const projected = clip(view, anchor[0], anchor[1]);
  const center = toScreen(view, projected);
  if (center === null) return null;
  const [x0, y0, x1, y1] = entry.box;
  // Logical pixels per canvas pixel.
  const scale = (entry.displayPx * size) / Math.max(x1 - x0, y1 - y0);
  const rotateWithMap = resolved.rotationAlignment === 1;
  const pitchWithMap =
    resolved.pitchAlignment === 1 ||
    (resolved.pitchAlignment === 0 && rotateWithMap);
  const cameraToCenter = view.cameraToCenterDistance;
  const w = projected[3];
  const distanceRatio = pitchWithMap ? w / cameraToCenter : cameraToCenter / w;
  const perspective = Math.min(Math.max(0.5 + 0.5 * distanceRatio, 0), 4);

  const [fx, fy] = anchorFraction(resolved.anchor);
  const ax = x0 + (x1 - x0) * fx;
  const ay = y0 + (y1 - y0) * fy;
  const angle = (resolved.rotate * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  // East at the anchor, in screen pixels, for map rotation facing the
  // camera, like the shader's u_rotate_symbol direction.
  let east: Vec2 = [1, 0];
  if (!pitchWithMap && rotateWithMap) {
    const e = clip(view, anchor[0] + 1, anchor[1]);
    const [width, height] = view.viewport;
    const dx = ((e[0] / e[3] - projected[0] / w) * width) / 2;
    const dy = (-(e[1] / e[3] - projected[1] / w) * height) / 2;
    const length = Math.hypot(dx, dy);
    if (length > 0) east = [dx / length, dy / length];
  }

  const result: Vec2[] = [];
  for (const [cx, cy] of CORNERS) {
    const ux = x0 + (x1 - x0) * cx;
    const uy = y0 + (y1 - y0) * cy;
    let o: Vec2 = [
      (ux - ax) * scale + resolved.offset[0] * size,
      (uy - ay) * scale + resolved.offset[1] * size,
    ];
    o = turn(o, cos, sin);
    o = [o[0] * perspective, o[1] * perspective];
    if (pitchWithMap) {
      if (!rotateWithMap)
        o = turn(o, Math.cos(-view.bearing), Math.sin(-view.bearing));
      const point = project(view, [
        anchor[0] + o[0] * view.pixelsToTileUnits,
        anchor[1] + o[1] * view.pixelsToTileUnits,
      ]);
      if (point === null) return null;
      result.push(point);
    } else {
      if (rotateWithMap) o = turn(o, east[0], east[1]);
      result.push([center[0] + o[0], center[1] + o[1]]);
    }
  }
  return result as unknown as Quad;
}

/** The quad's corners in winding order. */
function ring(quad: Quad): readonly Vec2[] {
  return [quad[0], quad[1], quad[3], quad[2]];
}

function cross(o: Vec2, a: Vec2, b: Vec2): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** Whether p lies inside or on the (convex) quad. */
export function hitPoint(quad: Quad, p: Vec2): boolean {
  const points = ring(quad);
  let positive = false;
  let negative = false;
  for (let i = 0; i < 4; i++) {
    const side = cross(points[i]!, points[(i + 1) % 4]!, p);
    if (side > 0) positive = true;
    if (side < 0) negative = true;
  }
  return !(positive && negative);
}

/** The interval of the points' projections onto axis. */
function extent(points: readonly Vec2[], axis: Vec2): Vec2 {
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    const d = p[0] * axis[0] + p[1] * axis[1];
    min = Math.min(min, d);
    max = Math.max(max, d);
  }
  return [min, max];
}

/** Whether any edge normal of points separates them from others. */
function separates(points: readonly Vec2[], others: readonly Vec2[]): boolean {
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const axis: Vec2 = [a[1] - b[1], b[0] - a[0]];
    if (axis[0] === 0 && axis[1] === 0) continue;
    const [minA, maxA] = extent(points, axis);
    const [minB, maxB] = extent(others, axis);
    if (maxA < minB || maxB < minA) return true;
  }
  return false;
}

/**
 * Whether the quad and a query ring overlap, touching included. The ring is
 * treated as convex (the separating axis test), as a query box is; a closing
 * point equal to the first is fine.
 */
export function hitPolygon(quad: Quad, polygon: readonly Vec2[]): boolean {
  if (polygon.length === 0) return false;
  const points = ring(quad);
  return !separates(points, polygon) && !separates(polygon, points);
}

/**
 * The farthest an icon of the entry reaches from its anchor at size 1, in
 * logical pixels: the box diagonal at display size.
 */
export function entryRadius(entry: Entry): number {
  const [x0, y0, x1, y1] = entry.box;
  const width = x1 - x0;
  const height = y1 - y0;
  return (
    (Math.hypot(width, height) * entry.displayPx) / Math.max(width, height)
  );
}
