// Paint evaluation for this layer's properties, on top of the shared
// @maplibre-plugins/paint package.

import {
  PaintState,
  type TransitionOptions,
  type Vector,
} from "@maplibre-plugins/paint";

import { type PaintName, paintNames, paintSpec } from "./spec.ts";

export {
  DEFAULT_TRANSITION,
  type TransitionOptions,
  type Vector,
} from "@maplibre-plugins/paint";

export type EvaluatedPaint = Readonly<Record<PaintName, Vector>>;

export type WaterPaintState = PaintState<PaintName>;

export function createPaintState(
  defaultTransition: Required<TransitionOptions>,
  paint: Partial<Record<string, unknown>>,
): WaterPaintState {
  return new PaintState(paintSpec, paintNames, defaultTransition, paint);
}

function number(paint: EvaluatedPaint, name: PaintName): number {
  return paint[name][0] ?? 0;
}

/** Whether the layer keeps repainting for these values, like the native should_animate callback. */
export function shouldAnimate(paint: EvaluatedPaint): boolean {
  return number(paint, "wave-speed") !== 0 && number(paint, "opacity") > 0;
}
