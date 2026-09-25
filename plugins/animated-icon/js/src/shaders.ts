// WebGL2 sources around the shared properties.glsl, place.glsl and
// icon.glsl, mirroring the native plugin's OpenGL wrappers (glslVertex and
// glslFragment in ../../native/src/plugin.zig). The attribute declarations,
// both uniform blocks, the varyings and both `main` functions are the same
// text on both sides, between `// begin:<name>` and `// end:<name>` markers;
// ../../fixtures/shaders/sections.glsl pins them and both test suites check
// against it. The vertex shader projects through maplibre-gl-js's
// projectTile prelude instead of the block's tile matrix, so the layer
// follows the map's projection, including globe.

import iconShade from "./generated/icon.glsl.ts";
import iconPlace from "./generated/place.glsl.ts";
import iconProperties from "./generated/properties.glsl.ts";
import { type PaintName, paintNames, paintSpec } from "./spec.ts";

/** Uniform block binding points; maplibre-gl-js uses 0 to 2. */
export const CATALOG_BINDING = 3;
export const DRAWABLE_BINDING = 4;

export const CATALOG_BLOCK = "IconCatalogUBO";
export const DRAWABLE_BLOCK = "IconDrawableUBO";

/** IconDrawableUBO's std140 size and the byte offsets of its fields. */
export const DRAWABLE_UBO_BYTES = 208;
export const DRAWABLE_OFFSETS = {
  matrix: 0,
  camera: 64,
  view: 80,
  /** interpolation0..2: property i's factor is at 160 + 4 i. */
  interpolation: 160,
} as const;

/** Byte offset of each property's field in IconDrawableUBO. */
export const PROPERTY_OFFSETS: Readonly<Record<PaintName, number>> = {
  "icon-animation": 120,
  "icon-size": 124,
  "icon-rotate": 128,
  "icon-opacity": 132,
  "icon-color": 96,
  "icon-offset": 112,
  "icon-anchor": 136,
  "icon-rotation-alignment": 140,
  "icon-pitch-alignment": 144,
  "icon-animation-speed": 148,
  "icon-animation-offset": 152,
  "icon-animation-mode": 156,
};

/** Byte offset of property i's interpolation factor in IconDrawableUBO. */
export function interpolationOffset(name: PaintName): number {
  return DRAWABLE_OFFSETS.interpolation + 4 * paintNames.indexOf(name);
}

/** One vertex attribute a data-driven property is bound through. */
export interface AttributeSlot {
  readonly name: string;
  /** The attribute location, equal to the native attribute ID. */
  readonly location: number;
  /** Floats: 2 (vec2) or 4 (vec4). */
  readonly size: 2 | 4;
  /** Floats from the property's start in the paint buffer. */
  readonly offset: number;
}

/** The layout's a_pos: `anchor * 2 + corner`, location 0. */
export const POSITION_LOCATION = 0;

/**
 * The attributes of each property, at the native attribute IDs: a number,
 * rotation or enum packs its [min, max] into one vec2, icon-offset into one
 * vec4, and icon-color takes a vec4 per endpoint.
 */
export const ATTRIBUTE_SLOTS: Readonly<
  Record<PaintName, readonly AttributeSlot[]>
> = (() => {
  const slots: Partial<Record<PaintName, AttributeSlot[]>> = {};
  let location = POSITION_LOCATION + 1;
  for (const name of paintNames) {
    const snake = `a_${name.replaceAll("-", "_")}`;
    const type = paintSpec[name].type;
    if (type === "color") {
      slots[name] = [
        { name: `${snake}_min`, location: location++, size: 4, offset: 0 },
        { name: `${snake}_max`, location: location++, size: 4, offset: 4 },
      ];
    } else {
      const size = type === "float2" ? 4 : 2;
      slots[name] = [{ name: snake, location: location++, size, offset: 0 }];
    }
  }
  return slots as Record<PaintName, AttributeSlot[]>;
})();

/** The host's macro for a property: 1 when it arrives as a uniform. */
export function uniformMacro(name: PaintName): string {
  return `MLN_PLUGIN_PROPERTY_${name.replaceAll("-", "_").toUpperCase()}_IS_UNIFORM`;
}

// ---------------------------------------------------------------------------
// The shared sections, as plugin.zig writes them for OpenGL.
// ---------------------------------------------------------------------------

function section(name: string, body: string): string {
  return `// begin:${name}\n${body}// end:${name}\n`;
}

const attributes = (() => {
  let text = `layout(location=${POSITION_LOCATION}) in vec2 a_pos;\n`;
  for (const name of paintNames) {
    text += `#if !${uniformMacro(name)}\n`;
    for (const slot of ATTRIBUTE_SLOTS[name]) {
      text += `layout(location=${slot.location}) in vec${slot.size} ${slot.name};\n`;
    }
    text += "#endif\n";
  }
  return text;
})();

const drawableUbo = `layout(std140) uniform ${DRAWABLE_BLOCK} {
    mat4 matrix;                    //   0  tile matrix
    vec4 camera;                    //  64  pixels_to_gl.x, pixels_to_gl.y, pixels_to_tile_units, camera_to_center_distance
    vec4 view;                      //  80  pixel_ratio, bearing (radians, the host's sign), 0, 0
    vec4 icon_color;                //  96
    vec2 icon_offset;               // 112
    float icon_animation;           // 120
    float icon_size;                // 124
    float icon_rotate;              // 128
    float icon_opacity;             // 132
    float icon_anchor;              // 136
    float icon_rotation_alignment;  // 140
    float icon_pitch_alignment;     // 144
    float icon_animation_speed;     // 148
    float icon_animation_offset;    // 152
    float icon_animation_mode;      // 156
    vec4 interpolation0;            // 160  properties 0-3
    vec4 interpolation1;            // 176  properties 4-7
    vec4 interpolation2;            // 192  properties 8-11
} u;
`;

const catalogUbo = `layout(std140) uniform ${CATALOG_BLOCK} {
    highp vec4 clock;                          // x: seconds in [0, 4096)
    highp vec4 entries[2 * ICON_ENTRY_COUNT];  // entry e: [2e] box, [2e + 1] (display_px, loop_rate, frame_count, frame_texel)
} catalog;
`;

const varyings = (direction: "in" | "out") =>
  `${direction} vec2 v_uv;\nflat ${direction} vec4 v_icon;\nflat ${direction} vec4 v_color;\n`;

const vertexMain = `void main() {
    IconVertex v = iconPlace(a_pos,
        float4(ICON_ANIMATION, ICON_SIZE, ICON_ROTATE, ICON_OPACITY),
        float4(ICON_ANCHOR, ICON_ROTATION_ALIGNMENT, ICON_PITCH_ALIGNMENT, 0.0),
        ICON_OFFSET,
        float4(ICON_ANIMATION_SPEED, ICON_ANIMATION_OFFSET, ICON_ANIMATION_MODE, 0.0),
        u.camera, u.view.xy ICON_PLACE_ARG);
    gl_Position = v.position;
    v_uv = v.uv;
    v_icon = vec4(v.frame, ICON_OPACITY, 0.0, 0.0);
    v_color = ICON_COLOR;
}
`;

const fragmentMain = `void main() {
    fragColor = iconShade(v_uv, v_icon.x, v_color, vec4(0.0), v_icon.y ICON_ART_ARG);
}
`;

/** Each shared section with its markers, by name. */
export const SECTIONS = {
  attributes: section("attributes", attributes),
  "drawable-ubo": section("drawable-ubo", drawableUbo),
  "catalog-ubo": section("catalog-ubo", catalogUbo),
  "varyings-out": section("varyings-out", varyings("out")),
  "varyings-in": section("varyings-in", varyings("in")),
  "vertex-main": section("vertex-main", vertexMain),
  "fragment-main": section("fragment-main", fragmentMain),
} as const;

export type SectionName = keyof typeof SECTIONS;

// ---------------------------------------------------------------------------
// Sources.
// ---------------------------------------------------------------------------

/**
 * The IS_UNIFORM defines for an attribute layout key: one character per
 * property in spec order, "1" uniform and "0" bound to its attribute.
 */
export function uniformDefines(layoutKey: string): string {
  if (layoutKey.length !== paintNames.length || /[^01]/.test(layoutKey)) {
    throw new Error(`animated-icon: bad attribute layout key ${layoutKey}`);
  }
  return paintNames
    .map((name, i) => `#define ${uniformMacro(name)} ${layoutKey[i]}\n`)
    .join("");
}

/**
 * The vertex source for maplibre-gl-js's projection `prelude` and `define`
 * (CustomRenderMethodInput.shaderData), an attribute layout key and the
 * catalog's shader defines (Catalog.shaderDefines).
 */
export function vertexSource(
  prelude: string,
  define: string,
  layoutKey: string,
  catalogDefines: string,
): string {
  return `#version 300 es
${prelude}
${define}
${uniformDefines(layoutKey)}${catalogDefines}${SECTIONS.attributes}${SECTIONS["drawable-ubo"]}${SECTIONS["catalog-ubo"]}${SECTIONS["varyings-out"]}#define float2 vec2
#define float4 vec4
#define PROJECT(p) projectTile(p)
#define ICON_PLACE_PARAM
#define ICON_PLACE_ARG
#define ICON_CLOCK (catalog.clock.x)
#define ICON_ENTRY(i) (catalog.entries[i])
#define ICON_ATTR(name) name
${iconProperties}
${iconPlace}
${SECTIONS["vertex-main"]}`;
}

/**
 * The fragment source for the catalog's shader defines. maplibre-gl-js hands
 * custom layers no fragment prelude, so it declares fragColor itself, which
 * MapLibre Native's OpenGL prelude does for the native twin. GLSL ES
 * defaults fragment floats to mediump and samplers to lowp, both too coarse
 * for the coverage and the catalog's texels.
 */
export function fragmentSource(catalogDefines: string): string {
  return `#version 300 es
${catalogDefines}precision highp float;
precision highp int;
${SECTIONS["varyings-in"]}out highp vec4 fragColor;
uniform highp sampler2D u_art;
#define float2 vec2
#define float4 vec4
#define DX(v) dFdx(v)
#define DY(v) dFdy(v)
#define FETCH(i) texelFetch(u_art, ivec2((i) & ((1 << ICON_ART_SHIFT) - 1), clamp((i) >> ICON_ART_SHIFT, 0, ICON_ART_ROWS - 1)), 0)
#define ICON_ART_PARAM
#define ICON_ART_ARG
${iconShade}
${SECTIONS["fragment-main"]}`;
}

/** The catalog texture's sampler; it reads texture unit 0. */
export const ART_SAMPLER = "u_art";

/** Projection uniforms the prelude declares; absent ones resolve to null and are skipped. */
export const PROJECTION_UNIFORMS = [
  "u_projection_matrix",
  "u_projection_fallback_matrix",
  "u_projection_tile_mercator_coords",
  "u_projection_clipping_plane",
  "u_projection_transition",
] as const;
