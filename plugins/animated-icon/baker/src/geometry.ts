// A draw's geometry in its own (style) space, and the Skia work that turns
// it into the closed quadratic contours the catalog stores (design §5.2 and
// [V-C12]):
//
// 1. The outline: the draw's paths after its modifiers (scene.ts), dashed
//    when the stroke has a dash pattern. Dashing measures the path scaled
//    to device pixels at the entry's largest display size, since Skia's
//    contour measure works to half a unit.
// 2. The style: a fill as is; a stroke outlined by makeStroked, again at
//    device scale and with `precision`.
// 3. Clips: masks and track mattes as path booleans (Path.MakeFromOp; the
//    typed makeCombined does not exist at runtime in canvaskit 0.42). A
//    boolean's result is filled even-odd. A null or suspect result (its
//    area more than 1%, and more than a device pixel, off an aliased raster
//    of the operands) is retried
//    on simplified operands, then on operands nudged by a sixty-fourth of
//    a pixel; if that fails too, the clip is left out (a union keeps both
//    operands) and the failure is reported.
// 4. Cubics and conics become quadratics within TOLERANCE_PX device pixels.
//
// Steps 2-4 run once per distinct geometry (dedupe.ts); `DrawGeometry`
// is the canonical description they start from.

import type { CanvasKit, Path } from "canvaskit-wasm";

import { type Cmds, dashPath } from "./dash.ts";
import type { Contour } from "./pack.ts";
import { refitContour } from "./quadratic.ts";
import type { BezierPath } from "./shapes.ts";
import {
  contoursFromCommands,
  STROKE_PRECISION,
  STROKER_ERROR,
  type StrokeStyle,
} from "./skia.ts";
import {
  apply,
  type Matrix,
  maxScale,
  multiply,
  scaling,
} from "./transform.ts";

export type { Cmds } from "./dash.ts";

/** How far, in device pixels at maxDisplayPx, a baked curve may stray. */
export const TOLERANCE_PX = 0.2;

/** One mask of a clip, in the masked layer's space. */
export interface MaskGeometry {
  readonly mode: "a" | "s" | "i";
  /** Nonzero-filled region paths (layer space). */
  readonly cmds: Cmds;
  readonly expansion: number;
}

export type ClipGeometry =
  | {
      readonly kind: "mask";
      /** Maps the layer's space to the draw's space. */
      readonly rel: Matrix;
      /**
       * The composition, in the draw's space, for a first subtract or
       * intersect mask; null when it holds the whole draw, which stands for
       * "everything".
       */
      readonly universe: Cmds | null;
      readonly masks: readonly MaskGeometry[];
    }
  | {
      readonly kind: "matte";
      readonly inverted: boolean;
      /** The source's draws, each with its map into this draw's space. */
      readonly sources: readonly { geometry: DrawGeometry; rel: Matrix }[];
    };

/** Everything that decides a draw's shape, in the draw's own space. */
export interface DrawGeometry {
  /** The outline after modifiers and dashes (open or closed contours). */
  readonly cmds: Cmds;
  readonly fillRule: "nonzero" | "evenodd";
  readonly stroke?: StrokeStyle;
  readonly clips: readonly ClipGeometry[];
}

/** A boolean that fell back, for the report. */
export interface Fallback {
  /** The draw (JSON path) and what happened. */
  readonly where: string;
  readonly op: "union" | "intersect" | "difference";
  readonly problem: "null" | "area";
  readonly resolution: "simplified" | "nudged" | "left out";
}

/** Path commands for Lottie bezier paths: cubics, lines where straight. */
export function bezierCmds(ck: CanvasKit, paths: readonly BezierPath[]): Cmds {
  const cmds: Cmds = [];
  for (const path of paths) {
    const { v, i, o } = path;
    const first = v[0];
    if (!first) continue;
    cmds.push(ck.MOVE_VERB, first[0], first[1]);
    const segments = path.closed ? v.length : v.length - 1;
    for (let k = 0; k < segments; k++) {
      const from = v[k] ?? first;
      const to = v[(k + 1) % v.length] ?? first;
      const out = o[k] ?? from;
      const into = i[(k + 1) % v.length] ?? to;
      if (
        out[0] === from[0] &&
        out[1] === from[1] &&
        into[0] === to[0] &&
        into[1] === to[1]
      ) {
        cmds.push(ck.LINE_VERB, to[0], to[1]);
      } else {
        cmds.push(
          ck.CUBIC_VERB,
          out[0],
          out[1],
          into[0],
          into[1],
          to[0],
          to[1],
        );
      }
    }
    if (path.closed) cmds.push(ck.CLOSE_VERB);
  }
  return cmds;
}

/** Commands with every point mapped through `m` (conic weights stay). */
export function mapCmds(
  ck: CanvasKit,
  cmds: readonly number[],
  m: Matrix,
): Cmds {
  const out: Cmds = [];
  const point = (i: number): void => {
    const [x, y] = apply(m, [cmds[i] ?? 0, cmds[i + 1] ?? 0]);
    out.push(x, y);
  };
  let i = 0;
  while (i < cmds.length) {
    const verb = cmds[i] as number;
    out.push(verb);
    switch (verb) {
      case ck.MOVE_VERB:
      case ck.LINE_VERB:
        point(i + 1);
        i += 3;
        break;
      case ck.QUAD_VERB:
        point(i + 1);
        point(i + 3);
        i += 5;
        break;
      case ck.CONIC_VERB:
        point(i + 1);
        point(i + 3);
        out.push(cmds[i + 5] ?? 1);
        i += 6;
        break;
      case ck.CUBIC_VERB:
        point(i + 1);
        point(i + 3);
        point(i + 5);
        i += 7;
        break;
      case ck.CLOSE_VERB:
        i += 1;
        break;
      default:
        throw new Error(`unknown Skia path verb ${verb}`);
    }
  }
  return out;
}

/** The bounds of every point in `cmds` (control points included). */
export function cmdsBounds(
  ck: CanvasKit,
  cmds: readonly number[],
): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let i = 0;
  const include = (k: number): void => {
    const x = cmds[k] ?? 0;
    const y = cmds[k + 1] ?? 0;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  while (i < cmds.length) {
    const verb = cmds[i];
    const points =
      verb === ck.MOVE_VERB || verb === ck.LINE_VERB
        ? 1
        : verb === ck.QUAD_VERB || verb === ck.CONIC_VERB
          ? 2
          : verb === ck.CUBIC_VERB
            ? 3
            : 0;
    for (let p = 0; p < points; p++) include(i + 1 + 2 * p);
    i += 1 + 2 * points + (verb === ck.CONIC_VERB ? 1 : 0);
  }
  return [x0, y0, x1, y1];
}

/** A Skia path from commands, filled by `rule`. */
export function toPath(
  ck: CanvasKit,
  cmds: readonly number[],
  rule: "nonzero" | "evenodd" = "nonzero",
): Path {
  const path =
    cmds.length > 0
      ? (ck.Path.MakeFromCmds([...cmds]) ?? new ck.Path())
      : new ck.Path();
  path.setFillType(
    rule === "evenodd" ? ck.FillType.EvenOdd : ck.FillType.Winding,
  );
  return path;
}

/** A path's commands, as plain numbers. */
export function cmdsOf(path: Path): Cmds {
  return Array.from(path.toCmds());
}

/**
 * Dashes an outline given in the draw's space: scaled by `k` (device
 * pixels per unit) to measure, and back.
 */
export function dashCmds(
  ck: CanvasKit,
  cmds: Cmds,
  intervals: readonly number[],
  offset: number,
  k: number,
): Cmds {
  const path = toPath(ck, mapCmds(ck, cmds, scaling(k, k)));
  const dashed = dashPath(
    ck,
    path,
    intervals.map((x) => x * k),
    offset * k,
  );
  path.delete();
  return mapCmds(ck, dashed, scaling(1 / k, 1 / k));
}

const CAPS = { butt: "Butt", round: "Round", square: "Square" } as const;
const JOINS = { miter: "Miter", round: "Round", bevel: "Bevel" } as const;

/** Strokes `path` (in device pixels); width is in the same units. */
function stroke(
  ck: CanvasKit,
  path: Path,
  style: StrokeStyle,
  width: number,
): Path {
  if (!(width > 0)) return new ck.Path();
  const stroked = path.makeStroked({
    width,
    cap: ck.StrokeCap[CAPS[style.cap]],
    join: ck.StrokeJoin[JOINS[style.join]],
    miter_limit: style.miterLimit,
    precision: STROKE_PRECISION,
  });
  return stroked ?? new ck.Path();
}

const OPS = {
  union: "Union",
  intersect: "Intersect",
  difference: "Difference",
} as const;

/**
 * Path.makeSimplified under the name canvaskit 0.42 actually binds (the
 * typed one is undefined at runtime).
 */
function simplified(path: Path): Path | null {
  const bound = (path as unknown as { _makeSimplified?: () => Path | null })
    ._makeSimplified;
  return bound ? bound.call(path) : null;
}

/** Raster size of the area check, in pixels along the longer side. */
const CHECK_PX = 256;

/**
 * Path booleans with the fallbacks described above. `where` names the
 * draw in fallback records.
 */
export class Booleans {
  readonly fallbacks: Fallback[] = [];
  private readonly ck: CanvasKit;

  constructor(ck: CanvasKit) {
    this.ck = ck;
  }

  op(a: Path, b: Path, op: keyof typeof OPS, where: string): Path {
    const ck = this.ck;
    const skOp = ck.PathOp[OPS[op]];
    const first = ck.Path.MakeFromOp(a, b, skOp);
    const problem = !first
      ? "null"
      : this.suspect(a, b, first, op)
        ? "area"
        : undefined;
    if (!problem && first) return first;
    first?.delete();
    const record = (resolution: Fallback["resolution"]): void => {
      this.fallbacks.push({
        where,
        op,
        problem: problem ?? "null",
        resolution,
      });
    };
    // Simplified operands.
    const sa = simplified(a);
    const sb = simplified(b);
    if (sa && sb) {
      const second = ck.Path.MakeFromOp(sa, sb, skOp);
      if (second && !this.suspect(a, b, second, op)) {
        sa.delete();
        sb.delete();
        record("simplified");
        return second;
      }
      second?.delete();
    }
    sa?.delete();
    sb?.delete();
    // Operands nudged apart by a sixty-fourth of a pixel.
    const nudged = toPath(
      ck,
      mapCmds(ck, cmdsOf(b), [1, 0, 0, 1, 1 / 64, 1 / 64]),
      b.getFillType().value === ck.FillType.EvenOdd.value
        ? "evenodd"
        : "nonzero",
    );
    const third = ck.Path.MakeFromOp(a, nudged, skOp);
    nudged.delete();
    if (third && !this.suspect(a, b, third, op)) {
      record("nudged");
      return third;
    }
    third?.delete();
    record("left out");
    if (op === "union") {
      // Both operands, winding: exact while they do not wind against
      // each other.
      const both = toPath(ck, [...cmdsOf(a), ...cmdsOf(b)]);
      return both;
    }
    return a.copy();
  }

  /**
   * Whether a boolean's area is more than 1% (and more than a device
   * pixel) off the same boolean done pixel by pixel on aliased rasters.
   */
  private suspect(
    a: Path,
    b: Path,
    result: Path,
    op: keyof typeof OPS,
  ): boolean {
    const ck = this.ck;
    const ba = a.computeTightBounds();
    const bb = b.computeTightBounds();
    const box =
      op === "union"
        ? [
            Math.min(ba[0] as number, bb[0] as number),
            Math.min(ba[1] as number, bb[1] as number),
            Math.max(ba[2] as number, bb[2] as number),
            Math.max(ba[3] as number, bb[3] as number),
          ]
        : [ba[0], ba[1], ba[2], ba[3]];
    const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = box as number[];
    const w = x1 - x0;
    const h = y1 - y0;
    if (!(w > 0 && h > 0)) return false;
    const scale = CHECK_PX / Math.max(w, h);
    const width = Math.max(1, Math.ceil(w * scale) + 2);
    const height = Math.max(1, Math.ceil(h * scale) + 2);
    const surface = ck.MakeSurface(width, height);
    if (!surface) return false;
    const canvas = surface.getCanvas();
    const paint = new ck.Paint();
    paint.setAntiAlias(false);
    paint.setColor(ck.BLACK);
    const raster = (path: Path): Uint8Array => {
      canvas.clear(ck.TRANSPARENT);
      canvas.save();
      canvas.translate(1, 1);
      canvas.scale(scale, scale);
      canvas.translate(-x0, -y0);
      canvas.drawPath(path, paint);
      canvas.restore();
      const pixels = canvas.readPixels(0, 0, {
        width,
        height,
        colorType: ck.ColorType.RGBA_8888,
        alphaType: ck.AlphaType.Unpremul,
        colorSpace: ck.ColorSpace.SRGB,
      }) as Uint8Array;
      const inside = new Uint8Array(width * height);
      for (let p = 0; p < inside.length; p++)
        inside[p] = (pixels[4 * p + 3] ?? 0) > 127 ? 1 : 0;
      return inside;
    };
    const ra = raster(a);
    const rb = raster(b);
    const rr = raster(result);
    paint.delete();
    // dispose, not delete: it also frees the surface's pixels.
    surface.dispose();
    let expected = 0;
    let actual = 0;
    for (let p = 0; p < rr.length; p++) {
      const pa = ra[p] as number;
      const pb = rb[p] as number;
      expected +=
        op === "union" ? pa | pb : op === "intersect" ? pa & pb : pa & (1 - pb);
      actual += rr[p] as number;
    }
    // Paths here are in device pixels at maxDisplayPx: a difference under
    // one device pixel of area cannot show, whatever its share.
    return (
      Math.abs(expected - actual) >
      Math.max(0.01 * Math.max(expected, actual), scale * scale) + 2
    );
  }
}

/**
 * The draw's final region in its space scaled by `k` (device pixels per
 * unit), before fitting: outline, style, then clips.
 */
export function finalPath(
  ck: CanvasKit,
  g: DrawGeometry,
  k: number,
  booleans: Booleans,
  where: string,
): Path {
  const scale = scaling(k, k);
  let path = toPath(ck, mapCmds(ck, g.cmds, scale), g.fillRule);
  if (g.stroke) {
    const outlined = stroke(ck, path, g.stroke, g.stroke.width * k);
    path.delete();
    path = outlined;
  }
  const replace = (next: Path): void => {
    path.delete();
    path = next;
  };
  for (const clip of g.clips) {
    if (clip.kind === "mask") {
      const toLocal = multiply(scale, clip.rel);
      let region: Path | undefined;
      clip.masks.forEach((mask, index) => {
        let m = toPath(ck, mapCmds(ck, mask.cmds, toLocal));
        if (mask.expansion > 0) {
          // lottie-web strokes the mask path 2x wide with SVG's default
          // miter joins (mask.js:71-94, 170-175).
          const s = maxScale(toLocal);
          const inLayer = toPath(ck, mapCmds(ck, mask.cmds, scaling(s, s)));
          const outline = stroke(
            ck,
            inLayer,
            { width: 0, cap: "butt", join: "miter", miterLimit: 4 },
            2 * mask.expansion * s,
          );
          inLayer.delete();
          const back = toPath(
            ck,
            mapCmds(
              ck,
              cmdsOf(outline),
              multiply(toLocal, scaling(1 / s, 1 / s)),
            ),
          );
          outline.delete();
          const grown = booleans.op(m, back, "union", where);
          m.delete();
          back.delete();
          m = grown;
        }
        if (index === 0) {
          if (mask.mode === "a") {
            region = m;
            return;
          }
          const universe = universePath(ck, clip.universe, scale, path);
          region = booleans.op(
            universe,
            m,
            mask.mode === "s" ? "difference" : "intersect",
            where,
          );
          universe.delete();
          m.delete();
          return;
        }
        const next = booleans.op(
          region as Path,
          m,
          mask.mode === "a"
            ? "union"
            : mask.mode === "s"
              ? "difference"
              : "intersect",
          where,
        );
        region?.delete();
        m.delete();
        region = next;
      });
      if (region) {
        replace(booleans.op(path, region, "intersect", where));
        region.delete();
      }
    } else {
      let source = new ck.Path();
      for (const { geometry, rel } of clip.sources) {
        const ks = k * maxScale(rel);
        if (!(ks > 0)) continue;
        const own = finalPath(ck, geometry, ks, booleans, where);
        const mapped = toPath(
          ck,
          mapCmds(
            ck,
            cmdsOf(own),
            multiply(scale, multiply(rel, scaling(1 / ks, 1 / ks))),
          ),
          own.getFillType().value === ck.FillType.EvenOdd.value
            ? "evenodd"
            : "nonzero",
        );
        own.delete();
        const next = booleans.op(source, mapped, "union", where);
        source.delete();
        mapped.delete();
        source = next;
      }
      replace(
        booleans.op(
          path,
          source,
          clip.inverted ? "difference" : "intersect",
          where,
        ),
      );
      source.delete();
    }
  }
  return path;
}

/**
 * The composition's rectangle in the scaled draw space, or for
 * "everything" a rectangle two pixels around `within`.
 */
function universePath(
  ck: CanvasKit,
  universe: Cmds | null,
  scale: Matrix,
  within: Path,
): Path {
  if (universe) return toPath(ck, mapCmds(ck, universe, scale));
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = within.computeTightBounds();
  return toPath(ck, [
    ck.MOVE_VERB,
    x0 - 2,
    y0 - 2,
    ck.LINE_VERB,
    x1 + 2,
    y0 - 2,
    ck.LINE_VERB,
    x1 + 2,
    y1 + 2,
    ck.LINE_VERB,
    x0 - 2,
    y1 + 2,
    ck.CLOSE_VERB,
  ]);
}

/** The fill rule a final path is filled with. */
export function fillRuleOf(ck: CanvasKit, path: Path): "nonzero" | "evenodd" {
  return path.getFillType().value === ck.FillType.EvenOdd.value
    ? "evenodd"
    : "nonzero";
}

/**
 * Closed quadratic contours within TOLERANCE_PX of a final path in device
 * pixels. A plain fill converts its cubics once; strokes and boolean
 * results, which Skia splits finely, are refit with what the tolerance
 * leaves.
 */
export function fitPath(
  ck: CanvasKit,
  path: Path,
  refined: boolean,
): Contour[] {
  const cmds = path.toCmds();
  if (!refined) return contoursFromCommands(ck, cmds, TOLERANCE_PX);
  const convert = TOLERANCE_PX / 20;
  return contoursFromCommands(ck, cmds, convert).map((contour) =>
    refitContour(contour, TOLERANCE_PX - STROKER_ERROR - convert),
  );
}
