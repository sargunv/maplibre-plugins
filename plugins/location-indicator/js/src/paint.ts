// Paint evaluation for this layer's properties, on top of the shared
// @maplibre-plugins/paint package, which owns expression compilation and
// MapLibre-style transitions.

import {
  type Compiled,
  compile as compileWith,
  PaintValue as SharedPaintValue,
  type Vector,
} from "@maplibre-plugins/paint";

import { type PaintName, paintSpec } from "./spec.ts";

export {
  type Compiled,
  DEFAULT_TRANSITION,
  ease,
  premultiply,
  type TransitionOptions,
  type Vector,
} from "@maplibre-plugins/paint";

/** Compiles a raw paint value (a literal, a CSS color, or a style expression) for one property. */
export function compile(name: PaintName, value: unknown): Compiled {
  return compileWith(paintSpec[name], name, value);
}

/** One paint property's current value, transitioning from earlier values. */
export class PaintValue extends SharedPaintValue {
  constructor(name: PaintName, initial: Compiled) {
    super(name, paintSpec[name].type, initial);
  }
}

export type EvaluatedPaint = Readonly<Record<PaintName, Vector>>;
