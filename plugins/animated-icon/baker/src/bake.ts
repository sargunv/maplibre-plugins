// Bakes Lottie animations into catalog animations: checks each file
// against the profile (profile.ts), samples every frame at the entry's
// frame rate (../../catalog/FORMAT.md, "Timing"), evaluates each frame into
// draws (scene.ts), and turns every distinct draw geometry into one shape
// record, fitted once (geometry.ts, dedupe.ts). Each draw of each frame
// becomes an op that places its shape with an affine map, so rigid motion
// costs a few texels per frame. The catalog is then packed (pack.ts),
// parsed back with the runtimes' reader, and rasterised with the shader's
// CPU twin (shade.ts) to measure what it costs to draw.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { CanvasKit, Path } from "canvaskit-wasm";

import { Catalog } from "../../js/src/catalog.ts";
import { geometryKey } from "./dedupe.ts";
import {
  bezierCmds,
  Booleans,
  type ClipGeometry,
  cmdsBounds,
  cmdsOf,
  dashCmds,
  type DrawGeometry,
  type Fallback,
  fillRuleOf,
  finalPath,
  fitPath,
  mapCmds,
  toPath,
} from "./geometry.ts";
import { MAX_STOPS, resampleStops } from "./gradient.ts";
import {
  type Affine,
  type AnimationInput,
  type Box,
  type CatalogInput,
  type Contour,
  type Curve,
  type MarkerInput,
  MAX_ANIMATIONS,
  MAX_OPS,
  NAME,
  type OpInput,
  type PackedCatalog,
  packCatalog,
  type PaintInput,
  type ShapeInput,
} from "./pack.ts";
import {
  checkProfile,
  type FeatureId,
  type ProfileNotes,
  ProfileError,
  type Violation,
} from "./profile.ts";
import { mapContour } from "./quadratic.ts";
import {
  type Clip,
  type Draw,
  evaluateFrame,
  type Lottie,
  prepare,
} from "./scene.ts";
import { shade } from "./shade.ts";
import { canvasKit } from "./skia.ts";
import { isHexColor, type SlotColors, type SlotRule, slotOf } from "./slots.ts";
import {
  apply,
  invert,
  type Matrix,
  maxScale,
  minScale,
  multiply,
  scaling,
} from "./transform.ts";

export { TOLERANCE_PX } from "./geometry.ts";

/** One animation in a manifest (`animations/*.json`). */
export interface CatalogEntry {
  /** The enum value styles use; see FORMAT.md for the allowed names. */
  readonly name: string;
  /** The Lottie file, relative to the manifest. */
  readonly file: string;
  /** Logical pixels of the anchor box's longer side at `icon-size` 1. */
  readonly displayPx: number;
  /**
   * Device pixels of the box's longer side at the largest size the icon is
   * drawn at; curves stay within 0.2 of these pixels. Defaults to 4 ×
   * displayPx (icon-size 1.33 on a 3× screen).
   */
  readonly maxDisplayPx?: number;
  /**
   * The anchor box: `"canvas"` for the Lottie canvas, explicit
   * `[x0, y0, x1, y1]` canvas pixels, or by default the union of every
   * frame's shapes.
   */
  readonly box?: "canvas" | Box;
  /** Flipbook frames per second; beats the manifest's `fps`. */
  readonly fps?: number;
  /**
   * Lottie markers to bake as extra entries `<name>#<marker>`: `true` for
   * all, or their names (`cm`).
   */
  readonly markers?: true | readonly string[];
  /** Authored colors (`#rrggbb`) to recolor through each slot. */
  readonly slots?: SlotColors;
  /** Puts every solid paint in the primary slot. */
  readonly tint?: boolean;
  /** Profile feature ids to drop instead of rejecting (profile.ts). */
  readonly ignore?: readonly string[];
  /** Accepts more than the cost and size limits. */
  readonly heavy?: boolean;
  /** Who made a third-party animation and where it comes from. */
  readonly credit?: string;
  /**
   * The license text file of a third-party animation, relative to the
   * manifest. The generated JS module or notice file carries its notice.
   */
  readonly license?: string;
}

/** A manifest: `animations/*.json`. */
export interface CatalogManifest {
  readonly $comment?: string;
  /** The .mlvc file the default CLI run writes, relative to the manifest. */
  readonly output?: string;
  /** A generated base64 module of the catalog (the demo only). */
  readonly js?: string;
  /** A plain-text file with the credits and license texts (app catalogs). */
  readonly notice?: string;
  /** Frames per second for entries without their own. */
  readonly fps?: number;
  readonly animations: readonly CatalogEntry[];
}

const ENTRY_FIELDS = [
  "name",
  "file",
  "displayPx",
  "maxDisplayPx",
  "box",
  "fps",
  "markers",
  "slots",
  "tint",
  "ignore",
  "heavy",
  "credit",
  "license",
] as const;

const MANIFEST_FIELDS = [
  "$comment",
  "output",
  "js",
  "notice",
  "fps",
  "animations",
] as const;

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function unknownFields(
  fields: Record<string, unknown>,
  known: readonly string[],
): void {
  for (const key of Object.keys(fields)) {
    if (!known.includes(key)) {
      throw new Error(
        `${key}: unknown field; known fields: ${known.join(", ")}`,
      );
    }
  }
}

/**
 * Rejects a malformed manifest entry with an error naming the field, so a
 * typo fails before any sampling instead of deep inside it.
 */
export function checkEntry(entry: unknown): asserts entry is CatalogEntry {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error("expected an object with name, file and displayPx");
  }
  const fields = entry as Record<string, unknown>;
  const fail = (field: string, expected: string): never => {
    throw new Error(
      `${field}: expected ${expected}, got ${JSON.stringify(fields[field])}`,
    );
  };
  unknownFields(fields, ENTRY_FIELDS);
  const { name, file, displayPx, maxDisplayPx, box, fps, markers, slots } =
    fields;
  if (typeof name !== "string" || !NAME.test(name) || name === "none") {
    fail("name", 'a name matching [a-z0-9][a-z0-9_#-]* other than "none"');
  }
  if (typeof name === "string" && name.includes("#")) {
    fail("name", "a name without # (marker entries are named after the entry)");
  }
  if (typeof file !== "string" || file === "") fail("file", "a path");
  if (!isPositive(displayPx)) fail("displayPx", "a finite number > 0");
  if (maxDisplayPx !== undefined && !isPositive(maxDisplayPx)) {
    fail("maxDisplayPx", "a finite number > 0");
  }
  if (fps !== undefined && !isPositive(fps)) fail("fps", "a finite number > 0");
  if (
    box !== undefined &&
    box !== "canvas" &&
    !(
      Array.isArray(box) &&
      box.length === 4 &&
      box.every((v) => typeof v === "number" && Number.isFinite(v)) &&
      box[0] < box[2] &&
      box[1] < box[3]
    )
  ) {
    fail("box", '"canvas" or [x0, y0, x1, y1] with x0 < x1 and y0 < y1');
  }
  if (
    markers !== undefined &&
    markers !== true &&
    !(Array.isArray(markers) && markers.every((m) => typeof m === "string"))
  ) {
    fail("markers", "true or an array of marker names");
  }
  if (slots !== undefined) {
    const valid =
      typeof slots === "object" &&
      slots !== null &&
      !Array.isArray(slots) &&
      Object.entries(slots).every(
        ([key, value]) =>
          (key === "primary" || key === "secondary") &&
          Array.isArray(value) &&
          value.every(isHexColor),
      );
    if (!valid)
      fail("slots", '{ "primary"?: ["#rrggbb", ...], "secondary"?: [...] }');
  }
  const { ignore, heavy, tint } = fields;
  if (
    ignore !== undefined &&
    !(Array.isArray(ignore) && ignore.every((id) => typeof id === "string"))
  ) {
    fail("ignore", "an array of feature ids");
  }
  if (heavy !== undefined && typeof heavy !== "boolean") {
    fail("heavy", "true or false");
  }
  if (tint !== undefined && typeof tint !== "boolean")
    fail("tint", "true or false");
  for (const field of ["credit", "license"] as const) {
    if (fields[field] !== undefined && typeof fields[field] !== "string") {
      fail(field, "a string");
    }
  }
}

/** Rejects a malformed manifest before any entry is baked. */
export function checkManifest(json: unknown): asserts json is CatalogManifest {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error("expected an object with an animations array");
  }
  const fields = json as Record<string, unknown>;
  unknownFields(fields, MANIFEST_FIELDS);
  if (!Array.isArray(fields.animations)) {
    throw new Error("animations: expected an array");
  }
  for (const key of ["output", "js", "notice", "$comment"] as const) {
    if (fields[key] !== undefined && typeof fields[key] !== "string") {
      throw new Error(
        `${key}: expected a string, got ${JSON.stringify(fields[key])}`,
      );
    }
  }
  if (fields.fps !== undefined && !isPositive(fields.fps)) {
    throw new Error(
      `fps: expected a finite number > 0, got ${JSON.stringify(fields.fps)}`,
    );
  }
}

/** Frames per second when neither the entry nor the manifest names one. */
export const DEFAULT_FPS = 60;
/** Shader curve visits per pixel above which the bake warns. */
export const VISITS_WARN = 16;
/** Shader curve visits per pixel above which the bake fails unless heavy. */
export const VISITS_MAX = 64;
/** Baked bytes per animation above which the bake fails unless heavy. */
export const BYTES_MAX = 1 << 20;
/** Most frames the visit measurement rasterises per animation. */
export const VISIT_SAMPLES = 120;
/**
 * Nanoseconds per curve visit: a design-research estimate for a UBO-reading
 * port on an Apple M5 (FINAL-DESIGN.md §6); the M1 texture shader is
 * unmeasured.
 */
export const NS_PER_VISIT = [0.014, 0.022] as const;
/** The label every cost estimate carries. */
export const COST_LABEL =
  "design-research estimate for a UBO-reading port on an Apple M5; the M1 texture shader is unmeasured";

/** The Lottie frame (in Lottie frames) that flipbook frame `i` samples. */
export function sampleTime(
  lottie: Pick<Lottie, "ip" | "fr">,
  i: number,
  fps: number = DEFAULT_FPS,
): number {
  return lottie.ip + (i * lottie.fr) / fps;
}

/** Flipbook frames in one loop over the composition's `[ip, op)`. */
export function frameCount(
  lottie: Pick<Lottie, "ip" | "op" | "fr">,
  fps: number = DEFAULT_FPS,
): number {
  return Math.max(1, Math.round(((lottie.op - lottie.ip) / lottie.fr) * fps));
}

function union(a: Box, b: Box): Box {
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3]),
  ];
}

const EMPTY: Box = [Infinity, Infinity, -Infinity, -Infinity];

function long(box: Box): number {
  return Math.max(box[2] - box[0], box[3] - box[1]);
}

function overlap(a: Box, b: Box): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

/** Whether two boxes overlap, touch, or come within `margin` of each other. */
function near(a: Box, b: Box, margin: number): boolean {
  return (
    a[0] <= b[2] + margin &&
    b[0] <= a[2] + margin &&
    a[1] <= b[3] + margin &&
    b[1] <= a[3] + margin
  );
}

/** The exact bounds of a contour's quadratics. */
export function contourBounds(contour: Contour): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  contour.forEach(({ on, ctrl }, k) => {
    const end = (contour[(k + 1) % contour.length] as Curve).on;
    const include = (x: number, y: number): void => {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    };
    include(on[0], on[1]);
    // Interior extremes of the quadratic, per axis.
    for (const axis of [0, 1] as const) {
      const denominator = on[axis] - 2 * ctrl[axis] + end[axis];
      if (denominator === 0) continue;
      const t = (on[axis] - ctrl[axis]) / denominator;
      if (t > 0 && t < 1) {
        const u = 1 - t;
        include(
          u * u * on[0] + 2 * u * t * ctrl[0] + t * t * end[0],
          u * u * on[1] + 2 * u * t * ctrl[1] + t * t * end[1],
        );
      }
    }
  });
  return [x0, y0, x1, y1];
}

/** The bounds of a contour's points, control points included. */
function controlBounds(contour: Contour, m: Matrix): Box {
  let box = EMPTY;
  for (const { on, ctrl } of contour) {
    const [ax, ay] = apply(m, on);
    const [bx, by] = apply(m, ctrl);
    box = union(box, [
      Math.min(ax, bx),
      Math.min(ay, by),
      Math.max(ax, bx),
      Math.max(ay, by),
    ]);
  }
  return box;
}

/**
 * Splits contours into groups whose bounds stay more than `margin` apart;
 * each group becomes its own shape and op, so the shader walks each
 * group's curves only inside its own, smaller box.
 *
 * The fill (winding or even-odd) is unchanged either way, but the
 * anti-aliased coverage is unchanged only while no pixel sees two parts:
 * composited source-over, two parts that share an edge leave a see-through
 * seam along it, where one paint's crossings would cancel. So contours
 * whose boxes touch always stay together, and `margin` should be at least
 * a display pixel, the reach of the shader's anti-aliasing.
 */
export function splitContours(
  contours: readonly Contour[],
  margin = 0,
): Contour[][] {
  const bounds = contours.map(contourBounds);
  const group = bounds.map((_, k) => k);
  const find = (k: number): number => {
    while (group[k] !== k) k = group[k] as number;
    return k;
  };
  for (let a = 0; a < bounds.length; a++) {
    for (let b = a + 1; b < bounds.length; b++) {
      if (near(bounds[a] as Box, bounds[b] as Box, margin)) {
        group[find(b)] = find(a);
      }
    }
  }
  const groups = new Map<number, number[]>();
  bounds.forEach((_, k) => {
    const root = find(k);
    groups.set(root, [...(groups.get(root) ?? []), k]);
  });
  return [...groups.values()].map((members) =>
    members.map((k) => contours[k] as Contour),
  );
}

/** A marker name as an entry name suffix: lowercase, other runs as `-`. */
export function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

/** What an animation costs, for the report and the limits. */
export interface AnimationStats {
  readonly name: string;
  readonly file: string;
  readonly fps: number;
  readonly frames: number;
  readonly box: Box;
  readonly displayPx: number;
  readonly maxDisplayPx: number;
  /** Most ops in any frame. */
  readonly maxOps: number;
  /** Ops over every frame, and the draws they come from. */
  readonly ops: number;
  readonly draws: number;
  /** Distinct geometries, and the shape records they became (after splits). */
  readonly geometries: number;
  readonly shapes: number;
  /** Most curves drawn in any frame. */
  readonly maxCurves: number;
  /** The frame and draw of every boolean that fell back. */
  readonly fallbacks: readonly Fallback[];
  readonly markers: readonly string[];
  readonly notes: ProfileNotes;
  readonly warnings: readonly string[];
}

/** Everything the catalog needs from one baked entry. */
export interface BakedAnimation {
  readonly entry: CatalogEntry;
  /** Ops name shapes by their index in `shapes`. */
  readonly animation: AnimationInput;
  readonly shapes: readonly ShapeInput[];
  readonly markers: readonly MarkerInput[];
  readonly stats: AnimationStats;
}

export interface BakeOptions {
  /** Frames per second for entries without their own. */
  readonly fps?: number;
}

/** One use of a geometry: a draw of a frame. */
interface Use {
  readonly frame: number;
  readonly draw: Draw;
  readonly inverse: Matrix;
  readonly key: string;
}

interface GeometryRecord {
  readonly geometry: DrawGeometry;
  readonly where: string;
  readonly uses: Use[];
  fillRule: "nonzero" | "evenodd";
  /** Split parts: contours in the draw's space and their shape index. */
  parts: { contours: Contour[]; shape: number; curves: number }[];
  /** The unsplit shape, made when a frame has no room for the parts. */
  whole?: { shape: number; curves: number };
  contours: Contour[];
  pxPerUnit: number;
}

/**
 * A matrix as the catalog's op affine: `q = (a·u + b·v + tx, c·u + d·v +
 * ty)` (FORMAT.md), where Matrix maps `(x, y)` to `(a x + c y + e, b x +
 * d y + f)`.
 */
export function toAffine(m: Matrix): Affine {
  return [m[0], m[2], m[1], m[3], m[4], m[5]];
}

/** A 1e-3 px margin on a precomposition's rectangle (design §2). */
const CLIP_MARGIN = 1e-3;

/** Whether every point of a box lies in the parallelogram `quad` (4 corners in order). */
function boxInQuad(
  box: Box,
  quad: readonly (readonly [number, number])[],
): boolean {
  const corners: [number, number][] = [
    [box[0], box[1]],
    [box[2], box[1]],
    [box[2], box[3]],
    [box[0], box[3]],
  ];
  let sign = 0;
  for (let k = 0; k < 4; k++) {
    const a = quad[k] as [number, number];
    const b = quad[(k + 1) % 4] as [number, number];
    for (const [x, y] of corners) {
      const cross = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
      if (cross === 0) continue;
      if (sign === 0) sign = Math.sign(cross);
      else if (Math.sign(cross) !== sign) return false;
    }
  }
  return true;
}

class AnimationBaker {
  private readonly ck: CanvasKit;
  private readonly entry: CatalogEntry;
  private readonly lottie: Lottie;
  private readonly ignore: ReadonlySet<string>;
  private readonly maxDisplayPx: number;
  readonly violations = new Map<string, Violation>();
  readonly fallbacks: Fallback[] = [];

  constructor(ck: CanvasKit, entry: CatalogEntry, lottie: Lottie) {
    this.ck = ck;
    this.entry = entry;
    this.lottie = lottie;
    this.ignore = new Set(entry.ignore ?? []);
    this.maxDisplayPx = entry.maxDisplayPx ?? 4 * entry.displayPx;
  }

  private violate(path: string, feature: FeatureId): void {
    if (this.ignore.has(feature)) return;
    this.violations.set(`${path}\0${feature}`, { path, feature });
  }

  /** Checks found only in evaluated frames: matte sources and gradient stops. */
  check(frames: readonly (readonly Draw[])[]): void {
    const opaque = (draw: Draw): boolean =>
      draw.alpha >= 1 - 1e-9 &&
      (draw.paint.kind === "solid" ||
        draw.paint.stops.every((stop) => stop.color[3] >= 1 - 1e-9));
    const visit = (draw: Draw): void => {
      if (draw.paint.kind !== "solid" && draw.paint.stops.length > MAX_STOPS) {
        this.violate(draw.path, "gradient-stops");
      }
      for (const clip of draw.clips) {
        if (clip.kind !== "matte") continue;
        if (!clip.source.every(opaque))
          this.violate(clip.path, "matte-sources");
        clip.source.forEach(visit);
      }
    };
    for (const draws of frames) draws.forEach(visit);
  }

  /** The geometry of a draw in its own space; `inverse` maps canvas to it. */
  private geometry(draw: Draw, inverse: Matrix, device: number): DrawGeometry {
    const ck = this.ck;
    let cmds = bezierCmds(ck, draw.paths);
    if (draw.dash) {
      const k = device * maxScale(draw.matrix);
      // The phase within one period, on a 1e-4 grid, so equal phases (a
      // marching dash comes back every period) dash identically and share
      // one shape.
      const { intervals, offset } = draw.dash;
      const period = intervals.reduce((sum, x) => sum + x, 0);
      const phase =
        Math.round((((offset % period) + period) % period) * 1e4) / 1e4;
      cmds = k > 0 ? dashCmds(ck, cmds, intervals, phase, k) : [];
    }
    const clips: ClipGeometry[] = [];
    for (const clip of draw.clips) {
      const geometry = this.clip(clip, draw, inverse, device, cmds);
      if (geometry) clips.push(geometry);
    }
    return {
      cmds,
      fillRule: draw.fillRule,
      ...(draw.stroke ? { stroke: draw.stroke } : {}),
      clips,
    };
  }

  private clip(
    clip: Clip,
    draw: Draw,
    inverse: Matrix,
    device: number,
    cmds: readonly number[],
  ): ClipGeometry | undefined {
    const ck = this.ck;
    if (clip.kind === "mask") {
      const masks = clip.masks.map((mask) => ({
        mode: mask.mode,
        cmds: bezierCmds(ck, mask.paths),
        expansion: mask.expansion,
      }));
      let universe: number[] | null = null;
      if (masks[0]?.mode !== "a") {
        universe = mapCmds(ck, bezierCmds(ck, [clip.universe]), inverse);
        // A universe that holds the whole draw only clips nothing; leave it
        // out of the key, or every move of the draw would change the key.
        const [x0, y0, x1, y1] = cmdsBounds(ck, cmds);
        const pad = draw.stroke
          ? (draw.stroke.width / 2) * Math.max(1, draw.stroke.miterLimit) + 1e-3
          : 1e-3;
        const quad = clip.universe.v.map((p) => apply(inverse, p));
        if (boxInQuad([x0 - pad, y0 - pad, x1 + pad, y1 + pad], quad)) {
          universe = null;
        }
      }
      return {
        kind: "mask",
        rel: multiply(inverse, clip.matrix),
        universe,
        masks,
      };
    }
    const sources: { geometry: DrawGeometry; rel: Matrix }[] = [];
    for (const source of clip.source) {
      const own = invert(source.matrix);
      if (!own) continue;
      const geometry = this.geometry(source, own, device);
      if (geometry.cmds.length === 0) continue;
      sources.push({ geometry, rel: multiply(inverse, source.matrix) });
    }
    return { kind: "matte", inverted: clip.inverted, sources };
  }

  /**
   * One pass over every frame at the device scale `box` gives. With
   * `measure`, only the content box: the union of every draw's exact
   * region, without fitting.
   */
  pass(
    frames: readonly (readonly Draw[])[],
    box: Box,
    measure: boolean,
  ): {
    records: Map<string, GeometryRecord>;
    uses: Use[][];
    contentBox: Box;
    shapes: ShapeInput[];
  } {
    const ck = this.ck;
    const device = this.maxDisplayPx / long(box);
    // Parts of a paint split apart only when more than a display pixel at
    // icon-size 1 separates them; see splitContours.
    const margin = long(box) / this.entry.displayPx;
    const booleans = new Booleans(ck);
    const records = new Map<string, GeometryRecord>();
    const uses: Use[][] = [];
    frames.forEach((draws, frame) => {
      const list: Use[] = [];
      for (const draw of draws) {
        const inverse = invert(draw.matrix);
        if (!inverse) continue;
        const geometry = this.geometry(draw, inverse, device);
        if (geometry.cmds.length === 0) continue;
        const key = geometryKey(geometry);
        let record = records.get(key);
        if (!record) {
          record = {
            geometry,
            where: draw.path,
            uses: [],
            fillRule: draw.fillRule,
            parts: [],
            contours: [],
            pxPerUnit: 0,
          };
          records.set(key, record);
        }
        const use: Use = { frame, draw, inverse, key };
        record.uses.push(use);
        list.push(use);
      }
      uses.push(list);
    });
    let contentBox = EMPTY;
    const shapes: ShapeInput[] = [];
    const px = this.entry.displayPx / long(box);
    for (const record of records.values()) {
      const stretch = Math.max(
        ...record.uses.map((u) => maxScale(u.draw.matrix)),
      );
      const k = device * stretch;
      const path = finalPath(ck, record.geometry, k, booleans, record.where);
      record.fillRule = fillRuleOf(ck, path);
      this.checkPrecomps(record, path, k);
      if (measure) {
        for (const use of record.uses) {
          contentBox = union(
            contentBox,
            this.tightBounds(
              path,
              multiply(use.draw.matrix, scaling(1 / k, 1 / k)),
            ),
          );
        }
      } else {
        const refined =
          !!record.geometry.stroke || record.geometry.clips.length > 0;
        record.contours = fitPath(ck, path, refined).map((contour) =>
          mapContour(contour, scaling(1 / k, 1 / k)),
        );
        record.pxPerUnit = px * stretch;
        const shrink = Math.min(
          ...record.uses.map((u) => minScale(u.draw.matrix)),
        );
        const parts = splitContours(
          record.contours,
          shrink > 0 ? margin / shrink : 0,
        );
        record.parts = parts.map((contours) => {
          shapes.push({ contours, pxPerUnit: record.pxPerUnit });
          return {
            contours,
            shape: shapes.length - 1,
            curves: contours.reduce((sum, c) => sum + c.length, 0),
          };
        });
      }
      path.delete();
    }
    // The measuring pass repeats the booleans; report the final pass's.
    if (!measure) this.fallbacks.push(...booleans.fallbacks);
    return { records, uses, contentBox, shapes };
  }

  /** The exact bounds of `path` mapped through `m`. */
  private tightBounds(path: Path, m: Matrix): Box {
    const mapped = toPath(this.ck, mapCmds(this.ck, cmdsOf(path), m));
    const empty = mapped.isEmpty();
    const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = mapped.computeTightBounds();
    mapped.delete();
    return !empty && x0 <= x1 && y0 <= y1 ? [x0, y0, x1, y1] : EMPTY;
  }

  /**
   * Rejects content that leaves a precomposition's rectangle: lottie-web
   * clips it there (SVGBaseElement.js:44-64), and the catalog cannot yet
   * (precomp-clip, Composite).
   */
  private checkPrecomps(record: GeometryRecord, path: Path, k: number): void {
    if (this.ignore.has("precomp-clip")) return;
    for (const use of record.uses) {
      for (const precomp of use.draw.precomps) {
        const toPrecomp = invert(precomp.matrix);
        if (!toPrecomp) continue;
        const [x0, y0, x1, y1] = this.tightBounds(
          path,
          multiply(toPrecomp, multiply(use.draw.matrix, scaling(1 / k, 1 / k))),
        );
        if (!(x0 <= x1)) continue;
        if (
          x0 < -CLIP_MARGIN ||
          y0 < -CLIP_MARGIN ||
          x1 > precomp.w + CLIP_MARGIN ||
          y1 > precomp.h + CLIP_MARGIN
        ) {
          this.violate(precomp.path, "precomp-clip");
        }
      }
    }
  }

  /** The catalog paint of a draw. */
  paint(draw: Draw): PaintInput | undefined {
    const paint = draw.paint;
    if (paint.kind === "solid") {
      const rule: SlotRule = {
        ...(this.entry.slots ? { colors: this.entry.slots } : {}),
        ...(this.entry.tint ? { tint: true } : {}),
      };
      return {
        kind: "solid",
        color: [...paint.color, draw.alpha],
        slot: slotOf(paint.color, paint.slot, rule),
      };
    }
    if (paint.stops.length < 2) return undefined;
    const stops =
      paint.stops.length > MAX_STOPS ? resampleStops(paint.stops) : paint.stops;
    return {
      kind: paint.kind,
      from: paint.from,
      to: paint.to,
      stops: stops.map((stop) => ({ offset: stop.offset, color: stop.color })),
      opacity: draw.alpha,
    };
  }
}

/**
 * Bakes one manifest entry from its parsed Lottie JSON. Throws on anything
 * the profile rejects, a frame over the op limit, or a size over the limit
 * of an entry not marked heavy. Cost limits need the packed catalog and
 * are checked by bakeEntries.
 */
export async function bakeAnimation(
  entry: CatalogEntry,
  json: unknown,
  options: BakeOptions = {},
): Promise<BakedAnimation> {
  checkEntry(entry);
  const ck = await canvasKit();
  const notes = checkProfile(entry.file, json, entry.ignore);
  const ignore = new Set(entry.ignore ?? []);
  const lottie = prepare(json as Lottie, { ignore });
  if (!isPositive(lottie.w) || !isPositive(lottie.h)) {
    throw new Error(
      `w, h: expected a canvas size > 0, got ${JSON.stringify([lottie.w, lottie.h])}`,
    );
  }
  if (!isPositive(lottie.fr) || !(lottie.op > lottie.ip)) {
    throw new Error(
      `fr, ip, op: expected a frame rate > 0 and op > ip, got ${JSON.stringify([lottie.fr, lottie.ip, lottie.op])}`,
    );
  }
  const fps = entry.fps ?? options.fps ?? DEFAULT_FPS;
  const maxDisplayPx = entry.maxDisplayPx ?? 4 * entry.displayPx;
  const count = frameCount(lottie, fps);
  const frames: Draw[][] = [];
  for (let i = 0; i < count; i++) {
    frames.push(evaluateFrame(lottie, sampleTime(lottie, i, fps), { ignore }));
  }
  const baker = new AnimationBaker(ck, entry, lottie);
  baker.check(frames);

  // The tolerance depends on the box; a content box is only known after a
  // first pass at the canvas's scale.
  let box: Box =
    entry.box && entry.box !== "canvas"
      ? entry.box
      : [0, 0, lottie.w, lottie.h];
  if (!entry.box) {
    const measured = baker.pass(frames, box, true).contentBox;
    if (!measured.every(Number.isFinite)) {
      throw new Error(
        'draws nothing in any frame, so it has no content box; give the entry a "box"',
      );
    }
    box = measured;
  }
  const { records, uses, shapes } = baker.pass(frames, box, false);
  if (baker.violations.size > 0) {
    throw new ProfileError(entry.file, [...baker.violations.values()]);
  }

  // Ops, frame by frame; the op bounds give the final content box.
  let contentBox = EMPTY;
  let maxOps = 0;
  let totalOps = 0;
  let maxCurves = 0;
  const isolation = new Map<string, Violation>();
  const inputFrames = uses.map((list, frame) => {
    const ops: OpInput[] = [];
    const groups = new Map<string, Box[]>();
    let curves = 0;
    // Split draws into parts while the frame has room (M0's rule).
    list.forEach((use, k) => {
      const record = records.get(use.key) as GeometryRecord;
      const paint = baker.paint(use.draw);
      if (!paint) return;
      const room = MAX_OPS - (ops.length + list.length - k);
      let parts: { shape: number; curves: number; contours: Contour[] }[] =
        record.parts;
      if (record.parts.length - 1 > room) {
        record.whole ??= {
          shape:
            shapes.push({
              contours: record.contours,
              pxPerUnit: record.pxPerUnit,
            }) - 1,
          curves: record.contours.reduce((sum, c) => sum + c.length, 0),
        };
        parts = [{ ...record.whole, contours: record.contours }];
      }
      let drawBox = EMPTY;
      for (const part of parts) {
        let bbox = EMPTY;
        for (const contour of part.contours) {
          bbox = union(bbox, controlBounds(contour, use.draw.matrix));
          if (!entry.box) {
            contentBox = union(
              contentBox,
              contourBounds(mapContour(contour, use.draw.matrix)),
            );
          }
        }
        if (!bbox.every(Number.isFinite)) continue;
        drawBox = union(drawBox, bbox);
        ops.push({
          bbox,
          affine: toAffine(use.inverse),
          shape: part.shape,
          fillRule: record.fillRule,
          paint,
        });
        curves += part.curves;
      }
      for (const group of use.draw.translucent) {
        const boxes = groups.get(group) ?? [];
        if (boxes.some((b) => overlap(b, drawBox)) && !isolation.has(group)) {
          isolation.set(group, { path: group, feature: "opacity-isolation" });
        }
        boxes.push(drawBox);
        groups.set(group, boxes);
      }
    });
    if (ops.length > MAX_OPS) {
      throw new Error(
        `frame ${frame} has ${ops.length} draws; a frame holds at most ${MAX_OPS}`,
      );
    }
    maxOps = Math.max(maxOps, ops.length);
    totalOps += ops.length;
    maxCurves = Math.max(maxCurves, curves);
    return { ops };
  });

  const ignoresIsolation = ignore.has("opacity-isolation");
  if (isolation.size > 0 && !ignoresIsolation) {
    throw new ProfileError(entry.file, [...isolation.values()]);
  }
  if (!entry.box) {
    if (!contentBox.every(Number.isFinite)) {
      throw new Error(
        'draws nothing in any frame, so it has no content box; give the entry a "box"',
      );
    }
    box = contentBox;
  }
  if (entry.box === "canvas") box = [0, 0, lottie.w, lottie.h];

  const markers = markerInputs(entry, lottie, count, fps);
  const warnings = [...markers.notes];
  const ignored = ignoresIsolation
    ? [...notes.ignored, ...isolation.values()]
    : notes.ignored;
  return {
    entry,
    animation: {
      name: entry.name,
      canvas: [lottie.w, lottie.h],
      box,
      displayPx: entry.displayPx,
      fps,
      frames: inputFrames,
    },
    shapes,
    markers: markers.inputs,
    stats: {
      name: entry.name,
      file: entry.file,
      fps,
      frames: count,
      box,
      displayPx: entry.displayPx,
      maxDisplayPx,
      maxOps,
      ops: totalOps,
      draws: uses.reduce((sum, list) => sum + list.length, 0),
      geometries: records.size,
      shapes: shapes.length,
      maxCurves,
      fallbacks: baker.fallbacks,
      markers: markers.inputs.map((m) => m.name),
      notes: { ...notes, ignored },
      warnings,
    },
  };
}

/**
 * The marker entries an entry asks for (FORMAT.md, "Frame sampling"): a
 * marker `{cm, tm, dr}` starts at `round((tm - ip) / fr * fps)` and runs
 * `max(1, round(dr / fr * fps))` frames, clipped to the animation's.
 */
export function markerInputs(
  entry: CatalogEntry,
  lottie: Pick<Lottie, "ip" | "fr" | "markers">,
  frames: number,
  fps: number,
): { inputs: MarkerInput[]; notes: string[] } {
  const inputs: MarkerInput[] = [];
  const notes: string[] = [];
  if (!entry.markers) return { inputs, notes };
  const markers = lottie.markers ?? [];
  const wanted = entry.markers === true ? undefined : new Set(entry.markers);
  for (const name of wanted ?? []) {
    if (!markers.some((m) => m.cm === name)) {
      throw new Error(
        `markers: the file has no marker ${JSON.stringify(name)}`,
      );
    }
  }
  const names = new Set<string>();
  for (const marker of markers) {
    const cm = marker.cm ?? "";
    if (wanted && !wanted.has(cm)) continue;
    const name = `${entry.name}#${slug(cm)}`;
    if (names.has(name)) {
      throw new Error(
        `markers: two markers become the entry ${JSON.stringify(name)}`,
      );
    }
    names.add(name);
    const start = Math.round(
      (((marker.tm ?? 0) - lottie.ip) / lottie.fr) * fps,
    );
    const count = Math.max(1, Math.round(((marker.dr ?? 0) / lottie.fr) * fps));
    const first = Math.max(0, start);
    const end = Math.min(frames, start + count);
    if (end <= first) {
      notes.push(
        `marker ${JSON.stringify(cm)} lies outside the animation's frames; skipped`,
      );
      continue;
    }
    inputs.push({ name, of: entry.name, start: first, count: end - first });
  }
  return { inputs, notes };
}

/** A license the baked catalog carries, with the animations under it. */
export interface LicenseNotice {
  /** `name: credit` for every animation under the license. */
  readonly credits: readonly string[];
  /** The license file's text. */
  readonly text: string;
}

/** An animation's final numbers, once packed and measured. */
export interface AnimationReport extends AnimationStats {
  /** Curve visits per pixel: the mean over the box, the most over frames. */
  readonly visits: number;
  /** Estimated µs per icon at displayPx on a 3x screen (COST_LABEL). */
  readonly micros: readonly [number, number];
  readonly bytes: number;
  readonly frameBytes: number;
  readonly opBytes: number;
  readonly shapeBytes: number;
  readonly gradientBytes: number;
}

export interface BakedCatalog {
  readonly animations: readonly AnimationReport[];
  readonly packed: PackedCatalog;
  /** The licenses of third-party animations, one entry per license text. */
  readonly licenses: readonly LicenseNotice[];
}

/**
 * Curve visits per pixel of an animation: every sampled frame rasterised
 * with the shader's CPU twin at `displayPx × 2` device pixels over the
 * anchor box (every frame up to VISIT_SAMPLES, else an even stride).
 */
export function measureVisits(catalog: Catalog, record: number): number {
  const animation = catalog.animations[record];
  if (!animation) throw new Error(`no animation record ${record}`);
  const art = {
    texels: catalog.texture,
    width: catalog.textureWidth,
    height: catalog.textureHeight,
  };
  const [x0, y0, x1, y1] = animation.box;
  const scale = (animation.displayPx * 2) / Math.max(x1 - x0, y1 - y0);
  const width = Math.max(1, Math.round((x1 - x0) * scale));
  const height = Math.max(1, Math.round((y1 - y0) * scale));
  const step = 1 / scale;
  const n = animation.frameCount;
  const samples = Math.min(n, VISIT_SAMPLES);
  let most = 0;
  for (let s = 0; s < samples; s++) {
    const frame = Math.floor((s * n) / samples);
    let visits = 0;
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        visits += shade({
          art,
          frameTexel: animation.frameTexel + frame,
          uv: [x0 + (px + 0.5) * step, y0 + (py + 0.5) * step],
          dx: [step, 0],
          dy: [0, step],
        }).visits;
      }
    }
    most = Math.max(most, visits / (width * height));
  }
  return most;
}

/**
 * Packs baked animations into one catalog, measures each, and applies the
 * cost and size limits. The shapes of every animation share one list;
 * identical shapes are stored once.
 */
export function packAnimations(
  baked: readonly BakedAnimation[],
  licenses: readonly LicenseNotice[] = [],
): BakedCatalog {
  const shapes: ShapeInput[] = [];
  const seen = new Map<string, number>();
  const animations: (AnimationInput | MarkerInput)[] = [];
  const records: number[] = [];
  for (const b of baked) {
    const index = b.shapes.map((shape) => {
      const key = createHash("sha1")
        .update(JSON.stringify(shape.contours))
        .digest("hex");
      const known = seen.get(key);
      if (known !== undefined) {
        const existing = shapes[known] as ShapeInput;
        if (shape.pxPerUnit > existing.pxPerUnit) {
          shapes[known] = { ...existing, pxPerUnit: shape.pxPerUnit };
        }
        return known;
      }
      seen.set(key, shapes.length);
      shapes.push(shape);
      return shapes.length - 1;
    });
    records.push(animations.length);
    animations.push({
      ...b.animation,
      frames: b.animation.frames.map((frame) => ({
        ops: frame.ops.map((op) => ({
          ...op,
          shape: index[op.shape] as number,
        })),
      })),
    });
    animations.push(...b.markers);
  }
  if (animations.length > MAX_ANIMATIONS) {
    throw new Error(
      `${animations.length} entries (markers included), more than a catalog's ${MAX_ANIMATIONS}`,
    );
  }
  const input: CatalogInput = { shapes, animations };
  const packed = packCatalog(input);
  // The writer mirrors the readers' checks; parsing the result with the JS
  // twin makes sure no file the runtimes reject is ever written.
  const catalog = Catalog.parse(packed.bytes);
  const reports = baked.map((b, i): AnimationReport => {
    const record = records[i] as number;
    const stats = packed.animations[record];
    const visits = measureVisits(catalog, record);
    const [x0, y0, x1, y1] = b.stats.box;
    const ratio = ((x1 - x0) * (y1 - y0)) / Math.max(x1 - x0, y1 - y0) ** 2;
    const pixels = (b.stats.displayPx * 3) ** 2 * ratio;
    const micros = NS_PER_VISIT.map((ns) => (visits * pixels * ns) / 1000) as [
      number,
      number,
    ];
    const warnings = [...b.stats.warnings];
    const heavy = b.entry.heavy === true;
    const label = `${b.stats.name} (${b.stats.file})`;
    if (visits > VISITS_MAX && !heavy) {
      throw new Error(
        `${label}: about ${visits.toFixed(1)} curve visits per pixel, over the limit of ${VISITS_MAX}; simplify the art or mark the entry "heavy": true`,
      );
    }
    if (visits > VISITS_WARN) {
      warnings.push(
        `about ${visits.toFixed(1)} curve visits per pixel, over ${VISITS_WARN}`,
      );
    }
    const bytes = stats?.bytes ?? 0;
    if (bytes > BYTES_MAX && !heavy) {
      throw new Error(
        `${label}: ${bytes} baked bytes, over the limit of ${BYTES_MAX}; bake with --fps 30 or mark heavy`,
      );
    }
    return {
      ...b.stats,
      warnings,
      visits,
      micros,
      bytes,
      frameBytes: (stats?.frameTexels ?? 0) * 16,
      opBytes: (stats?.opTexels ?? 0) * 16,
      shapeBytes: (stats?.shapeTexels ?? 0) * 16,
      gradientBytes: (stats?.gradientTexels ?? 0) * 16,
    };
  });
  return { animations: reports, packed, licenses };
}

/** Reads and checks a manifest. */
export function readManifest(path: string): CatalogManifest {
  const json: unknown = JSON.parse(readFileSync(path, "utf8"));
  try {
    checkManifest(json);
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`, { cause: error });
  }
  return json;
}

/**
 * Bakes and packs every entry of a manifest, in its order (the enum
 * order, marker entries after their animation). `fps` is the default for
 * entries without their own frame rate, before the manifest's.
 */
export async function bakeCatalog(
  manifestPath: string,
  options: BakeOptions = {},
): Promise<BakedCatalog> {
  const manifest = readManifest(manifestPath);
  const dir = dirname(manifestPath);
  const fps = options.fps ?? manifest.fps;
  const baked: BakedAnimation[] = [];
  const licenses = new Map<string, string[]>();
  for (const [index, entry] of manifest.animations.entries()) {
    const fields = entry as unknown as Partial<Record<string, unknown>>;
    const label =
      typeof fields.name === "string" && typeof fields.file === "string"
        ? `${fields.name} (${fields.file})`
        : `animations[${index}]`;
    try {
      checkEntry(entry);
      const json: unknown = JSON.parse(
        readFileSync(join(dir, entry.file), "utf8"),
      );
      baked.push(
        await bakeAnimation(entry, json, fps === undefined ? {} : { fps }),
      );
      if (entry.license !== undefined) {
        const text = readFileSync(join(dir, entry.license), "utf8").trim();
        const credit = `${entry.name}: ${entry.credit ?? entry.file}`;
        licenses.set(text, [...(licenses.get(text) ?? []), credit]);
      }
    } catch (error) {
      if (error instanceof ProfileError) throw error;
      throw new Error(`${label}: ${(error as Error).message}`, {
        cause: error,
      });
    }
  }
  return packAnimations(
    baked,
    [...licenses].map(([text, credits]) => ({ credits, text })),
  );
}
