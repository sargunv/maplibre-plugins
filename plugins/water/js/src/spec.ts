// The typed mirror of ../../spec.json. spec.test.ts fails when the two drift.

import type { PaintPropertySpec } from "@maplibre-plugins/paint";

export const LAYER_TYPE = "water-shore";

/** Tile-local coordinate range the layout works in, matching MapLibre Native. */
export const EXTENT = 8192;

export const paintSpec = {
  "shore-width": { type: "float", default: 48, minimum: 0 },
  "shore-color": { type: "color", default: [0.62, 0.9, 0.96, 0.55] },
  "foam-color": { type: "color", default: [1, 1, 1, 0.92] },
  "wave-count": { type: "float", default: 3, minimum: 0, maximum: 12 },
  "wave-speed": { type: "float", default: 0.3, minimum: -3, maximum: 3 },
  "wave-wobble": { type: "float", default: 0.5, minimum: 0, maximum: 1 },
  "foam-length": { type: "float", default: 0.3, minimum: 0, maximum: 1 },
  "wash-strength": { type: "float", default: 0.8, minimum: 0, maximum: 1 },
  opacity: { type: "float", default: 1, minimum: 0, maximum: 1 },
} as const satisfies Record<string, PaintPropertySpec>;

export type PaintName = keyof typeof paintSpec;

export const paintNames = Object.keys(paintSpec) as PaintName[];

export function isPaintName(name: string): name is PaintName {
  return Object.hasOwn(paintSpec, name);
}
