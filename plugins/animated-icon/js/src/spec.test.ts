import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { supportsTransitions } from "@maplibre-plugins/paint";
import { describe, expect, it } from "vite-plus/test";

import { Catalog } from "./catalog.ts";
import demoCatalog from "./generated/catalog.ts";
import { LAYER_TYPE, paintNames, paintSpec, paintSpecFor } from "./spec.ts";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface SharedSpec {
  layerType: string;
  geometry: string;
  catalog: string;
  paint: Record<
    string,
    {
      type: string;
      default: unknown;
      values?: unknown;
      minimum?: number;
      maximum?: number;
      expressions?: string;
      transition?: boolean;
    }
  >;
}

const shared = JSON.parse(
  readFileSync(join(pluginRoot, "spec.json"), "utf8"),
) as SharedSpec;

describe("shared spec", () => {
  it("declares the same layer type and geometry", () => {
    expect(LAYER_TYPE).toBe(shared.layerType);
    expect(shared.geometry).toBe("point");
  });

  it("declares the same properties in the same order", () => {
    expect(paintNames).toEqual(Object.keys(shared.paint));
    expect(paintNames).toHaveLength(12);
  });

  it("declares the same types, defaults, values, bounds, expressions and transitions", () => {
    const mirrored = Object.fromEntries(
      Object.entries(paintSpec).map(([name, spec]) => [
        name,
        JSON.parse(JSON.stringify(spec)),
      ]),
    );
    const expected = Object.fromEntries(
      Object.entries(shared.paint).map(
        ([
          name,
          {
            type,
            default: def,
            values,
            minimum,
            maximum,
            expressions,
            transition,
          },
        ]) => [
          name,
          {
            type,
            default: def,
            ...(values !== undefined && { values }),
            ...(minimum !== undefined && { minimum }),
            ...(maximum !== undefined && { maximum }),
            ...(expressions !== undefined && { expressions }),
            ...(transition !== undefined && { transition }),
          },
        ],
      ),
    );
    expect(mirrored).toEqual(expected);
  });

  it("takes a -transition key exactly where the native descriptors do", () => {
    // spec.json: absent means true for numbers and false for enums, and an
    // enum never says true.
    for (const name of paintNames) {
      const declared = shared.paint[name]!;
      const expected = declared.transition ?? declared.type !== "enum";
      expect(supportsTransitions(paintSpecFor(catalog)[name])).toBe(expected);
      if (declared.type === "enum") expect(declared.transition).not.toBe(true);
    }
  });

  it("makes every property data-driven except the two alignments", () => {
    const camera = paintNames.filter(
      (name) => paintSpec[name].expressions !== "data-driven",
    );
    expect(camera).toEqual(["icon-rotation-alignment", "icon-pitch-alignment"]);
  });
});

const catalog = Catalog.fromBase64(demoCatalog);

describe("catalog enum", () => {
  it("lists none, then the generated demo catalog's animations", () => {
    const names = catalog.animations.map((animation) => animation.name);
    expect(names).toEqual(expect.arrayContaining(["pulse", "pin"]));
    const resolved = paintSpecFor(catalog)["icon-animation"];
    expect(resolved.values).toEqual(["none", ...names]);
    expect(resolved.values.indexOf(resolved.default)).toBe(0);
    expect(resolved.expressions).toBe("data-driven");
  });

  it("matches the catalog file that spec.json names", () => {
    const file = Catalog.parse(
      readFileSync(join(pluginRoot, shared.catalog)),
    ).enumValues();
    expect(paintSpecFor(catalog)["icon-animation"].values).toEqual(file);
  });

  it("leaves every other property as declared", () => {
    const resolved = paintSpecFor(catalog);
    for (const name of paintNames) {
      if (name !== "icon-animation")
        expect(resolved[name]).toBe(paintSpec[name]);
    }
    expect(paintSpec["icon-animation"].values).toBe("catalog");
  });
});
