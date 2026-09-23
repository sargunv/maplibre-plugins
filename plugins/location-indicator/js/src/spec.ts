// The typed mirror of ../../spec.json. spec.test.ts fails when the two drift.

export const LAYER_TYPE = "location-puck";

export type PaintType = "double2" | "rotation" | "float" | "color";

export interface PaintPropertySpec {
  readonly type: PaintType;
  readonly default: number | readonly number[];
  readonly minimum?: number;
  readonly maximum?: number;
}

const blue = [0.17, 0.54, 0.94] as const;

export const paintSpec = {
  position: { type: "double2", default: [0, 0] },
  bearing: { type: "rotation", default: 0 },
  "perspective-compensation": {
    type: "float",
    default: 0.85,
    minimum: 0,
    maximum: 1,
  },
  "tilt-displacement": { type: "float", default: 0, minimum: 0 },
  "bearing-radius": { type: "float", default: 18, minimum: 0 },
  "bearing-visible": { type: "float", default: 0, minimum: 0, maximum: 1 },
  "accuracy-radius": { type: "float", default: 0, minimum: 0 },
  "accuracy-border-width": { type: "float", default: 0, minimum: 0 },
  "bearing-accuracy": { type: "float", default: 0, minimum: 0, maximum: 180 },
  "bearing-accuracy-radius": { type: "float", default: 64, minimum: 0 },
  "shadow-radius": { type: "float", default: 0, minimum: 0 },
  "puck-radius": { type: "float", default: 8, minimum: 0 },
  "puck-border-width": { type: "float", default: 2, minimum: 0 },
  "pulse-radius": { type: "float", default: 0, minimum: 0 },
  "pulse-period": { type: "float", default: 1.5, minimum: 0.1 },
  "puck-color": { type: "color", default: [...blue, 1] },
  "puck-border-color": { type: "color", default: [1, 1, 1, 1] },
  "accuracy-color": { type: "color", default: [...blue, 0.15] },
  "accuracy-border-color": { type: "color", default: [...blue, 0.4] },
  "bearing-accuracy-color": { type: "color", default: [...blue, 0.3] },
  "bearing-arrow-color": { type: "color", default: [1, 1, 1, 1] },
  "shadow-color": { type: "color", default: [0, 0, 0, 0.25] },
  "pulse-color": { type: "color", default: [...blue, 0.5] },
} as const satisfies Record<string, PaintPropertySpec>;

export type PaintName = keyof typeof paintSpec;

export const paintNames = Object.keys(paintSpec) as PaintName[];

export function isPaintName(name: string): name is PaintName {
  return Object.hasOwn(paintSpec, name);
}
