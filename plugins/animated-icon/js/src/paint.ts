// Paint evaluation for this layer's properties, on top of the shared
// @maplibre-plugins/paint package. Enums evaluate to their value's index, so
// icon-animation's vector is [0] for "none" and [i + 1] for the catalog's
// animation i. A data-driven value stays a FeatureValue, which the layer
// binds as vertex attributes like the native host's paint binders.

import {
  type Current,
  isFeatureValue,
  PaintState,
  type TransitionOptions,
  type Vector,
} from "@maplibre-plugins/paint";

import type { Catalog } from "./catalog.ts";
import { type PaintName, paintNames, paintSpecFor } from "./spec.ts";

export {
  type Current,
  DEFAULT_TRANSITION,
  type TransitionOptions,
  type Vector,
} from "@maplibre-plugins/paint";

/** Every property's current value: a vector, or a per-feature value. */
export type CurrentPaint = Readonly<Record<PaintName, Current>>;

export type AnimatedIconPaintState = PaintState<PaintName>;

/** Paint state whose icon-animation accepts "none" and the catalog's animation names. */
export function createPaintState(
  catalog: Catalog,
  defaultTransition: Required<TransitionOptions>,
  paint: Partial<Record<string, unknown>>,
): AnimatedIconPaintState {
  return new PaintState(
    paintSpecFor(catalog),
    paintNames,
    defaultTransition,
    paint,
  );
}

/** A property's first component when it is the same for every feature, else null. */
export function uniformNumber(
  current: CurrentPaint,
  name: PaintName,
): number | null {
  const value = current[name];
  return isFeatureValue(value) ? null : ((value as Vector)[0] ?? 0);
}

/**
 * Whether the layer keeps repainting for these values, apart from running
 * transitions, which always repaint. Only values that are the same for every
 * feature can stop it: an animation of none, a size or opacity that is not
 * positive, or a speed of 0; a data-driven value never does. This is
 * stricter than the native should_animate, which cannot tell a constant
 * from a data-driven value and keeps repainting whenever icon-animation is
 * set. It changes repaint cost only, never pixels: a camera move repaints
 * anyway, and every repaint evaluates the values again.
 */
export function shouldAnimate(current: CurrentPaint): boolean {
  const animation = uniformNumber(current, "icon-animation");
  const size = uniformNumber(current, "icon-size");
  const opacity = uniformNumber(current, "icon-opacity");
  const speed = uniformNumber(current, "icon-animation-speed");
  return (
    animation !== 0 &&
    !(size !== null && size <= 0) &&
    !(opacity !== null && opacity <= 0) &&
    speed !== 0
  );
}
