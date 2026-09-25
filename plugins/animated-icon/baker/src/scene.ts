// Evaluates a Lottie composition at one frame into draws: every fill and
// stroke with the paths it covers, bottom first. Scoping and order follow
// lottie-web's shape renderers (SVGShapeElement.searchShapes): a style covers
// every path before it in its group, including paths inside earlier nested
// groups; items earlier in a list draw on top; layers earlier in the list
// draw on top. Parenting composes transforms only, never opacity.
//
// Path modifiers (trim, round corners) change the shapes in their scope
// before any style reads them, in document order, in each shape's own space
// (ShapeElement.renderModifiers). Repeaters copy the items before them
// (repeater.ts). Precompositions evaluate their layers in their own time
// (CompElement.prepareFrame); masks and track mattes become clips that the
// baker applies with path booleans (geometry.ts).
//
// Opacity folds into each draw: the style's opacity times every group
// opacity above it and the layer's (and enclosing precompositions')
// opacity, as lottie-web's canvas renderer applies it. The draw records
// which translucent layers and groups it sits in, so the baker can tell
// when folding differs from compositing the group as a whole.

import {
  type GradientColors,
  gradientStops,
  type GradientStop,
} from "./gradient.ts";
import {
  type Property,
  parseLoop,
  scalarAt,
  shapeAt,
  valueAt,
} from "./keyframes.ts";
import type { Point } from "./pack.ts";
import { repeaterCopies, type RepeaterItem } from "./repeater.ts";
import {
  type BezierPath,
  ellipsePath,
  type EllipseItem,
  pathFromShape,
  rectPath,
  type RectItem,
  roundCorners,
  starPath,
  type StarItem,
  transformPath,
} from "./shapes.ts";
import type { StrokeStyle } from "./skia.ts";
import {
  IDENTITY,
  type Matrix,
  multiply,
  opacityAt,
  type Transform,
  transformAt,
} from "./transform.ts";
import { trimShapes } from "./trim.ts";

/** One entry of a stroke's dash list (`st.d`). */
export interface DashItem {
  /** "d" dash, "g" gap, "o" offset. */
  readonly n: string;
  readonly v?: Property;
}

/** The subset of a Lottie shape item the evaluator reads. */
export interface ShapeItem
  extends
    Omit<RectItem, "r" | "d">,
    Omit<EllipseItem, "d">,
    Omit<StarItem, "r" | "d"> {
  readonly ty: string;
  readonly hd?: boolean;
  readonly it?: readonly ShapeItem[];
  /** `sh`: the path. */
  readonly ks?: Property;
  /** `fl`/`st`: color. `rp`: copies. */
  readonly c?: Property;
  /** `fl`/`st`/`gf`/`gs`/`tr`: opacity (0..100). `tm`: offset. `rp`: offset. */
  readonly o?: Property;
  /**
   * `fl`/`gf`: fill rule, 1 nonzero, 2 even-odd. `rc`: corner radius.
   * `sr`: rotation. `rd`: radius.
   */
  readonly r?: Property | number;
  /** `st`/`gs`: width, cap, join, miter limit, dashes. */
  readonly w?: Property;
  readonly lc?: number;
  readonly lj?: number;
  readonly ml?: number;
  readonly ml2?: Property;
  /** `st`/`gs`: the dash list. `rc`/`el`/`sr`: the direction (3 reversed). */
  readonly d?: readonly DashItem[] | number;
  /** `gf`/`gs`: 1 linear, 2 radial; start and end points; stops; highlight. */
  readonly t?: number;
  readonly e?: Property;
  readonly g?: GradientColors;
  readonly h?: Property;
  /** `tm`: 1 simultaneously, 2 individually. `rp`: composite. */
  readonly m?: number;
  /** `mm`: merge mode. */
  readonly mm?: number;
  /** `rp`: the repeater's transform. */
  readonly tr?: RepeaterItem["tr"];
}

/** A layer mask (`masksProperties[]`). */
export interface MaskItem {
  /** a add, s subtract, i intersect, n none; l, d, f draw as add. */
  readonly mode?: string;
  readonly inv?: boolean;
  readonly pt?: Property;
  readonly o?: Property;
  /** Expansion, in layer pixels. */
  readonly x?: Property;
}

export interface Layer {
  readonly ty: number;
  readonly ind?: number;
  readonly parent?: number;
  readonly ip: number;
  readonly op: number;
  /** Start time and stretch; they only change a precomposition's time. */
  readonly st?: number;
  readonly sr?: number;
  readonly hd?: boolean;
  /** Matte source (`td`), matte type (`tt`) and matte parent (`tp`). */
  readonly td?: number;
  readonly tt?: number;
  readonly tp?: number;
  readonly ao?: number;
  /** Precompositions: asset, size and time remap (seconds). */
  readonly refId?: string;
  readonly w?: number;
  readonly h?: number;
  readonly tm?: Property;
  readonly ks?: Transform;
  readonly shapes?: readonly ShapeItem[];
  readonly masksProperties?: readonly MaskItem[];
  /** Solid layers: size and color (`#rrggbb`). */
  readonly sw?: number;
  readonly sh?: number;
  readonly sc?: string;
}

export interface Asset {
  readonly id: string;
  readonly layers?: readonly Layer[];
}

export interface Marker {
  /** Comment (the marker's name), start and duration in frames. */
  readonly cm?: string;
  readonly tm?: number;
  readonly dr?: number;
}

export interface Lottie {
  readonly w: number;
  readonly h: number;
  readonly fr: number;
  readonly ip: number;
  readonly op: number;
  readonly layers: readonly Layer[];
  readonly assets?: readonly Asset[];
  readonly markers?: readonly Marker[];
  readonly slots?: Readonly<Record<string, { readonly p?: Property }>>;
}

/** What a draw paints with. */
export type DrawPaint =
  | {
      readonly kind: "solid";
      /** Straight RGB in 0..1. */
      readonly color: readonly [number, number, number];
      /** The slot its color names: 1 `primary`, 2 `secondary`. */
      readonly slot: 0 | 1 | 2;
    }
  | {
      readonly kind: "linear" | "radial";
      /** Start and end in style space (radial: centre and a radius point). */
      readonly from: Point;
      readonly to: Point;
      /** Merged straight-RGBA stops (gradient.ts). */
      readonly stops: readonly GradientStop[];
      /** Radial highlight length, in percent; the catalog draws only 0. */
      readonly highlight: number;
    };

/** A stroke's dash pattern, in the stroke's space. */
export interface Dash {
  readonly intervals: readonly number[];
  readonly offset: number;
}

/** One mask, in the masked layer's space. */
export interface MaskShape {
  /** Add, subtract or intersect (l, d and f act as add, as in lottie-web). */
  readonly mode: "a" | "s" | "i";
  /**
   * The mask's region, filled nonzero: its path, or for an inverted mask
   * the composition's rectangle and the path together (lottie-web's
   * `solidPath + path`, mask.js:218-225). Empty for an open path, which
   * lottie-web draws as nothing.
   */
  readonly paths: readonly BezierPath[];
  /** Positive expansion: the region grows by a stroke twice this wide. */
  readonly expansion: number;
}

/** A layer's masks (mask.js:39-130), applied as one region. */
export interface MaskClip {
  readonly kind: "mask";
  readonly path: string;
  /** Maps the layer's space, where the masks are, to canvas pixels. */
  readonly matrix: Matrix;
  /**
   * The whole composition, in canvas pixels: the region a first subtract
   * or intersect mask starts from.
   */
  readonly universe: BezierPath;
  readonly masks: readonly MaskShape[];
}

/** A track matte: the region its source layer covers, or its complement. */
export interface MatteClip {
  readonly kind: "matte";
  readonly path: string;
  /** tt 2: the target shows outside the source. */
  readonly inverted: boolean;
  /** The source layer's draws; the baker requires them opaque. */
  readonly source: readonly Draw[];
}

export type Clip = MaskClip | MatteClip;

/** A precomposition a draw sits in, which lottie-web clips to its size. */
export interface PrecompBounds {
  readonly path: string;
  /** Maps the precomposition's space to canvas pixels. */
  readonly matrix: Matrix;
  readonly w: number;
  readonly h: number;
}

export interface Draw {
  readonly kind: "fill" | "stroke";
  /** JSON path of the fill or stroke item (or the solid layer). */
  readonly path: string;
  readonly paint: DrawPaint;
  /** Every opacity above the draw, multiplied, with the style's own. */
  readonly alpha: number;
  readonly fillRule: "nonzero" | "evenodd";
  readonly stroke?: StrokeStyle;
  readonly dash?: Dash;
  /** Maps the style's space, where the paths are, to canvas pixels. */
  readonly matrix: Matrix;
  readonly paths: BezierPath[];
  /** Masks and mattes, innermost first. */
  readonly clips: Clip[];
  /** JSON paths of the translucent layers and groups above the style. */
  readonly translucent: readonly string[];
  /** Enclosing precompositions, innermost first. */
  readonly precomps: readonly PrecompBounds[];
}

/** Profile feature ids (profile.ts) the entry drops; see `ignore`. */
export interface EvaluateOptions {
  readonly ignore?: ReadonlySet<string>;
}

const CAPS = { 1: "butt", 2: "round", 3: "square" } as const;
const JOINS = { 1: "miter", 2: "round", 3: "bevel" } as const;

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** A solid layer's `#rrggbb` color as RGB in 0..1. */
export function hexColor(hex: string | undefined): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex ?? "");
  if (!m) return [0, 0, 0];
  return [
    parseInt(m[1] ?? "0", 16) / 255,
    parseInt(m[2] ?? "0", 16) / 255,
    parseInt(m[3] ?? "0", 16) / 255,
  ];
}

/** A closed rectangle path from (x0, y0) to (x1, y1), through `m`. */
export function rectangle(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  m: Matrix = IDENTITY,
): BezierPath {
  const v: Point[] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  return transformPath({ closed: true, v, i: v, o: v }, m);
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A copy of the file with each loop expression parsed and bound to its
 * layer (keyframes.ts evaluates it), unless the entry ignores
 * `loop-expressions`. Other expressions stay as they are; the profile
 * rejects them, or the entry ignores them and their keyframes play.
 */
export function prepare(lottie: Lottie, options: EvaluateOptions = {}): Lottie {
  const copy = structuredClone(lottie) as Lottie;
  if (options.ignore?.has("loop-expressions")) return copy;
  const bind = (value: unknown, layer: Layer): void => {
    if (Array.isArray(value)) {
      for (const item of value) bind(item, layer);
    } else if (isObject(value)) {
      if (typeof value.x === "string" && "k" in value) {
        const loop = parseLoop(value.x);
        if (loop) {
          value.loop = { ...loop, fr: lottie.fr, ip: layer.ip, op: layer.op };
        }
      }
      for (const [key, item] of Object.entries(value)) {
        // A split position's `x` is its X property; nested layers bind
        // to themselves.
        if (key !== "loop") bind(item, layer);
      }
    }
  };
  const layers = [
    ...copy.layers,
    ...(copy.assets ?? []).flatMap((asset) => asset.layers ?? []),
  ];
  for (const layer of layers) {
    for (const key of ["ks", "shapes", "masksProperties", "tm"] as const) {
      bind(layer[key], layer);
    }
  }
  return copy;
}

/** The composition a layer list belongs to, at one frame of its time. */
interface Comp {
  readonly layers: readonly Layer[];
  /** JSON path of the layer list. */
  readonly at: string;
  /** The composition's own frame. */
  readonly frame: number;
  /** Maps the composition's space to canvas pixels. */
  readonly matrix: Matrix;
  /** Folded opacity of enclosing precompositions. */
  readonly opacity: number;
  readonly translucent: readonly string[];
  readonly precomps: readonly PrecompBounds[];
  /** The composition's size (the masks' universe). */
  readonly w: number;
  readonly h: number;
  readonly byIndex: Map<number, Layer>;
  readonly matrices: Map<Layer, Matrix>;
}

/** A shape item's paths on their way through the modifiers in its scope. */
interface ShapeRecord {
  paths: BezierPath[];
}

/** A style and the shapes it covers, each with its map into the style's space. */
interface StyleRecord {
  /** Undefined for styles that do not draw (a repeater's originals). */
  readonly draw: Draw | undefined;
  readonly shapes: { shape: ShapeRecord; relative: Matrix }[];
}

/** A style open to the paths before it. */
interface OpenStyle {
  readonly style: StyleRecord;
  /** Maps the current group's space to the style's space. */
  readonly relative: Matrix;
}

interface Modifier {
  readonly item: ShapeItem;
  /** The shapes in its scope, in the order they were met (reverse document order). */
  readonly shapes: ShapeRecord[];
}

/** One item of a group after repeaters are expanded. */
interface Entry {
  readonly item: ShapeItem;
  readonly path: string;
  /** False for a repeater's original items, which lottie-web does not draw. */
  readonly render: boolean;
  /** A repeater copy's fixed group transform. */
  readonly fixed?: { readonly matrix: Matrix; readonly opacity: number };
}

class FrameEvaluator {
  private readonly lottie: Lottie;
  private readonly ignore: ReadonlySet<string>;
  private readonly assets = new Map<string, { asset: Asset; index: number }>();

  constructor(lottie: Lottie, options: EvaluateOptions) {
    this.lottie = lottie;
    this.ignore = options.ignore ?? new Set();
    (lottie.assets ?? []).forEach((asset, index) => {
      this.assets.set(asset.id, { asset, index });
    });
  }

  /** Every draw of a composition, bottom first (SVGRendererBase.buildItem for mattes). */
  comp(comp: Comp): Draw[] {
    const out: Draw[] = [];
    const { layers } = comp;
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      // Matte sources (`td`) only draw through the layer they matte.
      if (!layer || layer.td) continue;
      const draws = this.layer(comp, i);
      if (draws.length > 0 && layer.tt && !this.ignore.has("mattes")) {
        // The source is the layer `tp` names, or else the one above.
        const source =
          layer.tp !== undefined
            ? layers.findIndex((l) => l.ind === layer.tp)
            : i - 1;
        if (source >= 0 && source < layers.length) {
          const clip: MatteClip = {
            kind: "matte",
            path: `${comp.at}[${i}].tt`,
            inverted: layer.tt === 2,
            // The source's own opacity inside the composition decides
            // whether it is opaque, not the composition's.
            source: this.layer({ ...comp, opacity: 1 }, source),
          };
          for (const draw of draws) draw.clips.push(clip);
        }
      }
      out.push(...draws);
    }
    return out;
  }

  /** The layer's matrix to canvas pixels, through its parents. */
  private layerMatrix(
    comp: Comp,
    layer: Layer,
    seen = new Set<Layer>(),
  ): Matrix {
    const cached = comp.matrices.get(layer);
    if (cached) return cached;
    if (seen.has(layer)) throw new Error("layer parenting forms a cycle");
    seen.add(layer);
    const autoOrient = layer.ao === 1 && !this.ignore.has("auto-orient");
    let m = transformAt(layer.ks, comp.frame, autoOrient);
    if (layer.parent !== undefined) {
      const parent = comp.byIndex.get(layer.parent);
      if (!parent)
        throw new Error(`layer parent ${layer.parent} does not exist`);
      m = multiply(this.layerMatrix(comp, parent, seen), m);
    } else {
      m = multiply(comp.matrix, m);
    }
    comp.matrices.set(layer, m);
    return m;
  }

  /** The draws of layer `index`, bottom first, with its masks applied. */
  private layer(comp: Comp, index: number): Draw[] {
    const layer = comp.layers[index] as Layer;
    const frame = comp.frame;
    if (layer.hd === true) return [];
    if (!(layer.ip <= frame && frame < layer.op)) return [];
    const opacity = opacityAt(layer.ks, frame);
    // lottie-web hides layers at zero opacity (hideOnTransparent).
    if (!(opacity > 0)) return [];
    const at = `${comp.at}[${index}]`;
    const translucent =
      opacity < 1 ? [...comp.translucent, `${at}.ks.o`] : comp.translucent;
    const alpha = comp.opacity * opacity;
    const matrix = this.layerMatrix(comp, layer);
    let draws: Draw[] = [];
    if (layer.ty === 1) {
      const w = layer.sw ?? 0;
      const h = layer.sh ?? 0;
      draws.push({
        kind: "fill",
        path: at,
        paint: { kind: "solid", color: hexColor(layer.sc), slot: 0 },
        alpha,
        fillRule: "nonzero",
        matrix,
        paths: [rectangle(0, 0, w, h)],
        clips: [],
        translucent,
        precomps: comp.precomps,
      });
    } else if (layer.ty === 4) {
      draws = new ShapeEvaluator(this, frame, comp.precomps).layer(
        layer.shapes ?? [],
        `${at}.shapes`,
        matrix,
        alpha,
        translucent,
      );
    } else if (layer.ty === 0 && !this.ignore.has("precomps")) {
      draws = this.precomp(comp, layer, at, matrix, alpha, translucent);
    }
    const masks = layer.masksProperties ?? [];
    if (draws.length > 0 && masks.length > 0 && !this.ignore.has("masks")) {
      const clip = this.masks(comp, masks, `${at}.masksProperties`, matrix);
      if (clip) for (const draw of draws) draw.clips.push(clip);
    }
    return draws;
  }

  /**
   * A precomposition layer's draws: its asset's layers at the child frame,
   * `(frame - st) / sr` (CompElement.js:56,66), or with time remap the
   * remapped seconds times the frame rate (SVGCompElement.js:19,
   * CompElement.js:49-54).
   */
  private precomp(
    comp: Comp,
    layer: Layer,
    at: string,
    matrix: Matrix,
    alpha: number,
    translucent: readonly string[],
  ): Draw[] {
    const found = this.assets.get(layer.refId ?? "");
    if (!found?.asset.layers) {
      throw new Error(
        `${at}.refId: no precomposition asset ${JSON.stringify(layer.refId)}`,
      );
    }
    const frame = precompFrame(layer, comp.frame, this.lottie.fr, this.ignore);
    const w = layer.w ?? 0;
    const h = layer.h ?? 0;
    const layers = found.asset.layers;
    const byIndex = new Map<number, Layer>();
    for (const child of layers) {
      if (child.ind !== undefined) byIndex.set(child.ind, child);
    }
    return this.comp({
      layers,
      at: `assets[${found.index}].layers`,
      frame,
      matrix,
      opacity: alpha,
      translucent,
      precomps: [{ path: at, matrix, w, h }, ...comp.precomps],
      w,
      h,
      byIndex,
      matrices: new Map(),
    });
  }

  /** A layer's masks as one clip, or undefined when every mask is off. */
  private masks(
    comp: Comp,
    items: readonly MaskItem[],
    at: string,
    matrix: Matrix,
  ): MaskClip | undefined {
    const frame = comp.frame;
    const masks: MaskShape[] = [];
    for (const item of items) {
      if (item.mode === "n") continue;
      const mode = item.mode === "s" ? "s" : item.mode === "i" ? "i" : "a";
      const shape = shapeAt(item.pt, frame);
      let paths: BezierPath[] = [];
      if (shape && shape.c === true && shape.v.length > 0) {
        paths = [pathFromShape(shape)];
        if (item.inv) {
          // lottie-web prepends the whole animation's rectangle, in the
          // layer's space, and fills both nonzero.
          paths.unshift(rectangle(0, 0, this.lottie.w, this.lottie.h));
        }
      }
      masks.push({
        mode,
        paths,
        expansion: Math.max(0, scalarAt(item.x, frame, 0)),
      });
    }
    if (masks.length === 0) return undefined;
    return {
      kind: "mask",
      path: at,
      matrix,
      universe: rectangle(0, 0, comp.w, comp.h, comp.matrix),
      masks,
    };
  }

  /**
   * A fill or stroke color, or the slot value it points at (lottie-web's
   * SlotManager.getProp).
   */
  resolve(property: Property | undefined): Property | undefined {
    if (!property?.sid) return property;
    const slot = this.lottie.slots?.[property.sid]?.p;
    return slot ? { ...property, ...slot } : property;
  }

  ignores(feature: string): boolean {
    return this.ignore.has(feature);
  }
}

/** The frame a precomposition's layers see at its parent's `frame`. */
export function precompFrame(
  layer: Pick<Layer, "tm" | "st" | "sr" | "op">,
  frame: number,
  fr: number,
  ignore: ReadonlySet<string> = new Set(),
): number {
  if (layer.tm && !ignore.has("time-remap")) {
    let remapped = scalarAt(layer.tm, frame, 0) * fr;
    if (remapped === layer.op) remapped = layer.op - 1;
    return remapped;
  }
  const stretch = ignore.has("time-stretch") ? 1 : (layer.sr ?? 1);
  return (frame - (layer.st ?? 0)) / (stretch || 1);
}

/** The draws of one shape layer. */
class ShapeEvaluator {
  private readonly scene: FrameEvaluator;
  private readonly frame: number;
  private readonly precomps: readonly PrecompBounds[];
  private readonly draws: Draw[] = [];
  private readonly styles: StyleRecord[] = [];
  private readonly modifiers: Modifier[] = [];

  constructor(
    scene: FrameEvaluator,
    frame: number,
    precomps: readonly PrecompBounds[],
  ) {
    this.scene = scene;
    this.frame = frame;
    this.precomps = precomps;
  }

  layer(
    items: readonly ShapeItem[],
    at: string,
    matrix: Matrix,
    opacity: number,
    translucent: readonly string[],
  ): Draw[] {
    this.group(
      this.expand(items, at, true),
      matrix,
      opacity,
      translucent,
      [],
      [],
    );
    // Modifiers run in document order: the reverse of the order met.
    for (let k = this.modifiers.length - 1; k >= 0; k--) {
      this.modify(this.modifiers[k] as Modifier);
    }
    for (const style of this.styles) {
      if (!style.draw) continue;
      for (const { shape, relative } of style.shapes) {
        for (const path of shape.paths) {
          style.draw.paths.push(transformPath(path, relative));
        }
      }
    }
    return this.draws;
  }

  /**
   * A group's items with its last repeater expanded: `ceil(c)` copies of
   * the items before it at the front, then the originals, not drawn, then
   * the items after it (RepeaterModifier.js:40-160).
   */
  private expand(
    items: readonly ShapeItem[],
    at: string,
    render: boolean,
  ): Entry[] {
    const entries: Entry[] = items.map((item, k) => ({
      item,
      path: `${at}[${k}]`,
      render,
    }));
    if (this.scene.ignores("repeaters")) return entries;
    let index = -1;
    for (let k = items.length - 1; k >= 0; k--) {
      const item = items[k];
      if (item?.ty === "rp" && item.hd !== true) {
        index = k;
        break;
      }
    }
    if (index < 0) return entries;
    const repeater = items[index] as ShapeItem & RepeaterItem;
    const before = items.slice(0, index);
    const copies: Entry[] = repeaterCopies(repeater, this.frame).map(
      (copy, n) => ({
        item: { ty: "gr", it: before },
        path: `${at}[${index}].copies[${n}]`,
        render,
        fixed: copy,
      }),
    );
    return [
      ...copies,
      ...entries.slice(0, index).map((entry) => ({ ...entry, render: false })),
      ...entries.slice(index + 1),
    ];
  }

  private group(
    entries: readonly Entry[],
    parentMatrix: Matrix,
    parentOpacity: number,
    parentTranslucent: readonly string[],
    inherited: readonly OpenStyle[],
    inheritedModifiers: readonly Modifier[],
    fixed?: Entry["fixed"],
    fixedPath?: string,
  ): void {
    const frame = this.frame;
    let matrix = parentMatrix;
    let opacity = parentOpacity;
    let translucent = parentTranslucent;
    let local = IDENTITY;
    if (fixed) {
      local = fixed.matrix;
      matrix = multiply(matrix, local);
      opacity *= fixed.opacity;
      if (fixed.opacity < 1) translucent = [...translucent, `${fixedPath}.o`];
    } else {
      const tr = entries.find((entry) => entry.item.ty === "tr");
      if (tr) {
        const transform = tr.item as ShapeItem & Transform;
        local = transformAt(transform, frame);
        matrix = multiply(matrix, local);
        const o = opacityAt(transform, frame);
        opacity *= o;
        if (o < 1) translucent = [...translucent, `${tr.path}.o`];
      }
    }
    // Styles from enclosing groups see this group's paths through its
    // transform; its own styles see them directly.
    const open: OpenStyle[] = inherited.map(({ style, relative }) => ({
      style,
      relative: multiply(relative, local),
    }));
    const modifiers = [...inheritedModifiers];
    for (let k = entries.length - 1; k >= 0; k--) {
      const entry = entries[k] as Entry;
      const { item, path, render } = entry;
      if (item.hd === true) continue;
      switch (item.ty) {
        case "fl":
        case "st":
        case "gf":
        case "gs": {
          const draw = this.style(item, path, matrix, opacity, translucent);
          const style: StyleRecord = {
            draw: render ? draw : undefined,
            shapes: [],
          };
          this.styles.push(style);
          if (style.draw) this.draws.push(style.draw);
          open.unshift({ style, relative: IDENTITY });
          break;
        }
        case "gr":
          this.group(
            this.expand(item.it ?? [], `${path}.it`, render),
            matrix,
            opacity,
            translucent,
            open,
            modifiers,
            entry.fixed,
            path,
          );
          break;
        case "sh":
        case "rc":
        case "el":
        case "sr": {
          const shape = this.shape(item);
          if (!shape) break;
          const record: ShapeRecord = { paths: [shape] };
          for (const modifier of modifiers) modifier.shapes.push(record);
          for (const { style, relative } of open) {
            style.shapes.push({ shape: record, relative });
          }
          break;
        }
        case "tm":
          if (this.scene.ignores("trim")) break;
          this.addModifier(item, modifiers);
          break;
        case "rd":
          if (this.scene.ignores("round-corners")) break;
          this.addModifier(item, modifiers);
          break;
        default:
          // Everything else is inert (merge paths mode 1, a repeater already
          // expanded, the group transform), rejected by the profile, or
          // ignored by the catalog entry.
          break;
      }
    }
  }

  private addModifier(item: ShapeItem, scope: Modifier[]): void {
    const modifier: Modifier = { item, shapes: [] };
    this.modifiers.push(modifier);
    scope.unshift(modifier);
  }

  /** Applies a trim or round-corners modifier to the shapes in its scope. */
  private modify({ item, shapes }: Modifier): void {
    const frame = this.frame;
    // lottie-web meets shapes in reverse and processes them in document order.
    const ordered = [...shapes].reverse();
    if (item.ty === "tm") {
      const trimmed = trimShapes(
        ordered.map((shape) => shape.paths),
        {
          start: scalarAt(item.s, frame, 0),
          end: scalarAt(item.e, frame, 100),
          offset: scalarAt(item.o, frame, 0),
          mode: item.m ?? 1,
        },
      );
      ordered.forEach((shape, k) => {
        shape.paths = trimmed[k] ?? [];
      });
    } else if (item.ty === "rd") {
      const radius = scalarAt(item.r as Property | undefined, frame, 0);
      if (radius === 0) return;
      for (const shape of ordered) {
        shape.paths = shape.paths.map((path) => roundCorners(path, radius));
      }
    }
  }

  private shape(item: ShapeItem): BezierPath | undefined {
    const frame = this.frame;
    switch (item.ty) {
      case "sh": {
        const value = shapeAt(item.ks, frame);
        return value && value.v.length > 0 ? pathFromShape(value) : undefined;
      }
      case "rc":
        return rectPath(item as RectItem, frame);
      case "el":
        return ellipsePath(item as EllipseItem, frame);
      case "sr":
        return starPath(item as StarItem, frame);
      default:
        return undefined;
    }
  }

  /** The draw a style makes, or undefined when it draws nothing visible. */
  private style(
    item: ShapeItem,
    path: string,
    matrix: Matrix,
    opacity: number,
    translucent: readonly string[],
  ): Draw | undefined {
    const frame = this.frame;
    const gradient = item.ty === "gf" || item.ty === "gs";
    if (gradient && this.scene.ignores("gradients")) return undefined;
    const stroked = item.ty === "st" || item.ty === "gs";
    const alpha = clamp01(opacity * (scalarAt(item.o, frame, 100) / 100));
    let paint: DrawPaint;
    if (gradient) {
      const [fx = 0, fy = 0] = valueAt(item.s, frame, [0, 0]);
      const [tx = 0, ty = 0] = valueAt(item.e, frame, [0, 0]);
      paint = {
        kind: item.t === 2 ? "radial" : "linear",
        from: [fx, fy],
        to: [tx, ty],
        stops: item.g ? gradientStops(item.g, frame) : [],
        highlight: item.t === 2 ? scalarAt(item.h, frame, 0) : 0,
      };
    } else {
      const color = this.scene.resolve(item.c);
      const [r = 0, g = 0, b = 0] = valueAt(color, frame, [0, 0, 0]);
      const named =
        item.c?.sid === "primary" ? 1 : item.c?.sid === "secondary" ? 2 : 0;
      paint = {
        kind: "solid",
        color: [clamp01(r), clamp01(g), clamp01(b)],
        slot: this.scene.ignores("color-slots") ? 0 : named,
      };
    }
    let stroke: StrokeStyle | undefined;
    let dash: Dash | undefined;
    if (stroked) {
      const join = JOINS[(item.lj ?? 2) as keyof typeof JOINS] ?? "round";
      stroke = {
        width: scalarAt(item.w, frame, 0),
        cap: CAPS[(item.lc ?? 2) as keyof typeof CAPS] ?? "round",
        join,
        miterLimit: item.ml2 ? scalarAt(item.ml2, frame, 4) : (item.ml ?? 4),
      };
      if (Array.isArray(item.d) && !this.scene.ignores("dashes")) {
        dash = dashAt(item.d, frame);
      }
    }
    const draw: Draw = {
      kind: stroked ? "stroke" : "fill",
      path,
      paint,
      alpha,
      fillRule: !stroked && (item.r as unknown) === 2 ? "evenodd" : "nonzero",
      ...(stroke ? { stroke } : {}),
      ...(dash ? { dash } : {}),
      matrix,
      paths: [],
      clips: [],
      translucent,
      precomps: this.precomps,
    };
    // Invisible styles still take their paths, so they are created, but
    // are not drawn.
    const visible = draw.alpha > 0 && (!stroke || stroke.width > 0);
    return visible ? draw : undefined;
  }
}

/**
 * A stroke's dash pattern at `frame`, as lottie-web hands it to SVG
 * (DashProperty.js:35-60): every dash and gap value in order, and the
 * offset. SVG draws the stroke solid when a value is negative or all are
 * zero, and repeats an odd-length list; undefined then means solid.
 */
export function dashAt(
  items: readonly DashItem[],
  frame: number,
): Dash | undefined {
  const intervals: number[] = [];
  let offset = 0;
  for (const item of items) {
    const value = scalarAt(item.v, frame, 0);
    if (item.n === "o") offset = value;
    else intervals.push(value);
  }
  if (intervals.length === 0) return undefined;
  if (intervals.some((v) => !(v >= 0)) || intervals.every((v) => v === 0)) {
    return undefined;
  }
  return {
    intervals:
      intervals.length % 2 === 1 ? [...intervals, ...intervals] : intervals,
    offset,
  };
}

/**
 * Every draw of the composition at `frame` (in Lottie frames), bottom first.
 * Features the profile rejects never reach here; ignored ones are skipped.
 * Pass a file through `prepare` first for its loop expressions to play.
 */
export function evaluateFrame(
  lottie: Lottie,
  frame: number,
  options: EvaluateOptions = {},
): Draw[] {
  const evaluator = new FrameEvaluator(lottie, options);
  const byIndex = new Map<number, Layer>();
  for (const layer of lottie.layers) {
    if (layer.ind !== undefined) byIndex.set(layer.ind, layer);
  }
  return evaluator.comp({
    layers: lottie.layers,
    at: "layers",
    frame,
    matrix: IDENTITY,
    opacity: 1,
    translucent: [],
    precomps: [],
    w: lottie.w,
    h: lottie.h,
    byIndex,
    matrices: new Map(),
  });
}
