// The WebGL 2 wrapper around the shared shader code in ../../shaders/
// (mirrored into ./generated/ by scripts/sync-shaders.mjs), and the
// rendering contract's tables as the web twin binds them: attribute
// locations, BuildingDrawableUBO's byte offsets and each paint property's
// binding. shaders.test.ts checks every table against
// ../../fixtures/render/contract.json, which the native twin also reads.
//
// The wrapper follows ../../README.md ("Where the code goes"): GLSL type
// names, BUILDING_ATTRIBUTE and BUILDING_ATTR, the IS_UNIFORM macros of one
// attribute layout, attributes.glsl, the block around uniforms.glsl,
// building.glsl, properties.glsl and a main around vertex.glsl. Unlike the
// native wrappers it projects o.position through maplibre-gl-js's
// projectTileFor3D prelude rather than u.tile_matrix, so the layer follows
// the map's projection (globe included) and keeps the depth gl-js's own 3D
// layers write. building-translate reaches that projection as u_translate, a
// plain uniform outside the shared block; the block's tile_matrix still
// carries the translated mercator tile matrix, as the native host fills it.

import attributesGlsl from "./generated/attributes.glsl.ts";
import buildingGlsl from "./generated/building.glsl.ts";
import propertiesGlsl from "./generated/properties.glsl.ts";
import uniformsGlsl from "./generated/uniforms.glsl.ts";
import vertexGlsl from "./generated/vertex.glsl.ts";
import type { PaintName } from "./spec.ts";

export const SHADER_ID = "building";

/** The one uniform block, its binding point and its std140 size. */
export const DRAWABLE_BLOCK = "BuildingDrawableUBO";
/** maplibre-gl-js binds its own blocks at 0 to 2. */
export const DRAWABLE_BINDING = 3;
export const DRAWABLE_UBO_BYTES = 192;

/** Byte offsets of BuildingDrawableUBO's members (uniforms.glsl). */
export const DRAWABLE_OFFSETS = {
  tileMatrix: 0,
  color: 64,
  roofColor: 80,
  lightColor: 96,
  lightPosition: 112,
  interpolation0: 128,
  interpolation1: 144,
  height: 160,
  base: 164,
  roofHeight: 168,
  roofAngle: 172,
  opacity: 176,
  verticalGradient: 180,
  metersPerTileUnit: 184,
  pad0: 188,
} as const;

/** The layout's vertex stream: a_pos at byte 0 and a_roof at byte 12. */
export const POS_LOCATION = 0;
export const ROOF_LOCATION = 1;
export const VERTEX_STRIDE = 28;

/** The ABI's vertex attribute types the contract names. */
export type AttributeType =
  | "VERTEX_FLOAT_X2"
  | "VERTEX_FLOAT_X3"
  | "VERTEX_FLOAT_X4"
  | "VERTEX_UINT8_X4_NORMALIZED";

export interface Attribute {
  /** The attribute id, equal to its location. */
  readonly id: number;
  readonly name: string;
  readonly type: AttributeType;
}

export const ATTRIBUTES: readonly Attribute[] = [
  { id: 0, name: "a_pos", type: "VERTEX_FLOAT_X3" },
  { id: 1, name: "a_roof", type: "VERTEX_FLOAT_X4" },
  { id: 2, name: "a_height", type: "VERTEX_FLOAT_X2" },
  { id: 3, name: "a_base", type: "VERTEX_FLOAT_X2" },
  { id: 4, name: "a_roof_height", type: "VERTEX_FLOAT_X2" },
  { id: 5, name: "a_roof_angle", type: "VERTEX_FLOAT_X2" },
  { id: 6, name: "a_color_min", type: "VERTEX_UINT8_X4_NORMALIZED" },
  { id: 7, name: "a_color_max", type: "VERTEX_UINT8_X4_NORMALIZED" },
  { id: 8, name: "a_roof_color_min", type: "VERTEX_UINT8_X4_NORMALIZED" },
  { id: 9, name: "a_roof_color_max", type: "VERTEX_UINT8_X4_NORMALIZED" },
  { id: 10, name: "a_opacity", type: "VERTEX_FLOAT_X2" },
  { id: 11, name: "a_vertical_gradient", type: "VERTEX_FLOAT_X2" },
];

/** The host encodings the bindings use. */
export type Encoding =
  | "PROPERTY_ENCODING_FLOAT"
  | "PROPERTY_ENCODING_COLOR_RGBA8"
  | "PROPERTY_ENCODING_BOOLEAN_FLOAT";

/** How one paint property reaches the shader, as the native host binds it. */
export interface Binding {
  readonly property: BoundName;
  readonly encoding: Encoding;
  /** Where its value goes in BuildingDrawableUBO when it is uniform. */
  readonly uniformOffset: number;
  /** Its attribute ids: one packed float2, or a color's min and max. */
  readonly minimumAttribute: number;
  readonly maximumAttribute: number;
  /** Where its interpolation factor goes in BuildingDrawableUBO. */
  readonly interpolationOffset: number;
}

/**
 * The paint properties with a shader binding, in binding order: every one
 * but building-translate and -translate-anchor, which the host applies to
 * the tile matrix. This order is the attribute layout key's.
 */
export const BOUND_NAMES = [
  "building-height",
  "building-base",
  "building-roof-height",
  "building-roof-angle",
  "building-color",
  "building-roof-color",
  "building-opacity",
  "building-vertical-gradient",
] as const satisfies readonly PaintName[];

export type BoundName = (typeof BOUND_NAMES)[number];

export const BINDINGS: Readonly<Record<BoundName, Binding>> = {
  "building-height": binding("building-height", "FLOAT", 160, 2, 2, 128),
  "building-base": binding("building-base", "FLOAT", 164, 3, 3, 132),
  "building-roof-height": binding(
    "building-roof-height",
    "FLOAT",
    168,
    4,
    4,
    136,
  ),
  "building-roof-angle": binding(
    "building-roof-angle",
    "FLOAT",
    172,
    5,
    5,
    140,
  ),
  "building-color": binding("building-color", "COLOR_RGBA8", 64, 6, 7, 144),
  "building-roof-color": binding(
    "building-roof-color",
    "COLOR_RGBA8",
    80,
    8,
    9,
    148,
  ),
  "building-opacity": binding("building-opacity", "FLOAT", 176, 10, 10, 152),
  "building-vertical-gradient": binding(
    "building-vertical-gradient",
    "BOOLEAN_FLOAT",
    180,
    11,
    11,
    156,
  ),
};

function binding(
  property: BoundName,
  encoding: "FLOAT" | "COLOR_RGBA8" | "BOOLEAN_FLOAT",
  uniformOffset: number,
  minimumAttribute: number,
  maximumAttribute: number,
  interpolationOffset: number,
): Binding {
  return {
    property,
    encoding: `PROPERTY_ENCODING_${encoding}`,
    uniformOffset,
    minimumAttribute,
    maximumAttribute,
    interpolationOffset,
  };
}

/** The host's macro for a property: 1 when it arrives as a uniform. */
export function uniformMacro(name: BoundName): string {
  return `MLN_PLUGIN_PROPERTY_${name.replaceAll("-", "_").toUpperCase()}_IS_UNIFORM`;
}

/**
 * The IS_UNIFORM defines for an attribute layout key: one character per
 * bound property in BOUND_NAMES order, "1" uniform and "0" bound to its
 * attribute.
 */
export function uniformDefines(layoutKey: string): string {
  if (layoutKey.length !== BOUND_NAMES.length || /[^01]/.test(layoutKey)) {
    throw new Error(`building: bad attribute layout key ${layoutKey}`);
  }
  return BOUND_NAMES.map(
    (name, i) => `#define ${uniformMacro(name)} ${layoutKey[i]}\n`,
  ).join("");
}

/** The uniform outside the shared block that carries building-translate. */
export const TRANSLATE_UNIFORM = "u_translate";

/**
 * The vertex source for maplibre-gl-js's projection `prelude` and `define`
 * (CustomRenderMethodInput.shaderData) and an attribute layout key. The
 * depth-only pass uses the same program, so both passes compute identical
 * positions.
 */
export function vertexSource(
  prelude: string,
  define: string,
  layoutKey: string,
): string {
  return `#version 300 es
${prelude}
${define}
#define float2 vec2
#define float3 vec3
#define float4 vec4
#define float4x4 mat4
#define BUILDING_ATTRIBUTE(l, t, n) layout(location = l) in t n;
#define BUILDING_ATTR(n) n
${uniformDefines(layoutKey)}${attributesGlsl}
layout(std140) uniform ${DRAWABLE_BLOCK} {
${uniformsGlsl}} u;
// building-translate in tile units (the web twin's projection takes it
// here; the block's tile_matrix already includes it).
uniform vec2 ${TRANSLATE_UNIFORM};
out vec4 v_color;
${buildingGlsl}
${propertiesGlsl}
void main() {
${vertexGlsl}
    gl_Position = projectTileFor3D(o.position.xy + ${TRANSLATE_UNIFORM}, o.position.z);
    v_color = o.color;
}
`;
}

/**
 * The fragment source: the interpolated, lit premultiplied color. The
 * depth-only pass masks color writes with colorMask instead of compiling a
 * variant, which on the native host is MLN_PLUGIN_COLOR_WRITE 0.
 */
export const fragmentSource = `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 fragColor;
void main() {
    fragColor = v_color;
}
`;

/** Projection uniforms the prelude declares; absent ones resolve to null and are skipped. */
export const PROJECTION_UNIFORMS = [
  "u_projection_matrix",
  "u_projection_fallback_matrix",
  "u_projection_tile_mercator_coords",
  "u_projection_clipping_plane",
  "u_projection_transition",
] as const;
