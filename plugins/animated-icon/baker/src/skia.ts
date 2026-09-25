// Stroke outlining through Skia (canvaskit-wasm, a dev dependency of the
// baker only). Strokes reach the catalog as nonzero fills of their outline.
//
// Skia measures its stroker's accuracy in path units, so each stroke is
// scaled first: its path, in the space where Lottie applies the stroke, is
// multiplied up to device pixels at the entry's largest display size, and
// the outline is mapped back to canvas pixels afterwards. That keeps small
// canvases as accurate as large ones.

import CanvasKitInit, { type CanvasKit, type Path } from "canvaskit-wasm";

import type { Contour } from "./pack.ts";
import { ContourBuilder, mapContour, refitContour } from "./quadratic.ts";
import type { BezierPath } from "./shapes.ts";
import { type Matrix, maxScale, multiply, scaling } from "./transform.ts";

let loading: Promise<CanvasKit> | undefined;

/** Loads canvaskit once per process. */
export function canvasKit(): Promise<CanvasKit> {
  loading ??= CanvasKitInit();
  return loading;
}

export interface StrokeStyle {
  /** Width in the stroke's own space. */
  readonly width: number;
  readonly cap: "butt" | "round" | "square";
  readonly join: "miter" | "round" | "bevel";
  readonly miterLimit: number;
}

/**
 * Skia's stroker aims to keep its offset curves within 1 / (4 × precision)
 * path units, here device pixels, of the true offset; measured on circles
 * it stays well inside that.
 */
export const STROKE_PRECISION = 8;
/** The stroker's error bound, in device pixels. */
export const STROKER_ERROR = 1 / (4 * STROKE_PRECISION);

/**
 * The outline of stroking `paths` (in the stroke's space, which `m` maps to
 * canvas pixels) as closed quadratic contours in canvas pixels. `device` is
 * device pixels per canvas pixel at the largest display size and
 * `tolerance` the conversion error allowed, in device pixels.
 */
export function strokeOutline(
  ck: CanvasKit,
  paths: readonly BezierPath[],
  m: Matrix,
  style: StrokeStyle,
  device: number,
  tolerance: number,
): Contour[] {
  // Device pixels per unit of the stroke's space, along its most stretched
  // direction, so no direction ends up coarser than the tolerance.
  const k = device * maxScale(m);
  if (!(style.width > 0) || !(k > 0)) return [];
  const builder = new ck.PathBuilder();
  for (const path of paths) {
    const { v, i, o } = path;
    const first = v[0];
    if (!first) continue;
    builder.moveTo(first[0] * k, first[1] * k);
    const segments = path.closed ? v.length : v.length - 1;
    for (let s = 0; s < segments; s++) {
      const to = v[(s + 1) % v.length] ?? first;
      const out = o[s] ?? first;
      const into = i[(s + 1) % v.length] ?? to;
      builder.cubicTo(
        out[0] * k,
        out[1] * k,
        into[0] * k,
        into[1] * k,
        to[0] * k,
        to[1] * k,
      );
    }
    if (path.closed) builder.close();
  }
  const path: Path = builder.detachAndDelete();
  const stroked = path.makeStroked({
    width: style.width * k,
    cap: ck.StrokeCap[
      style.cap === "butt" ? "Butt" : style.cap === "round" ? "Round" : "Square"
    ],
    join: ck.StrokeJoin[
      style.join === "miter"
        ? "Miter"
        : style.join === "round"
          ? "Round"
          : "Bevel"
    ],
    miter_limit: style.miterLimit,
    precision: STROKE_PRECISION,
  });
  path.delete();
  if (!stroked) return [];
  const cmds = stroked.toCmds();
  stroked.delete();
  // Skia's conics become quadratics well inside the budget; the refit
  // then spends the rest of it on fewer curves.
  const conics = tolerance / 20;
  const back = multiply(m, scaling(1 / k, 1 / k));
  return contoursFromCommands(ck, cmds, conics).map((contour) =>
    mapContour(refitContour(contour, tolerance - STROKER_ERROR - conics), back),
  );
}

/** Skia path commands (`Path.toCmds`) as contours. */
export function contoursFromCommands(
  ck: CanvasKit,
  cmds: ArrayLike<number>,
  tolerance: number,
): Contour[] {
  const builder = new ContourBuilder(tolerance);
  let i = 0;
  const at = (k: number): number => cmds[i + k] ?? 0;
  while (i < cmds.length) {
    const verb = cmds[i];
    switch (verb) {
      case ck.MOVE_VERB:
        builder.moveTo([at(1), at(2)]);
        i += 3;
        break;
      case ck.LINE_VERB:
        builder.lineTo([at(1), at(2)]);
        i += 3;
        break;
      case ck.QUAD_VERB:
        builder.quadTo([at(1), at(2)], [at(3), at(4)]);
        i += 5;
        break;
      case ck.CONIC_VERB:
        builder.conicTo([at(1), at(2)], [at(3), at(4)], at(5));
        i += 6;
        break;
      case ck.CUBIC_VERB:
        builder.cubicTo([at(1), at(2)], [at(3), at(4)], [at(5), at(6)]);
        i += 7;
        break;
      case ck.CLOSE_VERB:
        builder.close();
        i += 1;
        break;
      default:
        throw new Error(`unknown Skia path verb ${verb}`);
    }
  }
  return builder.done();
}
