// The typed mirror of ../../spec.json. spec.test.ts fails when the two drift.
// icon-animation's values are "catalog" there: "none" followed by the
// catalog's animation names, which paintSpecFor fills in from a catalog.

import type {
  EnumPaintPropertySpec,
  ExpressionSupport,
  PaintPropertySpec,
} from "@maplibre-plugins/paint";

import type { Catalog } from "./catalog.ts";

export const LAYER_TYPE = "animated-icon";

/** Tile-local coordinate range the layout works in, matching MapLibre Native. */
export const EXTENT = 8192;

/** An enum whose values come from the registered catalog. */
interface CatalogEnumSpec {
  readonly type: "enum";
  readonly values: "catalog";
  readonly default: string;
  readonly expressions?: ExpressionSupport;
}

const alignments = ["auto", "map", "viewport"] as const;

export const paintSpec = {
  "icon-animation": {
    type: "enum",
    values: "catalog",
    default: "none",
    expressions: "data-driven",
  },
  "icon-size": {
    type: "float",
    default: 1,
    minimum: 0,
    expressions: "data-driven",
  },
  "icon-rotate": { type: "rotation", default: 0, expressions: "data-driven" },
  "icon-opacity": {
    type: "float",
    default: 1,
    minimum: 0,
    maximum: 1,
    expressions: "data-driven",
  },
  "icon-color": {
    type: "color",
    default: [0, 0, 0, 0],
    expressions: "data-driven",
  },
  "icon-offset": {
    type: "float2",
    default: [0, 0],
    expressions: "data-driven",
  },
  "icon-anchor": {
    type: "enum",
    values: [
      "center",
      "left",
      "right",
      "top",
      "bottom",
      "top-left",
      "top-right",
      "bottom-left",
      "bottom-right",
    ],
    default: "center",
    expressions: "data-driven",
  },
  "icon-rotation-alignment": {
    type: "enum",
    values: alignments,
    default: "auto",
    expressions: "camera",
  },
  "icon-pitch-alignment": {
    type: "enum",
    values: alignments,
    default: "auto",
    expressions: "camera",
  },
  "icon-animation-speed": {
    type: "float",
    default: 1,
    minimum: -4,
    maximum: 4,
    expressions: "data-driven",
    // Unlike other numbers it says so explicitly: a style can then opt out
    // of the playhead sweep a constant change causes, with duration 0.
    transition: true,
  },
  "icon-animation-offset": {
    type: "float",
    default: 0,
    expressions: "data-driven",
  },
  "icon-animation-mode": {
    type: "enum",
    values: ["loop", "alternate", "once"],
    default: "loop",
    expressions: "data-driven",
  },
} as const satisfies Record<string, PaintPropertySpec | CatalogEnumSpec>;

export type PaintName = keyof typeof paintSpec;

export const paintNames = Object.keys(paintSpec) as PaintName[];

export function isPaintName(name: string): name is PaintName {
  return Object.hasOwn(paintSpec, name);
}

/** The paint spec with icon-animation's values resolved against a catalog. */
export type ResolvedPaintSpec = {
  readonly [Name in PaintName]: Name extends "icon-animation"
    ? EnumPaintPropertySpec
    : (typeof paintSpec)[Name];
};

/**
 * Resolves icon-animation's values to "none" and then the catalog's
 * animation names, in catalog order, so each name's index is its enum value.
 */
export function paintSpecFor(catalog: Catalog): ResolvedPaintSpec {
  return {
    ...paintSpec,
    "icon-animation": {
      ...paintSpec["icon-animation"],
      values: catalog.enumValues(),
    },
  };
}
