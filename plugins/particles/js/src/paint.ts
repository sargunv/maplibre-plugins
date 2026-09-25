// Paint evaluation for both particle layer types, on top of the shared
// @maplibre-plugins/paint package, which owns expression compilation,
// validation and MapLibre-style transitions the way the native host applies
// them. Both types read the one canonical table in spec.ts, so a property
// they share behaves the same on either; particle-features also takes
// feature and composite expressions for its data-driven properties, as the
// native type declares them (FEATURE | COMPOSITE, without FEATURE_STATE).

import {
  type Current,
  type PaintPropertySpec,
  PaintState,
  type TransitionOptions,
  type Vector,
} from "@maplibre-plugins/paint";

import {
  type EmitterPaintName,
  emitterPaintNames,
  featuresDataDriven,
  type FeaturesPaintName,
  featuresPaintNames,
  type PaintName,
  paintSpec,
  type TransitionName,
} from "./spec.ts";

export {
  type Current,
  DEFAULT_TRANSITION,
  type TransitionOptions,
  type Vector,
} from "@maplibre-plugins/paint";

/**
 * Raw paint input for one layer type: literals, CSS colors, or style
 * expressions keyed by property name, plus `<name>-transition` for the
 * properties that take one.
 */
export type PaintInput<Name extends PaintName> = Partial<
  Record<Name, unknown>
> &
  Partial<Record<`${Name & TransitionName}-transition`, TransitionOptions>>;

export type EmitterPaintInput = PaintInput<EmitterPaintName>;
export type FeaturesPaintInput = PaintInput<FeaturesPaintName>;

/** Evaluated emitter paint: one vector per property (enums as [index], colors premultiplied). */
export type EmitterPaint = Readonly<Record<EmitterPaintName, Vector>>;
export type FeaturesPaint = Readonly<Record<FeaturesPaintName, Vector>>;
/** particle-features paint at a moment: a vector, or a per-feature value for a data-driven property. */
export type FeaturesCurrent = Readonly<Record<FeaturesPaintName, Current>>;

export type EmitterPaintState = PaintState<EmitterPaintName>;
export type FeaturesPaintState = PaintState<FeaturesPaintName>;

/**
 * The particle-features view of the canonical table: its data-driven
 * properties also take feature and composite expressions, never ones that
 * read feature-state.
 */
export const featuresPaintSpec = Object.fromEntries(
  featuresPaintNames.map((name) => {
    const spec: PaintPropertySpec = paintSpec[name];
    return [
      name,
      (featuresDataDriven as readonly string[]).includes(name)
        ? { ...spec, expressions: "data-driven", featureState: false }
        : spec,
    ];
  }),
) as Readonly<Record<FeaturesPaintName, PaintPropertySpec>>;

/**
 * The paint state of a particle-emitter layer. Throws on invalid values and,
 * as the native host fails the whole layer, on keys the type does not take:
 * another type's property, a misspelt one, or its transition.
 */
export function createEmitterPaintState(
  defaultTransition: Required<TransitionOptions>,
  paint: Partial<Record<string, unknown>>,
): EmitterPaintState {
  return new PaintState(paintSpec, emitterPaintNames, defaultTransition, paint);
}

/**
 * The paint state of a particle-features layer, whose data-driven properties
 * also take feature expressions. Throws on invalid values and on keys the
 * type does not take, as createEmitterPaintState does.
 */
export function createFeaturesPaintState(
  defaultTransition: Required<TransitionOptions>,
  paint: Partial<Record<string, unknown>>,
): FeaturesPaintState {
  return new PaintState(
    featuresPaintSpec,
    featuresPaintNames,
    defaultTransition,
    paint,
  );
}
