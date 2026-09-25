// Repeaters (`rp`), as lottie-web 5.13's RepeaterModifier
// (player/js/utils/shapes/RepeaterModifier.js) builds them: the items
// before the repeater in its group are copied `ceil(c)` times into new
// groups at the front of the group, so the first copy draws on top. Each
// copy's group transform accumulates the repeater's transform a whole
// number of times plus the offset, with rotation and scale about the
// anchor and the position stepped separately; its opacity ramps from the
// start opacity to the end opacity across the copies. The original items
// stay in the group without drawing: their styles draw nothing, but their
// shapes still reach styles after the repeater, as in lottie-web.

import { type Property, scalarAt, valueAt } from "./keyframes.ts";
import {
  IDENTITY,
  type Matrix,
  multiply,
  rotation,
  scaling,
  type Transform,
  translation,
} from "./transform.ts";

/** A repeater's transform: a Lottie transform plus the opacity ramp. */
export interface RepeaterTransform extends Transform {
  /** Start and end opacity, in percent. */
  readonly so?: Property;
  readonly eo?: Property;
}

/** The subset of a repeater item the baker reads. */
export interface RepeaterItem {
  readonly ty: "rp";
  /** Copies (fractions round up) and offset, in copies. */
  readonly c?: Property;
  readonly o?: Property;
  /** Composite: 1 above (the untransformed copy on top), otherwise below. */
  readonly m?: number;
  readonly tr?: RepeaterTransform;
}

/** One copy's group transform. */
export interface RepeaterCopy {
  readonly matrix: Matrix;
  /** 0..1. */
  readonly opacity: number;
}

const DEG = Math.PI / 180;

/**
 * An affine matrix composed the way lottie-web's Matrix composes them
 * (3rd_party/transformation-matrix.js): points are row vectors, and each
 * call applies its transform after the ones before it.
 */
class RowMatrix {
  m: Matrix = IDENTITY;
  /** Applies `n` after the transforms so far. */
  transform(n: Matrix): this {
    this.m = multiply(n, this.m);
    return this;
  }
  translate(x: number, y: number): this {
    return this.transform(translation(x, y));
  }
  /** lottie-web's rotate(angle) turns counterclockwise on screen. */
  rotate(angle: number): this {
    return this.transform(rotation(-angle));
  }
  scale(x: number, y: number): this {
    return this.transform(scaling(x, y));
  }
}

/**
 * Every copy's transform at `frame`, in the order the copies sit in the
 * group (the first on top). Ported from RepeaterModifier.processShapes
 * (RepeaterModifier.js:113-190), including how it steps the transform for
 * negative offsets.
 */
export function repeaterCopies(
  item: RepeaterItem,
  frame: number,
): RepeaterCopy[] {
  const copies = Math.ceil(scalarAt(item.c, frame, 0));
  if (!(copies > 0)) return [];
  const tr = item.tr;
  const position = tr?.p;
  const [px = 0, py = 0] =
    position && !("s" in position && position.s === true)
      ? valueAt(position as Property, frame, [0, 0])
      : [0, 0];
  const [ax = 0, ay = 0] = valueAt(tr?.a, frame, [0, 0]);
  const [sx = 100, sy = sx] = valueAt(tr?.s, frame, [100, 100]);
  const r = scalarAt(tr?.r, frame, 0) * DEG;
  const so = scalarAt(tr?.so, frame, 100) / 100;
  const eo = scalarAt(tr?.eo, frame, 100) / 100;
  const p = new RowMatrix();
  const rot = new RowMatrix();
  const sc = new RowMatrix();
  const apply = (perc: number, inverse: boolean): void => {
    const dir = inverse ? -1 : 1;
    const scaleX = sx / 100 + (1 - sx / 100) * (1 - perc);
    const scaleY = sy / 100 + (1 - sy / 100) * (1 - perc);
    p.translate(px * dir * perc, py * dir * perc);
    rot
      .translate(-ax, -ay)
      .rotate(-r * dir * perc)
      .translate(ax, ay);
    sc.translate(-ax, -ay)
      .scale(inverse ? 1 / scaleX : scaleX, inverse ? 1 / scaleY : scaleY)
      .translate(ax, ay);
  };
  const offset = scalarAt(item.o, frame, 0);
  const offsetModulo = offset % 1;
  const roundOffset = offset > 0 ? Math.floor(offset) : Math.ceil(offset);
  let iteration = 0;
  if (offset > 0) {
    while (iteration < roundOffset) {
      apply(1, false);
      iteration += 1;
    }
    if (offsetModulo) {
      apply(offsetModulo, false);
      iteration += offsetModulo;
    }
  } else if (offset < 0) {
    while (iteration > roundOffset) {
      apply(1, true);
      iteration -= 1;
    }
    if (offsetModulo) {
      apply(-offsetModulo, true);
      iteration -= offsetModulo;
    }
  }
  const out: RepeaterCopy[] = Array.from({ length: copies });
  let i = item.m === 1 ? 0 : copies - 1;
  const dir = item.m === 1 ? 1 : -1;
  for (let left = copies; left > 0; left--) {
    const opacity = copies === 1 ? so : so + (eo - so) * (i / (copies - 1));
    let matrix = IDENTITY;
    if (iteration !== 0) {
      if ((i !== 0 && dir === 1) || (i !== copies - 1 && dir === -1)) {
        apply(1, false);
      }
      // The copy turns, then scales, then moves.
      matrix = new RowMatrix()
        .transform(rot.m)
        .transform(sc.m)
        .transform(p.m).m;
    }
    out[i] = { matrix, opacity };
    iteration += 1;
    i += dir;
  }
  return out;
}
