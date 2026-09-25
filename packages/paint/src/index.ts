// Paint property evaluation and transitions for the plugin layers. Values
// compile through the MapLibre style spec so expressions and CSS colors work
// like they do for built-in layers, and are checked the way MapLibre Native
// checks plugin paint properties (value.ts). Every change transitions the way
// MapLibre Native transitions plugin paint properties: 300 ms, ease
// (0, 0, 0.25, 1), with a still-running prior transition evaluated
// recursively, while a data-driven target snaps and a data-driven prior holds
// until the transition ends. Enum properties evaluate to the index of their
// value, as the host's ENUM_FLOAT encoding hands them to shaders, and never
// interpolate. Data-driven values become per-vertex attributes through
// binder.ts.

import { type Current } from "./binder.ts";
import {
  type Compiled,
  type CompiledValue,
  compileValue,
  isFeatureValue,
  type PaintPropertySpec,
  type PaintType,
  supportsTransitions,
  type Vector,
} from "./value.ts";

export {
  type AttributeLayout,
  attributeLayout,
  type Current,
  type FeatureSource,
  fillAttributes,
  type FillOptions,
  type VertexRange,
} from "./binder.ts";
export {
  type Compiled,
  compile,
  type CompiledValue,
  compileValue,
  componentCount,
  type EnumPaintPropertySpec,
  type EvaluationFeature,
  type ExpressionSupport,
  type FeatureState,
  type FeatureValue,
  isFeatureValue,
  type NumericPaintPropertySpec,
  type PaintPropertySpec,
  type PaintType,
  premultiply,
  supportsTransitions,
  type UniformValue,
  type Vector,
  wrapRotation,
} from "./value.ts";

export interface TransitionOptions {
  /** Milliseconds. Defaults to 300, like the style spec. */
  duration?: number;
  /** Milliseconds. Defaults to 0. */
  delay?: number;
}

export const DEFAULT_TRANSITION: Required<TransitionOptions> = {
  duration: 300,
  delay: 0,
};

/** MapLibre's default transition easing, `cubic-bezier(0, 0, 0.25, 1)`. */
export function ease(t: number): number {
  return unitBezier(0, 0, 0.25, 1, t);
}

function unitBezier(
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
  x: number,
): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const cx = 3 * p1x;
  const bx = 3 * (p2x - p1x) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * p1y;
  const by = 3 * (p2y - p1y) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const derivativeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  let t = x;
  for (let i = 0; i < 8; i++) {
    const error = sampleX(t) - x;
    if (Math.abs(error) < 1e-6) return sampleY(t);
    const d = derivativeX(t);
    if (Math.abs(d) < 1e-6) break;
    t -= error / d;
  }
  let lo = 0;
  let hi = 1;
  t = x;
  while (lo < hi) {
    const error = sampleX(t) - x;
    if (Math.abs(error) < 1e-6) break;
    if (error > 0) hi = t;
    else lo = t;
    t = (lo + hi) / 2;
  }
  return sampleY(t);
}

function shortestArc(from: number, to: number): number {
  const delta = ((((to - from) % 360) + 540) % 360) - 180;
  return from + delta;
}

function interpolate(
  type: PaintType,
  from: Vector,
  to: Vector,
  t: number,
): Vector {
  // MapLibre Native transitions every plugin property with the style's
  // transition, and a string one is uninterpolated: it keeps the prior value
  // until the transition ends, then snaps.
  if (type === "enum") return from;
  if (type === "rotation") {
    // The shorter way round, like the host's Interpolator<Rotation>. The
    // host also wraps the result to [0, 360) and this does not; a shader's
    // trigonometry gives the same result either way.
    const target = shortestArc(from[0] ?? 0, to[0] ?? 0);
    return [(from[0] ?? 0) + (target - (from[0] ?? 0)) * t];
  }
  return to.map((end, i) => (from[i] ?? end) + (end - (from[i] ?? end)) * t);
}

function uniformValue(value: Compiled | CompiledValue): CompiledValue {
  return typeof value === "function" ? { kind: "uniform", at: value } : value;
}

/**
 * One step of a property's transition history, like the host's
 * Transitioning (style/properties.hpp).
 */
class Transition {
  prior: Transition | null;
  readonly target: CompiledValue;
  readonly begin: number;
  readonly end: number;

  constructor(
    target: CompiledValue,
    prior: Transition | null,
    begin: number,
    end: number,
  ) {
    this.target = target;
    this.prior = prior;
    this.begin = begin;
    this.end = end;
  }

  active(now: number): boolean {
    return (
      this.prior !== null && now < this.end && this.target.kind !== "feature"
    );
  }

  /** Drops prior transitions that have finished so history cannot accumulate. */
  trim(now: number): void {
    if (now >= this.end) this.prior = null;
    else this.prior?.trim(now);
  }

  /**
   * A data-driven target snaps and drops the prior, since layout needs the
   * expression right away; a uniform target interpolates from a uniform
   * prior, and holds a data-driven prior until the transition ends
   * (possibly_evaluated_property_value.hpp Interpolator).
   */
  current(type: PaintType, zoom: number, now: number): Current {
    const target = this.target;
    if (target.kind === "feature") {
      this.prior = null;
      return target;
    }
    const end = target.at(zoom);
    if (this.prior === null) return end;
    if (now >= this.end) {
      this.prior = null;
      return end;
    }
    const from = this.prior.current(type, zoom, now);
    if (now <= this.begin || isFeatureValue(from)) return from;
    return interpolate(
      type,
      from,
      end,
      ease((now - this.begin) / (this.end - this.begin)),
    );
  }
}

/** One paint property's current value, transitioning from earlier values. */
export class PaintValue {
  private transition: Transition;

  constructor(
    readonly name: string,
    private readonly type: PaintType,
    initial: Compiled | CompiledValue,
  ) {
    this.transition = new Transition(uniformValue(initial), null, 0, 0);
  }

  /** The current vector; a data-driven value evaluates without a feature. */
  value(zoom: number, now: number): Vector {
    const current = this.current(zoom, now);
    return isFeatureValue(current) ? current.withoutFeature(zoom) : current;
  }

  /** The current vector, or the data-driven value itself. */
  current(zoom: number, now: number): Current {
    return this.transition.current(this.type, zoom, now);
  }

  active(now: number): boolean {
    return this.transition.active(now);
  }

  retarget(
    next: Compiled | CompiledValue,
    now: number,
    options: Required<TransitionOptions>,
  ): void {
    this.transition.trim(now);
    const begin = now + options.delay;
    const end = begin + Math.max(options.duration, 0);
    const target = uniformValue(next);
    if (end <= now) {
      this.transition = new Transition(target, null, begin, end);
      return;
    }
    this.transition = new Transition(target, this.transition, begin, end);
  }

  /** Jumps to the current target immediately. */
  finish(): void {
    this.transition = new Transition(this.transition.target, null, 0, 0);
  }
}

/**
 * The paint properties of one layer: raw inputs, compiled values and their
 * transitions, keyed by property name. Layers wrap this with their typed
 * property names.
 */
export class PaintState<Name extends string> {
  private readonly values = new Map<Name, PaintValue>();
  private readonly raw = new Map<Name, unknown>();
  private readonly transitions = new Map<Name, TransitionOptions>();
  private readonly bound = new Map<Name, CompiledValue>();
  private generationCount = 0;

  constructor(
    private readonly spec: Readonly<Record<Name, PaintPropertySpec>>,
    private readonly names: readonly Name[],
    private readonly defaultTransition: Required<TransitionOptions>,
    paint: Partial<Record<string, unknown>>,
  ) {
    for (const name of names) {
      const value = paint[name] ?? spec[name].default;
      this.raw.set(name, value);
      this.values.set(
        name,
        new PaintValue(
          name,
          spec[name].type,
          compileValue(spec[name], name, value),
        ),
      );
      // Like MapLibre Native, the `-transition` key of a property without
      // transitions is an error whatever its value, as it is for set().
      const transition = paint[`${name}-transition`];
      if (transition !== undefined) {
        if (!supportsTransitions(spec[name]))
          throw new Error(`Paint property ${name} takes no transition`);
        if (transition)
          this.transitions.set(name, transition as TransitionOptions);
      }
    }
  }

  isName(name: string): name is Name {
    return Object.hasOwn(this.spec, name);
  }

  get(name: Name): unknown {
    return this.raw.get(name);
  }

  /**
   * Counts changes in which values are data-driven: it bumps whenever a
   * property's current value becomes, stops being or changes to another
   * FeatureValue, as observed by set(), current() and evaluate(). A layer
   * refills its vertex attributes when it changes.
   */
  get generation(): number {
    return this.generationCount;
  }

  /** The raw paint values plus `<name>-transition` entries, as style JSON. */
  toJson(): Record<string, unknown> {
    const paint: Record<string, unknown> = {};
    for (const name of this.names) paint[name] = this.raw.get(name);
    for (const [name, transition] of this.transitions)
      paint[`${name}-transition`] = transition;
    return paint;
  }

  /**
   * Sets a paint property or its `<name>-transition`, animating to the new
   * value like a native style transition (a data-driven value snaps).
   * Invalid values throw and leave the old value in place.
   */
  set(
    name: string,
    value: unknown,
    now: number,
    transition?: TransitionOptions,
  ): void {
    if (name.endsWith("-transition")) {
      const property = name.slice(0, -"-transition".length);
      if (!this.isName(property))
        throw new Error(`Unknown paint property ${property}`);
      if (!supportsTransitions(this.spec[property]))
        throw new Error(`Paint property ${property} takes no transition`);
      if (value === undefined || value === null)
        this.transitions.delete(property);
      else this.transitions.set(property, value as TransitionOptions);
      return;
    }
    if (!this.isName(name)) throw new Error(`Unknown paint property ${name}`);
    const raw =
      value === undefined || value === null ? this.spec[name].default : value;
    const compiled = compileValue(this.spec[name], name, raw);
    this.raw.set(name, raw);
    this.values.get(name)!.retarget(compiled, now, {
      ...this.defaultTransition,
      ...this.transitions.get(name),
      ...transition,
    });
    if (compiled.kind === "feature") this.observe(name, compiled);
  }

  /**
   * Every property's current value at a zoom and time: a transitioned
   * vector for uniform values, the FeatureValue itself for data-driven ones.
   */
  current(zoom: number, now: number): Record<Name, Current> {
    const paint: Partial<Record<Name, Current>> = {};
    for (const [name, value] of this.values) {
      const current = value.current(zoom, now);
      this.observe(name, current);
      paint[name] = current;
    }
    return paint as Record<Name, Current>;
  }

  /**
   * Every property's current vector at a zoom and time; a data-driven value
   * evaluates without a feature, as the host does for should_animate.
   */
  evaluate(zoom: number, now: number): Record<Name, Vector> {
    const paint: Partial<Record<Name, Vector>> = {};
    for (const [name, value] of this.values) {
      const current = value.current(zoom, now);
      this.observe(name, current);
      paint[name] = isFeatureValue(current)
        ? current.withoutFeature(zoom)
        : current;
    }
    return paint as Record<Name, Vector>;
  }

  /** Whether any transition is still running. */
  active(now: number): boolean {
    for (const value of this.values.values())
      if (value.active(now)) return true;
    return false;
  }

  private observe(name: Name, current: Current | CompiledValue): void {
    const feature = isFeatureValue(current) ? current : undefined;
    if (this.bound.get(name) === feature) return;
    if (feature) this.bound.set(name, feature);
    else this.bound.delete(name);
    this.generationCount++;
  }
}
