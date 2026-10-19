// The typed mirror of ../../spec.json. spec.test.ts fails when the two drift.
//
// The layout table holds the properties that shape the geometry, evaluated
// once per feature at tile layout; the paint table follows fill-extrusion.
// These tables use their own property type, which adds the doc-only `units`
// to @maplibre-plugins/paint's PaintPropertySpec; paint.ts hands both tables
// to that package (building-vertical-gradient is its boolean type).

import type { ExpressionSupport } from "@maplibre-plugins/paint";

export const LAYER_TYPE = "building";

/** Tile-local coordinate range the layout works in, matching MapLibre Native. */
export const EXTENT = 8192;

/** StreetComplete's roof:shape values, in its quest's order. */
export const ROOF_SHAPES = [
  "flat",
  "gabled",
  "hipped",
  "half-hipped",
  "pyramidal",
  "skillion",
  "gambrel",
  "round",
  "double_saltbox",
  "saltbox",
  "mansard",
  "dome",
  "quadruple_saltbox",
  "round_gabled",
  "onion",
  "cone",
  "many",
  "complex",
] as const;

export type RoofShape = (typeof ROOF_SHAPES)[number];

export const ROOF_ORIENTATIONS = ["along", "across"] as const;

export type RoofOrientation = (typeof ROOF_ORIENTATIONS)[number];

/** A property in either table of spec.json. */
export interface BuildingPropertySpec {
  readonly type: "float" | "float2" | "color" | "enum" | "boolean" | "string";
  readonly default: number | boolean | string | readonly number[];
  readonly values?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly units?: string;
  /** Defaults to "camera". */
  readonly expressions?: ExpressionSupport;
  /** Whether a data-driven value may read feature-state. Defaults to true. */
  readonly featureState?: boolean;
  /**
   * Whether a `<name>-transition` key is accepted. Defaults to true for
   * floats, pairs and colors and to false for enums and booleans.
   */
  readonly transition?: boolean;
}

const layoutOnly = {
  expressions: "data-driven",
  featureState: false,
  transition: false,
} as const;

export const layoutSpec = {
  "building-roof-shape": {
    type: "enum",
    values: ROOF_SHAPES,
    default: "flat",
    ...layoutOnly,
  },
  "building-roof-orientation": {
    type: "enum",
    values: ROOF_ORIENTATIONS,
    default: "along",
    ...layoutOnly,
  },
  "building-roof-direction": {
    type: "float",
    default: -1,
    minimum: -1,
    maximum: 360,
    units: "degrees",
    ...layoutOnly,
  },
  "building-roof-lines": { type: "string", default: "", ...layoutOnly },
} as const satisfies Record<string, BuildingPropertySpec>;

export const paintSpec = {
  "building-height": {
    type: "float",
    default: 0,
    minimum: 0,
    units: "meters",
    expressions: "data-driven",
  },
  "building-base": {
    type: "float",
    default: 0,
    minimum: 0,
    units: "meters",
    expressions: "data-driven",
  },
  "building-roof-height": {
    type: "float",
    default: 3,
    minimum: 0,
    units: "meters",
    expressions: "data-driven",
  },
  "building-roof-angle": {
    type: "float",
    default: 0,
    minimum: 0,
    maximum: 89,
    units: "degrees",
    expressions: "data-driven",
  },
  "building-color": {
    type: "color",
    default: [0, 0, 0, 1],
    expressions: "data-driven",
  },
  "building-roof-color": {
    type: "color",
    default: [0, 0, 0, 1],
    expressions: "data-driven",
  },
  "building-opacity": { type: "float", default: 1, minimum: 0, maximum: 1 },
  "building-translate": { type: "float2", default: [0, 0], units: "pixels" },
  "building-translate-anchor": {
    type: "enum",
    values: ["map", "viewport"],
    default: "map",
  },
  "building-vertical-gradient": { type: "boolean", default: true },
} as const satisfies Record<string, BuildingPropertySpec>;

export type LayoutName = keyof typeof layoutSpec;
export type PaintName = keyof typeof paintSpec;

export const layoutNames = Object.keys(layoutSpec) as LayoutName[];
export const paintNames = Object.keys(paintSpec) as PaintName[];

export function isLayoutName(name: string): name is LayoutName {
  return Object.hasOwn(layoutSpec, name);
}

export function isPaintName(name: string): name is PaintName {
  return Object.hasOwn(paintSpec, name);
}
