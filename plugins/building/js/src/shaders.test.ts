import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import uniformsGlsl from "./generated/uniforms.glsl.ts";
import { FLOATS_PER_VERTEX, POS_OFFSET, ROOF_OFFSET } from "./layout.ts";
import {
  ATTRIBUTES,
  BINDINGS,
  BOUND_NAMES,
  DRAWABLE_BLOCK,
  DRAWABLE_OFFSETS,
  DRAWABLE_UBO_BYTES,
  fragmentSource,
  POS_LOCATION,
  ROOF_LOCATION,
  SHADER_ID,
  uniformDefines,
  VERTEX_STRIDE,
  vertexSource,
} from "./shaders.ts";
import { LAYER_TYPE, paintNames, paintSpec } from "./spec.ts";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Contract {
  layerType: string;
  shaderId: string;
  vertexStream: {
    stride: number;
    attributes: { name: string; byteOffset: number }[];
  };
  attributes: { id: number; name: string; type: string }[];
  uniformBlock: {
    name: string;
    byteSize: number;
    members: { name: string; type: string; offset: number }[];
  };
  bindings: {
    property: string;
    encoding: string;
    uniformOffset: number;
    minimumAttribute: number;
    maximumAttribute: number;
    interpolationOffset: number;
  }[];
  enabledPasses: { opacity: number; mask: number }[];
}

const contract = JSON.parse(
  readFileSync(join(pluginRoot, "fixtures", "render", "contract.json"), "utf8"),
) as Contract;

/** camelCase of a uniform member name, as DRAWABLE_OFFSETS keys it. */
function camel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

describe("the rendering contract", () => {
  it("names the layer type and shader", () => {
    expect(contract.layerType).toBe(LAYER_TYPE);
    expect(contract.shaderId).toBe(SHADER_ID);
  });

  it("has the layout's vertex stream", () => {
    expect(contract.vertexStream.stride).toBe(VERTEX_STRIDE);
    expect(VERTEX_STRIDE).toBe(FLOATS_PER_VERTEX * 4);
    expect(contract.vertexStream.attributes).toEqual([
      { name: "a_pos", byteOffset: POS_OFFSET },
      { name: "a_roof", byteOffset: ROOF_OFFSET },
    ]);
    expect(ATTRIBUTES[POS_LOCATION]!.name).toBe("a_pos");
    expect(ATTRIBUTES[ROOF_LOCATION]!.name).toBe("a_roof");
  });

  it("has the attribute table", () => {
    expect(ATTRIBUTES).toEqual(contract.attributes);
  });

  it("has the uniform block's size and member offsets", () => {
    expect(DRAWABLE_BLOCK).toBe(contract.uniformBlock.name);
    expect(DRAWABLE_UBO_BYTES).toBe(contract.uniformBlock.byteSize);
    expect(
      Object.fromEntries(
        contract.uniformBlock.members.map((m) => [camel(m.name), m.offset]),
      ),
    ).toEqual(DRAWABLE_OFFSETS);
  });

  it("agrees with uniforms.glsl's members and offset comments", () => {
    const members = [
      ...uniformsGlsl.matchAll(
        /^\s*(float4x4|float4|float)\s+(\w+);\s*\/\/\s*(\d+)/gm,
      ),
    ].map(([, type, name, offset]) => ({ name, type, offset: Number(offset) }));
    expect(members).toEqual(contract.uniformBlock.members);
  });

  it("binds every paint property but translate, in spec order", () => {
    expect(BOUND_NAMES).toEqual(
      paintNames.filter((name) => !name.startsWith("building-translate")),
    );
    expect(Object.values(BINDINGS)).toEqual(contract.bindings);
    for (const name of BOUND_NAMES) {
      const color = paintSpec[name].type === "color";
      expect(BINDINGS[name].encoding === "PROPERTY_ENCODING_COLOR_RGBA8").toBe(
        color,
      );
    }
  });
});

describe("the WebGL 2 wrapper", () => {
  const prelude =
    "uniform mat4 u_projection_matrix;\nvec4 projectTileFor3D(vec2 p, float e) { return u_projection_matrix * vec4(p, e, 1.0); }";

  it("prints one IS_UNIFORM define per bound property", () => {
    expect(uniformDefines("10111111")).toBe(
      [
        "#define MLN_PLUGIN_PROPERTY_BUILDING_HEIGHT_IS_UNIFORM 1",
        "#define MLN_PLUGIN_PROPERTY_BUILDING_BASE_IS_UNIFORM 0",
        "#define MLN_PLUGIN_PROPERTY_BUILDING_ROOF_HEIGHT_IS_UNIFORM 1",
        "#define MLN_PLUGIN_PROPERTY_BUILDING_ROOF_ANGLE_IS_UNIFORM 1",
        "#define MLN_PLUGIN_PROPERTY_BUILDING_COLOR_IS_UNIFORM 1",
        "#define MLN_PLUGIN_PROPERTY_BUILDING_ROOF_COLOR_IS_UNIFORM 1",
        "#define MLN_PLUGIN_PROPERTY_BUILDING_OPACITY_IS_UNIFORM 1",
        "#define MLN_PLUGIN_PROPERTY_BUILDING_VERTICAL_GRADIENT_IS_UNIFORM 1",
        "",
      ].join("\n"),
    );
    expect(() => uniformDefines("1111")).toThrow(/layout key/);
  });

  it("wraps the shared sources in GLSL ES 3.00", () => {
    const source = vertexSource(prelude, "", "00001111");
    expect(source.startsWith("#version 300 es\n")).toBe(true);
    expect(source).toContain(
      "#define BUILDING_ATTRIBUTE(l, t, n) layout(location = l) in t n;",
    );
    expect(source).toContain(`uniform ${DRAWABLE_BLOCK} {`);
    expect(source).toContain("buildingVertex(");
    expect(source).toContain(
      "projectTileFor3D(o.position.xy + u_translate, o.position.z)",
    );
    // The vertex stage never reads the pass's color write.
    expect(source).not.toContain("MLN_PLUGIN_COLOR_WRITE\n#if");
    expect(fragmentSource).toContain("precision highp float;");
  });
});
