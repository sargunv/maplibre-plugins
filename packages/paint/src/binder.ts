// Per-vertex paint attributes for data-driven values, laid out like MapLibre
// Native's plugin paint binders (plugin_bucket.cpp): each bound property
// holds [min..., max...] per vertex, min evaluated at the tile's zoom and max
// at the next zoom level, filled per feature vertex range and refilled for
// the features whose state changed.

import {
  type EvaluationFeature,
  type FeatureState,
  type FeatureValue,
  isFeatureValue,
  type Vector,
} from "./value.ts";

/** A property's current value: a uniform vector or a per-feature value. */
export type Current = Vector | FeatureValue;

/** Where each data-driven property lives in an interleaved vertex buffer. */
export interface AttributeLayout<Name extends string> {
  /** The data-driven properties, in `names` order. */
  readonly bound: readonly Name[];
  /** Floats from the vertex start to each bound property's min. */
  readonly offsets: Readonly<Partial<Record<Name, number>>>;
  /** Floats per vertex: two endpoints of each bound property's components. */
  readonly stride: number;
  /**
   * One character per name: "1" uniform, "0" bound, the values of the
   * MLN_PLUGIN_PROPERTY_<NAME>_IS_UNIFORM macros. Equal keys mean equal
   * layouts and equal shader variants.
   */
  readonly key: string;
}

export function attributeLayout<Name extends string>(
  names: readonly Name[],
  current: Readonly<Record<Name, Current>>,
): AttributeLayout<Name> {
  const bound: Name[] = [];
  const offsets: Partial<Record<Name, number>> = {};
  let stride = 0;
  let key = "";
  for (const name of names) {
    const value = current[name];
    if (isFeatureValue(value)) {
      bound.push(name);
      offsets[name] = stride;
      stride += 2 * value.components;
      key += "0";
    } else {
      key += "1";
    }
  }
  return { bound, offsets, stride, key };
}

/** Vertices one feature's geometry occupies, as a plugin layout reports them. */
export interface VertexRange {
  readonly featureIndex: number;
  readonly firstVertex: number;
  readonly vertexCount: number;
}

/** The features and feature states a fill reads. */
export interface FeatureSource {
  feature(index: number): EvaluationFeature | undefined;
  /** The feature-state key, String(id), or undefined for a feature without an id. */
  stateKey(index: number): string | undefined;
  state(key: string): FeatureState | undefined;
}

export interface FillOptions {
  /** Only ranges whose feature's state key is in the set. */
  readonly keys?: ReadonlySet<string>;
  /** Only properties whose value reads feature-state. */
  readonly stateOnly?: boolean;
}

/**
 * Fills `out` (vertex count × layout.stride floats) for the bound
 * properties: each range's vertices get its feature's [min..., max...]
 * (FeatureValue.encode at bucketZoom), with the feature's state when it has
 * one. `keys` limits the fill to ranges whose feature key is in it, and
 * `stateOnly` to state-dependent properties, as the native binder refills
 * on a feature-state change (plugin_bucket.cpp updateRanges). Ranges that
 * do not fit in `out` are skipped, as PluginPaintVertexVector::set does.
 * Returns the vertices written, [first, end), or null when none were.
 */
export function fillAttributes<Name extends string>(
  out: Float32Array,
  layout: AttributeLayout<Name>,
  current: Readonly<Record<Name, Current>>,
  ranges: readonly VertexRange[],
  source: FeatureSource,
  bucketZoom: number,
  options: FillOptions = {},
): { first: number; end: number } | null {
  const { keys, stateOnly = false } = options;
  const { stride } = layout;
  const properties: { value: FeatureValue; offset: number }[] = [];
  for (const name of layout.bound) {
    const value = current[name];
    if (!isFeatureValue(value)) {
      throw new Error(
        `${name} is not data-driven; recompute the attribute layout`,
      );
    }
    if (stateOnly && !value.stateDependent) continue;
    properties.push({ value, offset: layout.offsets[name] ?? 0 });
  }
  if (properties.length === 0 || stride === 0) return null;
  const vertexCount = Math.floor(out.length / stride);
  let first = Infinity;
  let end = -Infinity;
  for (const range of ranges) {
    const { featureIndex, firstVertex, vertexCount: count } = range;
    if (count <= 0 || firstVertex < 0 || firstVertex + count > vertexCount)
      continue;
    const key = source.stateKey(featureIndex);
    if (keys && (key === undefined || !keys.has(key))) continue;
    const feature = source.feature(featureIndex);
    if (!feature) continue;
    const state = key === undefined ? undefined : source.state(key);
    for (const { value, offset } of properties) {
      const start = firstVertex * stride + offset;
      const width = 2 * value.components;
      value.encode(bucketZoom, feature, state, out, start);
      for (let vertex = 1; vertex < count; vertex++) {
        out.copyWithin(start + vertex * stride, start, start + width);
      }
    }
    first = Math.min(first, firstVertex);
    end = Math.max(end, firstVertex + count);
  }
  return first < end ? { first, end } : null;
}
