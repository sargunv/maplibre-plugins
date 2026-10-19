import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import {
  type BuildingPropertySpec,
  LAYER_TYPE,
  layoutNames,
  layoutSpec,
  paintNames,
  paintSpec,
} from "./spec.ts";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface SharedProperty extends BuildingPropertySpec {
  doc: string;
}

interface SharedSpec {
  id: string;
  layerType: string;
  geometry: string;
  layout: Record<string, SharedProperty>;
  paint: Record<string, SharedProperty>;
}

const shared = JSON.parse(
  readFileSync(join(pluginRoot, "spec.json"), "utf8"),
) as SharedSpec;

/** A property without its doc, as plain JSON. */
function contract(spec: BuildingPropertySpec): unknown {
  const { doc: _doc, ...rest } = spec as SharedProperty;
  return JSON.parse(JSON.stringify(rest));
}

function mirrored(
  table: Record<string, BuildingPropertySpec>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(table).map(([name, spec]) => [name, contract(spec)]),
  );
}

describe("shared spec", () => {
  it("declares the same layer type and geometry", () => {
    expect(shared.id).toBe("building");
    expect(LAYER_TYPE).toBe(shared.layerType);
    expect(shared.geometry).toBe("polygon");
  });

  it("declares the same properties in the same order", () => {
    expect(layoutNames).toEqual(Object.keys(shared.layout));
    expect(paintNames).toEqual(Object.keys(shared.paint));
  });

  it("declares the same contract for every property", () => {
    expect(mirrored(layoutSpec)).toEqual(mirrored(shared.layout));
    expect(mirrored(paintSpec)).toEqual(mirrored(shared.paint));
  });

  it("documents every property", () => {
    for (const table of [shared.layout, shared.paint]) {
      for (const [name, spec] of Object.entries(table)) {
        expect(spec.doc, name).toMatch(/\S/);
      }
    }
  });

  it("keeps layout properties out of transitions and feature-state", () => {
    for (const spec of Object.values(shared.layout)) {
      expect(spec.expressions).toBe("data-driven");
      expect(spec.featureState).toBe(false);
      expect(spec.transition).toBe(false);
    }
  });

  it("puts every default inside its bounds and values", () => {
    for (const table of [shared.layout, shared.paint]) {
      for (const [name, spec] of Object.entries(table)) {
        if (spec.type === "enum") {
          expect(spec.values, name).toContain(spec.default);
        }
        if (typeof spec.default === "number") {
          if (spec.minimum !== undefined)
            expect(spec.default, name).toBeGreaterThanOrEqual(spec.minimum);
          if (spec.maximum !== undefined)
            expect(spec.default, name).toBeLessThanOrEqual(spec.maximum);
        }
      }
    }
  });
});
