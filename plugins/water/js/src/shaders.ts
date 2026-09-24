// GLSL ES 3.00 sources around the shared shoreShade() function. The vertex
// shader extrudes the band in tile units and projects through MapLibre's
// projectTile prelude, so the layer follows the map's projection, including
// globe. The same varyings as the native plugin carry the paint values to
// the fragment stage.

import shade from "./generated/shore.glsl.ts";

export function vertexSource(prelude: string, define: string): string {
  return `#version 300 es
${prelude}
${define}
layout(location=0) in vec2 a_pos;
layout(location=1) in vec4 a_extrude;
// pixels_to_tile_units, pixel_ratio, time in seconds, tile extent
uniform vec4 u_camera;
uniform vec4 u_shore_color;
uniform vec4 u_foam_color;
// shore_width, wave_count, wave_speed, wave_wobble
uniform vec4 u_wave;
// foam_length, wash_strength, opacity
uniform vec3 u_params;
out vec4 v_pos;
out vec4 v_shore;
out vec4 v_foam;
out vec4 v_wave;
out vec4 v_params;
out vec2 v_owner;
void main() {
    // The band is clamped to half the reach to the opposite bank, so the
    // two sides of a narrow channel meet instead of overlapping.
    vec2 pos = a_pos + a_extrude.xy * min(u_wave.x * u_camera.x, a_extrude.w);
    gl_Position = projectTile(pos);
    v_pos = vec4(pos, a_extrude.z, u_camera.z);
    v_owner = a_pos;
    v_shore = u_shore_color;
    v_foam = u_foam_color;
    v_wave = u_wave;
    v_params = vec4(u_params, u_camera.w);
}
`;
}

export const fragmentSource = `#version 300 es
precision highp float;
#define float2 vec2
#define float4 vec4
in vec4 v_pos;
in vec4 v_shore;
in vec4 v_foam;
in vec4 v_wave;
in vec4 v_params;
in vec2 v_owner;
out vec4 fragColor;
${shade}
void main() {
    fragColor = shoreShade(v_pos.xy, v_owner, v_pos.z, v_shore, v_foam, v_wave, v_params, v_pos.w);
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

export const LAYER_UNIFORMS = [
  "u_camera",
  "u_shore_color",
  "u_foam_color",
  "u_wave",
  "u_params",
] as const;
