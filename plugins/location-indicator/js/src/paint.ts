// Paint property evaluation and transitions. Values compile through the
// MapLibre style spec so camera expressions and CSS colors work like they do
// for built-in layers, and every change transitions the way MapLibre Native
// transitions plugin paint properties: 300 ms, ease (0, 0, 0.25, 1), with a
// still-running prior transition evaluated recursively.

import {
  Color,
  createPropertyExpression,
  type StylePropertySpecification,
} from "@maplibre/maplibre-gl-style-spec";

import { type PaintName, type PaintType, paintSpec } from "./spec.ts";

/** A property's numeric vector: [n] for floats, [lat, lon], or premultiplied [r, g, b, a]. */
export type Vector = readonly number[];

/** Evaluates a compiled paint value at a zoom level. */
export type Compiled = (zoom: number) => Vector;

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

const zoomExpression = {
  interpolated: true,
  parameters: ["zoom"],
} as const;

function propertySpecification(type: PaintType): StylePropertySpecification {
  switch (type) {
    case "color":
      return {
        type: "color",
        default: "black",
        "property-type": "data-constant",
        expression: zoomExpression,
        transition: true,
      } as unknown as StylePropertySpecification;
    case "double2":
      return {
        type: "array",
        value: "number",
        length: 2,
        "property-type": "data-constant",
        expression: zoomExpression,
        transition: true,
      } as unknown as StylePropertySpecification;
    default:
      return {
        type: "number",
        default: 0,
        "property-type": "data-constant",
        expression: zoomExpression,
        transition: true,
      } as unknown as StylePropertySpecification;
  }
}

function isNumberArray(value: unknown, length: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((v) => typeof v === "number" && Number.isFinite(v))
  );
}

/** Premultiplies a straight-alpha [r, g, b, a] in 0..1. */
export function premultiply(rgba: readonly number[]): Vector {
  const [r = 0, g = 0, b = 0, a = 1] = rgba;
  return [r * a, g * a, b * a, a];
}

function colorVector(color: Color): Vector {
  // Style-spec colors are premultiplied, which the custom layer blend expects.
  return [color.r, color.g, color.b, color.a];
}

function constant(vector: Vector): Compiled {
  return () => vector;
}

/**
 * Compiles a raw paint value (a literal, a CSS color, or a style expression)
 * for one property. Throws on values the style spec rejects.
 */
export function compile(name: PaintName, value: unknown): Compiled {
  const { type } = paintSpec[name];
  if (type === "color") {
    if (isNumberArray(value, 4)) return constant(premultiply(value));
    if (typeof value === "string") {
      const color = Color.parse(value);
      if (!color) throw new Error(`Invalid color for ${name}: ${value}`);
      return constant(colorVector(color));
    }
  } else if (type === "double2") {
    if (isNumberArray(value, 2)) return constant([value[0]!, value[1]!]);
  } else if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Invalid number for ${name}`);
    return constant([value]);
  }
  const result = createPropertyExpression(
    value,
    `paint.${name}`,
    propertySpecification(type),
  );
  if (result.result === "error") {
    const messages = result.value.map((e) => e.message).join("; ");
    throw new Error(`Invalid value for ${name}: ${messages}`);
  }
  const expression = result.value;
  return (zoom) => {
    const evaluated: unknown = expression.evaluate({ zoom });
    if (type === "color") {
      if (!(evaluated instanceof Color))
        return premultiply(paintSpec[name].default as readonly number[]);
      return colorVector(evaluated);
    }
    if (type === "double2") {
      return isNumberArray(evaluated, 2)
        ? [evaluated[0]!, evaluated[1]!]
        : [0, 0];
    }
    return [typeof evaluated === "number" ? evaluated : 0];
  };
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
  if (type === "rotation") {
    const target = shortestArc(from[0] ?? 0, to[0] ?? 0);
    return [(from[0] ?? 0) + (target - (from[0] ?? 0)) * t];
  }
  return to.map((end, i) => (from[i] ?? end) + (end - (from[i] ?? end)) * t);
}

class Transition {
  prior: Transition | null;

  constructor(
    readonly target: Compiled,
    prior: Transition | null,
    readonly begin: number,
    readonly end: number,
  ) {
    this.prior = prior;
  }

  active(now: number): boolean {
    return this.prior !== null && now < this.end;
  }

  /** Drops prior transitions that have finished so history cannot accumulate. */
  trim(now: number): void {
    if (now >= this.end) this.prior = null;
    else this.prior?.trim(now);
  }

  value(type: PaintType, zoom: number, now: number): Vector {
    const end = this.target(zoom);
    if (this.prior === null) return end;
    if (now >= this.end) {
      this.prior = null;
      return end;
    }
    const from = this.prior.value(type, zoom, now);
    if (now <= this.begin) return from;
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
  private readonly type: PaintType;
  private transition: Transition;

  constructor(
    readonly name: PaintName,
    initial: Compiled,
  ) {
    this.type = paintSpec[name].type;
    this.transition = new Transition(initial, null, 0, 0);
  }

  value(zoom: number, now: number): Vector {
    return this.transition.value(this.type, zoom, now);
  }

  active(now: number): boolean {
    return this.transition.active(now);
  }

  retarget(
    next: Compiled,
    now: number,
    options: Required<TransitionOptions>,
  ): void {
    this.transition.trim(now);
    const begin = now + options.delay;
    const end = begin + Math.max(options.duration, 0);
    if (end <= now) {
      this.transition = new Transition(next, null, begin, end);
      return;
    }
    this.transition = new Transition(next, this.transition, begin, end);
  }

  /** Jumps to the current target immediately. */
  finish(): void {
    this.transition = new Transition(this.transition.target, null, 0, 0);
  }
}

export type EvaluatedPaint = Readonly<Record<PaintName, Vector>>;
