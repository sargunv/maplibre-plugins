// Writer for the `.mlvc` catalog, version 2 (../../catalog/FORMAT.md). This
// is the only code that writes the format; the runtimes read it through the
// catalog twins (../../native/src/catalog.zig, ../../js/src/catalog.ts).
//
// The texel section holds, in this order: every animation's frame records,
// the op lists, the shapes (band headers, band lists, curves) and the
// gradients. Frames with identical ops share one op list, ops share shapes
// by index, identical gradients are stored once, and marker entries point
// into their animation's frame records. None of that changes how the
// shader reads the catalog.

import { buildBands } from "./bands.ts";

/** A point (y down). */
export type Point = readonly [number, number];

/** A box `x0, y0, x1, y1`. */
export type Box = readonly [number, number, number, number];

/**
 * One quadratic curve of a closed contour: its start point and control
 * point. The curve ends at the next curve's `on` point, and the last curve
 * ends at the first one's.
 */
export interface Curve {
  readonly on: Point;
  readonly ctrl: Point;
}

/** A closed contour of quadratic curves; at least one curve. */
export type Contour = readonly Curve[];

/** The canvas-to-local map `q = (a·u + b·v + tx, c·u + d·v + ty)`. */
export type Affine = readonly [number, number, number, number, number, number];

/** A shape that ops draw, in its own local units. */
export interface ShapeInput {
  readonly contours: readonly Contour[];
  /**
   * Logical pixels per local unit at displayPx, the largest over the
   * shape's uses: sizes the bands and enables the ray split.
   */
  readonly pxPerUnit: number;
}

export interface GradientStop {
  readonly offset: number;
  /** Straight (not premultiplied) RGBA in 0..1. */
  readonly color: readonly [number, number, number, number];
}

export type PaintInput =
  | {
      readonly kind: "solid";
      /** Straight RGBA in 0..1; the writer premultiplies it. */
      readonly color: readonly [number, number, number, number];
      /** 0 authored, 1 primary (icon-color), 2 secondary. */
      readonly slot?: 0 | 1 | 2;
    }
  | {
      readonly kind: "linear" | "radial";
      /** Start and end in local units; radial: the centre and a point on the radius. */
      readonly from: Point;
      readonly to: Point;
      /** 2 to 8 stops with non-decreasing offsets in 0..1. */
      readonly stops: readonly GradientStop[];
      /** Multiplies the whole gradient, 0..1. */
      readonly opacity: number;
    };

/** One draw: a shape filled with a paint. Ops draw in order, the first at the bottom. */
export interface OpInput {
  /** Conservative bounds of the op's coverage, in canvas pixels. */
  readonly bbox: Box;
  /** Canvas to the shape's local units. */
  readonly affine: Affine;
  /** Index into CatalogInput.shapes. */
  readonly shape: number;
  readonly fillRule: "nonzero" | "evenodd";
  readonly paint: PaintInput;
}

export interface FrameInput {
  /** At most 64. */
  readonly ops: readonly OpInput[];
}

export interface AnimationInput {
  /** Unique, matches `[a-z0-9][a-z0-9_#-]*`, never `none`. */
  readonly name: string;
  /** Lottie canvas width and height. */
  readonly canvas: Point;
  /** The anchor box in canvas pixels. */
  readonly box: Box;
  /** Logical pixels of the box's longer side at `icon-size` 1. */
  readonly displayPx: number;
  readonly fps: number;
  readonly frames: readonly FrameInput[];
}

/** An entry that plays frames `start .. start + count` of animation `of`. */
export interface MarkerInput {
  readonly name: string;
  readonly of: string;
  readonly start: number;
  readonly count: number;
}

export interface CatalogInput {
  readonly shapes: readonly ShapeInput[];
  /** Entries in enum order (index 0 is enum value 1; `none` is implicit). */
  readonly animations: readonly (AnimationInput | MarkerInput)[];
  /** Defaults to 1024, or 2048 when 1024 × 2048 texels are not enough. */
  readonly textureWidth?: 1024 | 2048;
}

/** Texels each entry adds to the catalog; markers add none. */
export interface PackedAnimationStats {
  readonly name: string;
  readonly frameTexels: number;
  /** Op lists this entry uses first. */
  readonly opTexels: number;
  /** Shapes this entry uses first. */
  readonly shapeTexels: number;
  /** Gradients this entry uses first. */
  readonly gradientTexels: number;
  /** 16 bytes per texel above. */
  readonly bytes: number;
}

export interface PackedCatalog {
  readonly bytes: Uint8Array;
  readonly textureWidth: number;
  readonly textureHeight: number;
  readonly texelCount: number;
  readonly animations: readonly PackedAnimationStats[];
}

export const MAGIC = "MLVCAT\0\0";
export const VERSION = 2;
/** Animation names: `[a-z0-9][a-z0-9_#-]*`, and never `none`. */
export const NAME = /^[a-z0-9][a-z0-9_#-]*$/;
export const MAX_OPS = 64;
export const MAX_ANIMATIONS = 510;
/** Curves one band may list; readers accept up to 1024. */
export const MAX_BAND_ENTRIES = 256;
export const MAX_TEXTURE_SIZE = 2048;
/** Largest magnitude of a record's float fields, and integers stay below it. */
export const MAX_MAGNITUDE = 16777216;

const HEADER_BYTES = 64;
const RECORD_BYTES = 64;
const TEXEL_BYTES = 16;
const STYLE_EVENODD = 4;
const PAINT_KINDS = { solid: 0, linear: 1, radial: 2 } as const;

function isPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= MAX_MAGNITUDE;
}

function isUnit(value: number): boolean {
  return value >= 0 && value <= 1;
}

function align16(value: number): number {
  return Math.ceil(value / 16) * 16;
}

function isMarker(entry: AnimationInput | MarkerInput): entry is MarkerInput {
  return "of" in entry;
}

/** A closed polygon; each straight edge stores its midpoint as control point. */
export function polygon(points: readonly Point[]): Contour {
  return points.map((on, i) => {
    const next = points[(i + 1) % points.length] ?? on;
    return { on, ctrl: [(on[0] + next[0]) / 2, (on[1] + next[1]) / 2] };
  });
}

/** A growable list of texels, four f32 each. */
class Texels {
  data = new Float32Array(1024);
  length = 0;

  /** Appends `count` zero texels and returns the first one's index. */
  alloc(count: number): number {
    const start = this.length;
    this.length += count;
    if (this.length * 4 > this.data.length) {
      let size = this.data.length;
      while (size < this.length * 4) size *= 2;
      const grown = new Float32Array(size);
      grown.set(this.data);
      this.data = grown;
    }
    return start;
  }

  set(texel: number, values: readonly number[]): void {
    this.data.set(values, texel * 4);
  }
}

/** A shape in the form it is written: shifted so its bounds start at 0. */
interface PreparedShape {
  /** Subtracted from every local coordinate (and from each op's translation). */
  readonly shift: Point;
  readonly contours: readonly Contour[];
  readonly texels: number;
  write(out: Texels, at: number): void;
}

/**
 * Moves a shape's control-hull minimum to the origin, which keeps its band
 * transform exact in f32, and lays out its record: two header texels, a
 * header per band, the band lists (identical lists shared), then the curves,
 * each contour closed by a copy of its first point.
 */
function prepareShape(shape: ShapeInput, index: number): PreparedShape {
  const where = `shape ${index}`;
  if (!(shape.pxPerUnit > 0 && Number.isFinite(shape.pxPerUnit))) {
    throw new Error(`${where}: pxPerUnit ${shape.pxPerUnit} must be positive`);
  }
  let x0 = Infinity;
  let y0 = Infinity;
  for (const contour of shape.contours) {
    if (contour.length === 0)
      throw new Error(`${where}: a contour has no curves`);
    for (const { on, ctrl } of contour) {
      for (const v of [...on, ...ctrl]) {
        if (!(Math.abs(v) <= MAX_MAGNITUDE)) {
          throw new Error(
            `${where}: coordinate ${v} is not finite or too large`,
          );
        }
      }
      x0 = Math.min(x0, Math.fround(on[0]), Math.fround(ctrl[0]));
      y0 = Math.min(y0, Math.fround(on[1]), Math.fround(ctrl[1]));
    }
  }
  const shift: Point = Number.isFinite(x0) ? [x0, y0] : [0, 0];
  const move = (p: Point): Point => [
    Math.fround(Math.fround(p[0]) - shift[0]),
    Math.fround(Math.fround(p[1]) - shift[1]),
  ];
  const contours = shape.contours.map((contour) =>
    contour.map(({ on, ctrl }) => ({ on: move(on), ctrl: move(ctrl) })),
  );
  const layout = buildBands(contours, shape.pxPerUnit);
  const bands = [...layout.h, ...layout.v];
  // Texel offset of each flattened curve within the curve block.
  const curveTexel: number[] = [];
  let curveTexels = 0;
  for (const contour of contours) {
    for (let k = 0; k < contour.length; k++) curveTexel.push(curveTexels + k);
    curveTexels += contour.length + 1;
  }
  const lists = new Map<string, number>();
  const listOffset: number[] = [];
  let listTexels = 0;
  bands.forEach((band, b) => {
    const direction = b < layout.h.length ? "horizontal" : "vertical";
    if (band.pos.length > MAX_BAND_ENTRIES) {
      throw new Error(
        `${where}: a ${direction} band lists ${band.pos.length} curves, at most ${MAX_BAND_ENTRIES}`,
      );
    }
    const key = `${band.pos.join(",")}|${band.neg.join(",")}`;
    let offset = lists.get(key);
    if (offset === undefined) {
      offset = listTexels;
      lists.set(key, offset);
      listTexels += Math.ceil(band.pos.length / 2);
    }
    listOffset.push(offset);
  });
  const headerTexels = 2 + bands.length;
  return {
    shift,
    contours,
    texels: headerTexels + listTexels + curveTexels,
    write(out, at) {
      const listsAt = at + headerTexels;
      const curvesAt = listsAt + listTexels;
      out.set(at, [layout.h.length, layout.v.length, 0, 0]);
      out.set(at + 1, layout.transform);
      bands.forEach((band, b) => {
        const count = band.pos.length;
        const list = listsAt + (listOffset[b] ?? 0);
        out.set(at + 2 + b, [band.split, count, count > 0 ? list : at, 0]);
        for (let i = 0; i < count; i++) {
          const pos = curvesAt + (curveTexel[band.pos[i] ?? 0] ?? 0);
          const neg = curvesAt + (curveTexel[band.neg[i] ?? 0] ?? 0);
          out.data.set([pos, neg], (list + (i >> 1)) * 4 + (i & 1) * 2);
        }
      });
      let texel = curvesAt;
      for (const contour of contours) {
        for (const { on, ctrl } of contour) {
          out.set(texel++, [on[0], on[1], ctrl[0], ctrl[1]]);
        }
        const first = contour[0]?.on ?? [0, 0];
        out.set(texel++, [first[0], first[1], 0, 0]);
      }
    },
  };
}

/** A gradient record's texels (FORMAT.md "Gradient"), in shifted local units. */
function gradientTexels(
  paint: Extract<PaintInput, { kind: "linear" | "radial" }>,
  shift: Point,
  where: string,
): number[][] {
  const { from, to, stops } = paint;
  if (stops.length < 2 || stops.length > 8) {
    throw new Error(
      `${where}: a gradient has ${stops.length} stops, expected 2 to 8`,
    );
  }
  if (![...from, ...to].every(Number.isFinite)) {
    throw new Error(`${where}: gradient endpoints must be finite`);
  }
  const offsets = [1, 1, 1, 1, 1, 1, 1, 1];
  stops.forEach((stop, k) => {
    const previous = stops[k - 1]?.offset ?? 0;
    if (!(isUnit(stop.offset) && stop.offset >= previous)) {
      throw new Error(
        `${where}: gradient offsets must be non-decreasing in 0..1, got ${stops.map((s) => s.offset).join(", ")}`,
      );
    }
    if (!stop.color.every(isUnit)) {
      throw new Error(`${where}: gradient stop ${k} color must be in 0..1`);
    }
    offsets[k] = stop.offset;
  });
  return [
    [
      from[0] - shift[0],
      from[1] - shift[1],
      to[0] - shift[0],
      to[1] - shift[1],
    ],
    offsets.slice(0, 4),
    offsets.slice(4),
    ...stops.map((stop) => [...stop.color]),
  ];
}

/** An op's texels with the shape and gradient left as references. */
interface OpDraft {
  readonly texels: number[][];
  readonly shape: number;
  /** Key of the gradient record, or null for a solid paint. */
  readonly gradient: string | null;
}

/** The f32 bits of values, as a string key. */
function key(values: readonly (readonly number[])[]): string {
  return Array.from(
    new Uint32Array(Float32Array.from(values.flat()).buffer),
  ).join(",");
}

/**
 * Packs shapes and animations into a catalog: premultiplies solid colors,
 * builds the band lists and dedupes op lists and gradients. Throws when the
 * input breaks a rule readers would reject or a baker limit.
 */
export function packCatalog(input: CatalogInput): PackedCatalog {
  const entries = input.animations;
  if (entries.length > MAX_ANIMATIONS) {
    throw new Error(
      `the catalog has ${entries.length} entries, at most ${MAX_ANIMATIONS}`,
    );
  }
  const names = new Map<string, number>();
  entries.forEach(({ name }, i) => {
    if (!NAME.test(name) || name === "none") {
      throw new Error(
        `animation name ${JSON.stringify(name)} must match [a-z0-9][a-z0-9_#-]* and not be "none"`,
      );
    }
    if (names.has(name)) throw new Error(`animation ${name} is repeated`);
    names.set(name, i);
  });

  // Shapes are written in the order ops first use them; unused ones are dropped.
  const shapes = new Map<number, PreparedShape>();
  const shapeFor = (index: number, where: string): PreparedShape => {
    let prepared = shapes.get(index);
    if (!prepared) {
      const shape = input.shapes[index];
      if (!shape || !Number.isInteger(index)) {
        throw new Error(`${where}: shape ${index} does not exist`);
      }
      prepared = prepareShape(shape, index);
      shapes.set(index, prepared);
    }
    return prepared;
  };
  const gradients = new Map<string, number[][]>();
  const opLists = new Map<string, OpDraft[]>();
  const stats = entries.map((entry) => ({
    name: entry.name,
    frameTexels: 0,
    opTexels: 0,
    shapeTexels: 0,
    gradientTexels: 0,
  }));
  // Per animation, per frame: the key of its op list.
  const frameLists: string[][] = [];

  entries.forEach((entry, i) => {
    const stat = stats[i];
    if (!stat) return;
    if (isMarker(entry)) {
      frameLists.push([]);
      return;
    }
    const { name, box, displayPx, fps, canvas, frames } = entry;
    // Readers check the f32 values.
    const [x0 = NaN, y0 = NaN, x1 = NaN, y1 = NaN] = box.map((v) =>
      Math.fround(v),
    );
    if (
      !(
        [x0, y0, x1, y1].every((v) => Math.abs(v) <= MAX_MAGNITUDE) &&
        x0 < x1 &&
        y0 < y1
      )
    ) {
      throw new Error(
        `animation ${name}: box [${box.join(", ")}] must be finite with x0 < x1 and y0 < y1, each at most ${MAX_MAGNITUDE} in magnitude`,
      );
    }
    const range = `a finite number in (0, ${MAX_MAGNITUDE}]`;
    if (!isPositive(Math.fround(displayPx))) {
      throw new Error(
        `animation ${name}: displayPx ${displayPx} must be ${range}`,
      );
    }
    if (!isPositive(Math.fround(fps))) {
      throw new Error(`animation ${name}: fps ${fps} must be ${range}`);
    }
    if (!canvas.every((v) => isPositive(Math.fround(v)))) {
      throw new Error(
        `animation ${name}: canvas [${canvas.join(", ")}] must be two sizes, each ${range}`,
      );
    }
    if (frames.length === 0 || frames.length >= MAX_MAGNITUDE) {
      throw new Error(
        `animation ${name}: has ${frames.length} frames, expected 1 to ${MAX_MAGNITUDE - 1}`,
      );
    }
    stat.frameTexels = frames.length;
    const lists: string[] = [];
    frames.forEach((frame, f) => {
      if (frame.ops.length > MAX_OPS) {
        throw new Error(
          `animation ${name}: frame ${f} has ${frame.ops.length} ops, at most ${MAX_OPS}`,
        );
      }
      const drafts = frame.ops.map((op, k): OpDraft => {
        const where = `animation ${name}: frame ${f}: op ${k}`;
        const shapeCount = shapes.size;
        const shape = shapeFor(op.shape, where);
        if (shapes.size > shapeCount) stat.shapeTexels += shape.texels;
        const [bx0, by0, bx1, by1] = op.bbox;
        if (!(op.bbox.every(Number.isFinite) && bx0 <= bx1 && by0 <= by1)) {
          throw new Error(
            `${where}: bbox [${op.bbox.join(", ")}] must be finite with x0 <= x1 and y0 <= y1`,
          );
        }
        const [a, b, c, d, tx, ty] = op.affine;
        if (!op.affine.every(Number.isFinite)) {
          throw new Error(
            `${where}: affine [${op.affine.join(", ")}] must be finite`,
          );
        }
        const evenOdd = op.fillRule === "evenodd" ? STYLE_EVENODD : 0;
        const paint = op.paint;
        let style: number;
        let color: number[];
        let gradient: string | null = null;
        if (paint.kind === "solid") {
          const [r, g, bl, al] = paint.color;
          if (!paint.color.every(isUnit)) {
            throw new Error(
              `${where}: color [${paint.color.join(", ")}] must be in 0..1`,
            );
          }
          const slot = paint.slot ?? 0;
          if (slot !== 0 && slot !== 1 && slot !== 2) {
            throw new Error(`${where}: slot ${String(slot)} must be 0, 1 or 2`);
          }
          style = slot | evenOdd;
          color = [r * al, g * al, bl * al, al];
        } else {
          if (!isUnit(paint.opacity)) {
            throw new Error(
              `${where}: gradient opacity ${paint.opacity} must be in 0..1`,
            );
          }
          const record = gradientTexels(paint, shape.shift, where);
          gradient = key(record);
          if (!gradients.has(gradient)) {
            gradients.set(gradient, record);
            stat.gradientTexels += record.length;
          }
          style = (PAINT_KINDS[paint.kind] << 3) | evenOdd;
          color = [0, record.length - 3, paint.opacity, 0];
        }
        return {
          texels: [
            [bx0, by0, bx1, by1],
            [a, b, c, d],
            [tx - shape.shift[0], ty - shape.shift[1], 0, style],
            color,
          ],
          shape: op.shape,
          gradient,
        };
      });
      const listKey = drafts
        .map((op) => `${key(op.texels)};${op.shape};${op.gradient ?? ""}`)
        .join("/");
      if (drafts.length > 0 && !opLists.has(listKey)) {
        opLists.set(listKey, drafts);
        stat.opTexels += 4 * drafts.length;
      }
      lists.push(listKey);
    });
    frameLists.push(lists);
  });

  // Texel positions: frames, op lists, shapes, gradients.
  const texels = new Texels();
  const frameTexel = entries.map((entry, i) =>
    isMarker(entry) ? 0 : texels.alloc(frameLists[i]?.length ?? 0),
  );
  const opTexel = new Map<string, number>();
  for (const [listKey, drafts] of opLists) {
    opTexel.set(listKey, texels.alloc(4 * drafts.length));
  }
  const shapeTexel = new Map<number, number>();
  for (const [index, shape] of shapes)
    shapeTexel.set(index, texels.alloc(shape.texels));
  const gradientTexel = new Map<string, number>();
  for (const [gradientKey, record] of gradients) {
    gradientTexel.set(gradientKey, texels.alloc(record.length));
  }
  const texelCount = texels.length;

  // Records: markers take their animation's frames.
  const records = entries.map((entry, i) => {
    if (!isMarker(entry)) {
      return {
        ...entry,
        frameCount: entry.frames.length,
        frameTexel: frameTexel[i] ?? 0,
      };
    }
    const parentIndex = names.get(entry.of);
    const parent = parentIndex === undefined ? undefined : entries[parentIndex];
    if (!parent || isMarker(parent)) {
      throw new Error(
        `marker ${entry.name}: ${JSON.stringify(entry.of)} is not an animation of the catalog`,
      );
    }
    const { start, count } = entry;
    if (
      !(
        Number.isInteger(start) &&
        Number.isInteger(count) &&
        start >= 0 &&
        count >= 1 &&
        start + count <= parent.frames.length
      )
    ) {
      throw new Error(
        `marker ${entry.name}: frames ${start}..${start + count} must lie inside ${parent.name}'s ${parent.frames.length} frames`,
      );
    }
    return {
      ...parent,
      name: entry.name,
      frameCount: count,
      frameTexel: (frameTexel[parentIndex ?? 0] ?? 0) + start,
    };
  });

  let textureWidth = input.textureWidth ?? 1024;
  if (input.textureWidth === undefined && texelCount > 1024 * MAX_TEXTURE_SIZE)
    textureWidth = 2048;
  if (textureWidth !== 1024 && textureWidth !== 2048) {
    throw new Error(
      `textureWidth ${String(textureWidth)} must be 1024 or 2048`,
    );
  }
  if (texelCount > textureWidth * MAX_TEXTURE_SIZE) {
    throw new Error(
      `the catalog needs ${texelCount} texels, more than a ${textureWidth}×${MAX_TEXTURE_SIZE} texture holds`,
    );
  }
  const textureHeight = Math.max(1, Math.ceil(texelCount / textureWidth));

  // Texel contents.
  entries.forEach((_, i) => {
    (frameLists[i] ?? []).forEach((listKey, f) => {
      const drafts = opLists.get(listKey) ?? [];
      texels.set((frameTexel[i] ?? 0) + f, [
        drafts.length,
        opTexel.get(listKey) ?? 0,
        0,
        0,
      ]);
    });
  });
  for (const [listKey, drafts] of opLists) {
    const at = opTexel.get(listKey) ?? 0;
    drafts.forEach((draft, k) => {
      const [o0 = [], o1 = [], o2 = [], o3 = []] = draft.texels;
      const shape = shapeTexel.get(draft.shape) ?? 0;
      const paint =
        draft.gradient === null
          ? o3
          : [gradientTexel.get(draft.gradient) ?? 0, ...o3.slice(1)];
      texels.set(at + 4 * k, o0);
      texels.set(at + 4 * k + 1, o1);
      texels.set(at + 4 * k + 2, [o2[0] ?? 0, o2[1] ?? 0, shape, o2[3] ?? 0]);
      texels.set(at + 4 * k + 3, paint);
    });
  }
  for (const [index, shape] of shapes)
    shape.write(texels, shapeTexel.get(index) ?? 0);
  for (const [gradientKey, record] of gradients) {
    const at = gradientTexel.get(gradientKey) ?? 0;
    record.forEach((values, k) => texels.set(at + k, values));
  }

  // The file: header, records, names, texels.
  const encoder = new TextEncoder();
  const nameBytes = records.map((r) => encoder.encode(r.name));
  const namesSize = nameBytes.reduce((sum, n) => sum + n.length, 0);
  const animationsOffset = HEADER_BYTES;
  const namesOffset = align16(animationsOffset + records.length * RECORD_BYTES);
  const texelsOffset = align16(namesOffset + namesSize);
  const bytes = new Uint8Array(texelsOffset + texelCount * TEXEL_BYTES);
  const view = new DataView(bytes.buffer);
  const u32 = (offset: number, value: number): void =>
    view.setUint32(offset, value, true);
  const f32 = (offset: number, value: number): void =>
    view.setFloat32(offset, value, true);
  for (let i = 0; i < MAGIC.length; i++) bytes[i] = MAGIC.charCodeAt(i);
  u32(8, VERSION);
  u32(12, records.length);
  u32(16, textureWidth);
  u32(20, textureHeight);
  u32(24, texelCount);
  u32(28, 0);
  u32(32, animationsOffset);
  u32(36, namesOffset);
  u32(40, namesSize);
  u32(44, texelsOffset);
  let nameOffset = 0;
  records.forEach((r, i) => {
    const at = animationsOffset + i * RECORD_BYTES;
    const name = nameBytes[i] ?? new Uint8Array();
    r.box.forEach((v, k) => f32(at + 4 * k, v));
    f32(at + 16, r.displayPx);
    f32(at + 20, r.fps);
    u32(at + 24, r.frameCount);
    u32(at + 28, r.frameTexel);
    u32(at + 32, nameOffset);
    u32(at + 36, name.length);
    f32(at + 40, r.canvas[0]);
    f32(at + 44, r.canvas[1]);
    bytes.set(name, namesOffset + nameOffset);
    nameOffset += name.length;
  });
  const out = new Float32Array(bytes.buffer, texelsOffset, texelCount * 4);
  const little = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  if (little) {
    out.set(texels.data.subarray(0, texelCount * 4));
  } else {
    for (let k = 0; k < texelCount * 4; k++)
      f32(texelsOffset + 4 * k, texels.data[k] ?? 0);
  }

  return {
    bytes,
    textureWidth,
    textureHeight,
    texelCount,
    animations: stats.map((s) => ({
      ...s,
      bytes:
        TEXEL_BYTES *
        (s.frameTexels + s.opTexels + s.shapeTexels + s.gradientTexels),
    })),
  };
}
