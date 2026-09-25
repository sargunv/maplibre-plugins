// The typed mirror of ../../spec.json. spec.test.ts fails when the two drift.
//
// One canonical paint table serves both layer types: each type lists the
// properties it takes, and a property both list has exactly one definition.
// Only the fields that change behavior are mirrored here; the gallery and the
// README read the doc-only ones (group, ui, units, doc, component names) from
// spec.json itself.

import type { PaintPropertySpec } from "@maplibre-plugins/paint";

export const EMITTER_TYPE = "particle-emitter";
export const FEATURES_TYPE = "particle-features";

/** Tile-local coordinate range the feature layout works in, matching MapLibre Native. */
export const EXTENT = 8192;

export const paintSpec = {
  "emitter-kind": {
    type: "enum",
    values: ["point", "circle", "weather"],
    default: "point",
    transition: false,
    expressions: "constant",
  },
  "emitter-position": { type: "double2", default: [0, 0] },
  "emitter-radius": { type: "float", default: 0, minimum: 0 },
  "emitter-height": { type: "float2", default: [0, 0] },
  "particle-space": {
    type: "enum",
    values: ["screen", "ground", "world"],
    default: "ground",
    transition: false,
    expressions: "constant",
  },
  "particle-scale": { type: "float", default: 1, minimum: 0 },
  "particle-count": { type: "float", default: 256, minimum: 0, maximum: 16384 },
  "particle-density": { type: "float", default: 8, minimum: 0, maximum: 100 },
  "particle-lifetime": {
    type: "float2",
    default: [1, 2],
    transition: false,
    expressions: "constant",
  },
  "particle-explosiveness": {
    type: "float",
    default: 0,
    minimum: 0,
    maximum: 1,
    transition: false,
    expressions: "constant",
  },
  "particle-burst-interval": {
    type: "float2",
    default: [0, 0],
    transition: false,
    expressions: "constant",
  },
  "particle-burst-groups": {
    type: "float",
    default: 1,
    minimum: 1,
    maximum: 16,
    transition: false,
    expressions: "constant",
  },
  "particle-seed": {
    type: "float",
    default: 0,
    minimum: 0,
    maximum: 65535,
    transition: false,
    expressions: "constant",
  },
  "particle-speed": { type: "float2", default: [20, 40] },
  "particle-direction": { type: "float2", default: [0, 90] },
  "particle-spread": { type: "float2", default: [15, 0] },
  "particle-gravity": { type: "float", default: 0 },
  "particle-drag": { type: "float", default: 0, minimum: 0, maximum: 50 },
  "particle-wind": { type: "float2", default: [0, 0] },
  "particle-wander": { type: "float2", default: [0, 0.5] },
  "particle-spin": { type: "float2", default: [0, 0] },
  "particle-shape": {
    type: "enum",
    values: [
      "circle",
      "glow",
      "star",
      "spark",
      "streak",
      "flake",
      "ring",
      "ripple",
      "smoke",
      "square",
    ],
    default: "glow",
    transition: false,
  },
  "particle-size": { type: "float2", default: [6, 10] },
  "particle-growth": { type: "float", default: 1, minimum: 0, maximum: 16 },
  "particle-size-clamp": { type: "float2", default: [0.5, 128] },
  "particle-stretch": { type: "float", default: 0, minimum: 0, maximum: 2 },
  "particle-color": { type: "color", default: [1, 0.9, 0.6, 1] },
  "particle-color-end": { type: "color", default: [0, 0, 0, 0] },
  "particle-color-variation": { type: "float2", default: [0, 0] },
  "particle-opacity": { type: "float", default: 1, minimum: 0, maximum: 1 },
  "particle-fade": { type: "float2", default: [0.1, 0.3] },
  "particle-additive": { type: "float2", default: [0, 0] },
  "particle-twinkle": { type: "float2", default: [0, 2] },
  "emitter-center-thinning": {
    type: "float",
    default: 0,
    minimum: 0,
    maximum: 1,
  },
  "emitter-screen-tint": { type: "color", default: [0, 0, 0, 0] },
  "emitter-vignette": { type: "float", default: 0, minimum: 0, maximum: 1 },
} as const satisfies Record<string, PaintPropertySpec>;

/** Every paint property of the plugin, in canonical order. */
export type PaintName = keyof typeof paintSpec;

export const paintNames = Object.keys(paintSpec) as PaintName[];

/** Properties that take a `<name>-transition` (transition is not false). */
export type TransitionName = {
  [K in PaintName]: (typeof paintSpec)[K] extends { readonly transition: false }
    ? never
    : K;
}[PaintName];

/** particle-emitter's properties, in its host definition order. */
export const emitterPaintNames = [
  "emitter-kind",
  "emitter-position",
  "emitter-radius",
  "emitter-height",
  "particle-space",
  "particle-scale",
  "particle-count",
  "particle-lifetime",
  "particle-explosiveness",
  "particle-burst-interval",
  "particle-burst-groups",
  "particle-seed",
  "particle-speed",
  "particle-direction",
  "particle-spread",
  "particle-gravity",
  "particle-drag",
  "particle-wind",
  "particle-wander",
  "particle-spin",
  "particle-shape",
  "particle-size",
  "particle-growth",
  "particle-size-clamp",
  "particle-stretch",
  "particle-color",
  "particle-color-end",
  "particle-color-variation",
  "particle-opacity",
  "particle-fade",
  "particle-additive",
  "particle-twinkle",
  "emitter-center-thinning",
  "emitter-screen-tint",
  "emitter-vignette",
] as const satisfies readonly PaintName[];

export type EmitterPaintName = (typeof emitterPaintNames)[number];

/** particle-features' properties, in its host definition order. */
export const featuresPaintNames = [
  "particle-density",
  "particle-lifetime",
  "particle-speed",
  "particle-direction",
  "particle-spread",
  "particle-gravity",
  "particle-wander",
  "particle-shape",
  "particle-size",
  "particle-stretch",
  "particle-color",
  "particle-fade",
  "particle-additive",
  "particle-twinkle",
] as const satisfies readonly PaintName[];

export type FeaturesPaintName = (typeof featuresPaintNames)[number];

/** The particle-features properties that also take feature expressions. */
export const featuresDataDriven = [
  "particle-density",
  "particle-shape",
  "particle-size",
  "particle-color",
] as const satisfies readonly FeaturesPaintName[];

/** Tile layout constants of particle-features, in tile units. */
export const featuresLayout = {
  /** Particle slots per point feature. */
  pointSlots: 16,
  /** Distance between a line's slots. */
  lineSlotSpacing: 32,
  /** Side of a polygon's lattice cell. */
  polygonCell: 128,
  /** Particles one tile's pool holds at most. */
  maxParticlesPerTile: 16383,
} as const;

export function isPaintName(name: string): name is PaintName {
  return Object.hasOwn(paintSpec, name);
}

export function isEmitterPaintName(name: string): name is EmitterPaintName {
  return (emitterPaintNames as readonly string[]).includes(name);
}

export function isFeaturesPaintName(name: string): name is FeaturesPaintName {
  return (featuresPaintNames as readonly string[]).includes(name);
}
