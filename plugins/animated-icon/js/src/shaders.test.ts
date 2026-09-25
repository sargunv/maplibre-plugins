import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { Catalog } from "./catalog.ts";
import demoCatalog from "./generated/catalog.ts";
import {
  ATTRIBUTE_SLOTS,
  CATALOG_BINDING,
  DRAWABLE_BINDING,
  DRAWABLE_OFFSETS,
  DRAWABLE_UBO_BYTES,
  fragmentSource,
  interpolationOffset,
  PROPERTY_OFFSETS,
  SECTIONS,
  type SectionName,
  uniformDefines,
  vertexSource,
} from "./shaders.ts";
import { paintNames } from "./spec.ts";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pinned = readFileSync(
  join(pluginRoot, "fixtures", "shaders", "sections.glsl"),
  "utf8",
);
const catalog = Catalog.fromBase64(demoCatalog);
const defines = catalog.shaderDefines();

/** The text between a section's markers, markers included. */
function findSection(text: string, name: string): string | null {
  const begin = text.indexOf(`// begin:${name}\n`);
  const endMarker = `// end:${name}\n`;
  const end = text.indexOf(endMarker, begin);
  if (begin < 0 || end < 0) return null;
  return text.slice(begin, end + endMarker.length);
}

const vertexSections: SectionName[] = [
  "attributes",
  "drawable-ubo",
  "catalog-ubo",
  "varyings-out",
  "vertex-main",
];
const fragmentSections: SectionName[] = ["varyings-in", "fragment-main"];

describe("shared sections", () => {
  it("equal fixtures/shaders/sections.glsl, which plugin.zig generates", () => {
    const names = [...pinned.matchAll(/^\/\/ begin:(.+)$/gm)].map((m) => m[1]);
    expect(names).toEqual(Object.keys(SECTIONS));
    for (const name of names) {
      expect(SECTIONS[name as SectionName], name).toBe(
        findSection(pinned, name!),
      );
    }
  });

  it("appear verbatim in the WebGL2 sources of every layout", () => {
    for (const key of ["111111111111", "000000111000", "010101010101"]) {
      const vertex = vertexSource("// prelude", "", key, defines);
      const fragment = fragmentSource(defines);
      for (const name of vertexSections) {
        expect(findSection(vertex, name), name).toBe(findSection(pinned, name));
        expect(findSection(fragment, name)).toBeNull();
      }
      for (const name of fragmentSections) {
        expect(findSection(fragment, name), name).toBe(
          findSection(pinned, name),
        );
        expect(findSection(vertex, name)).toBeNull();
      }
    }
  });
});

describe("vertex source", () => {
  it("puts the prelude, the layout's defines and the catalog's defines before the shared code", () => {
    const source = vertexSource(
      "// prelude",
      "#define GLOBE",
      "101111111100",
      defines,
    );
    expect(
      source.startsWith("#version 300 es\n// prelude\n#define GLOBE\n"),
    ).toBe(true);
    const at = (text: string) => {
      const index = source.indexOf(text);
      expect(index, text).toBeGreaterThanOrEqual(0);
      return index;
    };
    expect(
      at("#define MLN_PLUGIN_PROPERTY_ICON_SIZE_IS_UNIFORM 0\n"),
    ).toBeGreaterThan(at("#define GLOBE"));
    expect(
      at("#define MLN_PLUGIN_PROPERTY_ICON_ANIMATION_IS_UNIFORM 1\n"),
    ).toBeLessThan(at(defines));
    expect(
      at("#define MLN_PLUGIN_PROPERTY_ICON_ANIMATION_MODE_IS_UNIFORM 0\n"),
    ).toBeLessThan(at(defines));
    expect(at("// begin:attributes")).toBeGreaterThan(at(defines));
    expect(at("#define PROJECT(p) projectTile(p)")).toBeGreaterThan(
      at("// end:varyings-out"),
    );
    expect(at("#define ICON_ANIMATION (u.icon_animation)")).toBeGreaterThan(
      at("#define ICON_ATTR(name) name"),
    );
    expect(at("IconVertex iconPlace(")).toBeGreaterThan(
      at("#define ICON_ANIMATION_MODE"),
    );
    expect(at("// begin:vertex-main")).toBeGreaterThan(
      at("IconVertex iconPlace("),
    );
  });

  it("defines each property's IS_UNIFORM macro from the layout key", () => {
    expect(uniformDefines("100000000000").split("\n").slice(0, 2)).toEqual([
      "#define MLN_PLUGIN_PROPERTY_ICON_ANIMATION_IS_UNIFORM 1",
      "#define MLN_PLUGIN_PROPERTY_ICON_SIZE_IS_UNIFORM 0",
    ]);
    expect(() => uniformDefines("1")).toThrow(/layout key/);
  });
});

describe("fragment source", () => {
  it("declares the output, a highp sampler and the texture fetch", () => {
    const source = fragmentSource(defines);
    expect(source.startsWith(`#version 300 es\n${defines}`)).toBe(true);
    expect(source).toContain("precision highp float;\nprecision highp int;\n");
    expect(source).toContain("out highp vec4 fragColor;");
    expect(source).toContain("uniform highp sampler2D u_art;");
    expect(source).toContain("#define FETCH(i) texelFetch(u_art,");
    expect(source).toContain("float4 iconShade(");
    // The Slug license notice travels with the shader.
    expect(source).toContain("Copyright 2017, by Eric Lengyel.");
    expect(source).not.toContain("IconCatalogUBO");
  });
});

describe("block and attribute layout", () => {
  it("binds above maplibre-gl-js's own blocks", () => {
    // maplibre-gl-js binds its uniform blocks at 0 to 2.
    expect([CATALOG_BINDING, DRAWABLE_BINDING]).toEqual([3, 4]);
  });

  it("matches IconDrawableUBO's std140 offsets", () => {
    const block = SECTIONS["drawable-ubo"];
    for (const name of paintNames) {
      const field = name.replaceAll("-", "_");
      const line = block.split("\n").find((l) => l.includes(` ${field};`));
      expect(line, name).toMatch(
        new RegExp(`// +${PROPERTY_OFFSETS[name]}\\b`),
      );
      const i = paintNames.indexOf(name);
      expect(interpolationOffset(name)).toBe(160 + 4 * i);
    }
    expect(DRAWABLE_OFFSETS).toEqual({
      matrix: 0,
      camera: 64,
      view: 80,
      interpolation: 160,
    });
    expect(DRAWABLE_UBO_BYTES).toBe(208);
  });

  it("gives each property the native attribute IDs, 14 of 16", () => {
    const slots = paintNames.flatMap((name) => ATTRIBUTE_SLOTS[name]);
    expect(slots.map((s) => s.location)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
    expect(ATTRIBUTE_SLOTS["icon-color"]).toEqual([
      { name: "a_icon_color_min", location: 5, size: 4, offset: 0 },
      { name: "a_icon_color_max", location: 6, size: 4, offset: 4 },
    ]);
    expect(ATTRIBUTE_SLOTS["icon-offset"]).toEqual([
      { name: "a_icon_offset", location: 7, size: 4, offset: 0 },
    ]);
    expect(ATTRIBUTE_SLOTS["icon-animation-mode"]).toEqual([
      { name: "a_icon_animation_mode", location: 13, size: 2, offset: 0 },
    ]);
  });
});
