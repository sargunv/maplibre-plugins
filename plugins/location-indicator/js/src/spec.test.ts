import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import shade from "./generated/puck.glsl.ts";
import { LAYER_TYPE, paintNames, paintSpec } from "./spec.ts";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface SharedSpec {
  layerType: string;
  paint: Record<
    string,
    { type: string; default: unknown; minimum?: number; maximum?: number }
  >;
}

const shared = JSON.parse(
  readFileSync(join(pluginRoot, "spec.json"), "utf8"),
) as SharedSpec;

describe("shared spec", () => {
  it("declares the same layer type", () => {
    expect(LAYER_TYPE).toBe(shared.layerType);
  });

  it("declares the same properties in the same order", () => {
    expect(paintNames).toEqual(Object.keys(shared.paint));
  });

  it("declares the same types, defaults and bounds", () => {
    const mirrored = Object.fromEntries(
      Object.entries(paintSpec).map(([name, spec]) => [
        name,
        JSON.parse(JSON.stringify(spec)),
      ]),
    );
    const expected = Object.fromEntries(
      Object.entries(shared.paint).map(
        ([name, { type, default: def, minimum, maximum }]) => [
          name,
          {
            type,
            default: def,
            ...(minimum !== undefined && { minimum }),
            ...(maximum !== undefined && { maximum }),
          },
        ],
      ),
    );
    expect(mirrored).toEqual(expected);
  });
});

describe("shared shader", () => {
  it("is generated from shaders/puck.glsl", () => {
    expect(shade).toBe(
      readFileSync(join(pluginRoot, "shaders", "puck.glsl"), "utf8"),
    );
  });
});
