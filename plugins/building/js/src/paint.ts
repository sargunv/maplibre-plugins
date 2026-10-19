// Paint and layout evaluation for the building layer, on top of the shared
// @maplibre-plugins/paint package. Paint follows the native host: values
// the same for every feature are uniforms, data-driven ones stay a
// FeatureValue that the layer binds as vertex attributes, and every change
// transitions (building-vertical-gradient, a boolean, holds then switches).
//
// Layout properties are evaluated once per feature when a tile is laid out,
// as the host's per-feature layout values (patch 0006): at the tile's zoom,
// from the feature's properties, never with feature-state, and without
// transitions. An expression that fails, returns null or the wrong type, or
// a string outside an enum's values, gives the property's default.

import {
  type CanonicalTile,
  type CompiledValue,
  compileValue,
  type Current,
  type EvaluationFeature,
  isFeatureValue,
  type PaintPropertySpec,
  PaintState,
  type TransitionOptions,
  type Vector,
} from "@maplibre-plugins/paint";

import type { LayoutValues } from "./layout.ts";
import {
  type LayoutName,
  layoutNames,
  layoutSpec,
  type PaintName,
  paintNames,
  paintSpec,
  ROOF_ORIENTATIONS,
  ROOF_SHAPES,
} from "./spec.ts";

export {
  type Current,
  DEFAULT_TRANSITION,
  type TransitionOptions,
  type Vector,
} from "@maplibre-plugins/paint";

/** Every paint property's current value: a vector, or a per-feature value. */
export type CurrentPaint = Readonly<Record<PaintName, Current>>;

export type BuildingPaintState = PaintState<PaintName>;

/**
 * The paint state of a building layer. Throws on invalid values and on keys
 * the type does not take, as the native host fails the whole layer.
 */
export function createPaintState(
  defaultTransition: Required<TransitionOptions>,
  paint: Partial<Record<string, unknown>>,
): BuildingPaintState {
  const spec: Readonly<Record<PaintName, PaintPropertySpec>> = paintSpec;
  return new PaintState(spec, paintNames, defaultTransition, paint);
}

/** A property's first component when it is the same for every feature, else null. */
export function uniformNumber(
  current: CurrentPaint,
  name: PaintName,
): number | null {
  const value = current[name];
  return isFeatureValue(value) ? null : ((value as Vector)[0] ?? 0);
}

/** The layer's layout properties: raw values and their compiled forms. */
export class LayoutEvaluator {
  private readonly raw = new Map<LayoutName, unknown>();
  private readonly compiled = new Map<LayoutName, CompiledValue>();

  /**
   * Throws on an invalid value or an unknown key, as the host rejects the
   * layer. `visibility` is not one of these; the layer handles it.
   */
  constructor(layout: Partial<Record<string, unknown>> = {}) {
    for (const name of layoutNames) this.set(name, layout[name]);
    for (const key of Object.keys(layout)) {
      if (key !== "visibility" && !this.compiled.has(key as LayoutName))
        throw new Error(`Unknown layout property ${key}`);
    }
  }

  get(name: LayoutName): unknown {
    return this.raw.get(name);
  }

  /** Sets a property; undefined or null restores its default. Invalid values throw and keep the old one. */
  set(name: LayoutName, value: unknown): void {
    const spec: PaintPropertySpec = layoutSpec[name];
    const raw = value === undefined || value === null ? spec.default : value;
    const compiled = compileValue(spec, name, raw);
    this.raw.set(name, raw);
    this.compiled.set(name, compiled);
  }

  /** The raw layout values, as style JSON. */
  toJson(): Record<LayoutName, unknown> {
    return Object.fromEntries(
      layoutNames.map((name) => [name, this.raw.get(name)]),
    ) as Record<LayoutName, unknown>;
  }

  /**
   * One feature's layout values at a tile's zoom. With the tile and the
   * feature's geometry, `within` and `distance` work, as in the host's
   * layout.
   */
  evaluate(
    zoom: number,
    feature: EvaluationFeature,
    canonical?: CanonicalTile,
  ): Required<LayoutValues> {
    const at = (name: LayoutName): number => {
      const value = this.compiled.get(name)!;
      const vector = isFeatureValue(value)
        ? value.at(zoom, feature, undefined, canonical)
        : value.at(zoom);
      return vector[0] ?? 0;
    };
    return {
      shape: ROOF_SHAPES[at("building-roof-shape")] ?? "flat",
      orientation:
        ROOF_ORIENTATIONS[at("building-roof-orientation")] ?? "along",
      direction: at("building-roof-direction"),
    };
  }
}
