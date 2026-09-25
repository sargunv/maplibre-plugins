// Compiling one paint value the way MapLibre Native's plugin properties do
// (plugin_property.cpp): constants are checked against the property's list or
// bounds, expressions are parsed through the style spec and then checked
// against the property's expression capabilities, and each evaluation falls
// back to the plugin default when the expression throws or returns the wrong
// type. Camera values evaluate per zoom; data-driven ones evaluate per feature
// and are what a layer binds as vertex attributes.

import {
  Color,
  createPropertyExpression,
  type Feature as StyleFeature,
  type InterpolationType,
  type StylePropertyExpression,
  type StylePropertySpecification,
} from "@maplibre/maplibre-gl-style-spec";

/** Value types a plugin paint property can have, as in each plugin's spec.json. */
export type PaintType =
  | "double2"
  | "float2"
  | "rotation"
  | "float"
  | "color"
  | "enum";

/**
 * The expressions a property accepts, as the native expression capabilities
 * say: "constant" (NONE) takes only constants, including expressions that
 * fold to one; "camera" also takes zoom expressions; and "data-driven" also
 * takes feature, composite and feature-state expressions.
 */
export type ExpressionSupport = "constant" | "camera" | "data-driven";

/** A float, a rotation, a pair of floats or doubles, or a color. */
export interface NumericPaintPropertySpec {
  readonly type: Exclude<PaintType, "enum">;
  readonly default: number | readonly number[];
  readonly minimum?: number;
  readonly maximum?: number;
  /** Defaults to "camera". */
  readonly expressions?: ExpressionSupport;
  /**
   * Whether a data-driven value may read feature-state (the host's
   * FEATURE_STATE capability). Defaults to true.
   */
  readonly featureState?: boolean;
  /** Whether a `<name>-transition` key is accepted. Defaults to true. */
  readonly transition?: boolean;
}

/**
 * A string limited to `values`. It evaluates to the value's index, and it
 * takes no `<name>-transition` unless `transition` says so, like a native
 * enum property.
 */
export interface EnumPaintPropertySpec {
  readonly type: "enum";
  readonly values: readonly string[];
  readonly default: string;
  /** Defaults to "camera". */
  readonly expressions?: ExpressionSupport;
  /**
   * Whether a data-driven value may read feature-state (the host's
   * FEATURE_STATE capability). Defaults to true.
   */
  readonly featureState?: boolean;
  /** Whether a `<name>-transition` key is accepted. Defaults to false. */
  readonly transition?: boolean;
}

export type PaintPropertySpec =
  | NumericPaintPropertySpec
  | EnumPaintPropertySpec;

/**
 * A property's numeric vector: [n] for floats, [x, y] pairs, premultiplied
 * [r, g, b, a], or [index] into an enum's values.
 */
export type Vector = readonly number[];

/** Evaluates a compiled paint value at a zoom level. */
export type Compiled = (zoom: number) => Vector;

/** A feature as data-driven values read it. */
export interface EvaluationFeature {
  /** 1 point, 2 line, 3 polygon, as in vector tiles. */
  readonly type: 1 | 2 | 3;
  /** Omitted when the feature has none. */
  readonly id?: number | string;
  /** Already decoded: no "__$json__:" strings. */
  readonly properties: Readonly<Record<string, unknown>>;
}

export type FeatureState = Readonly<Record<string, unknown>>;

/** A value that is the same for every feature: a constant or a camera expression. */
export interface UniformValue {
  readonly kind: "uniform";
  at(zoom: number): Vector;
}

/**
 * A value that differs per feature: a source (feature or feature-state) or
 * composite (also zoom) expression. A layer binds it as a vertex attribute
 * holding [min..., max...] per vertex, like the native paint binder
 * (plugin_bucket.cpp fillRange), and mixes the two with factor().
 */
export interface FeatureValue {
  readonly kind: "feature";
  /** Floats per endpoint. */
  readonly components: 1 | 2 | 4;
  /** The expression is composite: it also depends on zoom. */
  readonly zoomDependent: boolean;
  /** The expression reads feature-state. */
  readonly stateDependent: boolean;
  /**
   * The value for a feature: the plugin default (premultiplied for colors)
   * when the expression throws or returns null or the wrong type, while NaN
   * and ±Infinity pass through.
   */
  at(zoom: number, feature: EvaluationFeature, state?: FeatureState): Vector;
  /**
   * Writes [min..., max...] at out[offset]: min at bucketZoom, max at
   * bucketZoom + 1 (a copy of min when the value is zoom-constant).
   */
  encode(
    bucketZoom: number,
    feature: EvaluationFeature,
    state: FeatureState | undefined,
    out: Float32Array,
    offset: number,
  ): void;
  /**
   * The factor that mixes min and max at a zoom:
   * clamp(interpolationFactor(zoom, bucketZoom, bucketZoom + 1), 0, 1), and
   * 0 unless the value is composite through an interpolate.
   */
  factor(bucketZoom: number, zoom: number): number;
  /**
   * The value as the host evaluates it without a feature (for
   * should_animate): feature accessors fail, so they give the default, and
   * feature-state reads null.
   */
  withoutFeature(zoom: number): Vector;
}

export type CompiledValue = UniformValue | FeatureValue;

/** Whether a value is bound per feature rather than uniform. */
export function isFeatureValue(value: unknown): value is FeatureValue {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { kind?: unknown }).kind === "feature"
  );
}

/**
 * Whether a property takes a `<name>-transition`: the spec's `transition`,
 * which defaults to true for numeric types and false for enums. Enums still
 * follow the layer's default transition (they hold, then switch).
 */
export function supportsTransitions(spec: PaintPropertySpec): boolean {
  return spec.transition ?? spec.type !== "enum";
}

/** Floats per endpoint, as the host encodes a binding (plugin_bucket.cpp componentCount). */
export function componentCount(spec: PaintPropertySpec): 1 | 2 | 4 {
  switch (spec.type) {
    case "color":
      return 4;
    case "float2":
    case "double2":
      return 2;
    default:
      return 1;
  }
}

/** Premultiplies a straight-alpha [r, g, b, a] in 0..1. */
export function premultiply(rgba: readonly number[]): Vector {
  const [r = 0, g = 0, b = 0, a = 1] = rgba;
  return [r * a, g * a, b * a, a];
}

const f32 = Math.fround;

/**
 * Wraps degrees to [0, 360) the way the host's Rotation does
 * (math/wrap.hpp): note that -360 wraps to 360, and non-finite angles to NaN.
 */
export function wrapRotation(angle: number): number {
  if (angle >= 0 && angle < 360) return angle;
  if (angle === 360) return 0;
  const wrapped = 0 + (angle % 360);
  return angle < 0 ? wrapped + 360 : wrapped;
}

// Every property parses as data-driven, as the host parses any property
// whose capabilities are not NONE (plugin_property.cpp convertTyped); the
// capability check happens afterwards, by expression kind.
const dataDriven = {
  "property-type": "data-driven",
  transition: true,
} as const;
const parameters = ["zoom", "feature", "feature-state"];

function propertySpecification(
  spec: PaintPropertySpec,
): StylePropertySpecification {
  const interpolated = { interpolated: true, parameters };
  switch (spec.type) {
    case "color":
      return {
        type: "color",
        default: "black",
        ...dataDriven,
        expression: interpolated,
      } as unknown as StylePropertySpecification;
    case "enum":
      // A plain string rather than a style-spec enum, as the host parses a
      // string property: the top level coerces (parsing_context.cpp
      // parseLayerPropertyExpression), so ["get", "k"] on the number 61
      // selects "61", and the plugin's own list check follows.
      return {
        type: "string",
        default: spec.default,
        ...dataDriven,
        expression: { interpolated: false, parameters },
      } as unknown as StylePropertySpecification;
    case "double2":
    case "float2":
      return {
        type: "array",
        value: "number",
        length: 2,
        ...dataDriven,
        expression: interpolated,
      } as unknown as StylePropertySpecification;
    default:
      return {
        type: "number",
        default: 0,
        ...dataDriven,
        expression: interpolated,
      } as unknown as StylePropertySpecification;
  }
}

/** The part of a style-spec expression this module evaluates. */
interface Evaluable {
  evaluateWithoutErrorHandling(
    globals: { zoom: number },
    feature?: StyleFeature,
    featureState?: FeatureState,
  ): unknown;
}

function isNumberArray(value: unknown, length: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((v) => typeof v === "number" && Number.isFinite(v))
  );
}

function colorVector(color: Color): Vector {
  // Style-spec colors are premultiplied, which the host's Color is too.
  return [color.r, color.g, color.b, color.a];
}

function parseExpression(
  spec: PaintPropertySpec,
  name: string,
  value: unknown,
): StylePropertyExpression {
  const result = createPropertyExpression(
    value,
    `paint.${name}`,
    propertySpecification(spec),
  );
  if (result.result === "error") {
    const messages = result.value.map((e) => e.message).join("; ");
    throw new Error(`Invalid value for ${name}: ${messages}`);
  }
  return result.value;
}

/** A listed value's index. Anything else throws the host's error. */
function enumIndex(
  spec: EnumPaintPropertySpec,
  name: string,
  value: unknown,
): number {
  const index = typeof value === "string" ? spec.values.indexOf(value) : -1;
  if (index < 0) {
    // plugin_property.cpp validateConstant
    throw new Error(
      `value is not allowed for plugin property '${name}': ${JSON.stringify(value)} is not one of ${spec.values.join(", ")}`,
    );
  }
  return index;
}

/**
 * Rejects a float or rotation constant outside the spec's bounds, as the
 * host does (plugin_property.cpp validateConstant): it compares the stored
 * constant, an f32 for floats and the wrapped double for rotations, with the
 * f32 bounds, in double. NaN fails any bound.
 */
function checkRange(
  spec: NumericPaintPropertySpec,
  name: string,
  stored: number,
): void {
  const { minimum, maximum } = spec;
  if (
    (minimum === undefined || stored >= f32(minimum)) &&
    (maximum === undefined || stored <= f32(maximum))
  )
    return;
  throw new Error(
    `value is outside the allowed range for plugin property '${name}': ${stored} is outside ${minimum ?? "-inf"}..${maximum ?? "inf"}`,
  );
}

/**
 * The plugin default as the host builds it (plugin_property.cpp
 * defaultValue): f32 components, a wrapped rotation, and a color
 * premultiplied in f32.
 */
function defaultVector(spec: PaintPropertySpec, name: string): Vector {
  switch (spec.type) {
    case "enum":
      return [enumIndex(spec, name, spec.default)];
    case "rotation":
      return [wrapRotation(f32(Number(spec.default)))];
    case "double2":
      return spec.default as readonly number[];
    case "color": {
      const [r = 0, g = 0, b = 0, a = 0] = (
        spec.default as readonly number[]
      ).map(f32);
      return [f32(r * a), f32(g * a), f32(b * a), a];
    }
    case "float2":
      return (spec.default as readonly number[]).map(f32);
    default:
      return [f32(Number(spec.default))];
  }
}

/**
 * An evaluated expression output as the property's vector, or null for the
 * wrong type (value.cpp fromExpressionValue). Numbers pass through, NaN and
 * ±Infinity included; rotations round to f32 before wrapping, as
 * ValueConverter<Rotation> does; an enum output outside the list becomes the
 * default's index (plugin_bucket.cpp encodedValue).
 */
function typedVector(
  spec: PaintPropertySpec,
  value: unknown,
  fallback: Vector,
): Vector | null {
  switch (spec.type) {
    case "enum": {
      if (typeof value !== "string") return null;
      const index = spec.values.indexOf(value);
      return index < 0 ? fallback : [index];
    }
    case "color":
      return value instanceof Color ? colorVector(value) : null;
    case "float2":
    case "double2":
      return Array.isArray(value) &&
        value.length === 2 &&
        value.every((v) => typeof v === "number")
        ? [value[0] as number, value[1] as number]
        : null;
    case "rotation":
      return typeof value === "number" ? [wrapRotation(f32(value))] : null;
    default:
      return typeof value === "number" ? [value] : null;
  }
}

/**
 * A feature whose data is unavailable: every accessor throws, as the host's
 * feature accessors fail without a feature ("Feature data is unavailable",
 * compound_expression.cpp), while feature-state still reads null.
 */
const NO_FEATURE = new Proxy({} as StyleFeature, {
  get() {
    throw new Error(
      "Feature data is unavailable in the current evaluation context.",
    );
  },
  has() {
    throw new Error(
      "Feature data is unavailable in the current evaluation context.",
    );
  },
});

function evaluator(
  spec: PaintPropertySpec,
  expression: StylePropertyExpression,
  fallback: Vector,
): (zoom: number, feature?: StyleFeature, state?: FeatureState) => Vector {
  const evaluable = expression as unknown as Evaluable;
  return (zoom, feature, state) => {
    let value: unknown;
    try {
      // The host evaluates at an f32 zoom, and with no canonical tile
      // (plugin_property.cpp evaluate).
      value = evaluable.evaluateWithoutErrorHandling(
        { zoom: f32(zoom) },
        feature,
        state,
      );
    } catch {
      return fallback;
    }
    return typedVector(spec, value, fallback) ?? fallback;
  };
}

// util/unitbezier.hpp, which the host's cubic-bezier interpolation uses.
function solveUnitBezier(
  [p1x, p1y, p2x, p2y]: readonly [number, number, number, number],
  x: number,
  epsilon: number,
): number {
  const cx = 3 * p1x;
  const bx = 3 * (p2x - p1x) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * p1y;
  const by = 3 * (p2y - p1y) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const derivativeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  const solveX = (): number => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const error = sampleX(t) - x;
      if (Math.abs(error) < epsilon) return t;
      const d = derivativeX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= error / d;
    }
    let t0 = 0;
    let t1 = 1;
    t = x;
    if (t < t0) return t0;
    if (t > t1) return t1;
    while (t0 < t1) {
      const sampled = sampleX(t);
      if (Math.abs(sampled - x) < epsilon) return t;
      if (x > sampled) t0 = t;
      else t1 = t;
      t = (t1 - t0) * 0.5 + t0;
    }
    return t;
  };
  const t = solveX();
  return ((ay * t + by) * t + cy) * t;
}

// util/interpolate.cpp interpolationFactor, in f32 like the host.
function exponentialFactor(
  base: number,
  lower: number,
  upper: number,
  input: number,
): number {
  const difference = f32(upper - lower);
  const progress = f32(input - lower);
  if (difference === 0) return 0;
  if (f32(base) === 1) return f32(progress / difference);
  return f32(
    (Math.pow(f32(base), progress) - 1) / (Math.pow(f32(base), difference) - 1),
  );
}

/**
 * The host's composite interpolation factor
 * (plugin_property.cpp interpolationFactor): the zoom curve's factor over
 * [bucketZoom, bucketZoom + 1] in f32, clamped to 0..1.
 */
function curveFactor(
  type: InterpolationType,
  bucketZoom: number,
  zoom: number,
): number {
  const lower = f32(bucketZoom);
  const upper = f32(lower + 1);
  const input = f32(zoom);
  let factor: number;
  switch (type.name) {
    case "exponential":
      factor = exponentialFactor(type.base, lower, upper, input);
      break;
    case "cubic-bezier":
      factor = f32(
        solveUnitBezier(
          type.controlPoints,
          exponentialFactor(1, lower, upper, input),
          1e-6,
        ),
      );
      break;
    default:
      factor = exponentialFactor(1, lower, upper, input);
  }
  return Math.min(Math.max(factor, 0), 1);
}

class ExpressionFeatureValue implements FeatureValue {
  readonly kind = "feature";
  readonly components: 1 | 2 | 4;
  readonly zoomDependent: boolean;
  readonly stateDependent: boolean;
  private readonly evaluate: ReturnType<typeof evaluator>;
  private readonly interpolation: InterpolationType | undefined;

  constructor(
    spec: PaintPropertySpec,
    expression: Extract<
      StylePropertyExpression,
      { kind: "source" | "composite" }
    >,
    fallback: Vector,
  ) {
    this.components = componentCount(spec);
    this.zoomDependent = expression.kind === "composite";
    this.stateDependent = expression.isStateDependent;
    this.evaluate = evaluator(spec, expression, fallback);
    this.interpolation =
      expression.kind === "composite"
        ? expression.interpolationType
        : undefined;
  }

  at(zoom: number, feature: EvaluationFeature, state?: FeatureState): Vector {
    return this.evaluate(zoom, feature as StyleFeature, state);
  }

  encode(
    bucketZoom: number,
    feature: EvaluationFeature,
    state: FeatureState | undefined,
    out: Float32Array,
    offset: number,
  ): void {
    const { components } = this;
    const minimum = this.at(bucketZoom, feature, state);
    const maximum = this.zoomDependent
      ? this.at(f32(f32(bucketZoom) + 1), feature, state)
      : minimum;
    for (let i = 0; i < components; i++) {
      out[offset + i] = minimum[i] ?? 0;
      out[offset + components + i] = maximum[i] ?? 0;
    }
  }

  factor(bucketZoom: number, zoom: number): number {
    return this.interpolation
      ? curveFactor(this.interpolation, bucketZoom, zoom)
      : 0;
  }

  withoutFeature(zoom: number): Vector {
    return this.evaluate(zoom, NO_FEATURE);
  }
}

function uniform(vector: Vector): UniformValue {
  return { kind: "uniform", at: () => vector };
}

/**
 * A folded constant (an expression without zoom or feature inputs folds to
 * a literal, property_value.cpp), checked like a literal: the stored value
 * is an f32 for floats and an f32 wrapped for rotations.
 */
function foldedConstant(
  spec: PaintPropertySpec,
  name: string,
  expression: StylePropertyExpression,
  fallback: Vector,
): UniformValue {
  const value = (
    expression as unknown as Evaluable
  ).evaluateWithoutErrorHandling({ zoom: 0 });
  if (spec.type === "enum") return uniform([enumIndex(spec, name, value)]);
  const vector = typedVector(spec, value, fallback);
  if (!vector) throw new Error(`Invalid value for ${name}: ${String(value)}`);
  if (spec.type === "float") checkRange(spec, name, f32(vector[0] ?? 0));
  if (spec.type === "rotation") checkRange(spec, name, vector[0] ?? 0);
  return uniform(vector);
}

/** The host's error for an expression the property's capabilities do not cover. */
function unsupported(name: string): Error {
  return new Error(
    `expression dependencies are not supported for plugin property '${name}'`,
  );
}

/**
 * Compiles a raw paint value (a literal, a CSS color, or a style expression)
 * for one property, like MapLibre Native's convertPluginPropertyValue. Throws
 * on values the style spec rejects, on an unlisted enum constant or a float
 * or rotation constant outside the bounds (validateConstant), and on an
 * expression the property's `expressions` or `featureState` does not allow
 * (the host's "expression dependencies are not supported" error, or "data
 * expressions not supported" for a data expression on a "constant"
 * property, which the host's conversion rejects first). Constants and camera
 * expressions compile to a UniformValue, feature and composite expressions to
 * a FeatureValue. Expression outputs are never range-checked. `null` and
 * `undefined` compile the default. `name` only labels errors.
 */
export function compileValue(
  spec: PaintPropertySpec,
  name: string,
  value: unknown,
): CompiledValue {
  const raw = value === undefined || value === null ? spec.default : value;
  const fallback = defaultVector(spec, name);
  if (spec.type === "enum") {
    if (typeof raw === "string") return uniform([enumIndex(spec, name, raw)]);
  } else if (spec.type === "color") {
    // Float arrays are this package's own shorthand for straight colors,
    // which spec.json defaults use; the host takes CSS strings.
    if (isNumberArray(raw, 4)) return uniform(premultiply(raw));
    if (typeof raw === "string") {
      const color = Color.parse(raw);
      if (!color) throw new Error(`Invalid color for ${name}: ${raw}`);
      return uniform(colorVector(color));
    }
  } else if (spec.type === "float2" || spec.type === "double2") {
    if (isNumberArray(raw, 2)) return uniform([raw[0]!, raw[1]!]);
  } else if (typeof raw === "number") {
    if (!Number.isFinite(raw)) throw new Error(`Invalid number for ${name}`);
    if (spec.type === "rotation") {
      // A rotation constant wraps in double (rotation.hpp) before the check.
      const wrapped = wrapRotation(raw);
      checkRange(spec, name, wrapped);
      return uniform([wrapped]);
    }
    // A float constant is stored as an f32 (conversion Converter<float>).
    checkRange(spec, name, f32(raw));
    return uniform([raw]);
  }

  const expressions = spec.expressions ?? "camera";
  const expression = parseExpression(spec, name, raw);
  switch (expression.kind) {
    case "constant":
      return foldedConstant(spec, name, expression, fallback);
    case "camera": {
      // A zoom expression needs CAMERA, which only NONE lacks.
      if (expressions === "constant") throw unsupported(name);
      const evaluate = evaluator(spec, expression, fallback);
      return { kind: "uniform", at: (zoom) => evaluate(zoom) };
    }
    default:
      // A property with no capabilities converts without data expressions
      // (plugin_property.cpp convertTyped, property_value.cpp).
      if (expressions === "constant") {
        throw new Error(
          `Invalid value for ${name}: data expressions not supported`,
        );
      }
      // plugin_property.cpp convertPluginPropertyValue: a feature (source)
      // expression needs FEATURE, a composite one COMPOSITE, and either
      // needs FEATURE_STATE when it reads feature-state. A data-driven
      // property declares all of them, less FEATURE_STATE when
      // `featureState` is false; a camera property none.
      if (expressions !== "data-driven") throw unsupported(name);
      if (expression.isStateDependent && spec.featureState === false)
        throw unsupported(name);
      return new ExpressionFeatureValue(spec, expression, fallback);
  }
}

/**
 * Compiles a raw paint value for a camera-only use: constants and zoom
 * expressions, or only constants for a "constant" property. Data
 * expressions throw, whatever the spec's `expressions` says. `name` only
 * labels errors.
 */
export function compile(
  spec: PaintPropertySpec,
  name: string,
  value: unknown,
): Compiled {
  const expressions = spec.expressions === "constant" ? "constant" : "camera";
  const compiled = compileValue(
    { ...spec, expressions } as PaintPropertySpec,
    name,
    value,
  ) as UniformValue;
  return (zoom) => compiled.at(zoom);
}
